// Połączenie z gateway Discorda w krótkich sesjach (~55 s co minutę, uruchamianych przez pg_cron).
// Funkcja Edge nie utrzyma stałego WebSocketu, więc każda sesja WZNAWIA poprzednią (RESUME) zamiast
// logować się od nowa (Discord dosyła wtedy zdarzenia z przerwy). Dzięki temu bot ma status "online",
// rotujące opisy, od razu dodaje 🫓 pod odpowiedziami na wiadomości o karach (cron zostaje jako zapas),
// a także obsługuje logi serwera, bumpy DISBOARD, AFK i kanały głosowe na żądanie.

import { reactionPath } from './rest.js';
import { getApp, getGuildContext } from './moderation.js';
import { syncGuildVoiceStates, onVoiceStateUpdate } from './voice.js';
import { membersFeaturesOn, membersIntentOn, contentFeaturesOn, contentIntentOn, onMemberJoin, onMemberLeave, onMemberUpdate } from './members.js';
import { auditLogsOn, onMessageCreateLog, onMessageUpdate, onMessageDelete, onMessageDeleteBulk, onAuditLogEntry, onMemberUpdateLog } from './logs.js';
import { onBumpMessage } from './bump.js';
import { onMessageAfk } from './community.js';
import { onMessageLevels, onReactionLevels, onMemberLeaveLevels } from './levels.js';
import { onMessageAutomod, onMemberJoinAutomod } from './automod.js';
import { onMessageTicketClaim } from './tickets.js';

const QUERY = '/?v=10&encoding=json';
// GUILDS (lista osób na kanałach głosowych przy logowaniu) + GUILD_VOICE_STATES (wejścia/wyjścia z kanałów)
// + GUILD_MESSAGES (odpowiedzi na wiadomości o karach — bez treści, wystarczy message_reference).
export const INTENTS = (1 << 0) | (1 << 7) | (1 << 9);
// Uprzywilejowane intencje (GUILD_MEMBERS, MESSAGE_CONTENT) dodajemy tylko, gdy są potrzebne i aplikacja
// je ma — inaczej Discord odrzuciłby logowanie (4014) i bot straciłby status i kanały głosowe.
// GUILD_MODERATION (bany + dziennik zdarzeń) nie jest uprzywilejowana — potrzebna do logów serwera.
const GUILD_MEMBERS = 1 << 1;
const GUILD_MODERATION = 1 << 2;
const MESSAGE_CONTENT = 1 << 15;
// Reakcje na wiadomościach — tylko dla XP za reakcje (poziomy).
const GUILD_MESSAGE_REACTIONS = 1 << 10;

export async function sessionIntents(bot) {
  const config = await bot.store.getConfig();
  let intents = INTENTS;
  if (auditLogsOn(config)) intents |= GUILD_MODERATION;
  if (config.levels.enabled && config.levels.reaction.enabled) intents |= GUILD_MESSAGE_REACTIONS;
  const wantsMembers = membersFeaturesOn(config);
  const wantsContent = contentFeaturesOn(config);
  if (!wantsMembers && !wantsContent) return intents;
  const app = await getApp(bot).catch(() => null);
  if (wantsMembers && membersIntentOn(app)) intents |= GUILD_MEMBERS;
  if (wantsContent && contentIntentOn(app)) intents |= MESSAGE_CONTENT;
  return intents;
}
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE: 3, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, ACK: 11 };
// 4004 zły token, 4010–4014 błędna konfiguracja — ponawianie nic nie da.
const FATAL = new Map([
  [4004, 'Discord odrzucił token (4004) — sprawdź sekret DISCORD_TOKEN.'],
  [4010, 'Nieprawidłowy shard (4010).'],
  [4011, 'Discord wymaga shardingu (4011).'],
  [4012, 'Nieobsługiwana wersja API (4012).'],
  [4013, 'Nieprawidłowe intencje (4013).'],
  [4014, 'Niedozwolone intencje (4014) — włącz je w Developer Portal.'],
]);
const RESET = new Set([4007, 4009]); // zły numer sekwencji / sesja wygasła — trzeba zalogować się od nowa
const CLOSE_KEEP_SESSION = 4000; // każdy kod inny niż 1000/1001 zostawia sesję do wznowienia
const DAY = 24 * 60 * 60_000;
export const IDENTIFY_CAP = 600; // Discord pozwala na 1000 logowań na dobę; po przekroczeniu resetuje token
const RESUME_WINDOW_MS = 15 * 60_000;

