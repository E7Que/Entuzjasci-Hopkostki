// Logowanie moderacji do panelu. /login na kanale wybranym w panelu daje osobie jej login i hasło (widoczne
// tylko dla niej). Login wygasa po ustawionym czasie (np. co tydzień albo co miesiąc) — wtedy /login daje
// nowy; /login nowy:True wymusza nowe hasło wcześniej (stare i wszystkie zalogowania nim przestają działać).
// Części panelu odblokowują role (zakładka „Dostęp do panelu”): bot czyta aktualne role przy /login, przy
// logowaniu i potem co kilka minut — odebrana rola zamyka dostęp bez wylogowywania ręcznie.
// Administratorzy serwera (i logowanie hasłem panelu) mają zawsze dostęp do wszystkiego.

import { P, has, memberPermissions } from './permissions.js';
import { getGuildContext } from './moderation.js';
import { DiscordError, avatarUrl } from './rest.js';
import { safeEqual } from './verify.js';

// Strona panelu (GitHub Pages). Adres zależy od nazwy konta na GitHubie — po zmianie NotKairo → E7Que
// strona przeniosła się na e7que.github.io (bez przekierowania ze starego adresu).
export const PANEL_SITE = 'https://e7que.github.io/Entuzjasci-Hopkostki/';

// Części panelu, które można odblokować rolami (kolejność jak w menu panelu).
export const PANEL_SECTIONS = {
  ustawienia: 'Ustawienia',
  uprawnienia: 'Uprawnienia komend',
  czlonkowie: 'Nowe osoby',
  logi: 'Logi serwera',
  bump: 'Bump',
  spolecznosc: 'Społeczność',
  tickety: 'Tickety',
  glosowe: 'Kanały głosowe',
  wiadomosci: 'Wiadomości',
  embedy: 'Wygląd embedów',
  ostrzezenia: 'Ostrzeżenia',
  sprawy: 'Sprawy',
  bany: 'Tymczasowe bany',
};
const ALL_SECTIONS = Object.keys(PANEL_SECTIONS);

// Klucze konfiguracji należące do części panelu — zapis z panelu zmienia tylko odblokowane części.
// panelAccess (kto ma dostęp do czego) zmienia wyłącznie pełny dostęp.
export const SECTION_CONFIG_KEYS = {
  ustawienia: ['modLogChannelId', 'announceChannelId', 'modRoleIds', 'mentionTarget', 'dmUsers', 'dmShowModerator', 'appealText', 'replyReaction', 'presence'],
  uprawnienia: ['commandPermissions'],
  czlonkowie: ['members'],
  logi: ['logs'],
  bump: ['bump'],
  spolecznosc: ['suggestions'],
  tickety: ['tickets'],
  glosowe: ['tempVoice'],
  embedy: ['actions'],
  ostrzezenia: ['warns', 'escalation'],
};

// Po ilu dniach login wygasa (do wyboru w panelu).
export const LOGIN_DAYS = [7, 14, 30];
const RECHECK_MS = 5 * 60_000;
const SEEN_EVERY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
// Bez znaków łatwych do pomylenia (0/O, 1/I). 32 znaki — bajt % 32 nie faworyzuje żadnego; 12 znaków = 60 bitów.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Błąd logowania — API odpowiada na niego 401 (strona panelu wraca do ekranu logowania).
export class AccessError extends Error {}

