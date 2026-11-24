// Eventy na stronie rankingu — zakładka „Eventy” pokazuje się tylko wtedy, gdy jakiś event jest zaplanowany,
// trwa albo skończył się w ostatnich 3 dniach. Każdy event ma warunek dostania się: zaprosić `invites` osób
// i/lub napisać `messages` wiadomości (0 = bez tego warunku). Jak to działa dla osoby:
//   1. łączy konto („Zaloguj przez Discord” na stronie albo link z /polacz) i klika „Zapisz się”,
//   2. od chwili zapisu (najwcześniej od startu eventu) liczą się jej zaproszenia i wiadomości — pasek postępu,
//   3. po spełnieniu warunku „Dostałeś się!” — bot ogłasza to na kanale wybranym w panelu,
//   4. opcjonalnie losowanie nagród wśród tych, którzy się dostali: ręcznie (panel) albo samo po końcu eventu.
// Zaproszenia liczą się tylko za osoby, które weszły z zaproszenia, nadal są na serwerze, nie były na nim wcześniej
// i mają konto starsze niż minAccountDays dni. Wiadomości liczą się tak jak do poziomów (cooldown, kanały bez XP,
// ochrona przed nabijaniem).

import { PANEL_SITE } from './access.js';
import { DiscordError, avatarUrl } from './rest.js';
import { ActionError, getGuildContext } from './moderation.js';
import * as embeds from './embeds.js';
import { discordTimestamp, plural } from './duration.js';

const DAY = 24 * 60 * 60_000;
export const CONTEST_SHOW_AFTER_MS = 3 * DAY;
const LINK_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 90 * DAY;
const SEEN_EVERY_MS = 60 * 60_000;
const TOP = 100;
// Strona rankingu — tu wraca też logowanie przez Discord (adres musi być na liście Redirects aplikacji w Developer Portal).
export const CONTEST_SITE = `${PANEL_SITE}ranking.html`;
export const OAUTH_REDIRECT = CONTEST_SITE;
// Biernik („zaprosić 1 osobę / 2 osoby”, „napisać 1 wiadomość”).
const UNITS = { invites: ['osobę', 'osoby', 'osób'], messages: ['wiadomość', 'wiadomości', 'wiadomości'] };
// Dopełniacz („brakuje 1 osoby / 2 osób”).
const UNITS_OF = { invites: ['osoby', 'osób', 'osób'], messages: ['wiadomości', 'wiadomości', 'wiadomości'] };
const DRAWS = 'contest_draws';

// Brak połączenia albo wygasła sesja — API odpowiada 401 (strona prosi o ponowne połączenie).
export class MemberAuthError extends Error {}
// Nie da się zapisać (np. event się skończył) — API odpowiada 400 z tym komunikatem.
export class ContestError extends Error {}

const pl = (n) => Number(n).toLocaleString('pl-PL');
export const unitText = (kind, n, { of = false } = {}) => `${pl(n)} ${plural(Math.abs(n), (of ? UNITS_OF : UNITS)[kind])}`;

export function contestStatus(c, now = Date.now()) {
  if (now < Date.parse(c.startsAt)) return 'upcoming';
  return now < Date.parse(c.endsAt) ? 'live' : 'ended';
}
// Rodzaj do wyglądu (ikona, kolor): tylko zaproszenia, tylko wiadomości albo oba warunki.
export const contestKind = (c) => (c.invites > 0 && c.messages > 0 ? 'mixed' : c.invites > 0 ? 'invites' : 'messages');
export function requirementText(c) {
  const parts = [];
  if (c.invites > 0) parts.push(`zaprosić ${unitText('invites', c.invites)}`);
  if (c.messages > 0) parts.push(`napisać ${unitText('messages', c.messages)}`);
  return parts.join(' i ');
}

const contestsOn = (config) => config.contests?.enabled !== false;
const contestList = (config) => (contestsOn(config) ? (config.contests?.list ?? []) : []);

// Widoczne na stronie: zaplanowane, trwające i zakończone w ostatnich 3 dniach.
export const visibleContests = (config, now = Date.now()) => contestList(config).filter((c) => Date.parse(c.endsAt) + CONTEST_SHOW_AFTER_MS > now);
export const liveContests = (config, now = Date.now()) => contestList(config).filter((c) => contestStatus(c, now) === 'live');

