// Funkcja Edge Supabase: cały bot moderacyjny Entuzjaści Hopkostki.
// Sekrety (Supabase → Edge Functions → Secrets): DISCORD_TOKEN, PANEL_PASSWORD, opcjonalnie GUILD_ID.
// SUPABASE_URL i SUPABASE_DB_URL Supabase ustawia sam.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import postgres from 'npm:postgres@3.4.5';
import { createHandler } from './lib/app.js';
import { createStore } from './lib/store.js';
import { createRest } from './lib/rest.js';

const env = (name: string) => Deno.env.get(name)?.trim() ?? '';

const sql = postgres(env('SUPABASE_DB_URL'), { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 10 });
const token = env('DISCORD_TOKEN');

const bot = {
  env: {
    token,
    guildId: env('GUILD_ID'),
    publicKey: env('DISCORD_PUBLIC_KEY'),
    panelPassword: env('PANEL_PASSWORD'),
    // Region bazy (Frankfurt) - krótsze zapytania do Postgresa, szybsze odpowiedzi na komendy.
    selfUrl: `${env('SUPABASE_URL')}/functions/v1/hopkostki-bot?forceFunctionRegion=eu-central-1`,
  },
  store: createStore((text: string, params?: unknown[]) => sql.unsafe(text, (params ?? []) as never[])),
  discord: token ? createRest(token) : null,
  cache: new Map(),
};

Deno.serve(createHandler(bot, { waitUntil: (promise: Promise<unknown>) => EdgeRuntime.waitUntil(promise) }));
