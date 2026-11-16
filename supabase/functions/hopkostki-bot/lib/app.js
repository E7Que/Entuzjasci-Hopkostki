// Router funkcji Edge "hopkostki-bot" (Web Request -> Response, działa w Deno i w Node):
//   POST /            interakcje Discorda (podpis Ed25519)
//   POST /cron        zadania okresowe (sekret z bazy, wywołuje pg_cron)
//   POST /gateway     sesja gateway w tle (status online + opisy), też z pg_cron
//   GET  /panel/      przekierowanie na stronę panelu (GitHub Pages)
//   *    /panel/...   API panelu (nagłówek x-panel-password albo x-panel-session, CORS dla strony panelu)
//   POST /panel/login logowanie moderatora loginem i hasłem z /login → sesja przeglądarki
//   GET  /health      szybka diagnostyka bez sekretów

import { handleInteraction } from './interactions.js';
import { runCron } from './cron.js';
import { runGatewaySession } from './gateway.js';
import { handlePanel, describeAuth } from './panel.js';
import { getApp, getGuildContext } from './moderation.js';
import { avatarUrl, guildIconUrl } from './rest.js';
import { levelProgress, monthKey, publicLook, publicProfile, rankedXpEvent, weekKey, xpEventsOverview } from './levels.js';
import { AccessError, PANEL_SITE, PASSWORD_AUTH, authenticateSession, signIn } from './access.js';
import { verifyDiscordRequest, ed25519Supported, safeEqual } from './verify.js';

