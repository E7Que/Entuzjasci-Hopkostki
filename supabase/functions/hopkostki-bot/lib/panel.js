// API panelu konfiguracyjnego. Strona panelu (GitHub Pages albo lokalny wrapper) wysyła tu żądania
// z nagłówkiem x-panel-password (pełny dostęp) albo x-panel-session (moderator zalogowany loginem z /login —
// tylko części panelu odblokowane jego rolami) — samo API działa na Supabase razem z botem.

import { DEFAULT_CONFIG } from './defaults.js';
import { cached, getApp, getGuildContext, unbanUser, sendModLog, describeError, ActionError } from './moderation.js';
import { avatarUrl, guildIconUrl, DiscordError } from './rest.js';
import { simpleEmbed } from './embeds.js';
import { ensureSetup } from './cron.js';
import { COMMAND_META, fillCommandPermissions } from './commands.js';
import { P, has, highestPosition, memberPermissions, permissionLabel } from './permissions.js';
import { sendPanelMessage, editPanelMessage, deletePanelMessage } from './messages.js';
import { sendTicketPanel, closeTicket } from './tickets.js';
import { ensureIntentFlags, membersIntentOn, contentIntentOn } from './members.js';
import { endGiveaway } from './community.js';
import { PANEL_SECTIONS, PASSWORD_AUTH, SECTION_CONFIG_KEYS, allowedConfigInput, sectionAccess } from './access.js';
import { activeXpEvent, changeXp, dayKey, importLevels, levelProgress, levelUpMessage, parseImport } from './levels.js';
import { alertChannel, sendAlertTest } from './health.js';

// Wersja kodu: funkcja na Supabase importuje bota z GitHuba pod adresem z pełnym SHA commita.
const SOURCE_SHA = (import.meta.url.match(/\/([0-9a-f]{40})\//) ?? [])[1] ?? null;

const TEXT_CHANNELS = new Set([0, 5]);
const byPosition = (a, b) => a.position - b.position;
const ok = (body) => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });
const hex = (n) => `#${Number(n ?? 0).toString(16).padStart(6, '0')}`;

// Nazwa części panelu dla klucza ustawień (dziennik zmian).
const KEY_SECTIONS = Object.fromEntries(Object.entries(SECTION_CONFIG_KEYS).flatMap(([section, keys]) => keys.map((key) => [key, PANEL_SECTIONS[section]])));
KEY_SECTIONS.panelAccess = 'Dostęp do panelu';
export const configKeyLabel = (key) => KEY_SECTIONS[key] ?? key;

// Porównanie bez względu na kolejność kluczy (Postgres zapisuje jsonb z innym porządkiem kluczy).
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Zmienione sekcje ustawień (klucze najwyższego poziomu): { klucz: { before, after } }.
export function configChanges(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (!sameValue(before?.[key], after[key])) changes[key] = { before: before?.[key] ?? null, after: after[key] };
  }
  return changes;
}

