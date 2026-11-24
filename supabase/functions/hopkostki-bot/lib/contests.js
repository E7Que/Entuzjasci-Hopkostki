// Eventy (konkursy) na stronie rankingu — zakładka „Eventy” pokazuje się tylko wtedy, gdy jakiś event jest
// zaplanowany, trwa albo skończył się w ostatnich 3 dniach (wyniki). Rodzaje:
//   invites  — zaproszenia: liczą się osoby, które weszły z zaproszenia w czasie eventu, nadal są na serwerze,
//              nie były na nim wcześniej i mają konto starsze niż minAccountDays dni,
//   messages — wiadomości liczone tak jak do poziomów (cooldown, kanały bez XP, ochrona przed nabijaniem),
//   mixed    — punkty: zaproszenie × points.invite + wiadomość × points.message.
// Udział wymaga połączenia konta: /polacz daje jednorazowy link (15 minut), który na stronie zamienia się w sesję
// przeglądarki (90 dni). Event bez progu: „Dołącz” — i jesteś w rankingu uczestników. Event z progiem (goal):
// pasek postępu, a po jego osiągnięciu „Zgłoś się” — zgłoszenie trafia też na kanał wybrany w panelu.

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
export const CONTEST_SITE = `${PANEL_SITE}ranking.html`;
export const CONTEST_TYPE_LABELS = { invites: 'Zaproszenia', messages: 'Wiadomości', mixed: 'Mieszany' };
const UNITS = {
  invites: ['zaproszenie', 'zaproszenia', 'zaproszeń'],
  messages: ['wiadomość', 'wiadomości', 'wiadomości'],
  mixed: ['punkt', 'punkty', 'punktów'],
};
// Dopełniacz („brakuje 1 zaproszenia / 2 zaproszeń”).
const UNITS_OF = {
  invites: ['zaproszenia', 'zaproszeń', 'zaproszeń'],
  messages: ['wiadomości', 'wiadomości', 'wiadomości'],
  mixed: ['punktu', 'punktów', 'punktów'],
};
const ZERO = Object.freeze({ invites: 0, messages: 0, score: 0 });

// Brak połączenia albo wygasła sesja — API odpowiada 401 (strona prosi o ponowne /polacz).
export class MemberAuthError extends Error {}
// Nie da się dołączyć (np. próg nieosiągnięty) — API odpowiada 400 z tym komunikatem.
export class ContestError extends Error {}

const pl = (n) => Number(n).toLocaleString('pl-PL');
export const unitText = (type, n, { of = false } = {}) => `${pl(n)} ${plural(Math.abs(n), (of ? UNITS_OF : UNITS)[type] ?? UNITS.mixed)}`;

export function contestStatus(c, now = Date.now()) {
  if (now < Date.parse(c.startsAt)) return 'upcoming';
  return now < Date.parse(c.endsAt) ? 'live' : 'ended';
}

const contestsOn = (config) => config.contests?.enabled !== false;
const contestList = (config) => (contestsOn(config) ? (config.contests?.list ?? []) : []);

// Widoczne na stronie: zaplanowane, trwające i zakończone w ostatnich 3 dniach.
export const visibleContests = (config, now = Date.now()) => contestList(config).filter((c) => Date.parse(c.endsAt) + CONTEST_SHOW_AFTER_MS > now);
export const liveContests = (config, now = Date.now()) => contestList(config).filter((c) => contestStatus(c, now) === 'live');
const countsInvites = (c) => c.type !== 'messages';
const countsMessages = (c) => c.type !== 'invites';

// Eventy, w których liczy się teraz każda wiadomość (wiadomości i mieszane, w trakcie).
export const messageContestIds = (config, now = Date.now()) => liveContests(config, now).filter(countsMessages).map((c) => c.id);
// Trwa event z zaproszeniami — bot musi sprawdzać, kto kogo zaprosił, nawet bez logów wejść.
export const inviteContestLive = (config, now = Date.now()) => liveContests(config, now).some(countsInvites);
// Event z zaproszeniami zaplanowany albo trwający — gateway potrzebuje wtedy wejść i wyjść z serwera.
export const inviteContestPlanned = (config, now = Date.now()) => contestList(config).some((c) => countsInvites(c) && Date.parse(c.endsAt) > now);
// Najwcześniejszy start trwającego eventu z zaproszeniami (stan zaproszeń sprzed niego trzeba odświeżyć).
export function inviteContestStart(config, now = Date.now()) {
  const starts = liveContests(config, now).filter(countsInvites).map((c) => Date.parse(c.startsAt));
  return starts.length ? Math.min(...starts) : null;
}