const ACTIVITY_CODES = { playing: 0, listening: 2, watching: 3, custom: 4, competing: 5 };

// ---------- Status i opisy ----------

export function fillPresenceText(text, vars) {
  return String(text ?? '')
    .replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    .slice(0, 128);
}

// Który opis pokazać teraz — liczone z zegara, więc kolejne sesje kontynuują rotację.
export function pickActivity(presence, now = Date.now()) {
  const list = presence?.activities ?? [];
  if (!presence?.enabled || !list.length) return { activity: null, nextAt: null };
  const period = Math.max(15, Number(presence.rotateSeconds) || 30) * 1000;
  const slot = Math.floor(now / period);
  return { activity: list[slot % list.length], index: slot % list.length, nextAt: list.length > 1 ? (slot + 1) * period : null };
}

export function presencePayload(presence, activity, vars) {
  const status = presence?.enabled ? presence.status ?? 'online' : 'online';
  if (!activity) return { since: null, activities: [], status, afk: false };
  const text = fillPresenceText(activity.text, vars);
  const type = ACTIVITY_CODES[activity.type] ?? ACTIVITY_CODES.custom;
  const entry = type === ACTIVITY_CODES.custom ? { type, name: 'Custom Status', state: text } : { type, name: text };
  return { since: null, activities: [entry], status, afk: false };
}

export async function presenceVars(bot) {
  const hit = bot.cache.get('presenceVars');
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const [context, stats] = await Promise.all([
    getGuildContext(bot).catch(() => null),
    bot.store.stats().catch(() => null),
  ]);
  const value = {
    czlonkowie: context?.guild?.memberCount ?? '?',
    online: context?.guild?.onlineCount ?? '?',
    serwer: context?.guild?.name ?? 'Entuzjaści Hopkostki',
    ostrzezenia: stats?.activeWarns ?? 0,
    sprawy: stats?.cases ?? 0,
  };
  bot.cache.set('presenceVars', { at: Date.now(), value });
  return value;
}

// ---------- Limit logowań ----------

async function identifyBudget(bot) {
  const now = Date.now();
  const log = ((await bot.store.getState('gateway_identifies')) ?? []).filter((at) => now - at < DAY);
  if (log.length >= IDENTIFY_CAP) {
    return { ok: false, reason: `Wstrzymano logowanie do gateway: ${log.length} logowań w ciągu doby (limit bezpieczeństwa ${IDENTIFY_CAP}).` };
  }
  const info = await bot.discord.get('/gateway/bot');
  const remaining = info?.session_start_limit?.remaining;
  if (typeof remaining === 'number' && remaining < 100) {
    return { ok: false, reason: `Discord pozwala jeszcze tylko na ${remaining} logowań — czekam na reset limitu.` };
  }
  await bot.store.setState('gateway_identifies', [...log, now]);
  return { ok: true, url: info?.url ?? 'wss://gateway.discord.gg', identifies24h: log.length + 1 };
}

// ---------- Reakcje 🫓 na żywo ----------

async function reactToReply(bot, message, status) {
  const ref = message.message_reference;
  if (message.author?.bot || !ref?.message_id || (ref.type ?? 0) !== 0) return;
  if (bot.env.guildId && message.guild_id !== bot.env.guildId) return;
  const { replyReaction } = await bot.store.getConfig();
  if (!replyReaction.enabled || !replyReaction.emoji) return;
  const mod = await bot.store.filterModMessages([ref.message_id]);
  if (!mod.has(ref.message_id)) return;
  await bot.discord.put(`/channels/${message.channel_id}/messages/${message.id}/reactions/${reactionPath(replyReaction.emoji)}/@me`);
  status.reactions += 1;
}

