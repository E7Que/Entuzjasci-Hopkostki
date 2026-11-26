// Dostęp do bazy (schemat "bot" w Postgresie Supabase).
// query(text, params) => Promise<wiersze> — w funkcji Edge to postgres.js, w testach PGlite.

import { DEFAULT_CONFIG } from './defaults.js';
import { mergeWithDefaults, sanitizeConfig } from './configSchema.js';

const ms = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

// Rodzaje XP: kolumna cooldownu i licznik statystyk.
const XP_KINDS = {
  message: { last: 'last_message_at', counter: 'messages' },
  voice: { last: 'last_voice_at', counter: 'voice_minutes' },
  reaction: { last: 'last_reaction_at', counter: 'reactions' },
};
// Kolumny w bot.level_daily dla każdego rodzaju XP.
const DAILY_COUNTERS = { message: 'messages', voice: 'voice_minutes', reaction: 'reactions' };

const mapLevel = (r) => ({
  userId: r.user_id,
  userTag: r.user_tag,
  displayName: r.display_name ?? null,
  avatar: r.avatar,
  xp: Number(r.xp),
  level: r.level,
  messages: r.messages,
  voiceMinutes: r.voice_minutes,
  reactions: r.reactions,
  weekKey: r.week_key,
  weekXp: Number(r.week_xp),
  monthKey: r.month_key,
  monthXp: Number(r.month_xp),
  lastMessageAt: r.last_message_at ?? null,
  lastVoiceAt: r.last_voice_at ?? null,
  lastReactionAt: r.last_reaction_at ?? null,
  accentColor: r.accent_color ?? null,
  nitro: Boolean(r.nitro),
  look: r.look ?? null,
  guildAvatar: r.guild_avatar ?? null,
  rank: r.rank === undefined ? null : Number(r.rank),
  hidden: Boolean(r.hidden),
});

// Szukanie po ID, nazwie albo pseudonimie; publicOnly — bez osób ukrytych na stronie rankingu.
const levelSearch = (n, alias, publicOnly) =>
  `($${n}::text = '' or (${publicOnly ? `not ${alias}hidden and ` : ''}(${alias}user_id = $${n}::text or ${alias}user_tag ilike '%' || $${n}::text || '%' or ${alias}display_name ilike '%' || $${n}::text || '%')))`;

const mapContestEntry = (r) => ({
  contestId: r.contest_id,
  userId: r.user_id,
  userTag: r.l_tag ?? r.user_tag ?? null,
  displayName: r.l_name ?? r.display_name ?? null,
  avatar: r.l_avatar ?? r.avatar ?? null,
  guildAvatar: r.l_guild_avatar ?? null,
  hidden: Boolean(r.hidden),
  score: Number(r.score ?? 0),
  createdAt: ms(r.created_at),
  qualifiedAt: ms(r.qualified_at),
  wonAt: ms(r.won_at),
});

// Bez skrótu tokenu — ten zostaje w bazie.
const mapMemberLink = (r) => ({
  id: r.id,
  kind: r.kind,
  userId: r.user_id,
  userTag: r.user_tag ?? null,
  displayName: r.display_name ?? null,
  avatar: r.avatar ?? null,
  createdAt: ms(r.created_at),
  expiresAt: ms(r.expires_at),
  lastSeenAt: ms(r.last_seen_at),
});

// Bez skrótu tokenu — ten zostaje w bazie.
const mapPanelSession = (r) => ({
  id: r.id,
  kind: r.kind,
  login: r.login,
  loginId: r.login_id,
  userId: r.user_id,
  userTag: r.user_tag,
  roles: r.roles ?? [],
  admin: r.admin,
  createdAt: ms(r.created_at),
  expiresAt: ms(r.expires_at),
  checkedAt: ms(r.checked_at),
  lastSeenAt: ms(r.last_seen_at),
});

function mapCase(r) {
  return {
    id: r.id,
    type: r.type,
    guildId: r.guild_id,
    userId: r.user_id,
    userTag: r.user_tag,
    moderatorId: r.moderator_id,
    moderatorTag: r.moderator_tag,
    reason: r.reason,
    duration: r.duration ?? null,
    expiresAt: ms(r.expires_at),
    auto: r.auto,
    note: r.note,
    dmStatus: r.dm_status,
    appealStatus: r.appeal_status ?? null,
    messageUrl: r.message_url,
    createdAt: ms(r.created_at),
  };
}

function mapWarn(r) {
  return {
    id: r.id,
    guildId: r.guild_id,
    userId: r.user_id,
    userTag: r.user_tag,
    moderatorId: r.moderator_id,
    moderatorTag: r.moderator_tag,
    reason: r.reason,
    points: r.points,
    caseId: r.case_id,
    createdAt: ms(r.created_at),
    expiresAt: ms(r.expires_at),
  };
}

function mapTempBan(r) {
  return { guildId: r.guild_id, userId: r.user_id, userTag: r.user_tag, expiresAt: ms(r.expires_at), caseId: r.case_id };
}

function mapAppeal(r) {
  return {
    id: r.id,
    caseId: r.case_id,
    userId: r.user_id,
    userTag: r.user_tag,
    text: r.text,
    status: r.status,
    channelId: r.channel_id,
    messageId: r.message_id,
    decidedBy: r.decided_by,
    decidedTag: r.decided_tag,
    decisionNote: r.decision_note,
    undoResult: r.undo_result,
    decidedAt: ms(r.decided_at),
    createdAt: ms(r.created_at),
  };
}

const mapWinner = (r) => ({
  rank: Number(r.rank),
  xp: Number(r.xp),
  userId: r.user_id,
  userTag: r.user_tag ?? null,
  displayName: r.display_name ?? null,
  avatar: r.avatar ?? null,
  guildAvatar: r.guild_avatar ?? null,
  hidden: Boolean(r.hidden),
});

const CASE_COLUMNS = { reason: 'reason', note: 'note', dmStatus: 'dm_status', messageUrl: 'message_url' };
const ACTIVE_WARN = '(expires_at is null or expires_at > now())';

function mapNote(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userTag: r.user_tag,
    authorId: r.author_id,
    authorTag: r.author_tag,
    text: r.text,
    createdAt: ms(r.created_at),
  };
}

function mapTempVoice(r) {
  return {
    channelId: r.channel_id,
    guildId: r.guild_id,
    ownerId: r.owner_id,
    hubId: r.hub_id,
    name: r.name,
    limit: r.user_limit,
    private: r.private,
    allowed: r.allowed ?? [],
    banned: r.banned ?? [],
    dashboardMessageId: r.dashboard_message_id,
    createdAt: ms(r.created_at),
  };
}

const TEMP_VOICE_COLUMNS = {
  ownerId: ['owner_id', 'text'],
  name: ['name', 'text'],
  limit: ['user_limit', 'int'],
  private: ['private', 'boolean'],
  allowed: ['allowed', 'jsonb'],
  banned: ['banned', 'jsonb'],
  dashboardMessageId: ['dashboard_message_id', 'text'],
};

function mapTicket(r) {
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    userId: r.user_id,
    userTag: r.user_tag,
    type: r.type,
    subject: r.subject,
    status: r.status,
    claimedBy: r.claimed_by,
    closedBy: r.closed_by,
    createdAt: ms(r.created_at),
    closedAt: ms(r.closed_at),
  };
}

const TICKET_COLUMNS = { channelId: 'channel_id', status: 'status', claimedBy: 'claimed_by', closedBy: 'closed_by' };

function mapSentMessage(r) {
  return { id: r.id, channelId: r.channel_id, messageId: r.message_id, data: r.data, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) };
}

function mapCachedMessage(r) {
  return {
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorTag: r.author_tag,
    authorAvatar: r.author_avatar,
    content: r.content ?? '',
    attachments: r.attachments ?? [],
    createdAt: ms(r.created_at),
    editedAt: ms(r.edited_at),
    deletedAt: ms(r.deleted_at),
  };
}

function mapReminder(r) {
  return { id: r.id, userId: r.user_id, channelId: r.channel_id, text: r.text, dueAt: ms(r.due_at), createdAt: ms(r.created_at) };
}

function mapGiveaway(r) {
  return {
    id: r.id,
    channelId: r.channel_id,
    messageId: r.message_id,
    prize: r.prize,
    winners: r.winners,
    hostId: r.host_id,
    requiredRoleId: r.required_role_id,
    entrants: r.entrants ?? [],
    winnerIds: r.winner_ids ?? [],
    endsAt: ms(r.ends_at),
    ended: r.ended,
    createdAt: ms(r.created_at),
  };
}