export function contestScore(c, { invites = 0, messages = 0 }) {
  if (c.type === 'invites') return invites;
  if (c.type === 'messages') return messages;
  return invites * (c.points?.invite ?? 0) + messages * (c.points?.message ?? 0);
}

// Wyniki osób w evencie: Map(userId → { invites, messages, score }). userIds = null → wszyscy z jakimkolwiek wynikiem.
export async function contestResults(bot, c, userIds = null) {
  if (userIds && !userIds.length) return new Map();
  const [invites, messages] = await Promise.all([
    countsInvites(c)
      ? bot.store.contestInvites({ start: Date.parse(c.startsAt), end: Date.parse(c.endsAt), minAccountMs: (c.minAccountDays ?? 0) * DAY, inviterIds: userIds })
      : new Map(),
    countsMessages(c) ? bot.store.contestMessages(c.id, userIds) : new Map(),
  ]);
  const ids = userIds ?? [...new Set([...invites.keys(), ...messages.keys()])];
  return new Map(
    ids.map((id) => {
      const r = { invites: invites.get(id) ?? 0, messages: messages.get(id) ?? 0 };
      return [id, { ...r, score: contestScore(c, r) }];
    }),
  );
}

// Dlaczego ta osoba nie może teraz dołączyć / się zgłosić (null = może).
function joinBlocker(c, status, result) {
  if (status === 'ended') return 'Ten event już się skończył.';
  if (c.goal > 0) {
    if (status === 'upcoming') return `Zgłoszenia ruszą razem z eventem — ${new Date(c.startsAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`;
    if (result.score < c.goal) return `Do zgłoszenia brakuje Ci jeszcze ${unitText(c.type, c.goal - result.score, { of: true })}.`;
  }
  return null;
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
  if (!row || row.expiresAt <= Date.now()) throw new MemberAuthError('Link wygasł albo był już użyty — wpisz /polacz na serwerze jeszcze raz.');
  const session = randomToken();
  const saved = await bot.store.addMemberLink({
    kind: 'session',
    tokenHash: await sessionHash(session),
    userId: row.userId,
    userTag: row.userTag,
    displayName: row.displayName,
    avatar: row.avatar,
    ttlMs: SESSION_TTL_MS,
  });
  return { token: session, me: describeMember(saved) };
}

// Sesja z nagłówka x-member-session. null = brak nagłówka.
export async function memberSession(bot, token) {
  if (!token) return null;
  const text = String(token);
  const session = /^[\w-]{20,100}$/.test(text) ? await bot.store.getMemberSession(await sessionHash(text)) : null;
  if (!session) throw new MemberAuthError('Połączenie z kontem wygasło — połącz je jeszcze raz (/polacz na serwerze).');
  if (!session.lastSeenAt || Date.now() - session.lastSeenAt > SEEN_EVERY_MS) await bot.store.touchMemberSession(session.id).catch(() => {});
  return session;
}

export async function endMemberSession(bot, token) {
  const text = String(token ?? '');
  if (!/^[\w-]{20,100}$/.test(text)) return 0;
  return bot.store.deleteMemberLinks({ tokenHash: await sessionHash(text), kind: 'session' });
}