export const normalizeLogin = (login) => String(login ?? '').trim().toLowerCase();
const normalizePassword = (password) => String(password ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomPassword() {
  const chars = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => PASSWORD_ALPHABET[b % 32]).join('');
  return chars.match(/.{4}/g).join('-');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const passwordHash = (userId, password) => sha256(`haslo:${userId}:${normalizePassword(password)}`);
const tokenHash = (token) => sha256(`sesja:${token}`);

// Login = nazwa użytkownika na Discordzie (bez znaków spoza [a-z0-9._]).
const loginName = (user) => normalizeLogin(user.username).replace(/[^a-z0-9._]/g, '').slice(0, 32) || `mod${String(user.id).slice(-4)}`;

// Które części panelu odblokowują te role (admin = właściciel serwera albo uprawnienie Administrator).
export function sectionAccess({ roles = [], admin = false }, config) {
  if (admin) return { full: true, sections: [...ALL_SECTIONS] };
  const byRole = config.panelAccess?.roles ?? {};
  return { full: false, sections: ALL_SECTIONS.filter((key) => (byRole[key] ?? []).some((id) => roles.includes(id))) };
}
const hasAccess = (access) => access.full || access.sections.length > 0;

// Aktualne role osoby prosto z Discorda. null = nie ma jej już na serwerze.
async function memberSnapshot(bot, userId) {
  const gctx = await getGuildContext(bot);
  let member;
  try {
    member = await bot.discord.get(`/guilds/${gctx.guild.id}/members/${userId}`);
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return null;
    throw error;
  }
  const roles = member.roles ?? [];
  const admin = userId === gctx.guild.ownerId || has(memberPermissions(roles, gctx.roles, gctx.guild.id), P.ADMINISTRATOR);
  return { roles, admin, user: member.user ?? null };
}

// /login: aktywny login tej osoby albo nowy (renew = wymuszone nowe hasło). Hasło jest tylko w odpowiedzi —
// w bazie zostaje jego skrót, więc istniejącego hasła nie da się pokazać drugi raz.
// Role i uprawnienia bierzemy z samej interakcji — to stan z chwili użycia komendy.
export async function issueLogin(bot, ix, config, { renew = false } = {}) {
  const { guild } = await getGuildContext(bot);
  const roles = ix.member?.roles ?? [];
  const admin = ix.user.id === guild.ownerId || has(ix.member?.permissions ?? '0', P.ADMINISTRATOR);
  const access = sectionAccess({ roles, admin }, config);
  if (!hasAccess(access)) return { access, login: null, password: null };
  const current = await bot.store.getPanelLoginForUser(ix.user.id);
  if (current && !renew) return { access, login: current, password: null };

  await bot.store.deletePanelLogins({ userId: ix.user.id, kind: 'login' });
  let name = loginName(ix.user);
  await bot.store.freePanelLoginName(name);
  if (await bot.store.findPanelLogin(name)) name = `${name}-${String(ix.user.id).slice(-4)}`;
  const password = randomPassword();
  const login = await bot.store.addPanelLogin({
    kind: 'login',
    login: name,
    tokenHash: await passwordHash(ix.user.id, password),
    userId: ix.user.id,
    userTag: ix.user.username,
    roles,
    admin,
    ttlMs: config.panelAccess.loginDays * DAY_MS,
  });
  return { access, login, password };
}

// Logowanie na stronie panelu loginem i hasłem → sesja przeglądarki (kończy się razem z loginem).
// Role sprawdzamy od nowa — od /login mogły się zmienić.
export async function signIn(bot, { login, password }) {
  const config = await bot.store.getConfig();
  if (!config.panelAccess.enabled) throw new AccessError('Logowanie moderacji jest wyłączone — zaloguj się hasłem panelu.');
  const row = await bot.store.findPanelLogin(normalizeLogin(login));
  // Skrót liczony także dla nieistniejącego loginu — czas odpowiedzi nie zdradza, które loginy istnieją.
  const hash = await passwordHash(row?.userId ?? '', password);
  if (!(await safeEqual(hash, row?.tokenHash ?? '')) || !row) {
    throw new AccessError('Zły login albo hasło. Login mógł też wygasnąć — wpisz /login na Discordzie, żeby dostać nowy.');
  }
  const member = await memberSnapshot(bot, row.userId);
  if (!member) throw new AccessError('Nie ma Cię już na serwerze.');
  if (!hasAccess(sectionAccess(member, config))) throw new AccessError('Żadna z Twoich ról nie odblokowuje już panelu.');
  const token = randomToken();
  const session = await bot.store.addPanelLogin({
    kind: 'session',
    loginId: row.id,
    tokenHash: await tokenHash(token),
    userId: row.userId,
    userTag: member.user?.username ?? row.userTag,
    roles: member.roles,
    admin: member.admin,
    expiresAt: row.expiresAt,
  });
  return { token, auth: sessionAuth(session, config, member.user) };
}

function sessionAuth(session, config, user = null) {
  return {
    kind: 'session',
    ...sectionAccess(session, config),
    session,
    expiresAt: session.expiresAt,
    user: { id: session.userId, tag: session.userTag ?? session.userId, avatar: user ? avatarUrl(user, 64) : null },
  };
}

// Sesja z nagłówka x-panel-session → dostęp tej osoby. Co kilka minut role są czytane z Discorda od nowa;
// osoba bez ról dających dostęp (albo spoza serwera) traci sesję od razu.
export async function authenticateSession(bot, token) {
  const config = await bot.store.getConfig();
  if (!config.panelAccess.enabled) throw new AccessError('Logowanie moderacji jest wyłączone — zaloguj się hasłem panelu.');
  let session = token ? await bot.store.getPanelSession(await tokenHash(token)) : null;
  if (!session) throw new AccessError('Sesja wygasła albo login został zmieniony — zaloguj się ponownie (nowy login: /login na Discordzie).');
  let user = null;
  if (Date.now() - session.checkedAt > RECHECK_MS) {
    // Chwilowy błąd Discorda nie wylogowuje — zostają role z ostatniego sprawdzenia.
    const member = await memberSnapshot(bot, session.userId).catch(() => undefined);
    if (member === null) {
      await bot.store.deletePanelLogins({ id: session.id });
      throw new AccessError('Nie ma Cię już na serwerze.');
    }
    if (member) {
      user = member.user;
      session = await bot.store.touchPanelSession(session.id, { roles: member.roles, admin: member.admin, checked: true });
    }
  } else if (!session.lastSeenAt || Date.now() - session.lastSeenAt > SEEN_EVERY_MS) {
    session = await bot.store.touchPanelSession(session.id);
  }
  const auth = sessionAuth(session, config, user);
  if (!hasAccess(auth)) {
    await bot.store.deletePanelLogins({ id: session.id });
    throw new AccessError('Nie masz już ról, które dają dostęp do panelu.');
  }
  return auth;
}

// Logowanie hasłem panelu — pełny dostęp.
export const PASSWORD_AUTH = Object.freeze({ kind: 'password', full: true, sections: ALL_SECTIONS, session: null, expiresAt: null, user: null });

// Zapis konfiguracji z panelu: osoba bez pełnego dostępu zmienia tylko klucze swoich części panelu.
export function allowedConfigInput(input, auth) {
  if (auth.full) return input;
  const keys = new Set(auth.sections.flatMap((section) => SECTION_CONFIG_KEYS[section] ?? []));
  return Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => keys.has(key)));
}