// configTtlMs: jak długo trzymać konfigurację w pamięci (mniej zapytań = szybsza odpowiedź dla Discorda).
export function createStore(query, { configTtlMs = 10_000 } = {}) {
  const one = async (text, params) => (await query(text, params))[0] ?? null;
  let configCache = null;

  const store = {
    query,

    // ---------- Konfiguracja ----------
    async getConfig() {
      if (configCache && Date.now() - configCache.at < configTtlMs) return configCache.value;
      const row = await one('select data from bot.config where id = 1');
      const value = mergeWithDefaults(DEFAULT_CONFIG, row?.data);
      configCache = { at: Date.now(), value };
      return value;
    },

    async updateConfig(input) {
      configCache = null;
      const next = sanitizeConfig(input, await store.getConfig());
      await query(
        `insert into bot.config (id, data, updated_at) values (1, $1::text::jsonb, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [JSON.stringify(next)],
      );
      configCache = { at: Date.now(), value: next };
      return next;
    },

    // ---------- Sprawy ----------
    async addCase(c) {
      const row = await one(
        `insert into bot.cases (type, guild_id, user_id, user_tag, moderator_id, moderator_tag, reason, duration, expires_at, auto)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text::jsonb,
                 case when $9::float8 is null then null else to_timestamp($9::float8 / 1000) end, $10::boolean)
         returning *`,
        [
          c.type,
          c.guildId,
          c.userId,
          c.userTag ?? null,
          c.moderatorId ?? null,
          c.moderatorTag ?? null,
          c.reason,
          c.duration ? JSON.stringify(c.duration) : null,
          c.expiresAt ?? null,
          Boolean(c.auto),
        ],
      );
      return mapCase(row);
    },

    async getCase(id) {
      const row = await one('select * from bot.cases where id = $1::int', [id]);
      return row ? mapCase(row) : null;
    },

    async updateCase(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => CASE_COLUMNS[key]);
      if (!entries.length) return store.getCase(id);
      const sets = entries.map(([key], i) => `${CASE_COLUMNS[key]} = $${i + 2}::text`).join(', ');
      const row = await one(`update bot.cases set ${sets} where id = $1::int returning *`, [id, ...entries.map(([, v]) => v)]);
      return row ? mapCase(row) : null;
    },

    async deleteCase(id) {
      await query('delete from bot.cases where id = $1::int', [id]);
    },

    async listCases({ userId, type, search, limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = [];
      if (userId) {
        params.push(userId);
        where.push(`user_id = $${params.length}::text`);
      }
      if (type) {
        params.push(type);
        where.push(`type = $${params.length}::text`);
      }
      if (search) {
        params.push(`%${search}%`);
        where.push(`(user_tag ilike $${params.length}::text or moderator_tag ilike $${params.length}::text)`);
      }
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = await one(`select count(*)::int as n from bot.cases ${clause}`, params);
      const rows = await query(
        `select c.*, (select a.status from bot.appeals a where a.case_id = c.id) as appeal_status
         from bot.cases c ${clause} order by id desc limit $${params.length + 1}::int offset $${params.length + 2}::int`,
        [...params, limit, offset],
      );
      return { total: total.n, items: rows.map(mapCase) };
    },

    // ---------- Obrazki z panelu (banery) ----------
    async addAsset({ id, contentType, data, size }) {
      await query('insert into bot.assets (id, content_type, data, size) values ($1::text, $2::text, $3::text, $4::int)', [id, contentType, data, size]);
    },

    async getAsset(id) {
      const row = await one('select content_type, data from bot.assets where id = $1::text', [id]);
      return row ? { contentType: row.content_type, data: row.data } : null;
    },

    // Usuwa obrazki spoza `keep`, starsze niż `hours` godzin.
    async pruneAssets(keep, hours = 24) {
      await query(
        'delete from bot.assets where created_at < now() - make_interval(hours => $2::int) and id not in (select jsonb_array_elements_text($1::text::jsonb))',
        [JSON.stringify(keep), hours],
      );
    },

    // ---------- Stan bota (pulpit panelu) ----------
    // Rozmiar bazy (Supabase Free: 500 MB) i największe schematy.
    async dbUsage() {
      const total = await one('select pg_database_size(current_database())::bigint as bytes', []);
      const schemas = await query(
        `select n.nspname as name, coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as bytes
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
         group by n.nspname order by 2 desc limit 6`,
        [],
      );
      return { bytes: Number(total.bytes), schemas: schemas.map((s) => ({ name: s.name, bytes: Number(s.bytes) })) };
    },

    // XP, wiadomości i minuty na głosowych z danego dnia (czas polski) — z bot.level_daily.
    async dayActivity(day) {
      const row = await one(
        `select count(*)::int as people, coalesce(sum(xp), 0)::bigint as xp, coalesce(sum(messages), 0)::int as messages,
           coalesce(sum(voice_minutes), 0)::int as voice from bot.level_daily where day = $1::date`,
        [day],
      );
      return { people: row.people, xp: Number(row.xp), messages: row.messages, voiceMinutes: row.voice };
    },

    async countPendingAppeals() {
      const row = await one("select count(*)::int as n from bot.appeals where status = 'pending'", []);
      return row.n;
    },

    // ---------- Ochrona logowania do panelu ----------
    async loginAttempt(key) {
      const row = await one('select fails, first_at, locked_until from bot.login_attempts where key = $1::text', [key]);
      return row ? { fails: row.fails, firstAt: ms(row.first_at), lockedUntil: ms(row.locked_until) } : null;
    },

    // Kolejny błąd: licznik w oknie `windowMin` minut; przy `limit` błędach blokada na `lockMin` minut.
    async loginFailed(key, { limit = 10, windowMin = 15, lockMin = 15 } = {}) {
      const row = await one(
        `insert into bot.login_attempts as a (key, fails, first_at, locked_until)
         values ($1::text, 1, now(), case when 1 >= $2::int then now() + make_interval(mins => $4::int) end)
         on conflict (key) do update set
           fails = case when a.first_at < now() - make_interval(mins => $3::int) then 1 else a.fails + 1 end,
           first_at = case when a.first_at < now() - make_interval(mins => $3::int) then now() else a.first_at end,
           locked_until = case
             when (case when a.first_at < now() - make_interval(mins => $3::int) then 1 else a.fails + 1 end) >= $2::int
               then greatest(a.locked_until, now() + make_interval(mins => $4::int))
             else a.locked_until end
         returning fails, locked_until`,
        [key, limit, windowMin, lockMin],
      );
      return { fails: row.fails, lockedUntil: ms(row.locked_until) };
    },

    async loginSucceeded(key) {
      await query('delete from bot.login_attempts where key = $1::text', [key]);
    },

    async pruneLoginAttempts() {
      await query("delete from bot.login_attempts where first_at < now() - interval '1 day' and (locked_until is null or locked_until < now())");
    },

    // ---------- Dziennik zmian ustawień ----------
    // changes = { klucz: { before, after } } — tylko zmienione sekcje. Zostaje ostatnie 100 wpisów.
    async addConfigHistory({ changedBy, changes }) {
      const keys = Object.keys(changes);
      if (!keys.length) return null;
      const row = await one(
        'insert into bot.config_history (changed_by, keys, changes) values ($1::text, $2::text::jsonb, $3::text::jsonb) returning id',
        [changedBy ?? null, JSON.stringify(keys), JSON.stringify(changes)],
      );
      await query('delete from bot.config_history where id <= $1::int - 100', [row.id]);
      return row.id;
    },

    async listConfigHistory(limit = 30) {
      const rows = await query('select id, changed_by, keys, created_at from bot.config_history order by id desc limit $1::int', [limit]);
      return rows.map((r) => ({ id: r.id, changedBy: r.changed_by, keys: r.keys ?? [], createdAt: ms(r.created_at) }));
    },

    async getConfigHistory(id) {
      const row = await one('select * from bot.config_history where id = $1::int', [id]);
      return row ? { id: row.id, changedBy: row.changed_by, keys: row.keys ?? [], changes: row.changes, createdAt: ms(row.created_at) } : null;
    },

    // ---------- Odwołania od kar ----------
    async addAppeal({ caseId, userId, userTag, text }) {
      const row = await one(
        `insert into bot.appeals (case_id, user_id, user_tag, text) values ($1::int, $2::text, $3::text, $4::text)
         on conflict (case_id) do nothing returning *`,
        [caseId, userId, userTag ?? null, text],
      );
      return row ? mapAppeal(row) : null;
    },

    async getAppeal(id) {
      const row = await one('select * from bot.appeals where id = $1::int', [id]);
      return row ? mapAppeal(row) : null;
    },

    async getAppealByCase(caseId) {
      const row = await one('select * from bot.appeals where case_id = $1::int', [caseId]);
      return row ? mapAppeal(row) : null;
    },

    async deleteAppeal(id) {
      await query('delete from bot.appeals where id = $1::int', [id]);
    },

    async setAppealMessage(id, { channelId, messageId }) {
      await query('update bot.appeals set channel_id = $2::text, message_id = $3::text where id = $1::int', [id, channelId, messageId]);
    },

    // Decyzja tylko dla oczekującego odwołania (null, gdy ktoś był szybszy).
    async decideAppeal(id, { status, decidedBy, decidedTag, note }) {
      const row = await one(
        `update bot.appeals set status = $2::text, decided_by = $3::text, decided_tag = $4::text, decision_note = $5::text, decided_at = now()
         where id = $1::int and status = 'pending' returning *`,
        [id, status, decidedBy, decidedTag ?? null, note ?? null],
      );
      return row ? mapAppeal(row) : null;
    },

    async setAppealUndo(id, result) {
      const row = await one('update bot.appeals set undo_result = $2::text where id = $1::int returning *', [id, result]);
      return row ? mapAppeal(row) : null;
    },

    // Lista do panelu (z karą, której dotyczy): najpierw oczekujące, potem najnowsze.
    async listAppeals({ status = null, limit = 30, offset = 0 } = {}) {
      const rows = await query(
        `select a.*, c.type as case_type, c.reason as case_reason, c.moderator_tag as case_moderator, c.created_at as case_created_at
         from bot.appeals a join bot.cases c on c.id = a.case_id
         where ($1::text is null or a.status = $1::text)
         order by (a.status = 'pending') desc, a.created_at desc limit $2::int offset $3::int`,
        [status, limit, offset],
      );
      const total = await one('select count(*)::int as n from bot.appeals where ($1::text is null or status = $1::text)', [status]);
      const pending = await one("select count(*)::int as n from bot.appeals where status = 'pending'", []);
      return {
        total: total.n,
        pending: pending.n,
        items: rows.map((r) => ({ ...mapAppeal(r), caseType: r.case_type, caseReason: r.case_reason, caseModerator: r.case_moderator, caseCreatedAt: ms(r.case_created_at) })),
      };
    },

    async removeWarnsByCase(caseId) {
      const rows = await query('delete from bot.warns where case_id = $1::int returning id', [caseId]);
      return rows.length;
    },

    async caseCounts(userId) {
      const rows = await query('select type, count(*)::int as n from bot.cases where user_id = $1::text group by type', [userId]);
      return Object.fromEntries(rows.map((r) => [r.type, r.n]));
    },

    // ---------- Ostrzeżenia ----------
    async addWarn(w, expiryDays) {
      const row = await one(
        `insert into bot.warns (guild_id, user_id, user_tag, moderator_id, moderator_tag, reason, points, case_id, expires_at)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::int, $8::int,
                 case when $9::int > 0 then now() + make_interval(days => $9::int) end)
         returning *`,
        [w.guildId, w.userId, w.userTag, w.moderatorId, w.moderatorTag, w.reason, w.points, w.caseId, expiryDays],
      );
      return mapWarn(row);
    },

    async getWarn(id) {
      const row = await one(`select * from bot.warns where id = $1::int and ${ACTIVE_WARN}`, [id]);
      return row ? mapWarn(row) : null;
    },

    async getWarns(userId) {
      const rows = await query(`select * from bot.warns where user_id = $1::text and ${ACTIVE_WARN} order by created_at desc, id desc`, [userId]);
      return rows.map(mapWarn);
    },

    async warnSummary(userId) {
      const warns = await store.getWarns(userId);
      const points = warns.reduce((sum, w) => sum + w.points, 0);
      const nextExpiry = warns.map((w) => w.expiresAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
      return { count: warns.length, points, warns, nextExpiry };
    },

    async removeWarn(id) {
      const row = await one('delete from bot.warns where id = $1::int returning *', [id]);
      return row ? mapWarn(row) : null;
    },

    async clearWarns(userId) {
      const rows = await query('delete from bot.warns where user_id = $1::text returning *', [userId]);
      return rows.map(mapWarn);
    },

    async updateWarnByCase(caseId, { reason }) {
      await query('update bot.warns set reason = $2::text where case_id = $1::int', [caseId, reason]);
    },

    // Usuwa ostrzeżenia, którym skończyło się odliczanie, i dopisuje notatkę w sprawie.
    async expireWarns() {
      const rows = await query('delete from bot.warns where expires_at is not null and expires_at <= now() returning *');
      const ids = rows.map((r) => r.case_id).filter(Boolean);
      if (ids.length) {
        await query(
          `update bot.cases set note = 'Ostrzeżenie wygasło' where id in (select (jsonb_array_elements_text($1::text::jsonb))::int)`,
          [JSON.stringify(ids)],
        );
      }
      return rows.map(mapWarn);
    },

    async warnRanking() {
      const rows = await query(`select * from bot.warns where ${ACTIVE_WARN} order by created_at desc, id desc`);
      const byUser = new Map();
      for (const w of rows.map(mapWarn)) {
        const row = byUser.get(w.userId) ?? { userId: w.userId, userTag: w.userTag, count: 0, points: 0, warns: [] };
        row.count += 1;
        row.points += w.points;
        row.warns.push(w);
        byUser.set(w.userId, row);
      }
      return [...byUser.values()].sort((a, b) => b.points - a.points || b.count - a.count);
    },

    // ---------- Tymczasowe bany ----------
    async setTempBan({ guildId, userId, userTag, expiresAt, caseId }) {
      await query(
        `insert into bot.temp_bans (guild_id, user_id, user_tag, expires_at, case_id)
         values ($1::text, $2::text, $3::text, to_timestamp($4::float8 / 1000), $5::int)
         on conflict (guild_id, user_id) do update
           set user_tag = excluded.user_tag, expires_at = excluded.expires_at, case_id = excluded.case_id`,
        [guildId, userId, userTag, expiresAt, caseId],
      );
    },

    async removeTempBan(guildId, userId) {
      const rows = await query('delete from bot.temp_bans where guild_id = $1::text and user_id = $2::text returning user_id', [guildId, userId]);
      return rows.length > 0;
    },

    async listTempBans() {
      return (await query('select * from bot.temp_bans order by expires_at')).map(mapTempBan);
    },

    async dueTempBans() {
      return (await query('select * from bot.temp_bans where expires_at <= now() order by expires_at')).map(mapTempBan);
    },

    // ---------- Wiadomości o karach (reakcje na odpowiedzi) ----------
    async addModMessage(messageId, channelId, caseId) {
      await query(
        `insert into bot.mod_messages (message_id, channel_id, case_id) values ($1::text, $2::text, $3::int)
         on conflict (message_id) do nothing`,
        [messageId, channelId, caseId ?? null],
      );
    },

    async filterModMessages(ids) {
      if (!ids.length) return new Set();
      const rows = await query(
        'select message_id from bot.mod_messages where message_id in (select jsonb_array_elements_text($1::text::jsonb))',
        [JSON.stringify(ids)],
      );
      return new Set(rows.map((r) => r.message_id));
    },

    // Kanały z wiadomościami o karach z ostatnich dni + najstarsza z nich (punkt startowy przeglądania).
    async recentModChannels(days = 7) {
      const rows = await query(
        `select m.channel_id, min(m.message_id::numeric)::text as first_message_id, c.last_message_id
         from bot.mod_messages m left join bot.channel_cursors c on c.channel_id = m.channel_id
         where m.created_at > now() - make_interval(days => $1::int)
         group by m.channel_id, c.last_message_id`,
        [days],
      );
      return rows.map((r) => ({ channelId: r.channel_id, firstMessageId: r.first_message_id, cursor: r.last_message_id }));
    },

    async setCursor(channelId, messageId) {
      await query(
        `insert into bot.channel_cursors (channel_id, last_message_id, updated_at) values ($1::text, $2::text, now())
         on conflict (channel_id) do update set last_message_id = excluded.last_message_id, updated_at = now()`,
        [channelId, messageId],
      );
    },

    async pruneModMessages(days = 30) {
      await query('delete from bot.mod_messages where created_at < now() - make_interval(days => $1::int)', [days]);
    },

    // ---------- Stan techniczny ----------
    async getState(key) {
      const row = await one('select value from bot.state where key = $1::text', [key]);
      return row?.value ?? null;
    },

    async setState(key, value) {
      await query(
        `insert into bot.state (key, value, updated_at) values ($1::text, $2::text::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    },

    // Blokada (dzierżawa) na czas działania zadania — wygasa sama, gdyby zadanie padło.
    async acquireLease(key, seconds) {
      await query(
        `insert into bot.state (key, value) values ($1::text, to_jsonb('1970-01-01T00:00:00Z'::text))
         on conflict (key) do nothing`,
        [key],
      );
      const rows = await query(
        `update bot.state set value = to_jsonb(now()::text), updated_at = now()
         where key = $1::text and (value #>> '{}')::timestamptz < now() - make_interval(secs => $2::int)
         returning key`,
        [key, seconds],
      );
      return rows.length > 0;
    },

    async releaseLease(key) {
      await query(`update bot.state set value = to_jsonb('1970-01-01T00:00:00Z'::text) where key = $1::text`, [key]);
    },

    acquireCronLock: () => store.acquireLease('cron_lock', 60),
    releaseCronLock: () => store.releaseLease('cron_lock'),

    // ---------- Notatki moderatorów ----------
    async addNote({ guildId, userId, userTag, authorId, authorTag, text }) {
      const row = await one(
        `insert into bot.notes (guild_id, user_id, user_tag, author_id, author_tag, text)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text) returning *`,
        [guildId, userId, userTag, authorId, authorTag, text],
      );
      return mapNote(row);
    },

    async listNotes(userId) {
      const rows = await query('select * from bot.notes where user_id = $1::text order by id desc', [userId]);
      return rows.map(mapNote);
    },

    async removeNote(id) {
      const row = await one('delete from bot.notes where id = $1::int returning *', [id]);
      return row ? mapNote(row) : null;
    },

    // ---------- Stany głosowe (kto jest na jakim kanale) ----------
    async getVoiceChannel(userId) {
      return (await one('select channel_id from bot.voice_states where user_id = $1::text', [userId]))?.channel_id ?? null;
    },

    // muted/deafened (samo- albo przez serwer), bot i role — dla XP za kanały głosowe (anty-AFK, role bez XP).
    async setVoiceState(userId, channelId, { muted = false, deafened = false, bot = false, roles = [] } = {}) {
      if (!channelId) {
        await query('delete from bot.voice_states where user_id = $1::text', [userId]);
        return;
      }
      await query(
        `insert into bot.voice_states as v (user_id, channel_id, muted, deafened, bot, roles, updated_at)
         values ($1::text, $2::text, $3::boolean, $4::boolean, $5::boolean, $6::text::jsonb, now())
         on conflict (user_id) do update set channel_id = excluded.channel_id, muted = excluded.muted, deafened = excluded.deafened,
           bot = excluded.bot, roles = excluded.roles,
           updated_at = case when v.channel_id = excluded.channel_id then v.updated_at else now() end`,
        [userId, channelId, muted, deafened, bot, JSON.stringify(roles)],
      );
    },

    async listVoiceStates() {
      return (await query('select * from bot.voice_states')).map((r) => ({
        userId: r.user_id,
        channelId: r.channel_id,
        muted: r.muted,
        deafened: r.deafened,
        bot: r.bot,
        roles: r.roles ?? [],
      }));
    },

    // Pełna lista z GUILD_CREATE — zastępuje wszystko, co było (po ponownym zalogowaniu do gatewaya).
    async replaceVoiceStates(states) {
      await query('delete from bot.voice_states');
      if (!states.length) return;
      await query(
        `insert into bot.voice_states (user_id, channel_id, muted, deafened, bot, roles)
         select s->>'userId', s->>'channelId', coalesce((s->>'muted')::boolean, false), coalesce((s->>'deafened')::boolean, false),
                coalesce((s->>'bot')::boolean, false), coalesce(s->'roles', '[]'::jsonb)
         from jsonb_array_elements($1::text::jsonb) s
         on conflict (user_id) do update set channel_id = excluded.channel_id, muted = excluded.muted, deafened = excluded.deafened,
           bot = excluded.bot, roles = excluded.roles, updated_at = now()`,
        [JSON.stringify(states)],
      );
    },

    async voiceMembers(channelId) {
      return (await query('select user_id from bot.voice_states where channel_id = $1::text order by updated_at', [channelId])).map((r) => r.user_id);
    },

    // ---------- Kanały głosowe na żądanie ----------
    async addTempVoice({ channelId, guildId, ownerId, hubId, name, limit = 0, private: isPrivate = false }) {
      const row = await one(
        `insert into bot.temp_voice (channel_id, guild_id, owner_id, hub_id, name, user_limit, private)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::int, $7::boolean) returning *`,
        [channelId, guildId, ownerId, hubId ?? null, name ?? null, limit, isPrivate],
      );
      return mapTempVoice(row);
    },

    async getTempVoice(channelId) {
      const row = await one('select * from bot.temp_voice where channel_id = $1::text', [channelId]);
      return row ? mapTempVoice(row) : null;
    },

    async getTempVoiceByOwner(ownerId) {
      const row = await one('select * from bot.temp_voice where owner_id = $1::text', [ownerId]);
      return row ? mapTempVoice(row) : null;
    },

    async listTempVoice() {
      return (await query('select * from bot.temp_voice order by created_at')).map(mapTempVoice);
    },

    async updateTempVoice(channelId, patch) {
      const entries = Object.entries(patch).filter(([key]) => TEMP_VOICE_COLUMNS[key]);
      if (!entries.length) return store.getTempVoice(channelId);
      const sets = entries.map(([key], i) => {
        const [column, type] = TEMP_VOICE_COLUMNS[key];
        return `${column} = $${i + 2}::${type === 'jsonb' ? 'text::jsonb' : type}`;
      });
      const values = entries.map(([key, value]) => (TEMP_VOICE_COLUMNS[key][1] === 'jsonb' ? JSON.stringify(value) : value));
      const row = await one(`update bot.temp_voice set ${sets.join(', ')} where channel_id = $1::text returning *`, [channelId, ...values]);
      return row ? mapTempVoice(row) : null;
    },

    async deleteTempVoice(channelId) {
      await query('delete from bot.temp_voice where channel_id = $1::text', [channelId]);
    },

    // ---------- Tickety ----------
    async addTicket({ guildId, userId, userTag, type, subject }) {
      const row = await one(
        `insert into bot.tickets (guild_id, user_id, user_tag, type, subject)
         values ($1::text, $2::text, $3::text, $4::text, $5::text) returning *`,
        [guildId, userId, userTag ?? null, type ?? null, subject || null],
      );
      return mapTicket(row);
    },

    async getTicket(id) {
      const row = await one('select * from bot.tickets where id = $1::int', [id]);
      return row ? mapTicket(row) : null;
    },

    // Otwarty ticket na tym kanale (null = to nie ticket albo już zamknięty).
    async openTicketByChannel(channelId) {
      const row = await one(`select * from bot.tickets where channel_id = $1::text and status = 'open' order by id desc limit 1`, [channelId]);
      return row ? mapTicket(row) : null;
    },

    // Przejęcie tylko wolnego, otwartego ticketu — przy dwóch odpowiedziach naraz wygrywa pierwsza (null = już zajęty).
    async claimTicketIfFree(id, userId) {
      const row = await one(
        `update bot.tickets set claimed_by = $2::text where id = $1::int and claimed_by is null and status = 'open' returning *`,
        [id, userId],
      );
      return row ? mapTicket(row) : null;
    },

    // Czy to kanał jakiegokolwiek ticketu (otwartego albo zamkniętego)?
    async isTicketChannel(channelId) {
      return Boolean(await one('select 1 as hit from bot.tickets where channel_id = $1::text limit 1', [channelId]));
    },

    async openTicketsForUser(userId) {
      return (await query(`select * from bot.tickets where user_id = $1::text and status = 'open' order by id`, [userId])).map(mapTicket);
    },

    async listTickets({ limit = 50 } = {}) {
      return (await query('select * from bot.tickets order by id desc limit $1::int', [limit])).map(mapTicket);
    },

    // closed_at ustawia się samo przy zmianie statusu na "closed".
    async updateTicket(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => TICKET_COLUMNS[key]);
      if (!entries.length) return store.getTicket(id);
      const sets = entries.map(([key], i) => `${TICKET_COLUMNS[key]} = $${i + 2}::text`);
      if (patch.status === 'closed') sets.push('closed_at = now()');
      const row = await one(`update bot.tickets set ${sets.join(', ')} where id = $1::int returning *`, [id, ...entries.map(([, v]) => v)]);
      return row ? mapTicket(row) : null;
    },

    async deleteTicket(id) {
      await query('delete from bot.tickets where id = $1::int', [id]);
    },

    // ---------- Wiadomości wysłane z panelu ----------
    async addSentMessage({ channelId, messageId, data }) {
      const row = await one(
        'insert into bot.sent_messages (channel_id, message_id, data) values ($1::text, $2::text, $3::text::jsonb) returning *',
        [channelId, messageId, JSON.stringify(data)],
      );
      return mapSentMessage(row);
    },

    async listSentMessages() {
      return (await query('select * from bot.sent_messages order by id desc limit 100')).map(mapSentMessage);
    },

    async getSentMessage(id) {
      const row = await one('select * from bot.sent_messages where id = $1::int', [id]);
      return row ? mapSentMessage(row) : null;
    },

    async updateSentMessage(id, data) {
      const row = await one(
        'update bot.sent_messages set data = $2::text::jsonb, updated_at = now() where id = $1::int returning *',
        [id, JSON.stringify(data)],
      );
      return row ? mapSentMessage(row) : null;
    },

    async deleteSentMessage(id) {
      await query('delete from bot.sent_messages where id = $1::int', [id]);
    },

    // ---------- Pamięć wiadomości (logi usunięć/edycji, /snipe) ----------
    async cacheMessage({ id, channelId, authorId, authorTag, authorAvatar, content, attachments, createdAt }) {
      await query(
        `insert into bot.message_cache (id, channel_id, author_id, author_tag, author_avatar, content, attachments, created_at)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text::jsonb, coalesce($8::timestamptz, now()))
         on conflict (id) do nothing`,
        [id, channelId, authorId, authorTag ?? null, authorAvatar ?? null, content ?? '', JSON.stringify(attachments ?? []), createdAt ? new Date(createdAt).toISOString() : null],
      );
    },

    // Zapisuje nową treść i zwraca wiadomość sprzed edycji (null, jeśli jej nie znamy).
    async editCachedMessage(id, content) {
      const row = await one(
        `with prev as (select * from bot.message_cache where id = $1::text)
         update bot.message_cache m set content = $2::text, edited_at = now() from prev where m.id = prev.id
         returning prev.*`,
        [id, content ?? ''],
      );
      return row ? mapCachedMessage(row) : null;
    },

    async deleteCachedMessages(ids) {
      if (!ids.length) return [];
      const rows = await query(
        `update bot.message_cache set deleted_at = now()
         where id in (select jsonb_array_elements_text($1::text::jsonb)) and deleted_at is null returning *`,
        [JSON.stringify(ids)],
      );
      return rows.map(mapCachedMessage).sort((a, b) => a.createdAt - b.createdAt);
    },

    async lastDeletedMessages(channelId, { limit = 10, withinMinutes = 120 } = {}) {
      const rows = await query(
        `select * from bot.message_cache where channel_id = $1::text and deleted_at > now() - make_interval(mins => $3::int)
         order by deleted_at desc limit $2::int`,
        [channelId, limit, withinMinutes],
      );
      return rows.map(mapCachedMessage);
    },

    async lastEditedMessages(channelId, { limit = 10, withinMinutes = 120 } = {}) {
      const rows = await query(
        `select * from bot.message_cache where channel_id = $1::text and edited_at > now() - make_interval(mins => $3::int)
         order by edited_at desc limit $2::int`,
        [channelId, limit, withinMinutes],
      );
      return rows.map(mapCachedMessage);
    },

    async pruneMessageCache(days = 7) {
      await query('delete from bot.message_cache where created_at < now() - make_interval(days => $1::int)', [days]);
    },

    // ---------- Profile (zdjęcie i nazwa) do logów zmian ----------
    // Zapisuje nową wersję i zwraca poprzednią (null, jeśli tej osoby jeszcze nie znaliśmy).
    async swapMemberProfile(userId, next) {
      const prev = await one('select * from bot.member_profiles where user_id = $1::text', [userId]);
      const mapped = prev ? { avatar: prev.avatar, guildAvatar: prev.guild_avatar, username: prev.username, globalName: prev.global_name } : null;
      const same = mapped && ['avatar', 'guildAvatar', 'username', 'globalName'].every((k) => (mapped[k] ?? null) === (next[k] ?? null));
      if (!same) {
        await query(
          `insert into bot.member_profiles (user_id, avatar, guild_avatar, username, global_name, updated_at)
           values ($1::text, $2::text, $3::text, $4::text, $5::text, now())
           on conflict (user_id) do update set avatar = excluded.avatar, guild_avatar = excluded.guild_avatar,
             username = excluded.username, global_name = excluded.global_name, updated_at = now()`,
          [userId, next.avatar ?? null, next.guildAvatar ?? null, next.username ?? null, next.globalName ?? null],
        );
      }
      return mapped;
    },

    // Tylko osoby, których jeszcze nie znamy — istniejących nie nadpisujemy (zmianę wykryje GUILD_MEMBER_UPDATE).
    async seedMemberProfiles(list) {
      if (!list.length) return 0;
      const rows = await query(
        `insert into bot.member_profiles (user_id, avatar, guild_avatar, username, global_name)
         select p->>'userId', p->>'avatar', p->>'guildAvatar', p->>'username', p->>'globalName' from jsonb_array_elements($1::text::jsonb) p
         on conflict (user_id) do nothing returning user_id`,
        [JSON.stringify(list)],
      );
      return rows.length;
    },

    // ---------- Zaproszenia (kto kogo zaprosił) ----------
    async addInviteJoin({ userId, inviterId, code }) {
      await query('insert into bot.invite_joins (user_id, inviter_id, code) values ($1::text, $2::text, $3::text)', [userId, inviterId ?? null, code ?? null]);
    },

    async inviteJoinFor(userId) {
      const row = await one('select * from bot.invite_joins where user_id = $1::text order by joined_at desc limit 1', [userId]);
      return row ? { userId: row.user_id, inviterId: row.inviter_id, code: row.code, joinedAt: ms(row.joined_at) } : null;
    },

    // Ile różnych osób weszło z zaproszeń tej osoby.
    async inviteCount(inviterId) {
      return (await one('select count(distinct user_id)::int as n from bot.invite_joins where inviter_id = $1::text', [inviterId]))?.n ?? 0;
    },

    async invitedBy(inviterId, limit = 10) {
      const rows = await query(
        `select distinct on (user_id) user_id, code, joined_at from bot.invite_joins where inviter_id = $1::text
         order by user_id, joined_at desc`,
        [inviterId],
      );
      return rows
        .map((r) => ({ userId: r.user_id, code: r.code, joinedAt: ms(r.joined_at) }))
        .sort((a, b) => b.joinedAt - a.joinedAt)
        .slice(0, limit);
    },

    async inviteRanking(limit = 10) {
      const rows = await query(
        `select inviter_id, count(distinct user_id)::int as n from bot.invite_joins where inviter_id is not null
         group by inviter_id order by n desc, max(joined_at) desc limit $1::int`,
        [limit],
      );
      return rows.map((r) => ({ inviterId: r.inviter_id, count: r.n }));
    },

    // Wyjście z serwera — jej zaproszenie przestaje się liczyć w eventach.
    async markInviteLeft(userId) {
      await query('update bot.invite_joins set left_at = now() where user_id = $1::text and left_at is null', [userId]);
    },

    // ---------- Eventy ----------
    // Zapisani do eventu z postępem. Zaproszenia (invites = true) liczą się od chwili zapisu (najwcześniej od startu)
    // do końca: osoby, które weszły z zaproszenia tej osoby, nadal są na serwerze, nie były tu wcześniej (wcześniejsze
    // wejście albo profil sprzed wejścia) i w chwili wejścia miały konto starsze niż minAccountMs. Wiadomości —
    // licznik z contest_scores (store.awardXp liczy je tylko zapisanym).
    async contestProgress(contestId, { start, end, invites = false, minAccountMs = 0 }) {
      const rows = await query(
        `select e.*, l.user_tag as l_tag, l.display_name as l_name, l.avatar as l_avatar, l.guild_avatar as l_guild_avatar,
                coalesce(l.hidden, false) as hidden, coalesce(s.messages, 0) as progress_messages,
                case when $4::boolean then (
                  select count(distinct j.user_id)::int from bot.invite_joins j
                  where j.inviter_id = e.user_id and j.user_id <> e.user_id
                    and j.joined_at >= greatest($2::timestamptz, e.created_at) and j.joined_at < $3::timestamptz
                    and j.left_at is null
                    and (case when j.user_id ~ '^[0-9]{15,19}$' then (j.user_id::bigint >> 22) + 1420070400000 else 0 end)
                        <= (extract(epoch from j.joined_at) * 1000)::bigint - $5::bigint
                    and not exists (select 1 from bot.invite_joins p where p.user_id = j.user_id and p.joined_at < j.joined_at)
                    and not exists (select 1 from bot.member_profiles m where m.user_id = j.user_id and m.updated_at < j.joined_at - interval '1 minute')
                ) else 0 end as progress_invites
         from bot.contest_entries e
         left join bot.levels l on l.user_id = e.user_id
         left join bot.contest_scores s on s.contest_id = e.contest_id and s.user_id = e.user_id
         where e.contest_id = $1::text order by e.created_at, e.user_id`,
        [contestId, new Date(start).toISOString(), new Date(end).toISOString(), invites, Math.max(0, Math.floor(minAccountMs))],
      );
      return rows.map((r) => ({ ...mapContestEntry(r), invites: Number(r.progress_invites ?? 0), messages: Number(r.progress_messages ?? 0) }));
    },

    // Osoby, które właśnie spełniły warunek → znacznik (tylko raz). Zwraca ID oznaczonych teraz.
    async markContestQualified(contestId, userIds) {
      if (!userIds?.length) return [];
      const rows = await query(
        `update bot.contest_entries set qualified_at = now()
         where contest_id = $1::text and qualified_at is null and user_id in (select jsonb_array_elements_text($2::text::jsonb))
         returning user_id`,
        [contestId, JSON.stringify(userIds)],
      );
      return rows.map((r) => r.user_id);
    },

    // Uczestnicy eventu (od najwcześniej zapisanych) — nazwa i avatar z rankingu poziomów, jeśli są świeższe.
    async contestEntries(contestId) {
      const rows = await query(
        `select e.*, l.user_tag as l_tag, l.display_name as l_name, l.avatar as l_avatar, l.guild_avatar as l_guild_avatar,
                coalesce(l.hidden, false) as hidden
         from bot.contest_entries e left join bot.levels l on l.user_id = e.user_id
         where e.contest_id = $1::text order by e.created_at, e.user_id`,
        [contestId],
      );
      return rows.map(mapContestEntry);
    },

    // Zapis do eventu; null = ta osoba już jest zapisana.
    async addContestEntry({ contestId, userId, userTag = null, displayName = null, avatar = null, score = 0 }) {
      const row = await one(
        `insert into bot.contest_entries (contest_id, user_id, user_tag, display_name, avatar, score)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::int)
         on conflict (contest_id, user_id) do nothing returning *`,
        [contestId, userId, userTag, displayName, avatar, Math.max(0, Math.floor(score))],
      );
      return row ? mapContestEntry(row) : null;
    },

    // Losowanie: nowi zwycięzcy zastępują poprzednich. Zwraca ID oznaczonych.
    async setContestWinners(contestId, userIds) {
      await query('update bot.contest_entries set won_at = null where contest_id = $1::text and won_at is not null', [contestId]);
      if (!userIds?.length) return [];
      const rows = await query(
        `update bot.contest_entries set won_at = now()
         where contest_id = $1::text and user_id in (select jsonb_array_elements_text($2::text::jsonb)) returning user_id`,
        [contestId, JSON.stringify(userIds)],
      );
      return rows.map((r) => r.user_id);
    },

    // Usunięcie z eventu kasuje też policzone wiadomości — po ponownym zapisie postęp liczy się od nowa.
    async removeContestEntry(contestId, userId) {
      const rows = await query('delete from bot.contest_entries where contest_id = $1::text and user_id = $2::text returning user_id', [contestId, userId]);
      await query('delete from bot.contest_scores where contest_id = $1::text and user_id = $2::text', [contestId, userId]);
      return rows.length > 0;
    },

    // Wyniki i zapisy eventów, których nie ma już w konfiguracji (po 30 dniach — usunięcie można cofnąć w dzienniku).
    async pruneContestData(keepIds) {
      const keep = JSON.stringify(keepIds ?? []);
      await query(
        `delete from bot.contest_scores where updated_at < now() - interval '30 days'
           and contest_id not in (select jsonb_array_elements_text($1::text::jsonb))`,
        [keep],
      );
      await query(
        `delete from bot.contest_entries where created_at < now() - interval '30 days'
           and contest_id not in (select jsonb_array_elements_text($1::text::jsonb))`,
        [keep],
      );
    },

    // ---------- Konta połączone ze stroną (/polacz) ----------
    async addMemberLink({ kind, tokenHash, userId, userTag = null, displayName = null, avatar = null, ttlMs }) {
      const row = await one(
        `insert into bot.member_links (kind, token_hash, user_id, user_tag, display_name, avatar, expires_at)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, now() + make_interval(secs => $7::double precision))
         returning *`,
        [kind, tokenHash, userId, userTag, displayName, avatar, ttlMs / 1000],
      );
      return mapMemberLink(row);
    },

    // Jednorazowy link z /polacz: znika przy pierwszym użyciu (także wygasły). null = nie ma takiego.
    async takeMemberLink(tokenHash) {
      const row = await one("delete from bot.member_links where token_hash = $1::text and kind = 'link' returning *", [tokenHash]);
      return row ? mapMemberLink(row) : null;
    },

    async getMemberSession(tokenHash) {
      const row = await one("select * from bot.member_links where token_hash = $1::text and kind = 'session' and expires_at > now()", [tokenHash]);
      return row ? mapMemberLink(row) : null;
    },

    async touchMemberSession(id) {
      await query('update bot.member_links set last_seen_at = now() where id = $1::int', [id]);
    },

    async deleteMemberLinks({ userId = null, kind = null, tokenHash = null }) {
      if (!userId && !tokenHash) return 0;
      const rows = await query(
        `delete from bot.member_links where ($1::text is null or user_id = $1::text) and ($2::text is null or kind = $2::text)
           and ($3::text is null or token_hash = $3::text) returning id`,
        [userId, kind, tokenHash],
      );
      return rows.length;
    },

    async pruneMemberLinks() {
      await query('delete from bot.member_links where expires_at < now()');
    },

    // ---------- Bumpy ----------
    async addBump({ userId, channelId, messageId }) {
      const row = await one(
        `insert into bot.bumps (user_id, channel_id, message_id) values ($1::text, $2::text, $3::text)
         on conflict (message_id) do nothing returning *`,
        [userId, channelId, messageId],
      );
      return row ? { id: row.id, userId: row.user_id, createdAt: ms(row.created_at) } : null;
    },

    async bumpRanking({ limit = 10, days = null } = {}) {
      const rows = await query(
        `select user_id, count(*)::int as n, max(created_at) as last_at from bot.bumps
         where $2::int is null or created_at > now() - make_interval(days => $2::int)
         group by user_id order by n desc, last_at desc limit $1::int`,
        [limit, days],
      );
      return rows.map((r) => ({ userId: r.user_id, count: r.n, lastAt: ms(r.last_at) }));
    },

    async bumpCount(userId) {
      return (await one('select count(*)::int as n from bot.bumps where user_id = $1::text', [userId]))?.n ?? 0;
    },

    // ---------- Przypomnienia ----------
    async addReminder({ userId, channelId, text, dueAt }) {
      const row = await one(
        `insert into bot.reminders (user_id, channel_id, text, due_at) values ($1::text, $2::text, $3::text, $4::timestamptz) returning *`,
        [userId, channelId, text, new Date(dueAt).toISOString()],
      );
      return mapReminder(row);
    },

    async listReminders(userId) {
      return (await query('select * from bot.reminders where user_id = $1::text order by due_at', [userId])).map(mapReminder);
    },

    async removeReminder(id, userId) {
      const row = await one('delete from bot.reminders where id = $1::int and user_id = $2::text returning *', [id, userId]);
      return row ? mapReminder(row) : null;
    },

    // Zabiera (usuwa) przypomnienia, których czas minął — każde wysyłamy tylko raz.
    async takeDueReminders(limit = 20) {
      const rows = await query(
        `delete from bot.reminders where id in (select id from bot.reminders where due_at <= now() order by due_at limit $1::int) returning *`,
        [limit],
      );
      return rows.map(mapReminder);
    },

    // ---------- Konkursy ----------
    async addGiveaway({ channelId, prize, winners, hostId, requiredRoleId, endsAt }) {
      const row = await one(
        `insert into bot.giveaways (channel_id, prize, winners, host_id, required_role_id, ends_at)
         values ($1::text, $2::text, $3::int, $4::text, $5::text, $6::timestamptz) returning *`,
        [channelId, prize, winners, hostId, requiredRoleId || null, new Date(endsAt).toISOString()],
      );
      return mapGiveaway(row);
    },

    async setGiveawayMessage(id, messageId) {
      await query('update bot.giveaways set message_id = $2::text where id = $1::int', [id, messageId]);
    },

    async getGiveaway(id) {
      const row = await one('select * from bot.giveaways where id = $1::int', [id]);
      return row ? mapGiveaway(row) : null;
    },

    async getGiveawayByMessage(messageId) {
      const row = await one('select * from bot.giveaways where message_id = $1::text', [messageId]);
      return row ? mapGiveaway(row) : null;
    },

    async listGiveaways({ limit = 25 } = {}) {
      return (await query('select * from bot.giveaways order by id desc limit $1::int', [limit])).map(mapGiveaway);
    },

    // Dopisuje albo wypisuje osobę (jednym zapytaniem, więc równoczesne kliknięcia się nie gubią).
    async toggleGiveawayEntry(id, userId) {
      const row = await one(
        `update bot.giveaways set entrants = case
           when entrants @> jsonb_build_array($2::text) then entrants - $2::text
           else entrants || jsonb_build_array($2::text) end
         where id = $1::int and not ended returning *`,
        [id, userId],
      );
      return row ? mapGiveaway(row) : null;
    },

    async dueGiveaways() {
      return (await query('select * from bot.giveaways where not ended and ends_at <= now() order by ends_at')).map(mapGiveaway);
    },

    async finishGiveaway(id, winnerIds) {
      const row = await one(
        'update bot.giveaways set ended = true, winner_ids = $2::text::jsonb, ends_at = least(ends_at, now()) where id = $1::int returning *',
        [id, JSON.stringify(winnerIds)],
      );
      return row ? mapGiveaway(row) : null;
    },

    async deleteGiveaway(id) {
      await query('delete from bot.giveaways where id = $1::int', [id]);
    },

    // ---------- AFK ----------
    async setAfk(userId, reason) {
      await query(
        `insert into bot.afk (user_id, reason, since) values ($1::text, $2::text, now())
         on conflict (user_id) do update set reason = excluded.reason, since = now()`,
        [userId, reason ?? ''],
      );
    },

    async removeAfk(userId) {
      const row = await one('delete from bot.afk where user_id = $1::text returning *', [userId]);
      return row ? { userId: row.user_id, reason: row.reason, since: ms(row.since) } : null;
    },

    async listAfk() {
      return (await query('select * from bot.afk')).map((r) => ({ userId: r.user_id, reason: r.reason, since: ms(r.since) }));
    },

    // ---------- Logowanie do panelu (loginy z /login i sesje przeglądarki) ----------
    // ttlMs — ważność od teraz, expiresAt — konkretna chwila (sesja kończy się razem ze swoim loginem).
    async addPanelLogin({ kind, login = null, loginId = null, tokenHash, userId, userTag, roles = [], admin = false, ttlMs, expiresAt }) {
      const row = await one(
        `insert into bot.panel_sessions (kind, login, login_id, token_hash, user_id, user_tag, roles, admin, expires_at)
         values ($1::text, $2::text, $3::int, $4::text, $5::text, $6::text, $7::text::jsonb, $8::boolean,
                 coalesce($9::timestamptz, now() + make_interval(secs => $10::double precision)))
         returning *`,
        [kind, login, loginId, tokenHash, userId, userTag ?? null, JSON.stringify(roles), admin, expiresAt ? new Date(expiresAt).toISOString() : null, (ttlMs ?? 0) / 1000],
      );
      return mapPanelSession(row);
    },

    // Aktywny login o tej nazwie — razem ze skrótem hasła (do sprawdzenia przy logowaniu).
    async findPanelLogin(login) {
      const row = await one(`select * from bot.panel_sessions where kind = 'login' and login = $1::text and expires_at > now()`, [login]);
      return row ? { ...mapPanelSession(row), tokenHash: row.token_hash } : null;
    },

    async getPanelLoginForUser(userId) {
      const row = await one(
        `select * from bot.panel_sessions where kind = 'login' and user_id = $1::text and expires_at > now() order by id desc limit 1`,
        [userId],
      );
      return row ? mapPanelSession(row) : null;
    },

    // Wygasły login o tej nazwie (jeszcze nie sprzątnięty przez crona) nie blokuje nowego.
    async freePanelLoginName(login) {
      await query(`delete from bot.panel_sessions where kind = 'login' and login = $1::text and expires_at <= now()`, [login]);
    },

    async getPanelSession(tokenHash) {
      const row = await one(`select * from bot.panel_sessions where kind = 'session' and token_hash = $1::text and expires_at > now()`, [tokenHash]);
      return row ? mapPanelSession(row) : null;
    },

    // Odświeżone role (checked = sprawdzone teraz w Discordzie) i/lub ostatnia aktywność.
    async touchPanelSession(id, { roles, admin, checked = false } = {}) {
      const row = await one(
        `update bot.panel_sessions set last_seen_at = now(),
           roles = coalesce($2::text::jsonb, roles),
           admin = coalesce($3::boolean, admin),
           checked_at = case when $4::boolean then now() else checked_at end
         where id = $1::int returning *`,
        [id, roles ? JSON.stringify(roles) : null, admin ?? null, checked],
      );
      return row ? mapPanelSession(row) : null;
    },

    // Aktywne loginy z liczbą zalogowanych przeglądarek i ostatnią aktywnością.
    async listPanelLogins() {
      const rows = await query(
        `select l.*,
           (select count(*)::int from bot.panel_sessions s where s.login_id = l.id and s.expires_at > now()) as sessions,
           (select max(s.last_seen_at) from bot.panel_sessions s where s.login_id = l.id) as session_seen_at
         from bot.panel_sessions l
         where l.kind = 'login' and l.expires_at > now()
         order by l.created_at desc limit 100`,
      );
      return rows.map((r) => ({ ...mapPanelSession(r), sessions: r.sessions, lastSeenAt: ms(r.session_seen_at) }));
    },

    // { id } — jeden wpis, { userId, kind } — np. login tej osoby, {} — wszystko. Usunięcie loginu kończy też
    // jego sesje (kaskada w bazie).
    async deletePanelLogins({ id, userId, kind } = {}) {
      const rows = await query(
        `delete from bot.panel_sessions
         where ($1::int is null or id = $1::int) and ($2::text is null or user_id = $2::text) and ($3::text is null or kind = $3::text)
         returning id`,
        [id ?? null, userId ?? null, kind ?? null],
      );
      return rows.length;
    },

    async prunePanelSessions() {
      await query('delete from bot.panel_sessions where expires_at < now()');
    },

    // ---------- Poziomy ----------
    // XP z cooldownem danego rodzaju (wiadomość / głosowe / reakcja) — atomowo: przy cooldownie nic się nie
    // zmienia i wynik to null. Zwraca nowe łączne XP i POPRZEDNI poziom (kolumna level zmienia się osobno).
    // XP z cooldownem danego rodzaju. dailyCap > 0 — najwyżej tyle XP na dobę (dayKey, czas polski), reszta przepada;
    // textHash — skrót wiadomości: ta sama wiadomość co ostatnio nagrodzona nie daje XP (null = bez sprawdzania).
    // Zwraca null (cooldown / powtórka) albo { xp, level, granted }. Dzienne sumy trafiają do bot.level_daily.
    async awardXp({ userId, userTag, displayName = null, avatar, amount, kind, cooldownSec, minutes = 0, weekKey, monthKey, dayKey, dailyCap = 0, textHash = null, eventId = null, contestIds = [] }) {
      const k = XP_KINDS[kind];
      const counter = kind === 'voice' ? minutes : 1;
      const day = dayKey ?? new Date().toISOString().slice(0, 10);
      const row = await one(
        `with today as (
           select coalesce((select d.xp from bot.level_daily d where d.user_id = $1::text and d.day = $10::date), 0) as xp
         ),
         given as (
           select case when $11::bigint > 0 then greatest(0, least($4::bigint, $11::bigint - today.xp)) else $4::bigint end as xp from today
         ),
         up as (
           insert into bot.levels as l (user_id, user_tag, display_name, avatar, xp, ${k.counter}, ${k.last}, week_key, week_xp, month_key, month_xp, last_text_hash, updated_at)
           values ($1::text, $2::text, $9::text, $3::text, (select xp from given), $8::int, now(), $5::text, (select xp from given), $6::text, (select xp from given), $12::text, now())
           on conflict (user_id) do update set
             xp = l.xp + excluded.xp,
             ${k.counter} = l.${k.counter} + excluded.${k.counter},
             ${k.last} = now(),
             user_tag = coalesce(excluded.user_tag, l.user_tag),
             display_name = coalesce(excluded.display_name, l.display_name),
             avatar = coalesce(excluded.avatar, l.avatar),
             week_xp = case when l.week_key = excluded.week_key then l.week_xp + excluded.xp else excluded.xp end,
             week_key = excluded.week_key,
             month_xp = case when l.month_key = excluded.month_key then l.month_xp + excluded.xp else excluded.xp end,
             month_key = excluded.month_key,
             last_text_hash = coalesce(excluded.last_text_hash, l.last_text_hash),
             updated_at = now()
           where (l.${k.last} is null or l.${k.last} <= now() - make_interval(secs => $7::double precision))
             and ($12::text is null or l.last_text_hash is distinct from $12::text)
           returning l.xp, l.level
         ),
         daily as (
           insert into bot.level_daily as d (user_id, day, xp, ${DAILY_COUNTERS[kind]})
           select $1::text, $10::date, (select xp from given), $8::int where exists (select 1 from up)
           on conflict (user_id, day) do update set
             xp = d.xp + excluded.xp,
             ${DAILY_COUNTERS[kind]} = d.${DAILY_COUNTERS[kind]} + excluded.${DAILY_COUNTERS[kind]}
         ),
         ev as (
           insert into bot.level_event_xp as e (event_id, user_id, xp)
           select $13::text, $1::text, (select xp from given)
           where $13::text is not null and (select xp from given) > 0 and exists (select 1 from up)
           on conflict (event_id, user_id) do update set xp = e.xp + excluded.xp
         ),
         -- Trwające eventy z warunkiem wiadomości (contests.js): policzona wiadomość zapisanej osoby = +1.
         contest as (
           insert into bot.contest_scores as s (contest_id, user_id, messages)
           select e.contest_id, $1::text, 1 from bot.contest_entries e
           where e.user_id = $1::text and e.contest_id in (select jsonb_array_elements_text(coalesce($14::text, '[]')::jsonb))
             and exists (select 1 from up)
           on conflict (contest_id, user_id) do update set messages = s.messages + 1, updated_at = now()
         )
         select up.xp, up.level, (select xp from given) as granted from up`,
        [userId, userTag ?? null, avatar ?? null, amount, weekKey, monthKey, cooldownSec, counter, displayName ?? null, day, dailyCap, textHash, eventId, contestIds?.length ? JSON.stringify(contestIds) : null],
      );
      return row ? { xp: Number(row.xp), level: row.level, granted: Number(row.granted) } : null;
    },

    // Dzienne XP osoby (wykres na stronie rankingu) od dnia `since` (YYYY-MM-DD), od najstarszego.
    async levelDaily(userId, { since }) {
      const rows = await query(
        `select to_char(day, 'YYYY-MM-DD') as day, xp, messages, voice_minutes, reactions from bot.level_daily
         where user_id = $1::text and day >= $2::date order by day`,
        [userId, since],
      );
      return rows.map((r) => ({ day: r.day, xp: Number(r.xp), messages: r.messages, voiceMinutes: r.voice_minutes, reactions: r.reactions }));
    },

    // ---------- Archiwum zwycięzców ----------
    // rows = wynik levelPeriodTop (kolejność = miejsca). Zapis raz na okres.
    async archiveWinners(period, key, rows) {
      if (!rows.length) return 0;
      const data = rows.map((r, i) => ({ rank: i + 1, user_id: r.userId, xp: r.periodXp }));
      const out = await query(
        `insert into bot.level_winners (period, key, rank, user_id, xp)
         select $1::text, $2::text, (x->>'rank')::int, x->>'user_id', (x->>'xp')::bigint from jsonb_array_elements($3::text::jsonb) x
         on conflict (period, key, rank) do nothing returning rank`,
        [period, key, JSON.stringify(data)],
      );
      return out.length;
    },

    // Ostatnie `periods` okresów, w każdym `top` osób: [{ key, winners: [{ rank, xp, userId, … }] }].
    async listWinners({ period, periods = 12, top = 3 }) {
      const rows = await query(
        `select w.key, w.rank, w.xp, w.user_id, l.user_tag, l.display_name, l.avatar, l.guild_avatar, coalesce(l.hidden, false) as hidden
         from bot.level_winners w left join bot.levels l on l.user_id = w.user_id
         where w.period = $1::text and w.rank <= $3::int
           and w.key in (select k.key from (select distinct key from bot.level_winners where period = $1::text) k order by k.key desc limit $2::int)
         order by w.key desc, w.rank`,
        [period, periods, top],
      );
      const out = [];
      for (const r of rows) {
        if (out.at(-1)?.key !== r.key) out.push({ key: r.key, winners: [] });
        out.at(-1).winners.push(mapWinner(r));
      }
      return out;
    },

    // Najlepsze osoby zakończonych wydarzeń XP: [{ eventId, rank, xp, userId, … }].
    async eventWinners(eventIds, top = 3) {
      if (!eventIds.length) return [];
      const rows = await query(
        `select * from (
           select e.event_id, e.user_id, e.xp, row_number() over (partition by e.event_id order by e.xp desc, e.user_id) as rank,
                  l.user_tag, l.display_name, l.avatar, l.guild_avatar, coalesce(l.hidden, false) as hidden
           from bot.level_event_xp e left join bot.levels l on l.user_id = e.user_id
           where e.event_id in (select jsonb_array_elements_text($1::text::jsonb)) and e.xp > 0
         ) r where r.rank <= $2::int order by r.event_id, r.rank`,
        [JSON.stringify(eventIds), top],
      );
      return rows.map((r) => ({ eventId: r.event_id, ...mapWinner(r) }));
    },

    // ---------- Wydarzenia XP ----------
    // Najwięcej XP w czasie wydarzenia (periodXp = XP z wydarzenia, już z mnożnikiem).
    async levelEventTop({ eventId, limit = 10, offset = 0, search = '', publicOnly = false }) {
      const rows = await query(
        `select * from (
           select l.*, e.xp as period_xp, rank() over (order by e.xp desc) as period_rank
           from bot.level_event_xp e join bot.levels l on l.user_id = e.user_id
           where e.event_id = $1::text and e.xp > 0
         ) r
         where ${levelSearch(4, 'r.', publicOnly)}
         order by r.period_xp desc, r.user_id limit $2::int offset $3::int`,
        [eventId, limit, offset, search],
      );
      return rows.map((r) => ({ ...mapLevel(r), periodXp: Number(r.period_xp), periodRank: Number(r.period_rank) }));
    },

    async countEvent({ eventId, search = '', publicOnly = false }) {
      const row = await one(
        `select count(*)::int as n from bot.level_event_xp e join bot.levels l on l.user_id = e.user_id
         where e.event_id = $1::text and e.xp > 0
           and ${levelSearch(2, 'l.', publicOnly)}`,
        [eventId, search],
      );
      return row.n;
    },

    // XP osoby w wydarzeniu i jej miejsce ({ xp, rank } albo null).
    async eventStanding(eventId, userId) {
      const row = await one(
        `select e.xp, (select count(*)::int + 1 from bot.level_event_xp o where o.event_id = e.event_id and o.xp > e.xp) as rank
         from bot.level_event_xp e where e.event_id = $1::text and e.user_id = $2::text and e.xp > 0`,
        [eventId, userId],
      );
      return row ? { xp: Number(row.xp), rank: row.rank } : null;
    },

    // Ile osób zdobyło XP w wydarzeniu i ile łącznie.
    async eventSummary(eventId) {
      const row = await one(
        'select count(*)::int as people, coalesce(sum(xp), 0)::bigint as xp from bot.level_event_xp where event_id = $1::text and xp > 0',
        [eventId],
      );
      return { people: row.people, xp: Number(row.xp) };
    },

    // Usuwa XP wydarzeń, których nie ma już w ustawieniach.
    async pruneEventXp(keepIds) {
      await query('delete from bot.level_event_xp where event_id not in (select jsonb_array_elements_text($1::text::jsonb))', [JSON.stringify(keepIds)]);
    },

    async pruneLevelDaily(days = 400) {
      await query('delete from bot.level_daily where day < current_date - $1::int', [days]);
    },

    async setLevel(userId, level) {
      await query('update bot.levels set level = $2::int where user_id = $1::text', [userId, level]);
    },

    // Ręczna zmiana (/xp, panel) — nie liczy się do rankingów tygodnia i miesiąca.
    async setXp({ userId, xp, userTag = null, avatar = null }) {
      const row = await one(
        `insert into bot.levels as l (user_id, user_tag, avatar, xp) values ($1::text, $3::text, $4::text, $2::bigint)
         on conflict (user_id) do update set xp = excluded.xp, user_tag = coalesce(excluded.user_tag, l.user_tag),
           avatar = coalesce(excluded.avatar, l.avatar), updated_at = now()
         returning xp, level`,
        [userId, xp, userTag, avatar],
      );
      return { xp: Number(row.xp), level: row.level };
    },

    // Import (np. z Arcane): większe XP zostaje, statystyki — większe z dwóch.
    async importLevel({ userId, userTag, displayName = null, avatar, xp, messages = 0, reactions = 0 }) {
      const row = await one(
        `insert into bot.levels as l (user_id, user_tag, avatar, xp, messages, reactions, display_name) values ($1::text, $2::text, $3::text, $4::bigint, $5::int, $6::int, $7::text)
         on conflict (user_id) do update set xp = greatest(l.xp, excluded.xp), messages = greatest(l.messages, excluded.messages),
           reactions = greatest(l.reactions, excluded.reactions), user_tag = coalesce(excluded.user_tag, l.user_tag),
           display_name = coalesce(excluded.display_name, l.display_name),
           avatar = coalesce(excluded.avatar, l.avatar), updated_at = now()
         returning xp, level`,
        [userId, userTag ?? null, avatar ?? null, xp, messages, reactions, displayName ?? null],
      );
      return { xp: Number(row.xp), level: row.level };
    },

    // Ukrycie (albo pokazanie) osoby na publicznej stronie rankingu — także zanim zdobędzie XP.
    async setLevelHidden(userId, hidden) {
      await query(
        `insert into bot.levels (user_id, hidden) values ($1::text, $2::boolean)
         on conflict (user_id) do update set hidden = excluded.hidden`,
        [userId, hidden],
      );
    },

    async getLevel(userId) {
      const row = await one(
        `select l.*, (select count(*)::int + 1 from bot.levels o where o.xp > l.xp) as rank from bot.levels l where l.user_id = $1::text`,
        [userId],
      );
      return row ? mapLevel(row) : null;
    },

    // sort: xp (domyślnie), messages albo voice — miejsca liczone według wybranej kolejności.
    async levelLeaderboard({ limit = 10, offset = 0, search = '', publicOnly = false, sort = 'xp' } = {}) {
      const col = { messages: 'messages', voice: 'voice_minutes' }[sort] ?? 'xp';
      const rows = await query(
        `select * from (select l.*, rank() over (order by l.${col} desc) as rank from bot.levels l where l.xp > 0) r
         where ${levelSearch(3, 'r.', publicOnly)}
         order by r.${col} desc, r.xp desc, r.user_id limit $1::int offset $2::int`,
        [limit, offset, search],
      );
      return rows.map(mapLevel);
    },

    async countLevels(search = '', { publicOnly = false } = {}) {
      const row = await one(
        `select count(*)::int as n from bot.levels where xp > 0
           and ${levelSearch(1, '', publicOnly)}`,
        [search],
      );
      return row.n;
    },

    // Najwięcej XP w tygodniu (period 'week', klucz = data niedzieli) albo miesiącu ('month', klucz RRRR-MM).
    async levelPeriodTop({ period, key, limit = 10, offset = 0, search = '', publicOnly = false }) {
      const [keyCol, xpCol] = period === 'week' ? ['week_key', 'week_xp'] : ['month_key', 'month_xp'];
      const rows = await query(
        `select * from (
           select l.*, l.${xpCol} as period_xp, rank() over (order by l.${xpCol} desc) as period_rank
           from bot.levels l where l.${keyCol} = $1::text and l.${xpCol} > 0
         ) r
         where ${levelSearch(4, 'r.', publicOnly)}
         order by r.period_xp desc, r.user_id limit $2::int offset $3::int`,
        [key, limit, offset, search],
      );
      return rows.map((r) => ({ ...mapLevel(r), periodXp: Number(r.period_xp), periodRank: Number(r.period_rank) }));
    },

    // Ile razy osoba wygrała tydzień/miesiąc (1. miejsce) i ile razy była na podium (1–3) — odznaki.
    async levelWins(userId) {
      const rows = await query(
        `select period, count(*) filter (where rank = 1)::int as wins, count(*)::int as podium
         from bot.level_winners where user_id = $1::text and rank <= 3 group by period`,
        [userId],
      );
      const out = { week: 0, month: 0, weekPodium: 0, monthPodium: 0 };
      for (const r of rows) {
        out[r.period] = Number(r.wins);
        out[`${r.period}Podium`] = Number(r.podium);
      }
      return out;
    },

    async periodRank({ period, key, xp }) {
      const [keyCol, xpCol] = period === 'week' ? ['week_key', 'week_xp'] : ['month_key', 'month_xp'];
      const row = await one(`select count(*)::int + 1 as n from bot.levels where ${keyCol} = $1::text and ${xpCol} > $2::bigint`, [key, xp]);
      return row.n;
    },

    async countPeriod({ period, key, search = '', publicOnly = false }) {
      const [keyCol, xpCol] = period === 'week' ? ['week_key', 'week_xp'] : ['month_key', 'month_xp'];
      const row = await one(
        `select count(*)::int as n from bot.levels where ${keyCol} = $1::text and ${xpCol} > 0
           and ${levelSearch(2, '', publicOnly)}`,
        [key, search],
      );
      return row.n;
    },

    // Nazwy i avatary z listy członków serwera — tylko dla osób, które już są w rankingu.
    // [{ id, tag, name, avatar }]; name = pseudonim na serwerze albo nazwa wyświetlana (może być null).
    async syncLevelProfiles(members) {
      if (!members.length) return 0;
      const rows = await query(
        `update bot.levels l set user_tag = coalesce(m->>'tag', l.user_tag), display_name = m->>'name', avatar = m->>'avatar', guild_avatar = m->>'guildAvatar'
         from jsonb_array_elements($1::text::jsonb) m
         where l.user_id = m->>'id'
           and (l.user_tag is distinct from coalesce(m->>'tag', l.user_tag) or l.display_name is distinct from m->>'name'
             or l.avatar is distinct from m->>'avatar' or l.guild_avatar is distinct from m->>'guildAvatar')
         returning l.user_id`,
        [JSON.stringify(members)],
      );
      return rows.length;
    },

    // Osoby z rankingu, których kolor akcentu i Nitro nie były sprawdzane od 12 godzin (najpierw nigdy).
    async levelsNeedingLook(limit = 5) {
      const rows = await query(
        `select user_id from bot.levels where xp > 0 and (look_checked_at is null or look_checked_at < now() - interval '12 hours')
         order by look_checked_at nulls first, xp desc limit $1::int`,
        [limit],
      );
      return rows.map((r) => r.user_id);
    },

    // avatar: świeży hash avatara z profilu (undefined = bez zmian).
    async setLevelLook(userId, { accentColor = null, nitro = false, look = null, avatar }) {
      await query(
        `update bot.levels set accent_color = $2::text, nitro = $3::boolean, look = $4::text::jsonb, look_checked_at = now(),
           avatar = case when $5::boolean then $6::text else avatar end
         where user_id = $1::text`,
        [userId, accentColor, Boolean(nitro), look ? JSON.stringify(look) : null, avatar !== undefined, avatar ?? null],
      );
    },

    // Podsumowanie do publicznego rankingu: ile osób ma XP i ile łącznie nazbierały.
    async levelTotals() {
      const row = await one(
        `select count(*) filter (where xp > 0)::int as members, coalesce(sum(xp), 0)::bigint as xp,
           coalesce(sum(messages), 0)::bigint as messages, coalesce(sum(voice_minutes), 0)::bigint as voice_minutes
         from bot.levels`,
        [],
      );
      return { members: row.members, xp: Number(row.xp), messages: Number(row.messages), voiceMinutes: Number(row.voice_minutes) };
    },

    // { userId } — jedna osoba, {} — wszyscy. Zeruje XP, poziom i liczniki okresów; statystyki zostają.
    async resetLevels({ userId } = {}) {
      const rows = await query(
        `update bot.levels set xp = 0, level = 0, week_xp = 0, month_xp = 0, updated_at = now()
         where ($1::text is null or user_id = $1::text) returning user_id`,
        [userId ?? null],
      );
      return rows.length;
    },

    async stats() {
      const row = await one(
        `select (select count(*)::int from bot.cases) as cases,
                (select count(*)::int from bot.warns where ${ACTIVE_WARN}) as active_warns,
                (select count(*)::int from bot.temp_bans) as temp_bans`,
      );
      const byType = await query('select type, count(*)::int as n from bot.cases group by type');
      return {
        cases: row.cases,
        activeWarns: row.active_warns,
        tempBans: row.temp_bans,
        byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      };
    },
  };
  return store;
}