// ---------- Widok eventów na stronie ----------
function personView({ entry, result }, rank, c, session, gctx) {
  const mine = session?.userId === entry.userId;
  const base = {
    rank,
    score: result.score,
    invites: result.invites,
    messages: result.messages,
    reached: c.goal > 0 ? result.score >= c.goal : null,
    me: mine,
    joinedAt: entry.createdAt,
  };
  // Osoba ukryta komendą /prywatnosc: miejsce i wynik zostają, bez nazwy, avatara i ID.
  if (entry.hidden && !mine) return { ...base, hidden: true, userId: null, name: 'Ukryta osoba', displayName: null, avatar: null };
  return {
    ...base,
    userId: entry.userId,
    name: entry.userTag ?? 'Użytkownik',
    displayName: entry.displayName && entry.displayName !== entry.userTag ? entry.displayName : null,
    avatar:
      entry.guildAvatar && gctx
        ? `https://cdn.discordapp.com/guilds/${gctx.guild.id}/users/${entry.userId}/avatars/${entry.guildAvatar}.png?size=64`
        : avatarUrl({ id: entry.userId, avatar: entry.avatar }, 64),
  };
}

async function contestView(bot, c, { session, now, gctx }) {
  const status = contestStatus(c, now);
  const entries = await bot.store.contestEntries(c.id);
  const ids = entries.map((e) => e.userId);
  if (session && !ids.includes(session.userId)) ids.push(session.userId);
  const results = status === 'upcoming' ? new Map() : await contestResults(bot, c, ids);
  const ranked = entries
    .map((entry) => ({ entry, result: results.get(entry.userId) ?? ZERO }))
    .sort((a, b) => b.result.score - a.result.score || a.entry.createdAt - b.entry.createdAt);
  let me = null;
  if (session) {
    const result = results.get(session.userId) ?? ZERO;
    const place = ranked.findIndex((x) => x.entry.userId === session.userId);
    const blocker = place >= 0 ? null : joinBlocker(c, status, result);
    me = {
      joined: place >= 0,
      rank: place >= 0 ? place + 1 : null,
      ...result,
      reached: c.goal > 0 ? result.score >= c.goal : null,
      canJoin: place < 0 && !blocker,
      blocker,
    };
  }
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    prize: c.prize,
    type: c.type,
    status,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    goal: c.goal,
    points: c.type === 'mixed' ? c.points : null,
    winners: c.winners,
    minAccountDays: countsInvites(c) ? c.minAccountDays : null,
    participants: entries.length,
    entries: ranked.slice(0, TOP).map((x, i) => personView(x, i + 1, c, session, gctx)),
    me,
  };
}

// GET /panel/public/contests — eventy na stronie (z wynikiem połączonej osoby, gdy jest sesja).
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
  const contests = [];
  for (const c of list) contests.push(await contestView(bot, c, { session, now, gctx }));
  return { enabled: contestsOn(config), contests, me: session ? describeMember(session) : null, expired, now };
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

// POST /panel/public/contests/:id/join — dołączenie (event bez progu) albo zgłoszenie (po osiągnięciu progu).
export async function joinContest(bot, { token, contestId, now = Date.now() }) {
  const session = await memberSession(bot, token);
  if (!session) throw new MemberAuthError('Najpierw połącz konto — wpisz /polacz na serwerze.');
  const config = await bot.store.getConfig();
  const c = visibleContests(config, now).find((x) => x.id === contestId);
  if (!c) throw new ContestError('Nie ma takiego eventu.');
  const status = contestStatus(c, now);
  if (!(await stillMember(bot, session.userId))) throw new ContestError('Nie ma Cię na serwerze — wróć na niego, żeby wziąć udział.');
  const result = status === 'upcoming' ? ZERO : ((await contestResults(bot, c, [session.userId])).get(session.userId) ?? ZERO);
  const entries = await bot.store.contestEntries(c.id);
  if (!entries.some((e) => e.userId === session.userId)) {
    const blocker = joinBlocker(c, status, result);
    if (blocker) throw new ContestError(blocker);
  }
  const entry = await bot.store.addContestEntry({
    contestId: c.id,
    userId: session.userId,
    userTag: session.userTag,
    displayName: session.displayName,
    avatar: session.avatar,
    score: result.score,
  });
  if (entry && c.goal > 0) await logApplication(bot, config, c, session, result).catch((error) => console.warn(`[eventy] Zgłoszenie: ${error.message}`));
  return { joined: true, already: !entry };
}