// ---------- Jedno połączenie ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectOnce(bot, { WebSocketImpl, deadline, margin, status }) {
  const saved = await bot.store.getState('gateway_session');
  const intents = await sessionIntents(bot);
  // Wznowiona sesja ma intencje z chwili logowania — po ich zmianie trzeba zalogować się od nowa.
  const resuming = Boolean(
    saved?.sessionId && saved?.resumeUrl && saved.intents === intents && Date.now() - (saved.savedAt ?? 0) < RESUME_WINDOW_MS,
  );
  let url = saved?.resumeUrl;
  if (!resuming) {
    const budget = await identifyBudget(bot);
    if (!budget.ok) {
      status.error = budget.reason;
      return { done: true };
    }
    url = budget.url;
    status.identifies24h = budget.identifies24h;
  }

  let session = resuming ? { sessionId: saved.sessionId, resumeUrl: saved.resumeUrl } : null;
  let seq = resuming ? saved.seq ?? null : null;
  const pending = new Set();
  const track = (promise) => {
    const p = promise.catch((error) => console.warn(`[gateway] ${error.message}`)).finally(() => pending.delete(p));
    pending.add(p);
  };
  // Zdarzenia głosowe po kolei — wejście i szybkie wyjście z kanału nie mogą się wyprzedzić.
  let voiceChain = Promise.resolve();
  const queueVoice = (fn) => {
    voiceChain = voiceChain.then(fn).catch((error) => console.warn(`[gateway:voice] ${error.message}`));
    track(voiceChain);
  };

  return new Promise((resolve) => {
    const ws = new WebSocketImpl(`${url.replace(/\/+$/, '')}${QUERY}`);
    const timers = new Set();
    let acked = true;
    let finished = false;
    let outcome = { done: true };

    const later = (fn, ms) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, Math.max(0, ms));
      timers.add(id);
    };
    const send = (op, d) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ op, d }));
    };
    let closing = false;
    const close = (next) => {
      if (closing) return;
      closing = true;
      outcome = next;
      try {
        ws.close(CLOSE_KEEP_SESSION, 'hopkostki: koniec sesji');
      } catch {
        finish();
        return;
      }
      // Gdyby zdarzenie close nie przyszło, i tak kończymy.
      later(finish, 3000);
    };
    later(() => close({ done: true }), deadline - Date.now());
    const heartbeat = () => {
      if (!acked) return close({ done: false }); // brak ACK — połączenie "zombie", łączymy się od nowa
      acked = false;
      send(OP.HEARTBEAT, seq);
    };
    const startHeartbeat = (interval) => {
      const loop = () => {
        heartbeat();
        later(loop, interval);
      };
      later(loop, interval * Math.random());
    };

    const updatePresence = async () => {
      const config = await bot.store.getConfig();
      const { activity, nextAt } = pickActivity(config.presence);
      const payload = presencePayload(config.presence, activity, await presenceVars(bot));
      send(OP.PRESENCE, payload);
      status.activity = payload.activities[0]?.state ?? payload.activities[0]?.name ?? null;
      status.presence = payload.status;
      if (nextAt && nextAt < deadline) later(() => track(updatePresence()), nextAt - Date.now());
    };

    async function finish() {
      if (finished) return;
      finished = true;
      for (const id of timers) clearTimeout(id);
      await Promise.allSettled([...pending]);
      if (session && !outcome.reset) {
        await bot.store.setState('gateway_session', { ...session, seq, intents, savedAt: Date.now() }).catch(() => {});
      }
      resolve(outcome);
    }

    ws.onmessage = (event) => {
      let packet;
      try {
        packet = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
      } catch {
        return;
      }
      if (packet.s !== null && packet.s !== undefined) seq = packet.s;
      status.events += 1;

      switch (packet.op) {
        case OP.HELLO:
          startHeartbeat(packet.d.heartbeat_interval);
          if (resuming) {
            send(OP.RESUME, { token: bot.env.token, session_id: saved.sessionId, seq });
          } else {
            track(
              (async () => {
                const config = await bot.store.getConfig();
                const { activity } = pickActivity(config.presence);
                send(OP.IDENTIFY, {
                  token: bot.env.token,
                  intents,
                  properties: { os: 'linux', browser: 'hopkostki-bot', device: 'hopkostki-bot' },
                  presence: presencePayload(config.presence, activity, await presenceVars(bot)),
                });
              })(),
            );
          }
          break;
        case OP.ACK:
          acked = true;
          break;
        case OP.HEARTBEAT:
          send(OP.HEARTBEAT, seq);
          break;
        case OP.RECONNECT:
          close({ done: false });
          break;
        case OP.INVALID_SESSION:
          // d = true: sesję da się jeszcze wznowić; false: trzeba zalogować się od nowa.
          if (!packet.d) session = null;
          close({ done: false, reset: !packet.d, wait: true });
          break;
        case OP.DISPATCH:
          if (packet.t === 'READY') {
            session = { sessionId: packet.d.session_id, resumeUrl: packet.d.resume_gateway_url };
            status.mode = 'identify';
            status.connectedAt = Date.now();
            track(bot.store.setState('gateway_session', { ...session, seq, intents, savedAt: Date.now() }));
            track(updatePresence());
          } else if (packet.t === 'RESUMED') {
            status.mode = 'resume';
            status.connectedAt = Date.now();
            track(updatePresence());
          } else if (packet.t === 'MESSAGE_CREATE') {
            track(reactToReply(bot, packet.d, status));
            track(onMessageCreateLog(bot, packet.d));
            track(onBumpMessage(bot, packet.d));
            track(onMessageAfk(bot, packet.d));
            track(onMessageTicketClaim(bot, packet.d));
            // Wiadomość ukarana przez automoderację nie daje XP.
            track(onMessageAutomod(bot, packet.d).then((hit) => (hit ? null : onMessageLevels(bot, packet.d))));
          } else if (packet.t === 'MESSAGE_UPDATE') {
            track(onMessageUpdate(bot, packet.d));
            track(onMessageAutomod(bot, packet.d, { edited: true }));
          } else if (packet.t === 'MESSAGE_DELETE') {
            track(onMessageDelete(bot, packet.d));
          } else if (packet.t === 'MESSAGE_DELETE_BULK') {
            track(onMessageDeleteBulk(bot, packet.d));
          } else if (packet.t === 'GUILD_AUDIT_LOG_ENTRY_CREATE') {
            track(onAuditLogEntry(bot, packet.d));
          } else if (packet.t === 'GUILD_CREATE') {
            queueVoice(() => syncGuildVoiceStates(bot, packet.d));
          } else if (packet.t === 'VOICE_STATE_UPDATE') {
            queueVoice(() => onVoiceStateUpdate(bot, packet.d));
          } else if (packet.t === 'GUILD_MEMBER_ADD') {
            track(onMemberJoin(bot, packet.d));
            track(onMemberJoinAutomod(bot, packet.d));
          } else if (packet.t === 'GUILD_MEMBER_UPDATE') {
            track(onMemberUpdate(bot, packet.d));
            track(onMemberUpdateLog(bot, packet.d));
          } else if (packet.t === 'GUILD_MEMBER_REMOVE') {
            track(onMemberLeave(bot, packet.d));
            track(onMemberLeaveLevels(bot, packet.d));
          } else if (packet.t === 'MESSAGE_REACTION_ADD') {
            track(onReactionLevels(bot, packet.d));
          }
          break;
        default:
          break;
      }
    };

    ws.onclose = (event) => {
      const code = event?.code ?? 1006;
      status.closeCode = code;
      if (FATAL.has(code)) {
        status.error = FATAL.get(code);
        outcome = { done: true, reset: code === 4004 };
      } else if (RESET.has(code)) {
        session = null;
        outcome = { done: false, reset: true };
      } else if (!closing) {
        // Discord zamknął połączenie sam — spróbujemy wznowić w tej samej sesji.
        outcome = { done: false };
      }
      if (!outcome.done && Date.now() >= deadline - margin) outcome = { ...outcome, done: true };
      finish();
    };
    ws.onerror = () => {
      status.error = status.error ?? 'Błąd połączenia WebSocket z gateway.';
    };
  });
}