// Supabase nie serwuje stron HTML z funkcji Edge (text/html zamienia na text/plain), więc sama strona
// panelu stoi na GitHub Pages (PANEL_SITE w access.js), a tutaj zostaje jej API. Zapytania panelu bot
// przyjmuje tylko z tej domeny.
export { PANEL_SITE };
const PANEL_ORIGINS = new Set([new URL(PANEL_SITE).origin]);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  if (!origin || !PANEL_ORIGINS.has(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-panel-password, x-panel-session',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function randomPassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

// Hasło panelu: ustawione w panelu (baza) > sekret PANEL_PASSWORD > wygenerowane samo przy pierwszym użyciu.
async function resolvePanelPassword(bot) {
  const stored = await bot.store.getState('panel_password');
  if (stored) return stored;
  if (bot.env.panelPassword) return bot.env.panelPassword;
  const generated = randomPassword();
  await bot.store.setState('panel_password', generated);
  return generated;
}

async function publicKey(bot) {
  if (bot.env.publicKey) return bot.env.publicKey;
  const hit = bot.cache.get('verifyKey');
  if (hit) return hit;
  let key = (await bot.store.getState('app'))?.verifyKey;
  if (!key) {
    const app = await getApp(bot);
    key = app.verify_key;
    await bot.store.setState('app', { id: app.id, verifyKey: key, name: app.name });
  }
  bot.cache.set('verifyKey', key);
  return key;
}

export function createHandler(bot, { waitUntil = (promise) => promise } = {}) {
  async function discord(request) {
    if (!bot.discord) return json({ error: 'Brak sekretu DISCORD_TOKEN' }, 503);
    const raw = await request.text();
    const valid = await verifyDiscordRequest(
      await publicKey(bot),
      request.headers.get('x-signature-ed25519'),
      request.headers.get('x-signature-timestamp'),
      raw,
    );
    if (!valid) return new Response('invalid request signature', { status: 401 });

    const { response, task } = await handleInteraction(JSON.parse(raw), bot);
    if (task) waitUntil(task());
    return json(response);
  }

  async function cronAllowed(request) {
    const secret = await bot.store.getState('cron_secret');
    return Boolean(secret) && (await safeEqual(request.headers.get('x-cron-secret'), secret));
  }

  async function cron(request, url) {
    if (!(await cronAllowed(request))) return json({ error: 'Brak dostępu' }, 401);
    if (!bot.discord) return json({ skipped: 'Brak sekretu DISCORD_TOKEN' });
    return json(await runCron(bot, { force: url.searchParams.get('force') === '1' }));
  }

  // Odpowiadamy od razu, a połączenie z gateway trwa w tle (~55 s).
  async function gateway(request) {
    if (!(await cronAllowed(request))) return json({ error: 'Brak dostępu' }, 401);
    if (!bot.discord) return json({ skipped: 'Brak sekretu DISCORD_TOKEN' });
    waitUntil(runGatewaySession(bot).catch((error) => console.error('[gateway]', error)));
    return json({ started: true }, 202);
  }

  // ?period=all|week|month|event, ?event= (ID wydarzenia XP), ?offset=, ?limit= (do 100),
  // ?search= (nazwa, pseudonim albo ID). Ranking wydarzenia bez wydarzenia → ranking ogólny.
  async function publicLeaderboard(url) {
    const { levels } = await bot.store.getConfig();
    if (!levels.enabled || !levels.publicLeaderboard) return { enabled: false, entries: [] };
    const params = url.searchParams;
    const offset = Math.min(Math.max(Math.floor(Number(params.get('offset'))) || 0, 0), 100_000);
    const limit = Math.min(Math.max(Math.floor(Number(params.get('limit'))) || 100, 1), 100);
    const event = params.get('period') === 'event' ? rankedXpEvent(levels, params.get('event')) : null;
    const period = event ? 'event' : ['week', 'month'].includes(params.get('period')) ? params.get('period') : 'all';
    const search = String(params.get('search') ?? '').trim().slice(0, 64);
    const periodKey = period === 'week' ? weekKey() : period === 'month' ? monthKey() : period === 'event' ? event.id : null;
    const [rows, total, totals, gctx] = await Promise.all([
      period === 'all'
        ? bot.store.levelLeaderboard({ limit, offset, search, publicOnly: true })
        : period === 'event'
          ? bot.store.levelEventTop({ eventId: event.id, limit, offset, search, publicOnly: true })
          : bot.store.levelPeriodTop({ period, key: periodKey, limit, offset, search, publicOnly: true }),
      period === 'all'
        ? bot.store.countLevels(search, { publicOnly: true })
        : period === 'event'
          ? bot.store.countEvent({ eventId: event.id, search, publicOnly: true })
          : bot.store.countPeriod({ period, key: periodKey, search, publicOnly: true }),
      bot.store.levelTotals(),
      bot.discord ? getGuildContext(bot).catch(() => null) : null,
    ]);
    const role = (id) => {
      const r = id ? gctx?.roles.get(id) : null;
      return r ? { name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null } : null;
    };
    const rate = (source, keys) => (source.enabled ? Object.fromEntries(keys.map((k) => [k, source[k]])) : null);
    const { effort } = levels.boosters;
    return {
      enabled: true,
      period,
      periodKey,
      total,
      offset,
      guild: gctx ? { name: gctx.guild.name, icon: guildIconUrl(gctx.guild), memberCount: gctx.guild.memberCount } : null,
      color: levels.card.color,
      totals,
      events: xpEventsOverview(levels),
      event: event ? { id: event.id, name: event.name, multiplier: event.multiplier, startsAt: event.startsAt, endsAt: event.endsAt, theme: event.theme, kinds: event.kinds } : null,
      rates: {
        message: rate(levels.message, ['mode', 'min', 'max', 'cooldown']),
        voice: rate(levels.voice, ['min', 'max', 'cooldown', 'minMembers']),
        reaction: rate(levels.reaction, ['min', 'max', 'cooldown']),
        effort: effort.enabled ? { words: effort.words, images: effort.images, percent: effort.percent } : null,
        boosters: levels.boosters.roles.map((b) => ({ ...role(b.roleId), percent: b.percent })).filter((b) => b.name),
      },
      rewards: levels.rewards
        .map((r) => ({ level: r.level, ...role(r.roleId) }))
        .filter((r) => r.name)
        .sort((a, b) => a.level - b.level),
      highlights: {
        weekly: levels.highlights.weekly.enabled,
        monthly: levels.highlights.monthly.enabled,
        role: role(levels.highlights.roleId)?.name ?? null,
      },
      entries: rows.map((r) => {
        const p = levelProgress(r.xp, levels.formula);
        // Osoba ukryta komendą /prywatnosc: miejsce i statystyki zostają, bez nazwy, avatara i ID.
        if (r.hidden) {
          return {
            rank: period === 'all' ? r.rank : r.periodRank,
            hidden: true,
            userId: null,
            name: 'Ukryta osoba',
            displayName: null,
            nitro: false,
            accent: null,
            avatar: null,
            avatarAnim: null,
            look: null,
            xp: r.xp,
            periodXp: period === 'all' ? null : r.periodXp,
            level: p.level,
            current: p.current,
            needed: p.needed,
            messages: r.messages,
            voiceMinutes: r.voiceMinutes,
            reactions: r.reactions,
          };
        }
        return {
          rank: period === 'all' ? r.rank : r.periodRank,
          userId: r.userId,
          name: r.userTag ?? 'Użytkownik',
          displayName: r.displayName && r.displayName !== r.userTag ? r.displayName : null,
          nitro: r.nitro,
          accent: r.nitro ? r.accentColor : null,
          avatar: r.guildAvatar && gctx
            ? `https://cdn.discordapp.com/guilds/${gctx.guild.id}/users/${r.userId}/avatars/${r.guildAvatar}.png?size=128`
            : avatarUrl({ id: r.userId, avatar: r.avatar }, 128),
          avatarAnim: String(r.guildAvatar ?? r.avatar ?? '').startsWith('a_')
            ? r.guildAvatar && gctx
              ? `https://cdn.discordapp.com/guilds/${gctx.guild.id}/users/${r.userId}/avatars/${r.guildAvatar}.gif?size=128`
              : `https://cdn.discordapp.com/avatars/${r.userId}/${r.avatar}.gif?size=128`
            : null,
          look: publicLook(r.look),
          xp: r.xp,
          periodXp: period === 'all' ? null : r.periodXp,
          level: p.level,
          current: p.current,
          needed: p.needed,
          messages: r.messages,
          voiceMinutes: r.voiceMinutes,
          reactions: r.reactions,
        };
      }),
    };
  }

  // Kto pyta: hasło panelu = pełny dostęp, sesja z loginu z /login = części panelu odblokowane rolami tej osoby.
  async function panelAuth(request) {
    const session = request.headers.get('x-panel-session');
    if (session) return authenticateSession(bot, session);
    const password = await resolvePanelPassword(bot);
    if (!(await safeEqual(request.headers.get('x-panel-password'), password))) throw new AccessError('Złe hasło panelu.');
    return PASSWORD_AUTH;
  }

  async function panel(request, url, path, cors) {
    const route = path.slice('/panel'.length) || '/';
    let body = {};
    if (!['GET', 'HEAD'].includes(request.method)) body = await request.json().catch(() => ({}));
    try {
      // Publiczny ranking poziomów (strona ranking.html) — bez logowania, o ile włączony w panelu.
      if (request.method === 'GET' && route === '/public/leaderboard') return json(await publicLeaderboard(url), 200, cors);
      if (request.method === 'GET' && route === '/public/profile') {
        const profile = bot.discord ? await publicProfile(bot, url.searchParams.get('id')) : null;
        return profile ? json(profile, 200, cors) : json({ error: 'Nie ma takiej osoby w rankingu.' }, 404, cors);
      }
      // Jedyne zapytanie panelu bez hasła panelu i sesji: login i hasło z /login → sesja przeglądarki.
      if (request.method === 'POST' && route === '/login') {
        const { token, auth } = await signIn(bot, { login: body?.login, password: body?.password });
        return json({ token, me: describeAuth(auth) }, 200, cors);
      }
      const auth = await panelAuth(request);
      const result = await handlePanel(bot, { method: request.method, path: route, query: Object.fromEntries(url.searchParams), body, auth });
      return json(result.body, result.status, cors);
    } catch (error) {
      if (error instanceof AccessError) return json({ error: error.message }, 401, cors);
      throw error;
    }
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*?\/hopkostki-bot(?=\/|$)/, '') || '/';
    const cors = path.startsWith('/panel') ? corsHeaders(request) : {};
    try {
      if (path === '/health') {
        return json({
          ok: true,
          tokenConfigured: Boolean(bot.env.token),
          panelPasswordConfigured: true, // zawsze prawda: sekret albo hasło wygenerowane samo w bazie
          ed25519: await ed25519Supported(),
        });
      }
      if (path === '/cron' && request.method === 'POST') return await cron(request, url);
      if (path === '/gateway' && request.method === 'POST') return await gateway(request);
      if ((path === '/panel' || path === '/panel/') && request.method === 'GET') return Response.redirect(PANEL_SITE, 302);
      if (path.startsWith('/panel/')) {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        return await panel(request, url, path, cors);
      }
      if (request.method === 'POST' && (path === '/' || path === '/interactions')) return await discord(request);
      return json({ error: 'Nie znaleziono' }, 404);
    } catch (error) {
      console.error('[handler]', error);
      return json({ error: 'Błąd serwera' }, 500, cors);
    }
  };
}