// Zgłoszenie po osiągnięciu progu → kanał z panelu (z pingiem roli, jeśli ustawiona).
async function logApplication(bot, config, c, session, result) {
  const { logChannelId, pingRoleId } = config.contests;
  if (!logChannelId || !bot.discord) return;
  const parts = c.type === 'mixed' ? ` (${unitText('invites', result.invites)}, ${unitText('messages', result.messages)})` : '';
  await bot.discord.post(`/channels/${logChannelId}/messages`, {
    ...(pingRoleId ? { content: `<@&${pingRoleId}>`, allowed_mentions: { roles: [pingRoleId] } } : { allowed_mentions: { parse: [] } }),
    embeds: [
      {
        color: embeds.COLORS.info,
        title: `🎟️ Nowe zgłoszenie — ${c.name}`.slice(0, 256),
        description: [
          `<@${session.userId}> osiągnął(-ęła) próg i zgłosił(a) się w evencie.`,
          `**Wynik:** ${unitText(c.type, result.score)}${parts} · próg: ${unitText(c.type, c.goal)}`,
          ...(c.prize ? [`**Nagroda:** ${c.prize}`] : []),
          `**Koniec eventu:** ${discordTimestamp(Date.parse(c.endsAt), 'f')}`,
        ].join('\n'),
        footer: { text: `ID: ${session.userId} • ${embeds.BRAND}` },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Zobacz event', url: `${CONTEST_SITE}#eventy` }] }],
  });
}

// ---------- Panel ----------
// Uczestnicy eventu z wynikami (także osoby ukryte na stronie) + najlepsi spoza listy (np. kto najwięcej zaprosił).
export async function contestDetails(bot, contestId, { now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const c = (config.contests?.list ?? []).find((x) => x.id === contestId);
  if (!c) return null;
  const entries = await bot.store.contestEntries(c.id);
  const status = contestStatus(c, now);
  const all = status === 'upcoming' ? new Map() : await contestResults(bot, c);
  const joined = new Set(entries.map((e) => e.userId));
  const people = entries
    .map((e) => ({
      userId: e.userId,
      userTag: e.userTag,
      displayName: e.displayName,
      hidden: e.hidden,
      joinedAt: e.createdAt,
      scoreAtJoin: e.score,
      ...(all.get(e.userId) ?? ZERO),
    }))
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((p, i) => ({ ...p, rank: i + 1, reached: c.goal > 0 ? p.score >= c.goal : null }));
  const best = [...all.entries()]
    .filter(([id, r]) => !joined.has(id) && r.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 20);
  const names = await bot.store.userNames(best.map(([id]) => id));
  const others = best.map(([userId, r]) => ({ userId, ...(names.get(userId) ?? { userTag: null, displayName: null }), ...r, reached: c.goal > 0 ? r.score >= c.goal : null }));
  return { contest: { ...c, status }, entries: people, others };
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
  data: { name: 'polacz', description: '🔗 Połącz konto ze stroną eventów (zakładka „Eventy” na stronie rankingu)', contexts: [0] },
  async execute(ix, bot) {
    const config = await bot.store.getConfig();
    if (!contestsOn(config)) throw new ActionError('Eventy są wyłączone — administrator może je włączyć w panelu (zakładka „Eventy”).');
    const { url, expiresAt } = await issueMemberLink(bot, ix);
    const live = visibleContests(config).filter((c) => contestStatus(c) !== 'ended');
    const list = live.length
      ? live.map((c) => `• **${c.name}** — ${CONTEST_TYPE_LABELS[c.type].toLowerCase()}${contestStatus(c) === 'upcoming' ? `, start ${discordTimestamp(Date.parse(c.startsAt), 'R')}` : `, koniec ${discordTimestamp(Date.parse(c.endsAt), 'R')}`}`).join('\n')
      : 'Teraz nie trwa żaden event — połączenie i tak się przyda, gdy ruszy następny.';
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.info,
          title: '🔗 Połącz konto ze stroną eventów',
          description: [
            'Kliknij przycisk poniżej — strona rankingu otworzy się już połączona z Twoim kontem. Zobaczysz tam swój postęp w eventach i dołączysz do nich jednym kliknięciem.',
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