// ---------- Sesja uruchamiana przez cron ----------

export async function runGatewaySession(
  bot,
  { WebSocketImpl = globalThis.WebSocket, durationMs = 55_000, retryDelay = () => 1000 + Math.random() * 4000 } = {},
) {
  if (!bot.discord || !bot.env.token) return { skipped: 'Brak sekretu DISCORD_TOKEN' };
  if (!WebSocketImpl) return { skipped: 'Brak WebSocketu w środowisku' };
  if (!(await bot.store.acquireLease('gateway_lock', Math.ceil(durationMs / 1000) + 10))) {
    return { skipped: 'poprzednia sesja jeszcze trwa' };
  }

  const started = Date.now();
  const deadline = started + durationMs;
  const margin = Math.min(5000, durationMs / 5); // nie zaczynamy nowego połączenia tuż przed końcem
  const status = { startedAt: started, mode: null, events: 0, reactions: 0, error: null, closeCode: null };
  try {
    for (let attempt = 0; attempt < 3 && Date.now() < deadline - margin; attempt += 1) {
      const result = await connectOnce(bot, { WebSocketImpl, deadline, margin, status });
      if (result.reset) await bot.store.setState('gateway_session', null);
      if (result.done) break;
      if (result.wait) await sleep(retryDelay()); // Discord zaleca 1–5 s po INVALID_SESSION
    }
  } catch (error) {
    console.error('[gateway]', error);
    status.error = error.message;
  } finally {
    status.endedAt = Date.now();
    await bot.store.setState('gateway_status', status).catch(() => {});
    await bot.store.releaseLease('gateway_lock').catch(() => {});
  }
  return status;
}