// Która część panelu odblokowuje które zapytanie: null = każdy zalogowany, 'full' = tylko pełny dostęp
// (hasło panelu albo administrator serwera). Nieznane ścieżki też wymagają pełnego dostępu.
const ROUTE_SECTIONS = [
  [/^\/(status|guild|config|commands|me|logout)$/, null],
  [/^\/permissions\//, 'uprawnienia'],
  [/^\/tickets(\/|$)/, 'tickety'],
  [/^\/bump$/, 'bump'],
  [/^\/giveaways(\/|$)/, 'spolecznosc'],
  [/^\/(setup|alerts\/test)$/, 'ustawienia'],
  [/^\/voice(\/|$)/, 'glosowe'],
  [/^\/messages(\/|$)/, 'wiadomosci'],
  [/^\/(cases|appeals)$/, 'sprawy'],
  [/^\/warns(\/|$)/, 'ostrzezenia'],
  [/^\/tempbans(\/|$)/, 'bany'],
  [/^\/levels(\/|$)/, 'poziomy'],
];
function requiredSection(path) {
  const match = ROUTE_SECTIONS.find(([pattern]) => pattern.test(path));
  return match ? match[1] : 'full';
}
const canUse = (auth, section) => section === null || auth.full || (section !== 'full' && auth.sections.includes(section));

// Kim jest zalogowana osoba, co może zmieniać w panelu i do kiedy ważny jest jej login.
export function describeAuth(auth) {
  return { kind: auth.kind, full: auth.full, sections: auth.sections, user: auth.user ?? null, expiresAt: auth.expiresAt ?? null };
}

// Najważniejsze uprawnienia moderacji, które panel pozwala włączać i wyłączać rolom w samym Discordzie
// (np. żeby Test Helper nie mógł wyrzucać z serwera, nawet bez bota).
export const ROLE_PERMISSION_KEYS = [
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'MODERATE_MEMBERS',
  'MANAGE_MESSAGES',
  'MANAGE_NICKNAMES',
  'MANAGE_ROLES',
  'MANAGE_CHANNELS',
  'MANAGE_GUILD_EXPRESSIONS',
  'MENTION_EVERYONE',
  'MOVE_MEMBERS',
  'MUTE_MEMBERS',
  'DEAFEN_MEMBERS',
  'VIEW_AUDIT_LOG',
  'VIEW_GUILD_INSIGHTS',
  'MANAGE_THREADS',
  'MANAGE_EVENTS',
  'MANAGE_WEBHOOKS',
  'MANAGE_GUILD',
  'CREATE_INSTANT_INVITE',
  'CHANGE_NICKNAME',
  'CREATE_PUBLIC_THREADS',
  'SEND_POLLS',
  'ADD_REACTIONS',
  'ATTACH_FILES',
  'EMBED_LINKS',
  'USE_EXTERNAL_EMOJIS',
];

async function setRolePermission(bot, auth, roleId, name, value) {
  if (!ROLE_PERMISSION_KEYS.includes(name)) throw new ActionError('Tego uprawnienia nie można zmieniać z panelu.');
  const gctx = await getGuildContext(bot, { force: true });
  const role = gctx.rawRoles.find((r) => r.id === roleId);
  if (!role || role.managed || role.id === gctx.guild.id) throw new ActionError('Nie ma takiej roli (albo to rola bota lub integracji).');
  if (has(role.permissions, P.ADMINISTRATOR)) throw new ActionError(`Rola ${role.name} ma uprawnienie Administrator — zmień ją w ustawieniach serwera.`);
  if (role.position >= highestPosition(gctx.botMember.roles, gctx.roles)) {
    throw new ActionError(`Rola ${role.name} jest wyżej niż rola bota — przesuń rolę bota wyżej (Ustawienia serwera → Role).`);
  }
  const bits = value ? BigInt(role.permissions) | P[name] : BigInt(role.permissions) & ~P[name];
  const who = auth.user ? auth.user.tag : 'hasło panelu';
  const updated = await bot.discord.patch(
    `/guilds/${gctx.guild.id}/roles/${role.id}`,
    { permissions: String(bits) },
    { reason: `Panel (${who}): ${value ? 'nadano' : 'odebrano'} ${permissionLabel(P[name])}` },
  );
  bot.cache.delete('guildCtx');
  return { id: updated.id, name: updated.name, permissions: updated.permissions };
}

// Czytelny stan bota na pulpit: błędy zadań okresowych, problemy wykryte przez strażnika, alerty, baza,
// dzisiejsza aktywność, odwołania, trwające wydarzenie XP i wersja kodu.
async function statusHealth(bot, { cron, config }) {
  const [healthState, hook, db, today, appeals] = await Promise.all([
    bot.store.getState('health_state'),
    bot.store.getState('alert_webhook'),
    cached(bot, 'status:db', 10 * 60_000, () => bot.store.dbUsage()).catch(() => null),
    bot.store.dayActivity(dayKey()),
    bot.store.countPendingAppeals(),
  ]);
  const steps = Object.entries(cron?.report ?? {})
    .filter(([, r]) => r && typeof r === 'object' && 'error' in r && Object.keys(r).length === 1)
    .map(([name, r]) => ({ name, error: r.error }));
  const event = activeXpEvent(config.levels);
  return {
    steps,
    problems: Object.values(healthState?.active ?? {}).map((p) => ({ since: p.since, text: p.text })),
    alerts: { enabled: config.alerts.enabled, channelId: alertChannel(config) || null, watchdog: Boolean(hook?.url) && !hook?.error, watchdogError: hook?.error ?? null },
    db: db ? { ...db, limit: 500 * 1024 * 1024 } : null,
    today,
    appeals,
    event: event ? { name: event.name, multiplier: event.multiplier, endsAt: event.endsAt } : null,
    version: SOURCE_SHA,
  };
}

async function status(bot) {
  const [stats, recent, setup, cron, gateway, config] = await Promise.all([
    bot.store.stats(),
    bot.store.listCases({ limit: 8 }),
    bot.store.getState('setup'),
    bot.store.getState('cron_last_run'),
    bot.store.getState('gateway_status'),
    bot.store.getConfig(),
  ]);
  const result = {
    ready: false,
    error: null,
    bot: null,
    guild: null,
    stats,
    recent: recent.items,
    setup: { ...(setup ?? {}), tokenConfigured: Boolean(bot.env.token), selfUrl: bot.env.selfUrl },
    cron,
    gateway,
    health: await statusHealth(bot, { cron, config }),
  };
  if (!bot.discord) {
    result.error = 'Brak sekretu DISCORD_TOKEN w Supabase (Edge Functions → Secrets).';
    return result;
  }
  try {
    const gctx = await getGuildContext(bot);
    result.ready = true;
    result.bot = { id: gctx.botUser.id, tag: gctx.botUser.username, avatar: avatarUrl(gctx.botUser, 128) };
    result.guild = {
      id: gctx.guild.id,
      name: gctx.guild.name,
      icon: guildIconUrl(gctx.guild),
      memberCount: gctx.guild.memberCount,
    };
  } catch (error) {
    result.error = describeError(error);
  }
  return result;
}

async function guildInfo(bot) {
  if (!bot.discord) return { channels: [], voiceChannels: [], categories: [], roles: [], emojis: [], bot: null };
  const gctx = await getGuildContext(bot);
  const channels = await bot.discord.get(`/guilds/${gctx.guild.id}/channels`);
  const categories = new Map(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
  const withCategory = (c) => ({ id: c.id, name: c.name, category: categories.get(c.parent_id) ?? null });
  const botPosition = highestPosition(gctx.botMember.roles, gctx.roles);
  const botPerms = memberPermissions(gctx.botMember.roles, gctx.roles, gctx.guild.id);
  const missing = (list) => list.filter((p) => !has(botPerms, p)).map((p) => permissionLabel(p));
  const app = await getApp(bot).catch(() => null);
  return {
    channels: channels.filter((c) => TEXT_CHANNELS.has(c.type)).sort(byPosition).map(withCategory),
    voiceChannels: channels.filter((c) => c.type === 2).sort(byPosition).map(withCategory),
    categories: channels.filter((c) => c.type === 4).sort(byPosition).map((c) => ({ id: c.id, name: c.name })),
    // permissions + position pozwalają panelowi policzyć samodzielnie, kto ma dostęp do jakiej komendy
    // (zakładka "Uprawnienia") i które role bot może rozdawać (zakładka "Wiadomości").
    roles: gctx.rawRoles
      // Role integracji pomijamy — poza rolą boosterów serwera (np. do boosterów XP w Poziomach).
      .filter((r) => r.id !== gctx.guild.id && (!r.managed || 'premium_subscriber' in (r.tags ?? {})))
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: hex(r.color),
        permissions: r.permissions,
        position: r.position,
        assignable: !r.managed && r.position < botPosition && !has(r.permissions, P.ADMINISTRATOR),
      })),
    // Własne emoji serwera — do wyboru przy rolach w wiadomościach.
    emojis: gctx.emojis
      .filter((e) => e.available)
      .map((e) => ({ ...e, tag: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48` })),
    bot: {
      missingVoice: missing([P.MANAGE_CHANNELS, P.MOVE_MEMBERS, P.CONNECT, P.MANAGE_ROLES]),
      missingRoles: missing([P.MANAGE_ROLES]),
      missingTickets: missing([P.MANAGE_CHANNELS, P.MANAGE_ROLES]),
      missingLogs: missing([P.VIEW_AUDIT_LOG, P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.ATTACH_FILES]),
      missingPing: missing([P.MENTION_EVERYONE]),
      missingInvites: missing([P.MANAGE_GUILD]),
      missingBump: missing([P.VIEW_CHANNEL, P.SEND_MESSAGES, P.EMBED_LINKS, P.READ_MESSAGE_HISTORY]),
      missingCommunity: missing([P.ADD_REACTIONS, P.CREATE_PUBLIC_THREADS, P.SEND_POLLS, P.MANAGE_GUILD_EXPRESSIONS]),
      membersIntent: membersIntentOn(app),
      contentIntent: contentIntentOn(app),
    },
  };
}

// Błędy z Discorda/walidacji -> czytelny komunikat 400 zamiast "Błąd serwera".
async function attempt(fn) {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof ActionError || error instanceof DiscordError) return fail(400, describeError(error));
    throw error;
  }
}

export async function handlePanel(bot, { method, path, query = {}, body = {}, auth = PASSWORD_AUTH }) {
  const { store } = bot;
  if (!canUse(auth, requiredSection(path))) return fail(403, 'Nie masz dostępu do tej części panelu.');

  if (method === 'GET' && path === '/me') return ok({ me: describeAuth(auth) });
  // Wylogowanie tej przeglądarki (sesja z /login); przy haśle panelu nie ma czego usuwać.
  if (method === 'POST' && path === '/logout') {
    if (auth.session) await store.deletePanelLogins({ id: auth.session.id });
    return ok({ ok: true });
  }

  if (method === 'GET' && path === '/status') {
    const result = await status(bot);
    // Ostatnie sprawy na pulpicie widzi tylko ktoś z dostępem do spraw.
    if (!canUse(auth, 'sprawy')) result.recent = [];
    return ok(result);
  }
  if (method === 'GET' && path === '/guild') return ok(await guildInfo(bot));
  if (method === 'GET' && path === '/config') return ok({ config: await store.getConfig(), defaults: DEFAULT_CONFIG });
  if (method === 'PUT' && path === '/config') {
    const before = await store.getConfig();
    const config = await store.updateConfig(allowedConfigInput(body ?? {}, auth));
    await store
      .addConfigHistory({ changedBy: auth.user?.tag ?? 'hasło panelu', changes: configChanges(before, config) })
      .catch((error) => console.warn(`[panel] Dziennik zmian: ${error.message}`));
    // Włączone powitania/autorole/tickety potrzebują intencji aplikacji — włączamy je od razu, nie czekając na crona.
    const intents = bot.discord ? await ensureIntentFlags(bot, config).catch((error) => ({ error: error.message })) : null;
    return ok({ config, intents });
  }

  // Listy ról komend od nowa według obecnych uprawnień Discorda (reset) albo tylko dla brakujących komend.
  if (method === 'POST' && path === '/permissions/defaults') {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    return attempt(async () => (await fillCommandPermissions(bot, { reset: body?.reset === true })));
  }

  // Tickety.
  if (method === 'GET' && path === '/tickets') {
    return ok({ tickets: await store.listTickets({ limit: 50 }), panel: await store.getState('ticket_panel') });
  }
  if (method === 'POST' && path === '/tickets/panel') {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    return attempt(async () => ({ panel: await sendTicketPanel(bot, String(body?.channelId ?? '')) }));
  }
  const ticketMatch = /^\/tickets\/(\d+)\/close$/.exec(path);
  if (method === 'POST' && ticketMatch) {
    const ticket = await store.getTicket(Number(ticketMatch[1]));
    if (!ticket || ticket.status !== 'open') return fail(404, 'Nie ma takiego otwartego ticketu');
    const reason = String(body?.reason ?? '').trim().slice(0, 500);
    if (reason.length < 3) return fail(400, 'Podaj powód zamknięcia (co najmniej 3 znaki).');
    return attempt(async () => {
      const { botUser } = await getGuildContext(bot);
      await closeTicket(bot, ticket, botUser, `${reason} (zamknięte w panelu)`);
      return { ok: true };
    });
  }
  if (method === 'GET' && path === '/commands') return ok({ commands: COMMAND_META });

  // Bump: ostatni bump, kiedy następny i ranking.
  if (method === 'GET' && path === '/bump') {
    const [last, ranking, month] = await Promise.all([store.getState('bump'), store.bumpRanking({ limit: 10 }), store.bumpRanking({ limit: 10, days: 30 })]);
    return ok({ last, ranking, month, now: Date.now() });
  }

  // Konkursy (/konkurs) — lista i zakończenie przed czasem.
  if (method === 'GET' && path === '/giveaways') return ok({ giveaways: await store.listGiveaways({ limit: 25 }), now: Date.now() });
  const giveawayMatch = /^\/giveaways\/(\d+)\/end$/.exec(path);
  if (method === 'POST' && giveawayMatch) {
    const giveaway = await store.getGiveaway(Number(giveawayMatch[1]));
    if (!giveaway || giveaway.ended) return fail(404, 'Nie ma takiego trwającego konkursu');
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    return attempt(async () => ({ giveaway: await endGiveaway(bot, giveaway) }));
  }

  if (method === 'POST' && path === '/setup') {
    if (!bot.discord) return fail(503, 'Brak sekretu DISCORD_TOKEN w Supabase.');
    return ok(await ensureSetup(bot, { force: true }));
  }

  // Test alertów o awarii: wiadomość przez API bota i przez webhook strażnika w bazie.
  if (method === 'POST' && path === '/alerts/test') {
    if (!bot.discord) return fail(503, 'Brak sekretu DISCORD_TOKEN w Supabase.');
    return attempt(async () => sendAlertTest(bot, auth.user?.tag ?? 'hasło panelu'));
  }

  // Zmiana hasła panelu (wywołujący już przeszedł logowanie obecnym hasłem). Hasło z bazy ma pierwszeństwo
  // przed sekretem PANEL_PASSWORD, więc po zmianie tutaj stare hasło przestaje działać.
  if (method === 'POST' && path === '/password') {
    const next = String(body?.next ?? '');
    if (next.length < 8) return fail(400, 'Nowe hasło musi mieć co najmniej 8 znaków.');
    await store.setState('panel_password', next);
    return ok({ ok: true });
  }

  // Kanały głosowe na żądanie, które teraz istnieją.
  if (method === 'GET' && path === '/voice') {
    const channels = await store.listTempVoice();
    return ok({ channels: await Promise.all(channels.map(async (c) => ({ ...c, members: (await store.voiceMembers(c.channelId)).length }))) });
  }
  const voiceMatch = /^\/voice\/(\d+)$/.exec(path);
  if (method === 'DELETE' && voiceMatch) {
    if (!(await store.getTempVoice(voiceMatch[1]))) return fail(404, 'Nie ma takiego kanału');
    await bot.discord?.delete(`/channels/${voiceMatch[1]}`, { reason: 'Usunięty w panelu' }).catch(() => {});
    await store.deleteTempVoice(voiceMatch[1]);
    return ok({ ok: true });
  }

  // Wiadomości wysyłane z panelu (z opcjonalnym wyborem ról).
  if (method === 'GET' && path === '/messages') return ok({ messages: await store.listSentMessages() });
  if (method === 'POST' && path === '/messages') {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    return attempt(async () => ({ message: await sendPanelMessage(bot, body) }));
  }
  const messageMatch = /^\/messages\/(\d+)$/.exec(path);
  if (method === 'PUT' && messageMatch) {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    return attempt(async () => ({ message: await editPanelMessage(bot, Number(messageMatch[1]), body) }));
  }
  if (method === 'DELETE' && messageMatch) {
    if (!(await deletePanelMessage(bot, Number(messageMatch[1])))) return fail(404, 'Nie ma takiej wiadomości');
    return ok({ ok: true });
  }

  // Dziennik zmian ustawień (tylko pełny dostęp — pokazuje wszystkie sekcje).
  if (method === 'GET' && path === '/config/history') {
    const items = await store.listConfigHistory(Math.min(Number(query.limit) || 30, 100));
    return ok({ items: items.map((h) => ({ ...h, sections: [...new Set(h.keys.map(configKeyLabel))] })) });
  }
  const historyMatch = path.match(/^\/config\/history\/(\d+)$/);
  if (method === 'GET' && historyMatch) {
    const entry = await store.getConfigHistory(Number(historyMatch[1]));
    return entry ? ok({ ...entry, sections: [...new Set(entry.keys.map(configKeyLabel))] }) : fail(404, 'Nie ma takiego wpisu w dzienniku.');
  }

  if (method === 'GET' && path === '/appeals') {
    const status = ['pending', 'accepted', 'rejected'].includes(query.status) ? query.status : null;
    const limit = Math.min(Number(query.limit) || 30, 100);
    const guildId = bot.discord ? ((await getGuildContext(bot).catch(() => null))?.guild.id ?? null) : null;
    return ok({ ...(await store.listAppeals({ status, limit })), guildId });
  }

  if (method === 'GET' && path === '/cases') {
    const limit = Math.min(Number(query.limit) || 25, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const user = String(query.user ?? '').trim();
    const isId = /^\d{15,25}$/.test(user);
    const result = await store.listCases({
      userId: isId ? user : undefined,
      search: user && !isId ? user : undefined,
      type: query.type || undefined,
      limit,
      offset: (page - 1) * limit,
    });
    return ok({ ...result, page, limit });
  }

  if (method === 'GET' && path === '/warns') return ok({ users: await store.warnRanking(), now: Date.now() });

  const warnMatch = /^\/warns\/(\d+)$/.exec(path);
  if (method === 'DELETE' && warnMatch) {
    const warn = await store.removeWarn(Number(warnMatch[1]));
    if (!warn) return fail(404, 'Nie ma takiego ostrzeżenia');
    if (warn.caseId) await store.updateCase(warn.caseId, { note: 'Ostrzeżenie usunięte w panelu' });
    if (bot.discord) {
      await sendModLog(bot, await store.getConfig(), {
        embeds: [
          simpleEmbed('success', `🗑️ Usunięto ostrzeżenie #${warn.id} (panel)`, `**Użytkownik:** <@${warn.userId}>\n**Treść:** ${warn.reason} (${warn.points} pkt)`),
        ],
      });
    }
    return ok({ ok: true });
  }

  if (method === 'GET' && path === '/tempbans') return ok({ bans: await store.listTempBans(), now: Date.now() });

  const unbanMatch = /^\/tempbans\/(\d+)\/unban$/.exec(path);
  if (method === 'POST' && unbanMatch) {
    const ban = (await store.listTempBans()).find((b) => b.userId === unbanMatch[1]);
    if (!ban) return fail(404, 'Nie ma takiego bana');
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    const target = await bot.discord.get(`/users/${ban.userId}`).catch(() => null);
    if (!target) {
      await store.removeTempBan(ban.guildId, ban.userId);
      return fail(404, 'Nie znaleziono użytkownika — usunięto wpis.');
    }
    try {
      const { botUser } = await getGuildContext(bot);
      await unbanUser(bot, { target, moderator: botUser, reason: 'Ban zdjęty w panelu', announce: false });
      return ok({ ok: true });
    } catch (error) {
      await store.removeTempBan(ban.guildId, ban.userId);
      return fail(400, describeError(error));
    }
  }

  // Dostęp do panelu: aktywne loginy z /login (części panelu liczone z obecnej konfiguracji i ról z chwili
  // /login). Unieważnienie loginu wylogowuje też wszystkie jego przeglądarki — osoba musi wpisać /login.
  if (method === 'GET' && path === '/access/logins') {
    const config = await store.getConfig();
    const logins = (await store.listPanelLogins()).map((login) => ({ ...login, ...sectionAccess(login, config) }));
    return ok({ logins, sections: PANEL_SECTIONS, now: Date.now() });
  }
  if (method === 'DELETE' && path === '/access/logins') return ok({ removed: await store.deletePanelLogins({ kind: 'login' }) });
  const loginMatch = /^\/access\/logins\/(\d+)$/.exec(path);
  if (method === 'DELETE' && loginMatch) {
    if (!(await store.deletePanelLogins({ id: Number(loginMatch[1]), kind: 'login' }))) return fail(404, 'Nie ma takiego loginu');
    return ok({ ok: true });
  }

  // Poziomy: ranking z wyszukiwaniem, ręczne zmiany XP, reset, test wiadomości o awansie, import z Arcane.
  if (method === 'GET' && path === '/levels') {
    const { levels } = await store.getConfig();
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const search = String(query.search ?? '').trim();
    const [rows, total] = await Promise.all([store.levelLeaderboard({ limit, offset, search }), store.countLevels(search)]);
    return ok({ entries: rows.map((r) => ({ ...r, ...levelProgress(r.xp, levels.formula) })), total, now: Date.now() });
  }
  const levelUser = /^\/levels\/user\/(\w+)$/.exec(path);
  const ownerOnlyReset = async () => {
    const { levels } = await store.getConfig();
    if (!levels.management.lockReset || auth.kind === 'password') return false;
    const { guild } = await getGuildContext(bot);
    return auth.user?.id !== guild.ownerId;
  };
  if (method === 'POST' && levelUser) {
    const mode = String(body?.mode ?? '');
    if (!['add', 'set', 'level', 'reset'].includes(mode)) return fail(400, 'Nieznana zmiana.');
    if (mode === 'reset' && (await ownerOnlyReset())) return fail(403, 'Resetowanie XP jest zablokowane — może to zrobić tylko właściciel serwera.');
    const amount = Math.trunc(Number(body?.amount) || 0);
    return attempt(async () => ({ result: await changeXp(bot, levelUser[1], { mode, amount }) }));
  }
  if (method === 'POST' && path === '/levels/reset-all') {
    if (body?.confirm !== true) return fail(400, 'Potwierdź reset.');
    if (await ownerOnlyReset()) return fail(403, 'Resetowanie XP jest zablokowane — może to zrobić tylko właściciel serwera.');
    return ok({ reset: await store.resetLevels() });
  }
  if (method === 'POST' && path === '/levels/test') {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    const channelId = String(body?.channelId ?? '');
    if (!/^\d{15,25}$/.test(channelId)) return fail(400, 'Wybierz kanał.');
    return attempt(async () => {
      const { levels } = await store.getConfig();
      const gctx = await getGuildContext(bot);
      // Test na prawdziwych danych: osoba zalogowana w panelu (albo bot), jej XP, avatar i baner z Discorda.
      const user = { id: auth.user?.id ?? gctx.botUser.id };
      const row = await store.getLevel(user.id);
      const xp = row?.xp || 1375;
      const level = Math.max(1, levelProgress(xp, levels.formula).level);
      const earned = levels.rewards.filter((r) => r.level <= level).slice(-1);
      const message = await levelUpMessage(bot, levels, { user, level, previous: level - 1, xp, earned });
      await bot.discord.post(`/channels/${channelId}/messages`, {
        ...message,
        content: `-# Test wiadomości o awansie (z panelu)\n${message.content}`.slice(0, 2000),
        allowed_mentions: { parse: [] },
      });
      return { ok: true };
    });
  }
  if (method === 'POST' && path === '/levels/import') {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    const { entries, invalid } = Array.isArray(body?.entries) ? { entries: body.entries, invalid: [] } : parseImport(body?.text);
    if (!entries.length) return fail(400, 'Brak poprawnych linii do importu (format: nazwa poziom xp [wiadomości] [reakcje]).');
    return attempt(async () => ({ ...(await importLevels(bot, entries.slice(0, 1000))), invalid }));
  }

  // Nowa rola (np. pingowana przy rankingach poziomów) — bez uprawnień, tylko pełny dostęp.
  if (method === 'POST' && path === '/roles') {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    const name = String(body?.name ?? '').trim().slice(0, 100);
    if (!name) return fail(400, 'Podaj nazwę roli.');
    const color = /^#[0-9a-f]{6}$/i.test(String(body?.color ?? '')) ? parseInt(body.color.slice(1), 16) : 0;
    return attempt(async () => {
      const { guild } = await getGuildContext(bot);
      const role = await bot.discord.post(`/guilds/${guild.id}/roles`, { name, color, permissions: '0', mentionable: body?.mentionable === true, hoist: false }, { reason: `Panel (${auth.user ? auth.user.tag : 'hasło panelu'})` });
      bot.cache.delete('guildCtx');
      return { role: { id: role.id, name: role.name } };
    });
  }

  // Uprawnienia ról w samym Discordzie (wybrane uprawnienia moderacji).
  const roleMatch = /^\/roles\/(\d+)\/permissions$/.exec(path);
  if (method === 'POST' && roleMatch) {
    if (!bot.discord) return fail(503, 'Bot nie jest skonfigurowany (brak DISCORD_TOKEN).');
    return attempt(async () => ({ role: await setRolePermission(bot, auth, roleMatch[1], String(body?.permission ?? ''), body?.value === true) }));
  }

  return fail(404, 'Nie znaleziono');
}