// Trwające eventy z warunkiem wiadomości — policzona wiadomość zapisanej osoby to +1 (store.awardXp).
export const messageContestIds = (config, now = Date.now()) => liveContests(config, now).filter((c) => c.messages > 0).map((c) => c.id);
// Trwa event z zaproszeniami — bot musi sprawdzać, kto kogo zaprosił, nawet bez logów wejść.
export const inviteContestLive = (config, now = Date.now()) => liveContests(config, now).some((c) => c.invites > 0);
// Event z zaproszeniami zaplanowany albo trwający — gateway potrzebuje wtedy wejść i wyjść z serwera.
export const inviteContestPlanned = (config, now = Date.now()) => contestList(config).some((c) => c.invites > 0 && Date.parse(c.endsAt) > now);
// Najwcześniejszy start trwającego eventu z zaproszeniami (stan zaproszeń sprzed niego trzeba odświeżyć).
export function inviteContestStart(config, now = Date.now()) {
  const starts = liveContests(config, now).filter((c) => c.invites > 0).map((c) => Date.parse(c.startsAt));
  return starts.length ? Math.min(...starts) : null;
}

// Czy warunek jest spełniony i jak daleko (0–1, średnia z warunków — do kolejności).
export const meetsRequirement = (c, p) => (c.invites <= 0 || p.invites >= c.invites) && (c.messages <= 0 || p.messages >= c.messages);
function progressRatio(c, p) {
  const parts = [];
  if (c.invites > 0) parts.push(Math.min(1, p.invites / c.invites));
  if (c.messages > 0) parts.push(Math.min(1, p.messages / c.messages));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
}

