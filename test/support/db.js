// Prawdziwy Postgres w pamięci (PGlite) z migracją schematu bota — testy sprawdzają faktyczne SQL.
// Jedna instancja na plik testowy; przed każdym testem tabele są czyszczone.
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createStore } from '../../supabase/functions/hopkostki-bot/lib/store.js';

const SCHEMA = new URL('../../supabase/migrations/20260925160000_bot_schema.sql', import.meta.url);
// Z migracji notatek bierzemy tylko DDL tabel (harmonogramy pg_cron nie istnieją w PGlite).
const NOTES = new URL('../../supabase/migrations/20260925213000_bot_notes_gateway.sql', import.meta.url);
const VOICE = new URL('../../supabase/migrations/20260926160000_bot_voice_messages.sql', import.meta.url);
const TICKETS = new URL('../../supabase/migrations/20260926200000_bot_tickets.sql', import.meta.url);
const COMMUNITY = new URL('../../supabase/migrations/20260927100000_bot_logs_community.sql', import.meta.url);
const PROFILES = new URL('../../supabase/migrations/20260927140000_bot_member_profiles.sql', import.meta.url);
const INVITES = new URL('../../supabase/migrations/20260927160000_bot_invite_joins.sql', import.meta.url);
const TICKET_ARCHIVE = new URL('../../supabase/migrations/20260927180000_bot_ticket_archive.sql', import.meta.url);
// Zapis rozmowy po zamknięciu wysyła się od razu (nie z opóźnieniem przez crona) — te kolumny już niepotrzebne.
const TICKET_ARCHIVE_IMMEDIATE = new URL('../../supabase/migrations/20260927190000_bot_ticket_archive_immediate.sql', import.meta.url);
const PANEL_SESSIONS = new URL('../../supabase/migrations/20261030200000_bot_panel_sessions.sql', import.meta.url);
const withoutCron = (sql) => sql.split(/^select cron\.schedule/m)[0];
const withoutGrants = (sql) => sql.replace(/revoke .*? from anon, authenticated;/g, '');
let shared = null;

async function database() {
  if (!shared) {
    shared = (async () => {
      const db = new PGlite();
      await db.exec(withoutGrants(fs.readFileSync(SCHEMA, 'utf8')));
      await db.exec(withoutGrants(withoutCron(fs.readFileSync(NOTES, 'utf8'))));
      await db.exec(withoutGrants(fs.readFileSync(VOICE, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(TICKETS, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(COMMUNITY, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(PROFILES, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(INVITES, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(TICKET_ARCHIVE, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(TICKET_ARCHIVE_IMMEDIATE, 'utf8')));
      await db.exec(withoutGrants(fs.readFileSync(PANEL_SESSIONS, 'utf8')));
      return db;
    })();
  }
  return shared;
}

export async function createTestStore() {
  const db = await database();
  await db.exec(`
    truncate bot.warns, bot.cases, bot.temp_bans, bot.mod_messages, bot.channel_cursors, bot.notes,
      bot.voice_states, bot.temp_voice, bot.sent_messages, bot.tickets, bot.message_cache, bot.bumps,
      bot.reminders, bot.giveaways, bot.afk, bot.member_profiles, bot.invite_joins, bot.panel_sessions restart identity cascade;
    update bot.config set data = '{}'::jsonb;
    delete from bot.state where key not in ('cron_secret', 'cron_lock');
    update bot.state set value = to_jsonb('1970-01-01T00:00:00Z'::text) where key = 'cron_lock';
  `);
  const store = createStore(async (text, params) => (await db.query(text, emulatePostgresJs(text, params ?? []))).rows);
  return { db, store };
}

// postgres.js (sterownik w funkcji Edge) serializuje parametr rzutowany wprost na jsonb przez JSON.stringify,
// więc przekazany napis JSON zostałby zapisany jako napis, a nie obiekt. PGlite tak nie robi —
// odtwarzamy to zachowanie, żeby testy wyłapywały takie błędy.
function emulatePostgresJs(text, params) {
  const jsonbParams = new Set([...text.matchAll(/\$(\d+)::jsonb/g)].map((m) => Number(m[1]) - 1));
  return params.map((value, i) => (jsonbParams.has(i) && value !== null ? JSON.stringify(value) : value));
}