// Zapisani z postępem, w kolejności: najpierw ci, którzy się dostali (kto pierwszy, ten wyżej), potem wg postępu.
async function standings(bot, c, now = Date.now()) {
  const rows = await bot.store.contestProgress(c.id, {
    start: Date.parse(c.startsAt),
    end: Math.min(Date.parse(c.endsAt), now + 60_000),
    invites: c.invites > 0,
    minAccountMs: (c.minAccountDays ?? 0) * DAY,
  });
  return rows
    .map((r) => ({ ...r, reached: contestStatus(c, now) !== 'upcoming' && meetsRequirement(c, r), ratio: progressRatio(c, r) }))
    .sort(
      (a, b) =>
        Number(b.reached) - Number(a.reached) ||
        (a.reached ? (a.qualifiedAt ?? Infinity) - (b.qualifiedAt ?? Infinity) : b.ratio - a.ratio) ||
        a.createdAt - b.createdAt,
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------- Połączenie konta ze stroną ----------
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const linkHash = (token) => sha256(`polacz:${token}`);
const sessionHash = (token) => sha256(`konto:${token}`);

export function describeMember(session) {
  return {
    id: session.userId,
    name: session.displayName || session.userTag || 'Użytkownik',
    tag: session.userTag ?? null,
    avatar: avatarUrl({ id: session.userId, avatar: session.avatar }, 64),
    expiresAt: session.expiresAt,
  };
}

async function newSession(bot, person) {
  const token = randomToken();
  const saved = await bot.store.addMemberLink({ kind: 'session', tokenHash: await sessionHash(token), ...person, ttlMs: SESSION_TTL_MS });
  return { token, me: describeMember(saved) };
}

// /polacz: nowy jednorazowy link (poprzednie, jeszcze nieużyte, przestają działać).
export async function issueMemberLink(bot, ix) {
  await bot.store.deleteMemberLinks({ userId: ix.user.id, kind: 'link' });
  const token = randomToken();
  await bot.store.addMemberLink({
    kind: 'link',
    tokenHash: await linkHash(token),
    userId: ix.user.id,
    userTag: ix.user.username ?? null,
    displayName: ix.member?.nick ?? ix.user.global_name ?? null,
    avatar: ix.user.avatar ?? null,
    ttlMs: LINK_TTL_MS,
  });
  return { url: `${CONTEST_SITE}#polacz=${token}`, expiresAt: Date.now() + LINK_TTL_MS };
}

// Strona: link z /polacz → sesja przeglądarki. Link działa raz.
export async function exchangeMemberLink(bot, token) {
  const text = String(token ?? '');
  const row = /^[\w-]{20,100}$/.test(text) ? await bot.store.takeMemberLink(await linkHash(text)) : null;
  if (!row || row.expiresAt <= Date.now()) throw new MemberAuthError('Link wygasł albo był już użyty — zaloguj się jeszcze raz.');
  return newSession(bot, { userId: row.userId, userTag: row.userTag, displayName: row.displayName, avatar: row.avatar });
}

// Logowanie przez Discord (OAuth2, kod z PKCE — bez sekretu aplikacji). Gotowe, gdy adres strony jest na liście
// Redirects aplikacji (bot sprawdza to przy konfiguracji: setup.oauthRedirect; null = Discord nie podał listy).
export async function oauthInfo(bot) {
  const setup = await bot.store.getState('setup');
  if (!setup?.appId || setup.oauthRedirect === false) return null;
  return { clientId: setup.appId, redirectUri: OAUTH_REDIRECT };
}

// Strona: kod z Discorda (+ code_verifier PKCE) → kto to jest → sesja przeglądarki.
export async function exchangeOAuthCode(bot, { code, verifier }) {
  const info = await oauthInfo(bot);
  if (!info || !bot.discord) throw new ContestError('Logowanie przez Discord nie jest jeszcze włączone — połącz konto komendą /polacz.');
  if (!/^[\w-]{10,200}$/.test(String(code ?? '')) || !/^[\w.~-]{43,128}$/.test(String(verifier ?? ''))) {
    throw new MemberAuthError('Logowanie nie powiodło się — spróbuj jeszcze raz.');
  }
  let token;
  try {
    token = await bot.discord.post('/oauth2/token', undefined, {
      auth: null,
      form: { grant_type: 'authorization_code', code: String(code), redirect_uri: info.redirectUri, client_id: info.clientId, code_verifier: String(verifier) },
    });
  } catch (error) {
    if (error instanceof DiscordError && error.status < 500) throw new MemberAuthError('Logowanie wygasło albo zostało przerwane — spróbuj jeszcze raz.');
    throw error;
  }
  if (!String(token?.scope ?? '').split(' ').includes('identify')) throw new MemberAuthError('Discord nie podał, kim jesteś — spróbuj jeszcze raz.');
  const user = await bot.discord.get('/users/@me', { auth: `Bearer ${token.access_token}` });
  if (!user?.id || user.bot) throw new MemberAuthError('Logowanie nie powiodło się — spróbuj jeszcze raz.');
  // Pseudonim na serwerze (jeśli tu jest) — tak jak w rankingu.
  const gctx = await getGuildContext(bot).catch(() => null);
  const member = gctx ? await bot.discord.get(`/guilds/${gctx.guild.id}/members/${user.id}`).catch(() => null) : null;
  return newSession(bot, { userId: user.id, userTag: user.username ?? null, displayName: member?.nick ?? user.global_name ?? null, avatar: user.avatar ?? null });
}

// Sesja z nagłówka x-member-session. null = brak nagłówka.
export async function memberSession(bot, token) {
  if (!token) return null;
  const text = String(token);
  const session = /^[\w-]{20,100}$/.test(text) ? await bot.store.getMemberSession(await sessionHash(text)) : null;
  if (!session) throw new MemberAuthError('Połączenie z kontem wygasło — zaloguj się jeszcze raz.');
  if (!session.lastSeenAt || Date.now() - session.lastSeenAt > SEEN_EVERY_MS) await bot.store.touchMemberSession(session.id).catch(() => {});
  return session;
}

export async function endMemberSession(bot, token) {
  const text = String(token ?? '');
  if (!/^[\w-]{20,100}$/.test(text)) return 0;
  return bot.store.deleteMemberLinks({ tokenHash: await sessionHash(text), kind: 'session' });
}

// ---------- Widok eventów na stronie ----------
function personView(p, session, gctx) {
  const mine = session?.userId === p.userId;
  const base = { rank: p.rank, invites: p.invites, messages: p.messages, reached: p.reached, won: Boolean(p.wonAt), me: mine, joinedAt: p.createdAt, qualifiedAt: p.qualifiedAt };
  // Osoba ukryta komendą /prywatnosc: miejsce i postęp zostają, bez nazwy, avatara i ID.
  if (p.hidden && !mine) return { ...base, hidden: true, userId: null, name: 'Ukryta osoba', displayName: null, avatar: null };
  return {
    ...base,
    userId: p.userId,
    name: p.userTag ?? 'Użytkownik',
    displayName: p.displayName && p.displayName !== p.userTag ? p.displayName : null,
    avatar:
      p.guildAvatar && gctx
        ? `https://cdn.discordapp.com/guilds/${gctx.guild.id}/users/${p.userId}/avatars/${p.guildAvatar}.png?size=64`
        : avatarUrl({ id: p.userId, avatar: p.avatar }, 64),
  };
}

async function contestView(bot, c, { session, now, gctx, draws }) {
  const status = contestStatus(c, now);
  const people = await standings(bot, c, now);
  let me = null;
  if (session) {
    const mine = people.find((p) => p.userId === session.userId);
    me = mine
      ? { joined: true, rank: mine.rank, invites: mine.invites, messages: mine.messages, reached: mine.reached, won: Boolean(mine.wonAt), joinedAt: mine.createdAt, canJoin: false, blocker: null }
      : { joined: false, rank: null, invites: 0, messages: 0, reached: false, won: false, joinedAt: null, canJoin: status !== 'ended', blocker: status === 'ended' ? 'Ten event już się skończył.' : null };
  }
  const drawn = draws?.[c.id] ?? null;
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    prize: c.prize,
    type: contestKind(c),
    status,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    invites: c.invites,
    messages: c.messages,
    minAccountDays: c.invites > 0 ? c.minAccountDays : null,
    participants: people.length,
    qualified: people.filter((p) => p.reached).length,
    draw: c.drawWinners > 0 || drawn ? { winners: c.drawWinners, mode: c.drawMode, done: Boolean(drawn), at: drawn?.at ?? null } : null,
    winners: people.filter((p) => p.wonAt).map((p) => personView(p, session, gctx)),
    entries: people.slice(0, TOP).map((p) => personView(p, session, gctx)),
    me,
  };
}

// GET /panel/public/contests — eventy na stronie (z postępem połączonej osoby, gdy jest sesja).
// Nieważna sesja nie psuje strony: expired = true, a strona prosi o ponowne połączenie.
export async function publicContests(bot, { token = null, now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const list = visibleContests(config, now);
  let session = null;
  let expired = false;
  try {
    session = await memberSession(bot, token);
  } catch (error) {
    if (!(error instanceof MemberAuthError)) throw error;
    expired = true;
  }
  const gctx = list.length && bot.discord ? await getGuildContext(bot).catch(() => null) : null;
  const draws = list.length ? ((await bot.store.getState(DRAWS)) ?? {}) : {};
  const contests = [];
  for (const c of list) contests.push(await contestView(bot, c, { session, now, gctx, draws }));
  return { enabled: contestsOn(config), contests, me: session ? describeMember(session) : null, expired, oauth: await oauthInfo(bot), now };
}

async function stillMember(bot, userId) {
  if (!bot.discord) return true;
  const gctx = await getGuildContext(bot);
  try {
    await bot.discord.get(`/guilds/${gctx.guild.id}/members/${userId}`);
    return true;
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return false;
    throw error;
  }
}

// POST /panel/public/contests/:id/join — zapis. Od tej chwili liczą się zaproszenia i wiadomości tej osoby.
export async function joinContest(bot, { token, contestId, now = Date.now() }) {
  const session = await memberSession(bot, token);
  if (!session) throw new MemberAuthError('Najpierw połącz konto — zaloguj się przez Discord.');
  const config = await bot.store.getConfig();
  const c = visibleContests(config, now).find((x) => x.id === contestId);
  if (!c) throw new ContestError('Nie ma takiego eventu.');
  if (contestStatus(c, now) === 'ended') throw new ContestError('Ten event już się skończył.');
  if (!(await stillMember(bot, session.userId))) throw new ContestError('Nie ma Cię na serwerze — wróć na niego, żeby się zapisać.');
  const entry = await bot.store.addContestEntry({
    contestId: c.id,
    userId: session.userId,
    userTag: session.userTag,
    displayName: session.displayName,
    avatar: session.avatar,
  });
  return { joined: true, already: !entry };
}

// ---------- Kto się dostał (cron) ----------
// Trwające eventy (i te zakończone w ostatniej godzinie — ostatnie zaproszenia): osoby, które właśnie spełniły
// warunek, dostają znacznik qualified_at, a bot ogłasza to na kanale z panelu.
export async function contestsTick(bot, { now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const list = contestList(config).filter((c) => Date.parse(c.startsAt) <= now && Date.parse(c.endsAt) + 60 * 60_000 > now);
  let marked = 0;
  for (const c of list) {
    const fresh = (await standings(bot, c, now)).filter((p) => p.reached && !p.qualifiedAt);
    if (!fresh.length) continue;
    const ids = await bot.store.markContestQualified(c.id, fresh.map((p) => p.userId));
    marked += ids.length;
    for (const p of fresh.filter((x) => ids.includes(x.userId))) {
      await logQualified(bot, config, c, p).catch((error) => console.warn(`[eventy] Ogłoszenie: ${error.message}`));
    }
  }
  // Losowanie samo po końcu eventu (raz).
  const due = contestList(config).filter((c) => c.drawMode === 'auto' && c.drawWinners > 0 && Date.parse(c.endsAt) <= now && Date.parse(c.endsAt) + CONTEST_SHOW_AFTER_MS > now);
  if (due.length) {
    const draws = (await bot.store.getState(DRAWS)) ?? {};
    for (const c of due.filter((x) => !draws[x.id])) await drawContest(bot, c.id, { by: null, now }).catch((error) => console.warn(`[eventy] Losowanie: ${error.message}`));
  }
  return marked;
}

// ---------- Losowanie ----------
// Uczciwe tasowanie (Fisher–Yates na crypto.getRandomValues) — pierwsze `n` osób wygrywa.
function pickRandom(list, n) {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const r = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [pool[i], pool[r]] = [pool[r], pool[i]];
  }
  return pool.slice(0, n);
}

// Losuje zwycięzców wśród osób, które teraz spełniają warunek (kolejne losowanie zastępuje poprzednie).
// by — kto losował (null = automatycznie po końcu eventu). Zwraca { winners: [...], pool }.
export async function drawContest(bot, contestId, { by = null, now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const c = (config.contests?.list ?? []).find((x) => x.id === contestId);
  if (!c) throw new ContestError('Nie ma takiego eventu — może nie został jeszcze zapisany.');
  if (contestStatus(c, now) === 'upcoming') throw new ContestError('Event jeszcze się nie zaczął — nie ma kogo losować.');
  const eligible = (await standings(bot, c, now)).filter((p) => p.reached);
  const picked = pickRandom(eligible, Math.max(1, c.drawWinners || 1));
  await bot.store.setContestWinners(c.id, picked.map((p) => p.userId));
  const draws = (await bot.store.getState(DRAWS)) ?? {};
  draws[c.id] = { at: now, by, winners: picked.map((p) => p.userId), pool: eligible.length };
  await bot.store.setState(DRAWS, draws);
  await logDraw(bot, config, c, picked, { by, pool: eligible.length }).catch((error) => console.warn(`[eventy] Ogłoszenie losowania: ${error.message}`));
  return { winners: picked.map((p) => ({ userId: p.userId, userTag: p.userTag, displayName: p.displayName })), pool: eligible.length };
}

async function logDraw(bot, config, c, picked, { by, pool }) {
  const { logChannelId, pingRoleId } = config.contests;
  if (!logChannelId || !bot.discord) return;
  const names = picked.map((p, i) => `${['🥇', '🥈', '🥉'][i] ?? '🏅'} <@${p.userId}>`);
  const ids = picked.map((p) => p.userId);
  await bot.discord.post(`/channels/${logChannelId}/messages`, {
    content: [pingRoleId ? `<@&${pingRoleId}>` : '', ...ids.map((id) => `<@${id}>`)].filter(Boolean).join(' ') || undefined,
    allowed_mentions: { users: ids, roles: pingRoleId ? [pingRoleId] : [] },
    embeds: [
      {
        color: embeds.COLORS.success,
        title: `🎲 Losowanie — ${c.name}`.slice(0, 256),
        description: [
          picked.length
            ? `**${picked.length === 1 ? 'Zwycięzca' : 'Zwycięzcy'}:**\n${names.join('\n')}`
            : 'Nikt nie spełnił warunku — nie było kogo losować.',
          ...(c.prize ? [`**Nagroda:** ${c.prize}`] : []),
          `-# Losowanie wśród ${pool} ${pool === 1 ? 'osoby, która się dostała' : `${plural(pool, ['osoby', 'osób', 'osób'])}, które się dostały`}${by ? ` · losował(a): ${by}` : ' · automatycznie po końcu eventu'}.`,
        ].join('\n'),
        footer: { text: embeds.BRAND },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Zobacz event', url: `${CONTEST_SITE}#eventy` }] }],
  });
}

async function logQualified(bot, config, c, p) {
  const { logChannelId, pingRoleId } = config.contests;
  if (!logChannelId || !bot.discord) return;
  const done = [];
  if (c.invites > 0) done.push(`zaprosił(a) **${unitText('invites', p.invites)}** (warunek: ${c.invites})`);
  if (c.messages > 0) done.push(`napisał(a) **${unitText('messages', p.messages)}** (warunek: ${c.messages})`);
  await bot.discord.post(`/channels/${logChannelId}/messages`, {
    ...(pingRoleId ? { content: `<@&${pingRoleId}>`, allowed_mentions: { roles: [pingRoleId] } } : { allowed_mentions: { parse: [] } }),
    embeds: [
      {
        color: embeds.COLORS.success,
        title: `✅ Dostał(a) się — ${c.name}`.slice(0, 256),
        description: [
          `<@${p.userId}> spełnił(a) warunek eventu: ${done.join(', ')}.`,
          ...(c.prize ? [`**Nagroda:** ${c.prize}`] : []),
          `**Koniec eventu:** ${discordTimestamp(Date.parse(c.endsAt), 'f')}`,
        ].join('\n'),
        footer: { text: `ID: ${p.userId} • ${embeds.BRAND}` },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Zobacz event', url: `${CONTEST_SITE}#eventy` }] }],
  });
}

// ---------- Panel ----------
// Zapisani z postępem (także osoby ukryte na stronie).
export async function contestDetails(bot, contestId, { now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const c = (config.contests?.list ?? []).find((x) => x.id === contestId);
  if (!c) return null;
  const people = (await standings(bot, c, now)).map((p) => ({
    rank: p.rank,
    userId: p.userId,
    userTag: p.userTag,
    displayName: p.displayName,
    hidden: p.hidden,
    invites: p.invites,
    messages: p.messages,
    reached: p.reached,
    joinedAt: p.createdAt,
    qualifiedAt: p.qualifiedAt,
    won: Boolean(p.wonAt),
  }));
  const drawn = ((await bot.store.getState(DRAWS)) ?? {})[c.id] ?? null;
  return { contest: { ...c, status: contestStatus(c, now) }, entries: people, draw: drawn };
}

// Panel: czy logowanie przez Discord na stronie jest gotowe (adres strony na liście Redirects aplikacji).
export async function oauthStatus(bot) {
  const setup = await bot.store.getState('setup');
  return { redirectUri: OAUTH_REDIRECT, registered: setup?.oauthRedirect ?? null, checkedAt: setup?.checkedAt ?? null };
}

export async function contestsCleanupTick(bot) {
  await bot.store.pruneMemberLinks();
  const config = await bot.store.getConfig();
  await bot.store.pruneContestData((config.contests?.list ?? []).map((c) => c.id));
}

// ---------- /polacz ----------
const polacz = {
  permission: null,
  defer: 'ephemeral',
  data: { name: 'polacz', description: '🔗 Połącz konto ze stroną eventów (gdy logowanie przez Discord nie działa)', contexts: [0] },
  async execute(ix, bot) {
    const config = await bot.store.getConfig();
    if (!contestsOn(config)) throw new ActionError('Eventy są wyłączone — administrator może je włączyć w panelu (zakładka „Eventy”).');
    const { url, expiresAt } = await issueMemberLink(bot, ix);
    const live = visibleContests(config).filter((c) => contestStatus(c) !== 'ended');
    const list = live.length
      ? live.map((c) => `• **${c.name}** — trzeba ${requirementText(c)}${contestStatus(c) === 'upcoming' ? `, start ${discordTimestamp(Date.parse(c.startsAt), 'R')}` : `, koniec ${discordTimestamp(Date.parse(c.endsAt), 'R')}`}`).join('\n')
      : 'Teraz nie trwa żaden event — połączenie i tak się przyda, gdy ruszy następny.';
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.info,
          title: '🔗 Połącz konto ze stroną eventów',
          description: [
            'Kliknij przycisk poniżej — strona rankingu otworzy się już połączona z Twoim kontem. Zapiszesz się tam do eventu i zobaczysz swój postęp.',
            '',
            list,
            '',
            `-# Link działa raz i wygasa ${discordTimestamp(expiresAt, 'R')}. Nie dawaj go nikomu — kto go otworzy, ten zostanie połączony z Twoim kontem.`,
          ].join('\n'),
          footer: { text: embeds.BRAND },
        },
      ],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Połącz konto', emoji: { name: '🔗' }, url }] }],
    });
  },
};

export const CONTEST_COMMANDS = [polacz];
