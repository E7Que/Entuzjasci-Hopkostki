'use strict';

// ---------- Stałe ----------
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ACTION_LABELS = { ban: 'Ban', unban: 'Unban', kick: 'Kick', timeout: 'Timeout', untimeout: 'Untimeout', warn: 'Ostrzeżenie' };
const CASE_LABELS = { ...ACTION_LABELS, untimeout: 'Zdjęcie timeoutu' };
const SLASH_NAMES = { ban: '/ban', unban: '/unban', kick: '/kick', timeout: '/timeout', untimeout: '/untimeout', warn: '/warn dodaj' };
const UNIT_FORMS = {
  m: ['minuta', 'minuty', 'minut'],
  h: ['godzina', 'godziny', 'godzin'],
  d: ['dzień', 'dni', 'dni'],
  w: ['tydzień', 'tygodnie', 'tygodni'],
  mo: ['miesiąc', 'miesiące', 'miesięcy'],
};
const UNIT_LABELS = { m: 'Minuty', h: 'Godziny', d: 'Dni', w: 'Tygodnie', mo: 'Miesiące' };
const RULE_ACTIONS = { alert: 'Alert', timeout: 'Timeout', kick: 'Kick', ban: 'Ban' };
const PLACEHOLDERS = ['{uzytkownik}', '{nick}', '{moderator}', '{moderatorNick}', '{powod}', '{czas}', '{serwer}', '{sprawa}', '{typ}'];
const ACTIVITY_LABELS = { custom: 'Własny opis', playing: 'Gra w', listening: 'Słucha', watching: 'Ogląda', competing: 'Rywalizuje w' };
const PRESENCE_PLACEHOLDERS = ['{czlonkowie}', '{online}', '{serwer}', '{ostrzezenia}', '{sprawy}'];
const VIEWS = ['pulpit', 'ustawienia', 'uprawnienia', 'czlonkowie', 'logi', 'bump', 'spolecznosc', 'tickety', 'glosowe', 'wiadomosci', 'embedy', 'ostrzezenia', 'sprawy', 'bany', 'dostep'];
const MEMBER_VARS = ['{uzytkownik}', '{nick}', '{serwer}', '{liczba}'];
const TICKET_VARS = ['{uzytkownik}', '{nick}', '{numer}', '{typ}'];
const BUMP_VARS = ['{uzytkownik}', '{nick}', '{liczba}', '{nastepny}', '{godzina}'];
const VAR_SETS = { ticket: TICKET_VARS, bump: BUMP_VARS, bumpReminder: ['{uzytkownik}', '</bump:947088344167366698>'] };
const EMPTY_GUILD = { channels: [], voiceChannels: [], categories: [], roles: [], emojis: [], bot: null };
// Grupy jak karty w Carl-bocie; klucz = logs.<klucz>ChannelId (kanał grupy).
const LOG_EVENT_GROUPS = {
  messages: [['messageDelete', 'Usunięte wiadomości'], ['messageEdit', 'Edytowane wiadomości'], ['messageBulk', 'Zbiorczo usunięte wiadomości (np. /clear)']],
  joinLeave: [['memberJoin', 'Wejścia na serwer'], ['memberLeave', 'Wyjścia z serwera'], ['memberInvite', 'Kto zaprosił (zaproszenie przy wejściu i wyjściu)']],
  members: [
    ['memberRoles', 'Zmiany ról'],
    ['memberNick', 'Zmiany nazw (pseudonim i nazwa użytkownika)'],
    ['memberAvatar', 'Zmiany zdjęcia profilowego (stare i nowe)'],
    ['memberBan', 'Bany'],
    ['memberUnban', 'Odbanowania'],
    ['memberTimeout', 'Timeouty'],
    ['memberTimeoutRemove', 'Zdjęte timeouty'],
    ['memberKick', 'Wyrzucenia'],
  ],
  server: [
    ['channelCreate', 'Utworzenie kanału'],
    ['channelUpdate', 'Zmiany kanału i jego uprawnień'],
    ['channelDelete', 'Usunięcie kanału'],
    ['threadCreate', 'Utworzenie wątku'],
    ['threadUpdate', 'Zmiany wątku'],
    ['threadDelete', 'Usunięcie wątku'],
    ['roleCreate', 'Utworzenie roli'],
    ['roleUpdate', 'Zmiany ról serwera'],
    ['roleDelete', 'Usunięcie roli'],
    ['serverUpdate', 'Zmiany ustawień serwera'],
    ['emojiUpdate', 'Zmiany emoji'],
    ['inviteCreate', 'Nowe zaproszenia'],
  ],
  voice: [['voiceJoin', 'Wejście na kanał głosowy'], ['voiceMove', 'Przejście między kanałami'], ['voiceLeave', 'Wyjście z kanału głosowego']],
};
const BUTTON_STYLES = { niebieski: 'Niebieski', szary: 'Szary', zielony: 'Zielony', czerwony: 'Czerwony' };
const PANEL_PASSWORD_KEY = 'hopkostki-panel-password';
const PANEL_SESSION_KEY = 'hopkostki-panel-session';
const SAMPLE = { targetId: '111', target: 'hurownik_og', modId: '222', mod: 'dfgbh65', reason: 'Wielokrotne łamanie zasad' };

const state = {
  config: null,
  draft: null,
  defaults: null,
  guild: EMPTY_GUILD,
  status: null,
  msg: null,
  sentMessages: [],
  view: 'pulpit',
  embedAction: 'ban',
  lastField: null,
  casesPage: 1,
  warnUsers: [],
  openWarnUsers: new Set(),
  reloadPending: false,
  commandMeta: null,
  lastActivityInput: null,
};

// ---------- Narzędzia ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const stripEmoji = (text) =>
  String(text ?? '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu, '').replace(/\s{2,}/g, ' ').trim();

function getPath(obj, path) {
  return path.split('.').reduce((o, key) => o?.[key], obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, key) => o[key], obj)[last] = value;
}

function plural(n, [one, few, many]) {
  if (n === 1) return one;
  const n10 = n % 10;
  const n100 = n % 100;
  return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
}
const formatDuration = (amount, unit) => `${amount} ${plural(amount, UNIT_FORMS[unit] ?? ['', '', ''])}`;

function fullDate(ms) {
  return new Date(ms).toLocaleString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function shortDate(ms) {
  return new Date(ms).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function relTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  let text;
  if (abs >= 30 * DAY) text = formatDuration(Math.round(abs / (30 * DAY)), 'mo');
  else if (abs >= DAY) text = formatDuration(Math.round(abs / DAY), 'd');
  else if (abs >= HOUR) text = formatDuration(Math.round(abs / HOUR), 'h');
  else text = formatDuration(Math.max(1, Math.round(abs / MINUTE)), 'm');
  return diff >= 0 ? `za ${text}` : `${text} temu`;
}
function formatCountdown(ms) {
  if (ms <= 0) return 'wygasa…';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${d ? `${d} ${plural(d, UNIT_FORMS.d)} ` : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Strona stoi na GitHub Pages, a API panelu w funkcji Edge na Supabase (Supabase nie serwuje stron HTML).
// Lokalny wrapper (npm run panel) sam przekazuje wywołania do bota, więc tam ścieżki zostają względne.
const REMOTE_API = 'https://ucjmbdogtzztrkorqzjq.supabase.co/functions/v1/hopkostki-bot/panel/';
const API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname) ? '' : REMOTE_API;

// Hasło żyje tylko w tej karcie (sessionStorage).
function getPanelPassword() {
  try {
    return sessionStorage.getItem(PANEL_PASSWORD_KEY) || '';
  } catch {
    return '';
  }
}
function setPanelPassword(value) {
  try {
    sessionStorage.setItem(PANEL_PASSWORD_KEY, value);
  } catch {
    /* prywatna karta / zablokowany storage — hasło trzeba będzie wpisać ponownie po odświeżeniu */
  }
}
function clearPanelPassword() {
  try {
    sessionStorage.removeItem(PANEL_PASSWORD_KEY);
  } catch {}
}

// Sesja moderatora z kodu /login — w localStorage, więc zostaje po zamknięciu karty (do wylogowania albo
// wygaśnięcia). Bot i tak sprawdza na bieżąco role tej osoby.
function getPanelSession() {
  try {
    return localStorage.getItem(PANEL_SESSION_KEY) || '';
  } catch {
    return '';
  }
}
function setPanelSession(token) {
  try {
    localStorage.setItem(PANEL_SESSION_KEY, token);
  } catch {
    /* zablokowany storage — po odświeżeniu trzeba będzie wygenerować nowy kod */
  }
}
function clearPanelSession() {
  try {
    localStorage.removeItem(PANEL_SESSION_KEY);
  } catch {}
}
const isLoggedIn = () => Boolean(getPanelSession() || getPanelPassword());

async function api(path, options = {}) {
  const session = getPanelSession();
  const res = await fetch(API_BASE + path.replace(/^\/+/, ''), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { 'x-panel-session': session } : { 'x-panel-password': getPanelPassword() }),
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearPanelPassword();
    clearPanelSession();
    showLoginGate(data.error || 'Złe hasło panelu.');
    throw new Error(data.error || 'Wymagane logowanie.');
  }
  if (!res.ok) {
    const message = data.error || `Błąd ${res.status}`;
    if ([500, 502, 503].includes(res.status)) showConnectionError(message);
    throw new Error(message);
  }
  hideConnectionError();
  return data;
}

let toastTimer = null;
function toast(message, type = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------- Błędy połączenia z botem ----------
function showConnectionError(message) {
  const el = $('#conn-error');
  el.innerHTML = `<strong>Brak połączenia z botem.</strong> ${esc(message)}`;
  el.classList.remove('hidden');
}
function hideConnectionError() {
  $('#conn-error').classList.add('hidden');
}

// ---------- Logowanie ----------
function showLoginGate(message) {
  const gate = $('#login-gate');
  const wasHidden = gate.classList.contains('hidden');
  gate.classList.remove('hidden');
  $('#app').classList.add('hidden');
  if (message) $('#login-error').textContent = message;
  if (wasHidden) {
    $('#login-password').value = '';
    $('#login-password').focus();
  }
}
function revealApp() {
  $('#login-gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#login-error').textContent = '';
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearPanelSession();
  setPanelPassword($('#login-password').value);
  $('#login-submit').disabled = true;
  try {
    await api('/status'); // samo wywołanie sprawdza, czy hasło jest poprawne
    await init();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    $('#login-submit').disabled = false;
  }
});

// Login i hasło z /login (wpisane albo z przycisku „Zaloguj się do panelu”) → sesja tej osoby.
async function loginWithCredentials(login, password) {
  $('#login-mod-submit').disabled = true;
  try {
    clearPanelPassword();
    clearPanelSession();
    const { token } = await api('/login', { method: 'POST', body: JSON.stringify({ login, password }) });
    setPanelSession(token);
    $('#login-mod-password').value = '';
    await init();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    $('#login-mod-submit').disabled = false;
  }
}
$('#login-mod-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loginWithCredentials($('#login-name').value, $('#login-mod-password').value);
});

$('#logout-btn').addEventListener('click', async () => {
  if (getPanelSession()) await api('/logout', { method: 'POST', body: '{}' }).catch(() => {});
  clearPanelPassword();
  clearPanelSession();
  state.me = null;
  showLoginGate();
});

// ---------- Start ----------
let started = false;
async function start() {
  let [{ config, defaults }, guild, { commands }, { me }] = await Promise.all([
    api('/config'),
    api('/guild').catch(() => EMPTY_GUILD),
    api('/commands').catch(() => ({ commands: [] })),
    api('/me'),
  ]);
  state.me = me;
  // Każda komenda ma mieć własną listę ról — brakujące (np. nowe komendy) bot uzupełnia według uprawnień Discorda.
  if (canEdit('uprawnienia') && guild.roles?.length && commands.some((c) => !Array.isArray(config.commandPermissions?.[c.name]))) {
    const filled = await api('/permissions/defaults', { method: 'POST', body: '{}' }).catch(() => null);
    if (filled?.config) config = filled.config;
  }
  state.config = config;
  state.draft = clone(config);
  state.defaults = defaults;
  state.guild = { ...EMPTY_GUILD, ...guild };
  // Opisy komend w Discordzie mają emoji — w panelu pokazujemy sam tekst.
  state.commandMeta = commands.map((c) => ({ ...c, description: stripEmoji(c.description) }));
  if (!state.msg) state.msg = { editingId: null, data: blankMessage() };
  revealApp();
  applyAccess();
  renderConfigUi();
  route();
  if (!started) {
    started = true;
    refreshStatus();
    setInterval(refreshStatus, 15_000);
    setInterval(tick, 1000);
  }
}

async function init() {
  try {
    await start();
  } catch (error) {
    // Hasło/sesja zostały już wyczyszczone i pokazany ekran logowania przez api() — nie ma sensu tu dobijać.
    if (isLoggedIn()) {
      showConnectionError(error.message);
      setTimeout(init, 10_000);
    }
  }
}

function boot() {
  // Przycisk z /login (#login=…&haslo=…): logujemy od razu i usuwamy dane z paska adresu i historii.
  // Sam #login=… (gdy hasło było już wygenerowane wcześniej) tylko wpisuje login.
  if (location.hash.startsWith('#login=')) {
    const params = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    showLoginGate();
    $('#login-name').value = params.get('login') ?? '';
    if (params.get('haslo')) loginWithCredentials(params.get('login'), params.get('haslo'));
    else $('#login-mod-password').focus();
    return;
  }
  if (isLoggedIn()) init();
  else showLoginGate();
}

// Co może zmieniać zalogowana osoba: hasło panelu i administratorzy — wszystko, moderacja — części odblokowane
// rolami. Resztę widzi z kłódką, tylko podglądowo; „Dostęp do panelu” widzi wyłącznie pełny dostęp.
function canEdit(view) {
  if (!state.me || state.me.full || view === 'pulpit') return true;
  return view !== 'dostep' && state.me.sections.includes(view);
}
const canSee = (view) => view !== 'dostep' || !state.me || state.me.full;
// Części, w których prawie wszystko to dane z bota (bez dostępu nie ma czego pokazać).
const DATA_VIEWS = ['sprawy', 'bany', 'wiadomosci'];
const viewLabel = (view) => $(`#nav a[data-view="${view}"]`)?.textContent.trim() ?? view;

function applyAccess() {
  $$('#nav a').forEach((a) => {
    a.hidden = !canSee(a.dataset.view);
    const locked = !canEdit(a.dataset.view);
    a.classList.toggle('locked', locked);
    a.title = locked ? 'Tylko podgląd — nie możesz tego zmieniać' : '';
  });
  $('#password-card').hidden = !state.me?.full;
  $('#supabase-link').hidden = !state.me?.full;
  $('#role-perms-card').hidden = !state.me?.full;
  $('#setup-run').hidden = !canEdit('ustawienia');
  const chip = $('#me-chip');
  const user = state.me?.kind === 'session' ? state.me.user : null;
  chip.classList.toggle('hidden', !user);
  if (user) {
    chip.innerHTML = `${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : ''}<span>Zalogowano jako <strong>${esc(user.tag)}</strong><small>${
      state.me.full ? 'pełny dostęp (administrator)' : `może zmieniać ${state.me.sections.length} z ${VIEWS.length - 2} części panelu`
    }</small></span>`;
  }
  renderAccessCard();
}

// Pulpit: co ta osoba może zmieniać, a co widzi tylko podglądowo, i do kiedy ważny jest jej login.
function renderAccessCard() {
  const card = $('#access-card');
  card.classList.toggle('hidden', state.me?.kind !== 'session');
  if (state.me?.kind !== 'session') return;
  const views = VIEWS.filter((v) => v !== 'pulpit' && v !== 'dostep');
  const expires = state.me.expiresAt ? `Login ważny do ${esc(fullDate(state.me.expiresAt))} (${relTime(state.me.expiresAt)}) — potem wpisz /login na Discordzie, żeby dostać nowy.` : '';
  $('#access-summary').innerHTML = `
    <p class="muted small">${state.me.full ? 'Masz pełny dostęp (administrator serwera).' : 'Co możesz zmieniać zależy od Twoich ról na serwerze — bot sprawdza je na bieżąco.'} ${expires}</p>
    <ul class="access-list">${views
      .map((v) => {
        const ok = canEdit(v);
        return `<li class="${ok ? 'ok' : 'locked'}"><span>${ok ? '✅' : '🔒'}</span><a href="#${v}">${esc(viewLabel(v))}</a><small>${ok ? 'możesz zmieniać' : 'tylko podgląd'}</small></li>`;
      })
      .join('')}</ul>`;
}

// Zablokowana część: baner z kłódką (i rolami, które ją odblokowują), a zawartość tylko do podglądu.
function applyViewLock(view) {
  const section = $(`#view-${view}`);
  if (!section) return;
  const locked = !canEdit(view);
  section.classList.toggle('locked', locked);
  let banner = $('.lock-banner', section);
  if (!locked) {
    banner?.remove();
    [...section.children].forEach((el) => el.removeAttribute('inert'));
    return;
  }
  const roleIds = state.config?.panelAccess?.roles?.[view] ?? [];
  const roles = roleIds.map((id) => roleLabel(id).name);
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'banner lock-banner';
    section.querySelector('.view-head').after(banner);
  }
  banner.innerHTML = `🔒 <strong>Tylko podgląd</strong> — tej części panelu nie możesz zmieniać${DATA_VIEWS.includes(view) ? ', a jej dane są ukryte' : ''}. ${
    roles.length ? `Odblokowują ją role: ${roles.map((n) => `<strong>${esc(n)}</strong>`).join(', ')}.` : 'Odblokowuje ją tylko administracja serwera.'
  }`;
  [...section.children].forEach((el) => el.toggleAttribute('inert', el !== banner && !el.classList.contains('view-head')));
}

// ---------- Nawigacja ----------
function route() {
  const hash = location.hash.slice(1);
  state.view = VIEWS.includes(hash) && canSee(hash) ? hash : 'pulpit';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === state.view));
  applyViewLock(state.view);
  // Dane z bota tylko tam, gdzie wolno (inaczej bot i tak odmówi).
  const open = canEdit(state.view);
  if (state.view === 'pulpit') refreshStatus();
  if (state.view === 'ostrzezenia' && open) loadWarns();
  if (state.view === 'sprawy' && open) loadCases();
  if (state.view === 'bany' && open) loadBans();
  if (state.view === 'embedy') renderPreview();
  if (state.view === 'uprawnienia') {
    renderPermissions();
    renderRolePermissions();
  }
  if (state.view === 'glosowe' && open) loadVoice();
  if (state.view === 'tickety' && open) loadTickets();
  if (state.view === 'dostep') loadLogins();
  if (state.view === 'bump') {
    renderBumpPreview();
    if (open) loadBump();
  }
  if (state.view === 'spolecznosc' && open) loadGiveaways();
  if (state.view === 'wiadomosci') {
    renderMessageEditor();
    if (open) loadSentMessages();
  }
}
window.addEventListener('hashchange', () => {
  // Przycisk z /login otwarty w karcie, w której panel już działa (zmienia się tylko #, bez przeładowania).
  if (location.hash.startsWith('#login=')) boot();
  else route();
});

// ---------- Status / pulpit ----------
async function refreshStatus() {
  if (!state.config) return;
  let status;
  try {
    status = await api('/status');
  } catch {
    $('#bot-state').textContent = 'panel offline';
    $('#bot-state').className = 'state offline';
    return;
  }
  const wasReady = state.status?.ready;
  state.status = status;

  $('#bot-state').textContent = status.ready ? 'działa na Supabase' : 'wymaga konfiguracji';
  $('#bot-state').className = `state ${status.ready ? 'online' : 'offline'}`;
  if (status.bot) {
    $('#bot-name').textContent = status.bot.tag;
    const avatar = $('#bot-avatar');
    avatar.onerror = () => {
      avatar.hidden = true;
      $('#bot-logo').hidden = false;
    };
    avatar.src = status.bot.avatar;
    avatar.hidden = false;
    $('#bot-logo').hidden = true;
  }
  if (status.guild) {
    $('#guild-name').textContent = status.guild.name;
    $('#guild-members').textContent = `${status.guild.memberCount ?? "?"} członków • ID ${status.guild.id}`;
    if (status.guild.icon) {
      $('#guild-icon').src = status.guild.icon;
      $('#guild-icon').hidden = false;
    }
  } else {
    $('#guild-name').textContent = status.ready ? 'Bot nie jest na żadnym serwerze' : '—';
  }
  const lastCron = status.cron?.at;
  $('#status-text').innerHTML = status.ready ? '<span class="dot ok"></span>Działa' : '<span class="dot bad"></span>Nie działa';
  $('#status-extra').textContent = status.ready
    ? `Ostatnie zadania okresowe: ${lastCron ? relTime(lastCron) : 'jeszcze nie było'}`
    : status.error ?? 'Sprawdź sekrety w Supabase.';
  renderSetup(status);
  renderGatewayLine(status.gateway);

  const s = status.stats;
  const cards = [
    ['Sprawy łącznie', s.cases, '#5865f2'],
    ['Aktywne ostrzeżenia', s.activeWarns, state.config.actions.warn.color],
    ['Tymczasowe bany', s.tempBans, state.config.actions.ban.color],
    ['Bany', s.byType.ban ?? 0, state.config.actions.ban.color],
    ['Timeouty', s.byType.timeout ?? 0, state.config.actions.timeout.color],
    ['Kicki', s.byType.kick ?? 0, state.config.actions.kick.color],
  ];
  $('#stats').innerHTML = cards
    .map(([label, value, color]) => `<div class="stat" style="--accent:${esc(color)}"><b>${value}</b><span>${label}</span></div>`)
    .join('');
  $('#recent-table').innerHTML = casesTable(status.recent);

  // Bot właśnie się połączył — dociągamy kanały i role do formularzy.
  if (status.ready && (!wasReady || !state.guild.channels.length)) {
    state.guild = { ...EMPTY_GUILD, ...(await api('/guild')) };
    renderChannelSelects();
    renderRoles();
    renderGenerators();
    renderTicketTypes();
    renderBotWarnings();
    if (state.view === 'uprawnienia') renderPermissions();
    if (state.view === 'wiadomosci') renderMessageEditor();
  }
  if (state.view === 'embedy') renderPreview();
  renderPasswordStatus(status);
}

const gatewayOk = (gateway) => Boolean(gateway?.startedAt && !gateway.error && Date.now() - gateway.startedAt < 3 * MINUTE);

function renderSetup(status) {
  const setup = status.setup ?? {};
  const cronAt = status.cron?.at;
  const items = [
    [setup.tokenConfigured, 'Token bota (DISCORD_TOKEN) ustawiony w sekretach Supabase', setup.tokenConfigured ? '' : 'Supabase → Edge Functions → Secrets → dodaj DISCORD_TOKEN.'],
    [status.ready, 'Bot widzi serwer', status.ready ? status.guild?.name : status.error],
    [
      setup.endpoint && setup.endpoint === setup.selfUrl,
      'Discord wysyła komendy do Supabase (Interactions Endpoint URL)',
      setup.endpointError ? `Błąd: ${setup.endpointError}` : setup.selfUrl,
    ],
    [Boolean(setup.commandsRegisteredAt), 'Komendy slash zarejestrowane', setup.commandsRegisteredAt ? `ostatnio ${relTime(setup.commandsRegisteredAt)}` : 'zrobi się samo w ciągu minuty'],
    [cronAt && Date.now() - cronAt < 3 * MINUTE, 'Zadania okresowe (pg_cron co 30 s)', cronAt ? `ostatnio ${relTime(cronAt)}` : 'jeszcze nie uruchomione'],
    [
      gatewayOk(status.gateway),
      'Status „online” i opisy (gateway co minutę)',
      status.gateway?.error ?? (status.gateway?.startedAt ? `ostatnia sesja ${relTime(status.gateway.startedAt)}${status.gateway.mode === 'resume' ? ' (wznowiona)' : ''}` : 'uruchomi się w ciągu minuty'),
    ],
  ];
  $('#setup-list').innerHTML = items
    .map(([done, label, hint]) => `<li><span class="dot ${done ? 'ok' : 'wait'}"></span><div>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</div></li>`)
    .join('');
}

$('#setup-run').addEventListener('click', async () => {
  $('#setup-run').disabled = true;
  try {
    await api('/setup', { method: 'POST' });
    toast('Komendy zarejestrowane');
  } catch (error) {
    toast(error.message, 'error');
  }
  $('#setup-run').disabled = false;
  refreshStatus();
});

function caseBadge(entry) {
  const color = state.config.actions[entry.type]?.color ?? '#99aab5';
  const label = entry.type === 'ban' && entry.duration ? 'Tempban' : CASE_LABELS[entry.type] ?? entry.type;
  return `<span class="badge" style="background:${esc(color)}">${esc(label)}</span>`;
}

function casesTable(items) {
  if (!items.length) return '<tr><td class="empty">Brak spraw.</td></tr>';
  const rows = items
    .map((c) => {
      const duration = c.duration ? formatDuration(c.duration.amount, c.duration.unit) : c.type === 'ban' ? 'perm.' : '—';
      const expiry = c.expiresAt ? `<span class="note">do ${esc(shortDate(c.expiresAt))}</span>` : '';
      return `<tr>
        <td><strong>#${c.id}</strong></td>
        <td>${caseBadge(c)}</td>
        <td>${esc(c.userTag)}<span class="note">${esc(c.userId)}</span></td>
        <td>${esc(c.moderatorTag)}${c.auto ? ' (auto)' : ''}</td>
        <td class="reason">${esc(c.reason)}${c.note ? `<span class="note">Notatka: ${esc(c.note)}</span>` : ''}</td>
        <td>${duration}${expiry}</td>
        <td>${esc(shortDate(c.createdAt))}</td>
      </tr>`;
    })
    .join('');
  return `<thead><tr><th>#</th><th>Typ</th><th>Użytkownik</th><th>Moderator</th><th>Powód</th><th>Czas</th><th>Data</th></tr></thead><tbody>${rows}</tbody>`;
}

// ---------- Formularze konfiguracji ----------
function renderConfigUi() {
  renderChannelSelects();
  renderRoles();
  renderRules();
  renderActivities();
  renderPermissions();
  renderGenerators();
  renderTicketTypes();
  renderLogEvents();
  renderChannelPickers();
  renderBotWarnings();
  renderEmbedTabs();
  fillInputs();
  renderEmojiButtons();
  renderBumpPreview();
  $$('[data-insert-into]').forEach((box) => {
    const vars = VAR_SETS[box.dataset.vars] ?? MEMBER_VARS;
    box.innerHTML = vars.map((v) => `<button type="button" class="chip" data-insert="${esc(v)}">${esc(v.startsWith('</') ? '/bump (klikalne)' : v)}</button>`).join('');
  });
  $('#presence-chips').innerHTML = PRESENCE_PLACEHOLDERS.map((p) => `<button type="button" class="chip" data-presence-placeholder="${p}">${p}</button>`).join('');
  $('#placeholder-chips').innerHTML = PLACEHOLDERS.map((p) => `<button type="button" class="chip" data-placeholder="${p}">${p}</button>`).join('');
  markDirty();
}

function fillInputs() {
  $$('[data-path]').forEach((el) => {
    const value = getPath(state.draft, el.dataset.path);
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  });
  $$('input[type=color][data-color-for]').forEach((picker) => {
    const value = getPath(state.draft, picker.dataset.colorFor);
    if (/^#[0-9a-f]{6}$/i.test(value ?? '')) picker.value = value;
  });
  const dashboardColor = state.draft.tempVoice?.dashboard?.color;
  if (/^#[0-9a-f]{6}$/i.test(dashboardColor ?? '')) $('#dashboard-color-picker').value = dashboardColor;
  fillEmbedFields();
}

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if ('number' in el.dataset) return Number(el.value);
  if (el.type === 'number') return Math.max(0, Math.floor(Number(el.value) || 0));
  return el.value;
}

function onFieldChange(event) {
  const el = event.target;
  if (el.dataset.path) {
    setPath(state.draft, el.dataset.path, readValue(el));
    markDirty();
    if (el.dataset.path.startsWith('warns') || el.dataset.path === 'dmShowModerator' || el.dataset.path === 'appealText' || el.dataset.path === 'mentionTarget') {
      renderPreview();
    }
  } else if (el.dataset.embedField) {
    const field = el.dataset.embedField;
    state.draft.actions[state.embedAction][field] = el.value;
    if (field === 'color' && /^#[0-9a-f]{6}$/i.test(el.value)) $('#embed-color-picker').value = el.value;
    renderEmbedTabs();
    renderPreview();
    markDirty();
  }
}
document.addEventListener('input', onFieldChange);
document.addEventListener('change', onFieldChange);

function renderChannelSelects() {
  $$('[data-channel-select]').forEach((select) => {
    const current = getPath(state.draft, select.dataset.path) ?? '';
    const kind = select.dataset.channelSelect;
    const list = kind === 'category' || kind === 'archiveCategory' ? state.guild.categories : state.guild.channels;
    const emptyLabel =
      {
        none: '— wyłączone —',
        category: 'Bez kategorii',
        archiveCategory: 'Zostaje w tej samej kategorii',
        pick: '— wybierz kanał —',
        inherit: 'Jak kanał domyślny',
        bump: 'Kanał, na którym ktoś użył /bump',
      }[kind] ?? 'Kanał, na którym użyto komendy';
    let html = `<option value="">${emptyLabel}</option>`;
    html += list
      .map((c) => `<option value="${c.id}">${kind === 'category' ? '' : '#'}${esc(c.name)}${c.category ? ` · ${esc(c.category)}` : ''}</option>`)
      .join('');
    if (current && !list.some((c) => c.id === current)) {
      html += `<option value="${esc(current)}">(nieznany kanał ${esc(current)})</option>`;
    }
    select.innerHTML = html;
    select.value = current;
  });
}

function renderRoles() {
  renderPickers();
}

// ---------- Wybór ról jako „chipy” (+ Dodaj rolę / ×) ----------
// Klucz listy: "perm:<komenda>" (kto może użyć komendy) albo "cfg:<ścieżka w konfiguracji>".
const EVERYONE = 'everyone';

function pickerList(key) {
  if (key.startsWith('perm:')) return state.draft.commandPermissions?.[key.slice(5)] ?? [];
  return getPath(state.draft, key.slice(4)) ?? [];
}

function setPickerList(key, list) {
  if (key.startsWith('perm:')) {
    state.draft.commandPermissions = { ...(state.draft.commandPermissions ?? {}), [key.slice(5)]: list };
    renderPermissionMatrix();
  } else {
    setPath(state.draft, key.slice(4), list);
  }
  renderBotWarnings();
  markDirty();
}

function roleLabel(id) {
  if (id === EVERYONE) return { name: 'Wszyscy (@everyone)', color: '#99aab5' };
  const role = roleById(id);
  return { name: role?.name ?? 'usunięta rola', color: role && role.color !== '#000000' ? role.color : '#99aab5' };
}

function rolePicker(key, { everyone = false, assignable = false } = {}) {
  const list = pickerList(key);
  const chips = list
    .map((id) => {
      const { name, color } = roleLabel(id);
      return `<span class="role-chip"><span class="role-dot" style="background:${esc(color)}"></span>${esc(name)}<button type="button" data-chip-remove="${esc(id)}" title="Usuń">×</button></span>`;
    })
    .join('');
  const options = [
    ...(everyone && !list.includes(EVERYONE) ? [`<option value="${EVERYONE}">Wszyscy (@everyone)</option>`] : []),
    ...state.guild.roles.filter((r) => !list.includes(r.id) && (!assignable || r.assignable)).map((r) => `<option value="${r.id}">${esc(r.name)}</option>`),
  ];
  const add = options.length
    ? `<select class="chip-add" data-chip-add aria-label="Dodaj rolę"><option value="">+ Dodaj rolę</option>${options.join('')}</select>`
    : '';
  const empty = list.length ? '' : `<span class="muted small">${key.startsWith('perm:') ? 'tylko administratorzy' : 'brak'}</span>`;
  return `<div class="role-picker" data-picker="${esc(key)}" data-everyone="${everyone}" data-assignable="${assignable}">${chips}${empty}${add}</div>`;
}

function refreshPicker(box) {
  box.outerHTML = rolePicker(box.dataset.picker, { everyone: box.dataset.everyone === 'true', assignable: box.dataset.assignable === 'true' });
}

// Miejsca w HTML: <div data-picker-slot="cfg:ścieżka" [data-assignable] [data-everyone]></div>
function renderPickers() {
  $$('[data-picker-slot]').forEach((slot) => {
    slot.innerHTML = rolePicker(slot.dataset.pickerSlot, { everyone: 'everyone' in slot.dataset, assignable: 'assignable' in slot.dataset });
  });
}

document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-chip-add]');
  if (!select?.value) return;
  const box = select.closest('[data-picker]');
  setPickerList(box.dataset.picker, [...pickerList(box.dataset.picker), select.value]);
  refreshPicker(box);
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-chip-remove]');
  if (!button) return;
  const box = button.closest('[data-picker]');
  setPickerList(box.dataset.picker, pickerList(box.dataset.picker).filter((id) => id !== button.dataset.chipRemove));
  refreshPicker(box);
});

// ---------- Uprawnienia komend ----------
// Ta sama logika co po stronie bota (moderation.js/roleHasAccess) — liczona tu dla podglądu na żywo.
const ADMINISTRATOR_BIT = 8n;
function hasBit(bitsStr, bit) {
  const bits = BigInt(bitsStr || 0);
  return (bits & bit) === bit;
}
function roleCanUse(role, cmd, config) {
  if (hasBit(role.permissions, ADMINISTRATOR_BIT)) return true;
  const list = config.commandPermissions?.[cmd.name];
  if (Array.isArray(list)) return list.includes(EVERYONE) || list.includes(role.id);
  if (!cmd.permission) return true;
  return hasBit(role.permissions, BigInt(cmd.permission)) || config.modRoleIds.includes(role.id);
}

function renderPermissions() {
  if (!state.commandMeta) return;
  $('#permission-commands').innerHTML = state.commandMeta
    .map(
      (cmd) => `<div class="perm-command">
        <div class="perm-command-head"><code>/${esc(cmd.name)}</code><span class="muted small">${esc(cmd.description)}</span></div>
        ${rolePicker(`perm:${cmd.name}`, { everyone: true })}
        <div class="muted small">Uprawnienie Discorda do tej komendy: ${esc(cmd.permissionLabel)}</div>
      </div>`,
    )
    .join('');
  $('#perm-bulk-role').innerHTML =
    '<option value="">— wybierz rolę —</option>' + state.guild.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  renderPermissionMatrix();
}

function bulkRoleChange(add) {
  const roleId = $('#perm-bulk-role').value;
  if (!roleId) return toast('Wybierz rolę.', 'error');
  const onlyMod = $('#perm-bulk-scope').value === 'mod';
  for (const cmd of state.commandMeta) {
    if (add && onlyMod && !cmd.permission) continue;
    const list = pickerList(`perm:${cmd.name}`);
    state.draft.commandPermissions[cmd.name] = add ? [...new Set([...list, roleId])] : list.filter((id) => id !== roleId);
  }
  markDirty();
  renderPermissions();
}
$('#perm-bulk-add').addEventListener('click', () => bulkRoleChange(true));
$('#perm-bulk-remove').addEventListener('click', () => bulkRoleChange(false));
$('#perm-reset').addEventListener('click', async () => {
  if (!confirm('Ustawić listy ról wszystkich komend od nowa według obecnych uprawnień Discorda?')) return;
  try {
    const { config } = await api('/permissions/defaults', { method: 'POST', body: JSON.stringify({ reset: true }) });
    state.config.commandPermissions = config.commandPermissions;
    state.draft.commandPermissions = clone(config.commandPermissions);
    renderPermissions();
    markDirty();
    toast('Listy ról ustawione od nowa');
  } catch (error) {
    toast(error.message, 'error');
  }
});

function renderPermissionMatrix() {
  const roles = state.guild.roles;
  const cmds = state.commandMeta;
  if (!roles?.length || !cmds?.length) {
    $('#permission-matrix').innerHTML = '<tr><td class="empty">Bot nie jest jeszcze połączony z serwerem — role pojawią się tutaj automatycznie.</td></tr>';
    return;
  }
  const head = `<thead><tr><th>Rola</th>${cmds.map((c) => `<th title="${esc(c.description)}">/${esc(c.name)}</th>`).join('')}</tr></thead>`;
  const body = roles
    .map((r) => {
      const cells = cmds.map((c) => `<td class="perm-cell">${roleCanUse(r, c, state.draft) ? '<span class="yes">tak</span>' : '<span class="no">—</span>'}</td>`).join('');
      return `<tr><td><span class="role-dot" style="background:${esc(r.color === '#000000' ? '#99aab5' : r.color)}"></span>${esc(r.name)}</td>${cells}</tr>`;
    })
    .join('');
  $('#permission-matrix').innerHTML = head + `<tbody>${body}</tbody>`;
}

// ---------- Progi automatycznych kar ----------
const optionList = (map, selected) =>
  Object.entries(map).map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');

function renderRules() {
  const rules = state.draft.escalation.rules;
  const body = rules
    .map((rule, i) => {
      const noTime = rule.action === 'alert' || rule.action === 'kick';
      return `<tr data-rule="${i}">
        <td><input type="number" min="1" value="${rule.points}" data-rule-field="points" aria-label="Próg punktów"></td>
        <td><select data-rule-field="action" aria-label="Akcja">${optionList(RULE_ACTIONS, rule.action)}</select></td>
        <td><input type="number" min="0" value="${rule.amount}" data-rule-field="amount" aria-label="Czas" ${noTime ? 'disabled' : ''}></td>
        <td><select data-rule-field="unit" aria-label="Jednostka" ${noTime ? 'disabled' : ''}>${optionList(UNIT_LABELS, rule.unit)}</select></td>
        <td><button type="button" class="btn ghost small" data-rule-del>Usuń</button></td>
      </tr>`;
    })
    .join('');
  $('#rules-table').innerHTML = `<thead><tr><th>Próg (pkt)</th><th>Akcja</th><th>Czas</th><th>Jednostka</th><th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="5" class="empty">Brak progów</td></tr>'}</tbody>
    <tfoot><tr><td colspan="5" class="muted small">Czas 0 przy banie = ban permanentny. Timeout: maks. 28 dni (0 = 28 dni).</td></tr></tfoot>`;
}

function onRuleChange(event) {
  const row = event.target.closest('[data-rule]');
  const field = event.target.dataset.ruleField;
  if (!row || !field) return;
  event.stopPropagation();
  const rule = state.draft.escalation.rules[Number(row.dataset.rule)];
  rule[field] = field === 'points' || field === 'amount' ? Math.max(0, Math.floor(Number(event.target.value) || 0)) : event.target.value;
  if (field === 'action') renderRules();
  markDirty();
}
$('#rules-table').addEventListener('input', onRuleChange);
$('#rules-table').addEventListener('change', onRuleChange);
$('#rules-table').addEventListener('click', (event) => {
  const row = event.target.closest('[data-rule-del]') && event.target.closest('[data-rule]');
  if (!row) return;
  state.draft.escalation.rules.splice(Number(row.dataset.rule), 1);
  renderRules();
  markDirty();
});
$('#add-rule').addEventListener('click', () => {
  const last = state.draft.escalation.rules.at(-1);
  state.draft.escalation.rules.push({ points: (last?.points ?? 0) + 5, action: 'timeout', amount: 1, unit: 'h' });
  renderRules();
  markDirty();
});

// ---------- Status bota (opisy) ----------
function renderActivities() {
  const list = state.draft.presence.activities;
  const body = list
    .map(
      (a, i) => `<tr data-activity="${i}">
        <td><select data-activity-field="type" aria-label="Rodzaj">${optionList(ACTIVITY_LABELS, a.type)}</select></td>
        <td class="grow"><input type="text" maxlength="128" value="${esc(a.text)}" data-activity-field="text" aria-label="Tekst opisu"></td>
        <td><button type="button" class="btn ghost small" data-activity-del>Usuń</button></td>
      </tr>`,
    )
    .join('');
  $('#activities-table').innerHTML = `<thead><tr><th>Rodzaj</th><th>Tekst</th><th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="3" class="empty">Brak opisów — bot będzie tylko „online”.</td></tr>'}</tbody>`;
  $('#add-activity').disabled = list.length >= 10;
}

function onActivityChange(event) {
  const row = event.target.closest('[data-activity]');
  const field = event.target.dataset.activityField;
  if (!row || !field) return;
  event.stopPropagation();
  state.draft.presence.activities[Number(row.dataset.activity)][field] = event.target.value;
  state.lastActivityInput = field === 'text' ? event.target : state.lastActivityInput;
  markDirty();
}
$('#activities-table').addEventListener('input', onActivityChange);
$('#activities-table').addEventListener('change', onActivityChange);
$('#activities-table').addEventListener('focusin', (event) => {
  if (event.target.dataset.activityField === 'text') state.lastActivityInput = event.target;
});
$('#activities-table').addEventListener('click', (event) => {
  const row = event.target.closest('[data-activity-del]') && event.target.closest('[data-activity]');
  if (!row) return;
  state.draft.presence.activities.splice(Number(row.dataset.activity), 1);
  state.lastActivityInput = null;
  renderActivities();
  markDirty();
});
$('#add-activity').addEventListener('click', () => {
  state.draft.presence.activities.push({ type: 'custom', text: '' });
  renderActivities();
  markDirty();
  const inputs = $$('#activities-table [data-activity-field="text"]');
  inputs.at(-1)?.focus();
});
$('#presence-chips').addEventListener('click', (event) => {
  const text = event.target.closest('[data-presence-placeholder]')?.dataset.presencePlaceholder;
  const field = state.lastActivityInput?.isConnected ? state.lastActivityInput : $$('#activities-table [data-activity-field="text"]').at(-1);
  if (!text || !field) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = (field.value.slice(0, start) + text + field.value.slice(end)).slice(0, 128);
  field.focus();
  field.setSelectionRange(start + text.length, start + text.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});

// ---------- Hasło panelu ----------
function renderPasswordStatus(status) {
  const text = $('#password-status');
  const form = $('#password-form');
  if (!text || !form) return;
  text.textContent = 'Po zmianie poprzednie hasło przestaje działać (także to z sekretu PANEL_PASSWORD w Supabase).';
  form.classList.remove('hidden');
}

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = $('#password-new').value;
  const repeat = $('#password-repeat').value;
  if (next !== repeat) return toast('Hasła nie są takie same.', 'error');
  $('#password-submit').disabled = true;
  try {
    await api('/password', { method: 'POST', body: JSON.stringify({ next }) });
    setPanelPassword(next);
    $('#password-new').value = '';
    $('#password-repeat').value = '';
    toast('Hasło panelu zmienione');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#password-submit').disabled = false;
  }
});

function renderGatewayLine(gateway) {
  const line = $('#gateway-line');
  if (!line) return;
  if (!gateway?.startedAt) {
    line.textContent = 'gateway: jeszcze nie połączony';
    return;
  }
  const fresh = Date.now() - (gateway.endedAt ?? gateway.startedAt) < 3 * MINUTE;
  const current = gateway.activity ? ` • „${gateway.activity}”` : '';
  line.innerHTML = gateway.error
    ? `<span class="dot bad"></span>${esc(gateway.error)}`
    : `<span class="dot ${fresh ? 'ok' : 'wait'}"></span>gateway ${relTime(gateway.endedAt ?? gateway.startedAt)}${esc(current)}`;
}

// ---------- Kanały głosowe na żądanie ----------
function renderBotWarnings() {
  const bot = state.guild.bot;
  const set = (el, parts) => {
    const html = parts.filter(Boolean).join('<br>');
    el.classList.toggle('hidden', !html);
    el.innerHTML = html;
  };
  const missing = (list, what) =>
    list?.length ? `<strong>Bot nie ma uprawnień: ${list.map(esc).join(', ')}.</strong> Nadaj je roli bota (Ustawienia serwera → Role), inaczej ${what} nie zadziała.` : '';
  const intent = (name, portalName) =>
    `<strong>Potrzebna intencja „${name}”.</strong> Bot włącza ją sam po zapisaniu ustawień${
      bot?.intentsError ? ` — tym razem się nie udało (${esc(bot.intentsError)}). Włącz ją ręcznie: Discord Developer Portal → Bot → Privileged Gateway Intents → ${portalName}.` : '.'
    }`;
  const m = state.draft?.members;
  const logs = state.draft?.logs;
  const logOn = (event) => Boolean(logs?.enabled && logs.events[event] && (logs[`${logGroupOf(event)}ChannelId`] || logs.channelId));
  const joinLogs = logOn('memberJoin') || logOn('memberLeave') || logOn('memberAvatar') || logOn('memberNick');
  const messageLogs = logOn('messageDelete') || logOn('messageEdit') || logOn('messageBulk');
  const membersOn = m && (m.autoRole.enabled || m.welcome.enabled || m.goodbye.enabled || joinLogs);
  const bump = state.draft?.bump;
  set($('#logs-warning'), [
    logs?.enabled ? missing(bot?.missingLogs, 'część logów') : '',
    logs?.enabled && !logs.channelId && !Object.keys(LOG_EVENT_GROUPS).some((g) => logs[`${g}ChannelId`]) ? '<strong>Wybierz kanał logów</strong> — bez kanału nic nie będzie zapisywane.' : '',
    messageLogs && bot && !bot.contentIntent ? intent('Message Content', 'Message Content Intent') + ' Bez niej logi wiadomości nie pokażą treści.' : '',
    joinLogs && bot && !bot.membersIntent ? intent('Server Members', 'Server Members Intent') : '',
  ]);
  if (logOn('memberJoin') && logs?.events.memberInvite && bot?.missingInvites?.length) {
    const warnings = $('#logs-warning');
    warnings.innerHTML = [warnings.innerHTML, `<strong>Bot nie ma uprawnienia „${esc(bot.missingInvites[0])}”</strong> — bez niego nie zobaczy zaproszeń i nie ustali, kto kogo zaprosił.`].filter(Boolean).join('<br>');
    warnings.classList.remove('hidden');
  }
  const alert = logs?.newAccount;
  $('#new-account-roles')?.classList.toggle('hidden', alert?.mention !== 'roles');
  if (logOn('memberJoin') && alert?.ping) {
    const warnings = $('#logs-warning');
    const extra = alert.mention === 'roles' && !alert.roleIds.length
      ? '<strong>Wybierz role do oznaczenia</strong> przy nowych kontach.'
      : alert.mention !== 'roles' && bot?.missingPing?.length
        ? `<strong>Bot nie ma uprawnienia „${esc(bot.missingPing[0])}”</strong> — bez niego ${alert.mention === 'everyone' ? '@everyone' : '@here'} nikogo nie powiadomi.`
        : '';
    if (extra) {
      warnings.innerHTML = [warnings.innerHTML, extra].filter(Boolean).join('<br>');
      warnings.classList.remove('hidden');
    }
  }
  set($('#bump-warning'), [
    bump?.enabled ? missing(bot?.missingBump, 'przypominajka') : '',
    bump?.enabled && bot && !bot.contentIntent ? intent('Message Content', 'Message Content Intent') + ' Bez niej bot nie odróżni udanego bumpa od „poczekaj jeszcze X minut”.' : '',
  ]);
  set($('#community-warning'), [missing(bot?.missingCommunity, 'część komend (reakcje, wątki, ankiety, emoji)')]);
  set($('#voice-warning'), [missing(bot?.missingVoice, 'tworzenie kanałów głosowych')]);
  set($('#roles-warning'), [missing(bot?.missingRoles, 'rozdawanie ról')]);
  set($('#members-warning'), [
    m?.autoRole.enabled ? missing(bot?.missingRoles, 'dawanie ról') : '',
    membersOn && bot && !bot.membersIntent ? intent('Server Members', 'Server Members Intent') : '',
  ]);
  set($('#tickets-warning'), [
    missing(bot?.missingTickets, 'tworzenie ticketów'),
    state.draft?.tickets.enabled && bot && !bot.contentIntent ? intent('Message Content', 'Message Content Intent') + ' Bez niej zapis rozmowy w tickecie będzie pusty.' : '',
  ]);
}

function channelOptions(list, selected, emptyLabel, prefix = '') {
  let html = `<option value="">${esc(emptyLabel)}</option>`;
  html += list
    .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${prefix}${esc(c.name)}${c.category ? ` · ${esc(c.category)}` : ''}</option>`)
    .join('');
  if (selected && !list.some((c) => c.id === selected)) html += `<option value="${esc(selected)}" selected>(nieznany kanał ${esc(selected)})</option>`;
  return html;
}

function renderGenerators() {
  const list = state.draft.tempVoice.generators;
  const body = list
    .map(
      (g, i) => `<tr data-gen="${i}">
        <td><select data-gen-field="hubId" aria-label="Kanał do dołączenia">${channelOptions(state.guild.voiceChannels, g.hubId, '— wybierz kanał —')}</select></td>
        <td><select data-gen-field="categoryId" aria-label="Kategoria">${channelOptions(state.guild.categories, g.categoryId, 'Ta sama co kanał do dołączenia')}</select></td>
        <td class="grow"><input type="text" maxlength="90" value="${esc(g.name)}" data-gen-field="name" aria-label="Nazwa nowego kanału"></td>
        <td><input type="number" min="0" max="99" value="${g.limit}" data-gen-field="limit" aria-label="Limit osób"></td>
        <td><label class="toggle small"><input type="checkbox" data-gen-field="private" ${g.private ? 'checked' : ''}><span></span>Prywatny</label></td>
        <td><button type="button" class="btn ghost small" data-gen-del>Usuń</button></td>
      </tr>`,
    )
    .join('');
  $('#generators-table').innerHTML = `<thead><tr><th>Kanał do dołączenia</th><th>Kategoria nowych kanałów</th><th>Nazwa nowego kanału</th><th>Limit</th><th>Na start</th><th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="6" class="empty">Dodaj kanał, na który trzeba wejść, żeby dostać własny kanał.</td></tr>'}</tbody>`;
  $('#add-generator').disabled = list.length >= 10;
}

function onGeneratorChange(event) {
  const row = event.target.closest('[data-gen]');
  const field = event.target.dataset.genField;
  if (!row || !field) return;
  event.stopPropagation();
  const generator = state.draft.tempVoice.generators[Number(row.dataset.gen)];
  if (field === 'private') generator.private = event.target.checked;
  else if (field === 'limit') generator.limit = Math.min(99, Math.max(0, Math.floor(Number(event.target.value) || 0)));
  else generator[field] = event.target.value;
  markDirty();
}
$('#generators-table').addEventListener('input', onGeneratorChange);
$('#generators-table').addEventListener('change', onGeneratorChange);
$('#generators-table').addEventListener('click', (event) => {
  const row = event.target.closest('[data-gen-del]') && event.target.closest('[data-gen]');
  if (!row) return;
  state.draft.tempVoice.generators.splice(Number(row.dataset.gen), 1);
  renderGenerators();
  markDirty();
});
$('#add-generator').addEventListener('click', () => {
  state.draft.tempVoice.generators.push({ hubId: '', categoryId: '', name: 'Kanał {nick}', limit: 0, private: false });
  renderGenerators();
  markDirty();
});
$('#dashboard-color-picker').addEventListener('input', (event) => {
  event.stopPropagation();
  const field = $('[data-path="tempVoice.dashboard.color"]');
  field.value = event.target.value.toUpperCase();
  field.dispatchEvent(new Event('input', { bubbles: true }));
});

async function loadVoice() {
  try {
    const { channels } = await api('/voice');
    const rows = channels
      .map(
        (c) => `<tr>
          <td><strong>${esc(c.name ?? 'kanał')}</strong><span class="note">${esc(c.channelId)}</span></td>
          <td><span class="note">ID właściciela</span>${esc(c.ownerId)}</td>
          <td>${c.members}</td>
          <td>${c.private ? 'prywatny' : 'publiczny'}${c.limit ? ` • limit ${c.limit}` : ''}</td>
          <td>${esc(relTime(c.createdAt))}</td>
          <td><button type="button" class="btn danger small" data-voice-del="${esc(c.channelId)}">Usuń kanał</button></td>
        </tr>`,
      )
      .join('');
    $('#voice-table').innerHTML = channels.length
      ? `<thead><tr><th>Kanał</th><th>Właściciel</th><th>Osób</th><th>Ustawienia</th><th>Utworzony</th><th></th></tr></thead><tbody>${rows}</tbody>`
      : '<tr><td class="empty">Nikt nie ma teraz własnego kanału.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#voice-refresh').addEventListener('click', loadVoice);
$('#voice-table').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-voice-del]')?.dataset.voiceDel;
  if (!id || !confirm('Usunąć ten kanał? Osoby na nim zostaną rozłączone.')) return;
  try {
    await api(`/voice/${id}`, { method: 'DELETE' });
    toast('Kanał usunięty');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadVoice();
});

// ---------- Pola koloru i zmienne w tekstach ----------
document.addEventListener('input', (event) => {
  const picker = event.target.closest('input[type=color][data-color-for]');
  if (!picker) return;
  event.stopPropagation();
  const field = $(`[data-path="${picker.dataset.colorFor}"]`);
  field.value = picker.value.toUpperCase();
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-insert]');
  if (!chip) return;
  const field = document.getElementById(chip.closest('[data-insert-into]').dataset.insertInto);
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + chip.dataset.insert + field.value.slice(end);
  field.focus();
  field.setSelectionRange(start + chip.dataset.insert.length, start + chip.dataset.insert.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('change', (event) => {
  if (/^(members|logs|bump|suggestions)\.|^tickets\.enabled$/.test(event.target.dataset?.path ?? '')) renderBotWarnings();
});
document.addEventListener('input', (event) => {
  const path = event.target.dataset?.path ?? '';
  if (path.startsWith('bump.')) renderBumpPreview();
  if (path === 'replyReaction.emoji') renderEmojiButtons();
});

// ---------- Logi serwera ----------
function logGroupOf(event) {
  return Object.keys(LOG_EVENT_GROUPS).find((group) => LOG_EVENT_GROUPS[group].some(([key]) => key === event)) ?? 'server';
}

function renderLogEvents() {
  $$('[data-log-group]').forEach((box) => {
    box.innerHTML = `<div class="log-list">${LOG_EVENT_GROUPS[box.dataset.logGroup]
      .map(([key, label]) => `<label class="log-item"><input type="checkbox" data-path="logs.events.${key}"><span>${esc(label)}</span></label>`)
      .join('')}</div>`;
  });
}

// Lista kanałów jako „chipy” (jak role): <div data-channel-picker-slot="ścieżka"></div>
function channelPicker(path) {
  const list = getPath(state.draft, path) ?? [];
  const byId = (id) => state.guild.channels.find((c) => c.id === id) ?? state.guild.voiceChannels.find((c) => c.id === id);
  const chips = list
    .map((id) => `<span class="role-chip">#${esc(byId(id)?.name ?? id)}<button type="button" data-chan-remove="${esc(id)}" title="Usuń">×</button></span>`)
    .join('');
  const options = [...state.guild.channels, ...state.guild.voiceChannels]
    .filter((c) => !list.includes(c.id))
    .map((c) => `<option value="${c.id}">#${esc(c.name)}${c.category ? ` · ${esc(c.category)}` : ''}</option>`);
  const add = options.length ? `<select class="chip-add" data-chan-add aria-label="Dodaj kanał"><option value="">+ Dodaj kanał</option>${options.join('')}</select>` : '';
  return `<div class="role-picker" data-chan-picker="${esc(path)}">${chips}${list.length ? '' : '<span class="muted small">brak</span>'}${add}</div>`;
}

function renderChannelPickers() {
  $$('[data-channel-picker-slot]').forEach((slot) => (slot.innerHTML = channelPicker(slot.dataset.channelPickerSlot)));
}

document.addEventListener('change', (event) => {
  const select = event.target.closest('[data-chan-add]');
  if (!select?.value) return;
  event.stopPropagation();
  const path = select.closest('[data-chan-picker]').dataset.chanPicker;
  setPath(state.draft, path, [...(getPath(state.draft, path) ?? []), select.value]);
  renderChannelPickers();
  markDirty();
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-chan-remove]');
  if (!button) return;
  const path = button.closest('[data-chan-picker]').dataset.chanPicker;
  setPath(state.draft, path, (getPath(state.draft, path) ?? []).filter((id) => id !== button.dataset.chanRemove));
  renderChannelPickers();
  markDirty();
});

// ---------- Bump ----------
function bumpVars(text) {
  const next = Date.now() + (state.draft.bump.intervalMinutes || 120) * MINUTE;
  return String(text ?? '')
    .replaceAll('{uzytkownik}', `<@${SAMPLE.targetId}>`)
    .replaceAll('{nick}', SAMPLE.target)
    .replaceAll('{liczba}', '7')
    .replaceAll('{nastepny}', ts(next, 'R'))
    .replaceAll('{godzina}', ts(next, 't'));
}

function renderBumpPreview() {
  const box = $('#bump-preview');
  if (!box || !state.draft) return;
  const b = state.draft.bump;
  const time = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const avatar = state.status?.bot?.avatar ? `<img src="${esc(state.status.bot.avatar)}" alt="">` : 'EH';
  const name = esc(state.status?.bot?.tag?.split('#')[0] ?? 'Entuzjaści Hopkostki');
  const color = (c) => esc(/^#[0-9a-f]{6}$/i.test(c) ? c : '#5865F2');
  const message = ({ reply, content, embed }) => `<div class="discord"><div class="msg">
      <div class="msg-avatar">${avatar}</div>
      <div>
        ${reply ? `<div class="msg-reply">↱ <strong>DISBOARD</strong> — ${esc(SAMPLE.target)} użył(a) /bump</div>` : ''}
        <div class="msg-head"><span class="msg-name">${name}</span><span class="msg-app">APP</span><span class="msg-time">Dzisiaj o ${time}</span></div>
        ${content ? `<div>${md(content)}</div>` : ''}
        <div class="embed" style="border-left-color:${color(embed.color)}"><div>
          ${embed.title ? `<div class="embed-title">${md(embed.title)}</div>` : ''}
          <div class="embed-desc">${md(embed.description)}</div>
        </div></div>
      </div>
    </div></div>`;
  const parts = [];
  if (b.thanks.enabled) {
    parts.push('<div class="preview-label">Po udanym /bump</div>');
    parts.push(message({ reply: b.thanks.reply, embed: { color: b.thanks.color, title: bumpVars(b.thanks.title), description: bumpVars(b.thanks.message) } }));
  }
  parts.push(`<div class="preview-label">Po ${esc(b.intervalMinutes || 120)} minutach</div>`);
  parts.push(
    message({
      reply: b.reminder.reply && !b.channelId,
      content: b.roleIds.map((id) => `<@&${id}>`).join(' '),
      embed: { color: b.reminder.color, title: b.reminder.title, description: bumpVars(b.reminder.message) },
    }),
  );
  box.innerHTML = parts.join('');
}

async function loadBump() {
  try {
    const { last, ranking, month } = await api('/bump');
    $('#bump-last').innerHTML = last?.at
      ? `Ostatni bump: <strong>${esc(relTime(last.at))}</strong> (ID osoby ${esc(last.userId)}). ${
          last.remindAt > Date.now() ? `Przypomnienie ${esc(relTime(last.remindAt))}.` : last.reminded ? 'Przypomnienie wysłane — można bumpować.' : 'Można bumpować.'
        }`
      : 'Bot nie zapisał jeszcze żadnego bumpa.';
    const monthly = new Map(month.map((r) => [r.userId, r.count]));
    $('#bump-ranking').innerHTML = ranking.length
      ? `<thead><tr><th>#</th><th>Osoba</th><th>Bumpy</th><th>30 dni</th></tr></thead><tbody>${ranking
          .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.userId)}<span class="note">ostatni ${esc(relTime(r.lastAt))}</span></td><td><strong>${r.count}</strong></td><td>${monthly.get(r.userId) ?? 0}</td></tr>`)
          .join('')}</tbody>`
      : '<tr><td class="empty">Brak bumpów.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#bump-refresh').addEventListener('click', loadBump);

// ---------- Konkursy ----------
async function loadGiveaways() {
  try {
    const { giveaways } = await api('/giveaways');
    const channelName = (id) => state.guild.channels.find((c) => c.id === id)?.name ?? id;
    $('#giveaways-table').innerHTML = giveaways.length
      ? `<thead><tr><th>#</th><th>Nagroda</th><th>Kanał</th><th>Uczestnicy</th><th>Koniec</th><th></th></tr></thead><tbody>${giveaways
          .map(
            (g) => `<tr>
              <td>${g.id}</td>
              <td><strong>${esc(g.prize)}</strong>${g.ended && g.winnerIds.length ? `<span class="note">Zwycięzcy (ID): ${esc(g.winnerIds.join(', '))}</span>` : ''}</td>
              <td>#${esc(channelName(g.channelId))}</td>
              <td>${g.entrants.length}</td>
              <td>${g.ended ? 'zakończony' : esc(relTime(g.endsAt))}</td>
              <td>${g.ended ? '' : `<button type="button" class="btn ghost small" data-giveaway-end="${g.id}">Zakończ teraz</button>`}</td>
            </tr>`,
          )
          .join('')}</tbody>`
      : '<tr><td class="empty">Nie było jeszcze konkursów — uruchom je komendą /konkurs start.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#giveaways-refresh').addEventListener('click', loadGiveaways);
$('#giveaways-table').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-giveaway-end]')?.dataset.giveawayEnd;
  if (!id || !confirm('Zakończyć konkurs teraz i wylosować zwycięzców?')) return;
  try {
    await api(`/giveaways/${id}/end`, { method: 'POST' });
    toast('Konkurs zakończony');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadGiveaways();
});

// ---------- Wybór emoji (emoji serwera albo zwykłe) ----------
const CUSTOM_EMOJI = /^<(a?):(\w+):(\d+)>$/;
function emojiHtml(value) {
  const custom = CUSTOM_EMOJI.exec(value ?? '');
  if (custom) return `<img class="emoji" alt=":${esc(custom[2])}:" src="https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'png'}?size=48">`;
  return value ? `<span class="emoji-text">${esc(value)}</span>` : '';
}

let emojiTarget = null;
function openEmojiPicker(anchor, current, onPick) {
  closeEmojiPicker();
  emojiTarget = onPick;
  const pop = document.createElement('div');
  pop.id = 'emoji-pop';
  pop.className = 'emoji-pop';
  const emojis = state.guild.emojis ?? [];
  pop.innerHTML = `
    <div class="emoji-pop-head"><strong>Emoji serwera</strong><button type="button" class="btn ghost small" data-emoji-close>Zamknij</button></div>
    <div class="emoji-grid">${
      emojis.length
        ? emojis.map((e) => `<button type="button" data-emoji-pick="${esc(e.tag)}" title=":${esc(e.name)}:" class="${e.tag === current ? 'active' : ''}"><img src="${esc(e.url)}" alt=":${esc(e.name)}:" loading="lazy"></button>`).join('')
        : '<p class="muted small">Serwer nie ma własnych emoji.</p>'
    }</div>
    <label class="field"><span>Albo wpisz zwykłe emoji (np. 🎮)</span>
      <div class="emoji-own"><input type="text" maxlength="32" data-emoji-own value="${CUSTOM_EMOJI.test(current ?? '') ? '' : esc(current ?? '')}"><button type="button" class="btn small" data-emoji-own-ok>Ustaw</button></div>
    </label>
    <button type="button" class="btn ghost small" data-emoji-pick="">Bez emoji</button>`;
  document.body.append(pop);
  // Gdy obrazek się nie wczyta, zostaje nazwa emoji.
  $$('img', pop).forEach((img) =>
    img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'emoji-fallback', textContent: img.alt }))),
  );
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 32);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(16, Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - width - 16))}px`;
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
}
function closeEmojiPicker() {
  $('#emoji-pop')?.remove();
  emojiTarget = null;
}
document.addEventListener('click', (event) => {
  const pop = event.target.closest('#emoji-pop');
  if (!pop) {
    if (!event.target.closest('[data-emoji-open]')) closeEmojiPicker();
    return;
  }
  if (event.target.closest('[data-emoji-close]')) return closeEmojiPicker();
  const pick = event.target.closest('[data-emoji-pick]');
  const own = event.target.closest('[data-emoji-own-ok]');
  if (!pick && !own) return;
  const value = pick ? pick.dataset.emojiPick : $('[data-emoji-own]', pop).value.trim();
  const done = emojiTarget;
  closeEmojiPicker();
  done?.(value);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeEmojiPicker();
  if (event.key === 'Enter' && event.target.matches('[data-emoji-own]')) {
    event.preventDefault();
    $('[data-emoji-own-ok]')?.click();
  }
});

// Przyciski wyboru emoji przy polach konfiguracji: <button data-emoji-open data-emoji-path="ścieżka">
function renderEmojiButtons() {
  $$('[data-emoji-path]').forEach((button) => {
    const value = getPath(state.draft, button.dataset.emojiPath);
    button.innerHTML = value ? `${emojiHtml(value)} Zmień` : 'Wybierz emoji';
  });
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-emoji-open][data-emoji-path]');
  if (!button) return;
  openEmojiPicker(button, getPath(state.draft, button.dataset.emojiPath), (value) => {
    const field = $(`[data-path="${button.dataset.emojiPath}"]`);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    renderEmojiButtons();
  });
});

// ---------- Dostęp do panelu (loginy moderacji z /login) ----------
async function loadLogins() {
  try {
    const { logins, sections } = await api('/access/logins');
    const access = (x) =>
      x.full ? 'Wszystko (administrator)' : x.sections.length ? esc(x.sections.map((key) => sections[key] ?? key).join(', ')) : '<span class="muted">nic — przy następnym wejściu zostanie wylogowany</span>';
    $('#logins-table').innerHTML = logins.length
      ? `<thead><tr><th>Osoba</th><th>Może zmieniać</th><th>Utworzony</th><th>Wygasa</th><th>Zalogowania</th><th></th></tr></thead><tbody>${logins
          .map(
            (x) => `<tr>
          <td><strong>${esc(x.userTag ?? x.userId)}</strong><span class="note">login: ${esc(x.login)}</span></td>
          <td>${access(x)}</td>
          <td>${relTime(x.createdAt)}</td>
          <td>${relTime(x.expiresAt)}</td>
          <td>${x.sessions ? `${x.sessions} ${plural(x.sessions, ['przeglądarka', 'przeglądarki', 'przeglądarek'])}${x.lastSeenAt ? `<span class="note">ostatnio ${relTime(x.lastSeenAt)}</span>` : ''}` : '<span class="muted">teraz nie jest zalogowany(-a)</span>'}</td>
          <td><button type="button" class="btn danger small" data-login-revoke="${x.id}">Wymuś nowy login</button></td>
        </tr>`,
          )
          .join('')}</tbody>`
      : '<tr><td class="empty">Nikt nie ma teraz aktywnego loginu z /login.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#logins-refresh').addEventListener('click', loadLogins);
$('#logins-table').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-login-revoke]')?.dataset.loginRevoke;
  if (!id || !confirm('Unieważnić ten login? Hasło przestanie działać, a ta osoba zostanie wylogowana — żeby wrócić, wpisze /login jeszcze raz.')) return;
  try {
    await api(`/access/logins/${id}`, { method: 'DELETE' });
    toast('Login unieważniony');
    loadLogins();
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('#logins-revoke-all').addEventListener('click', async () => {
  if (!confirm('Unieważnić wszystkie loginy z /login (także Twój, jeśli tak się zalogowałeś)? Każdy będzie musiał wpisać /login jeszcze raz. Logowanie hasłem panelu zostaje.')) return;
  try {
    const { removed } = await api('/access/logins', { method: 'DELETE' });
    toast(`Unieważniono loginy: ${removed}`);
    loadLogins();
  } catch (error) {
    toast(error.message, 'error');
  }
});

// ---------- Uprawnienia ról w samym Discordzie ----------
// [klucz, nazwa, bit] w grupach — klucze muszą być na liście ROLE_PERMISSION_KEYS po stronie bota.
const ROLE_PERM_GROUPS = [
  ['Kary i ludzie', [['KICK_MEMBERS', 'Wyrzucanie', 1n << 1n], ['BAN_MEMBERS', 'Banowanie', 1n << 2n], ['MODERATE_MEMBERS', 'Wyciszanie (timeout)', 1n << 40n], ['MANAGE_NICKNAMES', 'Zmiana cudzych pseudonimów', 1n << 27n], ['MANAGE_ROLES', 'Zarządzanie rolami', 1n << 28n]]],
  ['Wiadomości i kanały', [['MANAGE_MESSAGES', 'Usuwanie wiadomości', 1n << 13n], ['MANAGE_THREADS', 'Zarządzanie wątkami', 1n << 34n], ['MANAGE_CHANNELS', 'Zarządzanie kanałami', 1n << 4n], ['MANAGE_WEBHOOKS', 'Webhooki', 1n << 29n], ['MENTION_EVERYONE', '@everyone i @here', 1n << 17n]]],
  ['Kanały głosowe', [['MOVE_MEMBERS', 'Przenoszenie osób', 1n << 24n], ['MUTE_MEMBERS', 'Wyciszanie osób', 1n << 22n], ['DEAFEN_MEMBERS', 'Ogłuszanie osób', 1n << 23n]]],
  ['Serwer', [['MANAGE_GUILD', 'Zarządzanie serwerem', 1n << 5n], ['MANAGE_GUILD_EXPRESSIONS', 'Emoji i naklejki', 1n << 30n], ['MANAGE_EVENTS', 'Wydarzenia', 1n << 33n], ['VIEW_AUDIT_LOG', 'Dziennik zdarzeń', 1n << 7n], ['VIEW_GUILD_INSIGHTS', 'Statystyki serwera', 1n << 19n], ['CREATE_INSTANT_INVITE', 'Tworzenie zaproszeń', 1n << 0n]]],
  ['Zwykłe uprawnienia', [['CHANGE_NICKNAME', 'Zmiana własnego pseudonimu', 1n << 26n], ['ADD_REACTIONS', 'Dodawanie reakcji', 1n << 6n], ['ATTACH_FILES', 'Załączanie plików', 1n << 15n], ['EMBED_LINKS', 'Osadzanie linków', 1n << 14n], ['USE_EXTERNAL_EMOJIS', 'Zewnętrzne emoji', 1n << 18n], ['CREATE_PUBLIC_THREADS', 'Tworzenie wątków', 1n << 35n], ['SEND_POLLS', 'Tworzenie ankiet', 1n << 49n]]],
];
const ROLE_PERMS = ROLE_PERM_GROUPS.flatMap(([, perms]) => perms);
const roleBits = (role) => BigInt(role.permissions ?? 0);

function renderRolePermissions() {
  if (!state.me?.full) return;
  const open = new Set($$('#role-perms-list details[open]').map((d) => d.dataset.roleId));
  const roles = state.guild.roles.filter((r) => !hasBit(r.permissions, ADMINISTRATOR_BIT));
  $('#role-perms-list').innerHTML = roles.length
    ? roles
        .map((r) => {
          const on = ROLE_PERMS.filter(([, , bit]) => (roleBits(r) & bit) === bit).length;
          const groups = ROLE_PERM_GROUPS.map(
            ([group, perms]) => `<div class="role-perm-group"><strong>${esc(group)}</strong>${perms
              .map(
                ([key, label, bit]) =>
                  `<label class="toggle small"><input type="checkbox" data-role-perm="${esc(key)}" data-role-id="${r.id}" ${(roleBits(r) & bit) === bit ? 'checked' : ''} ${r.assignable ? '' : 'disabled'}><span></span>${esc(label)}</label>`,
              )
              .join('')}</div>`,
          ).join('');
          const note = r.assignable ? '' : ' • wyżej niż bot, tylko w ustawieniach serwera';
          return `<details class="role-perm" data-role-id="${r.id}" ${open.has(r.id) ? 'open' : ''}>
        <summary><span class="role-dot" style="background:${esc(r.color !== '#000000' ? r.color : '#99aab5')}"></span>${esc(r.name)}<small class="muted"> — włączone: ${on} z ${ROLE_PERMS.length}${note}</small></summary>
        ${groups}
      </details>`;
        })
        .join('')
    : '<p class="muted">Brak ról do ustawienia.</p>';
}
$('#role-perms-list').addEventListener('change', async (event) => {
  const box = event.target.closest('[data-role-perm]');
  if (!box) return;
  const role = state.guild.roles.find((r) => r.id === box.dataset.roleId);
  const [, label] = ROLE_PERMS.find(([key]) => key === box.dataset.rolePerm);
  if (!confirm(`${box.checked ? 'Nadać' : 'Odebrać'} roli ${role.name} uprawnienie „${label}” w Discordzie? Zmiana działa od razu na serwerze.`)) {
    box.checked = !box.checked;
    return;
  }
  box.disabled = true;
  try {
    const { role: updated } = await api(`/roles/${role.id}/permissions`, { method: 'POST', body: JSON.stringify({ permission: box.dataset.rolePerm, value: box.checked }) });
    role.permissions = updated.permissions;
    toast(`${role.name}: ${box.checked ? 'nadano' : 'odebrano'} „${label}”`);
    renderRolePermissions();
  } catch (error) {
    box.checked = !box.checked;
    toast(error.message, 'error');
  } finally {
    box.disabled = !role.assignable;
    renderPermissionMatrix();
  }
});

// ---------- Tickety ----------
// Każdy rodzaj ticketu (przycisk w panelu) ma własny formularz: maks. 5 pól w okienku Discorda.
const TICKET_FIELD_KINDS = { short: 'Krótka odpowiedź', long: 'Długi tekst', number: 'Liczba', invite: 'Link do serwera Discord' };

// Starsze rodzaje ticketów miały jedno pole `question` — w edytorze to formularz z jednym długim polem.
function ticketTypeFields(type) {
  if (!Array.isArray(type.fields)) {
    type.fields = type.question ? [{ label: type.question, placeholder: '', kind: 'long', required: true }] : [];
    delete type.question;
  }
  return type.fields;
}

function renderTicketTypes() {
  const types = state.draft.tickets.types;
  $('#ticket-types').innerHTML = types
    .map((t, i) => {
      const fields = Array.isArray(t.fields) ? t.fields : t.question ? [{ label: t.question, placeholder: '', kind: 'long', required: true }] : [];
      return `<div class="ttype" data-ttype="${i}">
        <div class="ttype-row">
          <button type="button" class="btn ghost small emoji-btn" data-emoji-open data-ttype-emoji title="Emoji na przycisku (emoji serwera albo zwykłe)">${t.emoji ? emojiHtml(t.emoji) : 'Emoji'}</button>
          <input type="text" maxlength="80" value="${esc(t.label)}" data-ttype-field="label" aria-label="Napis na przycisku">
          <select data-ttype-field="style" aria-label="Kolor przycisku">${Object.entries(BUTTON_STYLES).map(([v, l]) => `<option value="${v}" ${v === t.style ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button type="button" class="btn ghost small" data-ttype-del ${types.length <= 1 ? 'disabled' : ''}>Usuń</button>
        </div>
        <div class="tfields">
          <span class="muted small">Formularz przed otwarciem ticketu${fields.length ? '' : ' — brak pól, ticket otwiera się od razu'}</span>
          ${fields
            .map(
              (f, j) => `<div class="tfield" data-tfield="${j}">
            <input type="text" maxlength="45" value="${esc(f.label)}" data-tfield-prop="label" placeholder="Pytanie (maks. 45 znaków)" aria-label="Pytanie">
            <select data-tfield-prop="kind" aria-label="Rodzaj odpowiedzi">${Object.entries(TICKET_FIELD_KINDS).map(([v, l]) => `<option value="${v}" ${v === f.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <label class="toggle small"><input type="checkbox" data-tfield-prop="required" ${f.required !== false ? 'checked' : ''}><span></span>Wymagane</label>
            <button type="button" class="btn ghost small" data-tfield-del aria-label="Usuń pole">Usuń</button>
            <input type="text" maxlength="100" value="${esc(f.placeholder ?? '')}" data-tfield-prop="placeholder" placeholder="Podpowiedź w polu (opcjonalnie, np. https://discord.gg/…)" aria-label="Podpowiedź" class="tfield-hint">
          </div>`,
            )
            .join('')}
          <button type="button" class="btn ghost small" data-tfield-add ${fields.length >= 5 ? 'disabled' : ''}>Dodaj pole</button>
        </div>
        <label class="field"><span>Powitanie w tym rodzaju ticketu (puste = wspólne z ustawień)</span><textarea rows="2" maxlength="1500" data-ttype-field="welcome" placeholder="np. Dzięki za chęć partnerstwa, {uzytkownik}! Sprawdzimy Twój serwer.">${esc(t.welcome ?? '')}</textarea></label>
        <label class="field"><span>Regulamin przed formularzem (puste = bez ekranu regulaminu)</span><textarea rows="5" maxlength="3800" data-ttype-field="rules" placeholder="Osoba zobaczy ten tekst z przyciskami „Akceptuję regulamin” i „Nie akceptuję” — formularz pojawi się dopiero po akceptacji. Możesz użyć **pogrubienia**.">${esc(t.rules ?? '')}</textarea></label>
        <details class="ttype-own">
          <summary>Osobne ustawienia i uprawnienia tego rodzaju (kategoria, obsługa, logi, autor)</summary>
          <p class="muted small">Puste pola używają ustawień ogólnych z karty „Ustawienia”. Dzięki temu np. partnerstwa trafiają do innej kategorii i widzi je inna obsługa niż zgłoszenia.</p>
          <label class="field"><span>Kategoria</span><select data-ttype-field="categoryId">${channelOptions(state.guild.categories, t.categoryId ?? '', 'Jak w ustawieniach ogólnych', '')}</select></label>
          <label class="field"><span>Kategoria archiwum</span><select data-ttype-field="archiveCategoryId">${channelOptions(state.guild.categories, t.archiveCategoryId ?? '', 'Jak w ustawieniach ogólnych', '')}</select></label>
          <label class="field"><span>Kanał logów</span><select data-ttype-field="logChannelId">${channelOptions(state.guild.channels, t.logChannelId ?? '', 'Jak w ustawieniach ogólnych', '#')}</select></label>
          <div class="field"><span>Obsługa tego rodzaju (puste = obsługa z ustawień ogólnych; tylko te role widzą ticket)</span><div data-picker-slot="cfg:tickets.types.${i}.supportRoleIds"></div></div>
          <label class="toggle"><input type="checkbox" data-ttype-field="authorCanClose" ${t.authorCanClose !== false ? 'checked' : ''}><span></span>Autor może zamknąć ticket</label>
          <label class="toggle"><input type="checkbox" data-ttype-field="authorCanAdd" ${t.authorCanAdd !== false ? 'checked' : ''}><span></span>Autor może dodawać osoby</label>
          <label class="toggle"><input type="checkbox" data-ttype-field="authorCanAttach" ${t.authorCanAttach !== false ? 'checked' : ''}><span></span>Autor może wysyłać pliki i linki z podglądem</label>
        </details>
      </div>`;
    })
    .join('');
  $('#add-ticket-type').disabled = types.length >= 5;
  renderPickers();
  const saved = state.ticketPanel?.channelId;
  $('#ticket-panel-channel').innerHTML = channelOptions(state.guild.channels, saved ?? '', '— wybierz kanał —', '#');
}

function onTicketTypeChange(event) {
  const row = event.target.closest('[data-ttype]');
  if (!row) return;
  const type = state.draft.tickets.types[Number(row.dataset.ttype)];
  const field = event.target.dataset.ttypeField;
  const prop = event.target.dataset.tfieldProp;
  if (field) type[field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  else if (prop) {
    const item = ticketTypeFields(type)[Number(event.target.closest('[data-tfield]').dataset.tfield)];
    item[prop] = prop === 'required' ? event.target.checked : event.target.value;
  } else return;
  event.stopPropagation();
  markDirty();
}
$('#ticket-types').addEventListener('input', onTicketTypeChange);
$('#ticket-types').addEventListener('change', onTicketTypeChange);
$('#ticket-types').addEventListener('click', (event) => {
  const row = event.target.closest('[data-ttype]');
  if (!row) return;
  const types = state.draft.tickets.types;
  const type = types[Number(row.dataset.ttype)];
  if (event.target.closest('[data-ttype-emoji]')) {
    openEmojiPicker(event.target.closest('[data-ttype-emoji]'), type.emoji ?? '', (value) => {
      type.emoji = value;
      renderTicketTypes();
      markDirty();
    });
    return;
  }
  if (event.target.closest('[data-ttype-del]')) types.splice(Number(row.dataset.ttype), 1);
  else if (event.target.closest('[data-tfield-add]')) {
    const fields = ticketTypeFields(type);
    if (fields.length >= 5) return;
    fields.push({ label: '', placeholder: '', kind: 'short', required: true });
  } else if (event.target.closest('[data-tfield-del]')) {
    ticketTypeFields(type).splice(Number(event.target.closest('[data-tfield]').dataset.tfield), 1);
  } else return;
  renderTicketTypes();
  markDirty();
});
$('#add-ticket-type').addEventListener('click', () => {
  state.draft.tickets.types.push({ label: 'Nowy ticket', style: 'szary', emoji: '', welcome: '', rules: '', categoryId: '', archiveCategoryId: '', logChannelId: '', supportRoleIds: [], authorCanClose: true, authorCanAdd: true, authorCanAttach: true, fields: [{ label: 'Opisz krótko swoją sprawę', placeholder: '', kind: 'long', required: true }] });
  renderTicketTypes();
  markDirty();
});
$('#ticket-panel-send').addEventListener('click', async () => {
  if (isDirty()) return toast('Najpierw zapisz zmiany (przycisk na dole ekranu).', 'error');
  const channelId = $('#ticket-panel-channel').value;
  if (!channelId) return toast('Wybierz kanał.', 'error');
  $('#ticket-panel-send').disabled = true;
  try {
    const { panel } = await api('/tickets/panel', { method: 'POST', body: JSON.stringify({ channelId }) });
    toast(panel.updated ? 'Panel ticketów zaktualizowany' : 'Panel ticketów wysłany');
    loadTickets();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#ticket-panel-send').disabled = false;
  }
});

async function loadTickets() {
  try {
    const { tickets, panel } = await api('/tickets');
    state.ticketPanel = panel;
    const channelName = (id) => state.guild.channels.find((c) => c.id === id)?.name ?? id;
    $('#ticket-panel-info').textContent = panel ? `Panel jest teraz na #${channelName(panel.channelId)} (wysłany ${relTime(panel.at)}). Ponowne wysłanie na ten sam kanał tylko go zaktualizuje.` : 'Panel nie został jeszcze wysłany.';
    if (!$('#ticket-panel-channel').value && panel) $('#ticket-panel-channel').value = panel.channelId;
    const rows = tickets
      .map(
        (t) => `<tr>
          <td><strong>#${String(t.id).padStart(4, '0')}</strong></td>
          <td>${esc(t.userTag ?? t.userId)}<span class="note">${esc(t.userId)}</span></td>
          <td>${esc(t.type ?? '—')}${t.subject ? `<span class="note">${esc(t.subject.slice(0, 80))}</span>` : ''}</td>
          <td><span class="dot ${t.status === 'open' ? 'ok' : 'wait'}"></span>${t.status === 'open' ? 'otwarty' : 'zamknięty'}${t.claimedBy ? '<span class="note">przejęty</span>' : ''}</td>
          <td>${esc(shortDate(t.createdAt))}${t.closedAt ? `<span class="note">zamknięty ${esc(shortDate(t.closedAt))}</span>` : ''}</td>
          <td>${t.status === 'open' ? `<button type="button" class="btn danger small" data-ticket-close="${t.id}">Zamknij</button>` : ''}</td>
        </tr>`,
      )
      .join('');
    $('#tickets-table').innerHTML = tickets.length
      ? `<thead><tr><th>#</th><th>Autor</th><th>Rodzaj / sprawa</th><th>Status</th><th>Otwarty</th><th></th></tr></thead><tbody>${rows}</tbody>`
      : '<tr><td class="empty">Nie było jeszcze żadnych ticketów.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#tickets-refresh').addEventListener('click', loadTickets);
$('#tickets-table').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-ticket-close]')?.dataset.ticketClose;
  if (!id || !confirm('Zamknąć ten ticket? Kanał trafi do archiwum i zniknie dla autora oraz każdego poza obsługą; zapis trafi do logów, w DM do autora i na ten kanał.')) return;
  try {
    await api(`/tickets/${id}/close`, { method: 'POST' });
    toast('Ticket zamknięty');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadTickets();
});

// ---------- Wiadomości (z przyciskami / listą ról) ----------
function blankMessage() {
  return {
    channelId: '',
    content: '',
    embed: { enabled: false, title: '', description: '', color: '#5865F2', image: '', footer: '' },
    roles: { mode: 'none', placeholder: '', multiple: true, items: [] },
  };
}

const roleById = (id) => state.guild.roles.find((r) => r.id === id);

function renderMessageEditor() {
  if (!state.msg) return;
  const { data, editingId } = state.msg;
  $('#msg-editor-title').textContent = editingId ? 'Edycja wysłanej wiadomości' : 'Nowa wiadomość';
  $('#msg-send').textContent = editingId ? 'Zapisz zmiany' : 'Wyślij';
  $('#msg-cancel').classList.toggle('hidden', !editingId);
  $('#msg-channel').innerHTML = channelOptions(state.guild.channels, data.channelId, '— wybierz kanał —', '#');
  $('#msg-channel').disabled = Boolean(editingId);
  $('#msg-content').value = data.content;
  $('#msg-embed-enabled').checked = data.embed.enabled;
  $('#msg-embed-title').value = data.embed.title;
  $('#msg-embed-description').value = data.embed.description;
  $('#msg-embed-color').value = data.embed.color;
  if (/^#[0-9a-f]{6}$/i.test(data.embed.color)) $('#msg-embed-color-picker').value = data.embed.color;
  $('#msg-embed-image').value = data.embed.image;
  $('#msg-embed-footer').value = data.embed.footer;
  $$('input[name="role-mode"]').forEach((el) => (el.checked = el.value === data.roles.mode));
  $('#msg-placeholder').value = data.roles.placeholder;
  $('#msg-multiple').checked = data.roles.multiple;
  renderMessageItems();
  syncMessageSections();
}

function syncMessageSections() {
  const { data } = state.msg;
  $('#msg-embed-fields').classList.toggle('hidden', !data.embed.enabled);
  $('#msg-roles').classList.toggle('hidden', data.roles.mode === 'none');
  $('#msg-select-options').classList.toggle('hidden', data.roles.mode !== 'select');
  renderMessagePreview();
}

function renderMessageItems() {
  const { mode, items } = state.msg.data.roles;
  const assignable = state.guild.roles.filter((r) => r.assignable);
  const roleSelect = (selected) => {
    let html = '<option value="">— wybierz rolę —</option>';
    html += assignable.map((r) => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    if (selected && !assignable.some((r) => r.id === selected)) {
      html += `<option value="${esc(selected)}" selected>${esc(roleById(selected)?.name ?? 'nieznana rola')} (bot nie może jej nadać)</option>`;
    }
    return html;
  };
  const rows = items
    .map(
      (item, i) => `<tr data-item="${i}">
        <td><select data-item-field="roleId" aria-label="Rola">${roleSelect(item.roleId)}</select></td>
        <td class="grow"><div class="emoji-own">
          <button type="button" class="btn ghost small emoji-btn" data-emoji-open data-emoji-item="${i}" title="Emoji przy roli (emoji serwera albo zwykłe)">${item.emoji ? emojiHtml(item.emoji) : 'Emoji'}</button>
          <input type="text" maxlength="80" value="${esc(item.label)}" data-item-field="label" placeholder="${esc(roleById(item.roleId)?.name ?? 'Nazwa roli')}" aria-label="Napis">
        </div></td>
        <td>${
          mode === 'buttons'
            ? `<select data-item-field="style" aria-label="Kolor przycisku">${Object.entries(BUTTON_STYLES).map(([v, l]) => `<option value="${v}" ${v === item.style ? 'selected' : ''}>${l}</option>`).join('')}</select>`
            : `<input type="text" maxlength="100" value="${esc(item.description)}" data-item-field="description" placeholder="Opis (opcjonalnie)" aria-label="Opis">`
        }</td>
        <td><button type="button" class="btn ghost small" data-item-del>Usuń</button></td>
      </tr>`,
    )
    .join('');
  const third = mode === 'buttons' ? 'Kolor' : 'Opis na liście';
  $('#msg-items').innerHTML = `<thead><tr><th>Rola</th><th>Emoji i napis</th><th>${third}</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="empty">Dodaj role, które można będzie sobie wybrać.</td></tr>'}</tbody>`;
  $('#msg-add-item').disabled = items.length >= 25;
}

function readMessageForm() {
  const { data } = state.msg;
  data.channelId = $('#msg-channel').value;
  data.content = $('#msg-content').value;
  data.embed.enabled = $('#msg-embed-enabled').checked;
  data.embed.title = $('#msg-embed-title').value;
  data.embed.description = $('#msg-embed-description').value;
  data.embed.color = $('#msg-embed-color').value;
  data.embed.image = $('#msg-embed-image').value.trim();
  data.embed.footer = $('#msg-embed-footer').value;
  data.roles.mode = $('input[name="role-mode"]:checked')?.value ?? 'none';
  data.roles.placeholder = $('#msg-placeholder').value;
  data.roles.multiple = $('#msg-multiple').checked;
}

function onMessageFormChange(event) {
  if (!state.msg) return;
  const el = event.target;
  const row = el.closest('[data-item]');
  if (row && el.dataset.itemField) {
    state.msg.data.roles.items[Number(row.dataset.item)][el.dataset.itemField] = el.value;
    if (el.dataset.itemField === 'roleId') renderMessageItems();
    renderMessagePreview();
    return;
  }
  const modeBefore = state.msg.data.roles.mode;
  readMessageForm();
  if (el.id === 'msg-embed-color' && /^#[0-9a-f]{6}$/i.test(el.value)) $('#msg-embed-color-picker').value = el.value;
  if (state.msg.data.roles.mode !== modeBefore) renderMessageItems();
  syncMessageSections();
}
$('#view-wiadomosci').addEventListener('input', onMessageFormChange);
$('#view-wiadomosci').addEventListener('change', onMessageFormChange);
$('#msg-embed-color-picker').addEventListener('input', (event) => {
  event.stopPropagation();
  $('#msg-embed-color').value = event.target.value.toUpperCase();
  $('#msg-embed-color').dispatchEvent(new Event('input', { bubbles: true }));
});
$('#msg-items').addEventListener('click', (event) => {
  const emojiButton = event.target.closest('[data-emoji-item]');
  if (emojiButton) {
    const item = state.msg.data.roles.items[Number(emojiButton.dataset.emojiItem)];
    openEmojiPicker(emojiButton, item.emoji, (value) => {
      item.emoji = value;
      renderMessageItems();
      renderMessagePreview();
    });
    return;
  }
  const row = event.target.closest('[data-item-del]') && event.target.closest('[data-item]');
  if (!row) return;
  state.msg.data.roles.items.splice(Number(row.dataset.item), 1);
  renderMessageItems();
  renderMessagePreview();
});
$('#msg-add-item').addEventListener('click', () => {
  const used = new Set(state.msg.data.roles.items.map((i) => i.roleId));
  const next = state.guild.roles.find((r) => r.assignable && !used.has(r.id));
  state.msg.data.roles.items.push({ roleId: next?.id ?? '', label: '', description: '', style: 'niebieski', emoji: '' });
  renderMessageItems();
  renderMessagePreview();
});
$('#msg-cancel').addEventListener('click', () => {
  state.msg = { editingId: null, data: blankMessage() };
  renderMessageEditor();
});
$('#msg-send').addEventListener('click', async () => {
  readMessageForm();
  const { editingId, data } = state.msg;
  $('#msg-send').disabled = true;
  try {
    if (editingId) await api(`/messages/${editingId}`, { method: 'PUT', body: JSON.stringify(data) });
    else await api('/messages', { method: 'POST', body: JSON.stringify(data) });
    toast(editingId ? 'Wiadomość zaktualizowana' : 'Wiadomość wysłana');
    if (!editingId) {
      state.msg = { editingId: null, data: { ...blankMessage(), channelId: data.channelId } };
      renderMessageEditor();
    }
    loadSentMessages();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#msg-send').disabled = false;
  }
});

function renderMessagePreview() {
  const d = state.msg.data;
  const time = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const avatar = state.status?.bot?.avatar ? `<img src="${esc(state.status.bot.avatar)}" alt="">` : 'EH';
  const name = state.status?.bot?.tag?.split('#')[0] ?? 'Entuzjaści Hopkostki';
  const hasEmbed = d.embed.enabled && (d.embed.title || d.embed.description || d.embed.image);
  const embed = hasEmbed
    ? `<div class="embed" style="border-left-color:${esc(/^#[0-9a-f]{6}$/i.test(d.embed.color) ? d.embed.color : '#5865F2')}">
        <div>
          ${d.embed.title ? `<div class="embed-title">${md(d.embed.title)}</div>` : ''}
          ${d.embed.description ? `<div class="embed-desc">${md(d.embed.description)}</div>` : ''}
          ${/^https:\/\//i.test(d.embed.image) ? `<img class="embed-image" src="${esc(d.embed.image)}" alt="">` : ''}
        </div>
        ${d.embed.footer ? `<div class="embed-footer">${esc(d.embed.footer)}</div>` : ''}
      </div>`
    : '';
  const label = (item) => item.label || roleById(item.roleId)?.name || 'Rola';
  let components = '';
  if (d.roles.mode === 'buttons' && d.roles.items.length) {
    components = `<div class="dc-buttons">${d.roles.items.map((i) => `<span class="dc-button ${esc(i.style)}">${emojiHtml(i.emoji)}${esc(label(i))}</span>`).join('')}</div>`;
  } else if (d.roles.mode === 'select' && d.roles.items.length) {
    components = `<div class="dc-select"><span>${esc(d.roles.placeholder || 'Wybierz role')}</span><i></i></div>
      <div class="dc-options">${d.roles.items.map((i) => `<div>${i.emoji ? `<span class="dc-option-emoji">${emojiHtml(i.emoji)}</span>` : ''}<span><b>${esc(label(i))}</b>${i.description ? `<small>${esc(i.description)}</small>` : ''}</span></div>`).join('')}</div>`;
  }
  const empty = !d.content && !hasEmbed;
  $('#msg-preview').innerHTML = `<div class="msg">
    <div class="msg-avatar">${avatar}</div>
    <div>
      <div class="msg-head"><span class="msg-name">${esc(name)}</span><span class="msg-app">APP</span><span class="msg-time">Dzisiaj o ${time}</span></div>
      ${empty ? '<div class="muted small">Wpisz treść albo włącz embed.</div>' : ''}
      ${d.content ? `<div>${md(d.content)}</div>` : ''}
      ${embed}
      ${components}
    </div>
  </div>`;
}

async function loadSentMessages() {
  try {
    const { messages } = await api('/messages');
    state.sentMessages = messages;
    const channelName = (id) => state.guild.channels.find((c) => c.id === id)?.name ?? id;
    const modeText = (roles) => (roles.mode === 'buttons' ? `przyciski (${roles.items.length})` : roles.mode === 'select' ? `lista (${roles.items.length})` : '—');
    const rows = messages
      .map((m) => {
        const snippet = m.data.content || m.data.embed.title || m.data.embed.description || '';
        return `<tr>
          <td>#${esc(channelName(m.channelId))}</td>
          <td class="reason">${esc(snippet.slice(0, 120))}</td>
          <td>${esc(modeText(m.data.roles))}</td>
          <td>${esc(shortDate(m.updatedAt))}</td>
          <td class="nowrap"><button type="button" class="btn ghost small" data-msg-edit="${m.id}">Edytuj</button>
            <button type="button" class="btn danger small" data-msg-del="${m.id}">Usuń</button></td>
        </tr>`;
      })
      .join('');
    $('#msg-sent').innerHTML = messages.length
      ? `<thead><tr><th>Kanał</th><th>Treść</th><th>Wybór ról</th><th>Zmieniona</th><th></th></tr></thead><tbody>${rows}</tbody>`
      : '<tr><td class="empty">Nie wysłano jeszcze żadnej wiadomości z panelu.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#msg-sent').addEventListener('click', async (event) => {
  const editId = event.target.closest('[data-msg-edit]')?.dataset.msgEdit;
  const delId = event.target.closest('[data-msg-del]')?.dataset.msgDel;
  if (editId) {
    const found = state.sentMessages.find((m) => String(m.id) === editId);
    if (!found) return;
    state.msg = { editingId: found.id, data: { ...blankMessage(), ...clone(found.data) } };
    renderMessageEditor();
    $('#view-wiadomosci').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (!delId || !confirm('Usunąć tę wiadomość z Discorda?')) return;
  try {
    await api(`/messages/${delId}`, { method: 'DELETE' });
    toast('Wiadomość usunięta');
    if (String(state.msg?.editingId) === delId) state.msg = { editingId: null, data: blankMessage() };
    renderMessageEditor();
  } catch (error) {
    toast(error.message, 'error');
  }
  loadSentMessages();
});

// ---------- Zapis ----------
function isDirty() {
  return state.draft && JSON.stringify(state.draft) !== JSON.stringify(state.config);
}
function markDirty() {
  $('#savebar').classList.toggle('hidden', !isDirty());
}

$('#save').addEventListener('click', async () => {
  $('#save').disabled = true;
  try {
    const { config, intents } = await api('/config', { method: 'PUT', body: JSON.stringify(state.draft) });
    if (intents && state.guild.bot) {
      state.guild.bot = { ...state.guild.bot, membersIntent: intents.members, contentIntent: intents.content, intentsError: intents.error };
    }
    state.config = config;
    state.draft = clone(config);
    renderConfigUi();
    renderPreview();
    toast('Zapisano ustawienia');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#save').disabled = false;
  }
});

$('#discard').addEventListener('click', () => {
  state.draft = clone(state.config);
  renderConfigUi();
  renderPreview();
});

window.addEventListener('beforeunload', (event) => {
  if (isDirty()) event.preventDefault();
});

// ---------- Edytor embedów ----------
function renderEmbedTabs() {
  $('#embed-tabs').innerHTML = Object.keys(ACTION_LABELS)
    .map((action) => {
      const style = state.draft.actions[action];
      return `<button type="button" class="tab ${action === state.embedAction ? 'active' : ''}" data-action="${action}" style="--tab-color:${esc(style.color)}">${ACTION_LABELS[action]}</button>`;
    })
    .join('');
}

function fillEmbedFields() {
  const style = state.draft.actions[state.embedAction];
  $$('[data-embed-field]').forEach((el) => {
    if (document.activeElement !== el) el.value = style[el.dataset.embedField] ?? '';
  });
  if (/^#[0-9a-f]{6}$/i.test(style.color)) $('#embed-color-picker').value = style.color;
}

$('#embed-tabs').addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  state.embedAction = action;
  renderEmbedTabs();
  fillEmbedFields();
  renderPreview();
});

$('#embed-color-picker').addEventListener('input', (event) => {
  event.stopPropagation();
  const field = $('[data-embed-field="color"]');
  field.value = event.target.value.toUpperCase();
  field.dispatchEvent(new Event('input', { bubbles: true }));
});

document.addEventListener('focusin', (event) => {
  if (event.target.dataset?.embedField && event.target.dataset.embedField !== 'color') state.lastField = event.target;
});

$('#placeholder-chips').addEventListener('click', (event) => {
  const text = event.target.closest('[data-placeholder]')?.dataset.placeholder;
  const field = state.lastField ?? $('[data-embed-field="description"]');
  if (!text) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  field.focus();
  field.setSelectionRange(start + text.length, start + text.length);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});

$('#embed-reset').addEventListener('click', () => {
  state.draft.actions[state.embedAction] = clone(state.defaults.actions[state.embedAction]);
  renderEmbedTabs();
  $$('[data-embed-field]').forEach((el) => (el.value = state.draft.actions[state.embedAction][el.dataset.embedField] ?? ''));
  fillEmbedFields();
  renderPreview();
  markDirty();
});

// Mini-markdown Discorda do podglądu.
function md(text) {
  const names = { [SAMPLE.targetId]: SAMPLE.target, [SAMPLE.modId]: SAMPLE.mod };
  return String(text ?? '')
    .split('\n')
    .map((raw) => {
      let line = raw;
      const small = line.startsWith('-# ');
      if (small) line = line.slice(3);
      const html = esc(line)
        .replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, a, name, id) => `<img class="emoji" alt=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${a ? 'gif' : 'webp'}?size=48">`)
        .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(names[id] ?? 'użytkownik')}</span>`)
        .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(roleById(id)?.name ?? 'rola')}</span>`)
        .replace(/&lt;\/([\w -]+):\d+&gt;/g, (_, name) => `<span class="mention">/${esc(name)}</span>`)
        .replace(/&lt;t:(\d+):([a-zA-Z])&gt;/g, (_, ts, style) => `<span class="ts">${style === 'R' ? relTime(ts * 1000) : fullDate(ts * 1000)}</span>`)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
      return small ? `<small>${html}</small>` : html;
    })
    .join('<br>');
}

const ts = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
const withEmoji = (style, text) => {
  const cleaned = String(text ?? '').replace(/\s{2,}/g, ' ').trim();
  return style.emoji ? `${style.emoji} ${cleaned}` : cleaned;
};

// Odzwierciedla supabase/functions/hopkostki-bot/lib/embeds.js — przykładowe dane do podglądu.
function previewData(action) {
  const cfg = state.draft;
  const style = cfg.actions[action];
  const now = Date.now();
  const server = state.status?.guild?.name ?? 'Entuzjaści Hopkostki';
  const brand = 'Entuzjaści Hopkostki';
  const ctx = { duration: null, expiresAt: null, warn: null };
  if (action === 'ban') Object.assign(ctx, { duration: '14 dni', expiresAt: now + 14 * DAY });
  if (action === 'timeout') Object.assign(ctx, { duration: '2 godziny', expiresAt: now + 2 * HOUR });
  if (action === 'warn') {
    ctx.warn = { points: 2, count: 3, total: 5, expiresAt: cfg.warns.expiryDays > 0 ? now + cfg.warns.expiryDays * DAY : null };
  }
  const durationText = ctx.duration ?? (action === 'ban' ? 'Permanentny' : null);
  const vars = {
    uzytkownik: `<@${SAMPLE.targetId}>`,
    nick: SAMPLE.target,
    moderator: `<@${SAMPLE.modId}>`,
    moderatorNick: SAMPLE.mod,
    powod: SAMPLE.reason,
    czas: durationText ?? '—',
    serwer: server,
    sprawa: '#42',
    typ: action === 'ban' ? 'tymczasowo' : '',
  };
  const fill = (text) => String(text ?? '').replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
  const stamp = (ms) => `${ts(ms, 'f')}\n${ts(ms, 'R')}`;

  const timeFields = [];
  if (durationText) timeFields.push({ name: '⏱️ Czas trwania', value: `**${durationText}**`, inline: true });
  if (ctx.expiresAt) timeFields.push({ name: '📅 Wygasa', value: stamp(ctx.expiresAt), inline: true });
  const warnFields = (points, totals) => {
    if (!ctx.warn) return [];
    const fields = [];
    if (points) fields.push({ name: '🔢 Punkty', value: `**+${ctx.warn.points}**${totals ? ` (razem **${ctx.warn.total}**)` : ''}`, inline: true });
    if (ctx.warn.expiresAt) fields.push({ name: '⏳ Ostrzeżenie wygasa', value: stamp(ctx.warn.expiresAt), inline: true });
    return fields;
  };
  const issued = { name: '🗓️ Nałożono', value: stamp(now), inline: true };
  const reason = { name: '📝 Powód', value: SAMPLE.reason, code: true };
  const showPoints = cfg.warns.showPointsToUser;

  const channel = {
    content: cfg.mentionTarget ? `<@${SAMPLE.targetId}>` : '',
    author: `${server} • Moderacja`,
    title: withEmoji(style, fill(style.title)),
    description: fill(style.description).trim(),
    fields: [
      { name: '👤 Użytkownik', value: `<@${SAMPLE.targetId}>\n\`${SAMPLE.target}\``, inline: true },
      { name: '🛡️ Moderator', value: `<@${SAMPLE.modId}>`, inline: true },
      ...timeFields,
      issued,
      ...warnFields(showPoints, false),
      reason,
    ],
    footer: `Sprawa #42 • ${brand}`,
    thumb: { placeholder: true },
  };

  const dmFields = [...timeFields, issued, ...warnFields(showPoints, showPoints)];
  if (cfg.dmShowModerator) dmFields.push({ name: '🛡️ Moderator', value: SAMPLE.mod, inline: true });
  dmFields.push(reason);
  if (cfg.appealText && ['ban', 'kick', 'timeout', 'warn'].includes(action)) dmFields.push({ name: '💬 Odwołania', value: cfg.appealText });
  const dm = {
    author: server,
    title: withEmoji(style, fill(style.dmTitle)),
    description: fill(style.dmDescription).trim(),
    fields: dmFields,
    footer: `Sprawa #42 • ${brand}`,
    thumb: state.status?.guild?.icon ? { src: state.status.guild.icon } : { placeholder: true },
  };

  return { color: style.color, channel, dm };
}

// Pola embeda jak w Discordzie: do 3 pól "inline" w rzędzie, pozostałe na całą szerokość.
function fieldsHtml(fields = []) {
  if (!fields.length) return '';
  const items = fields
    .map((f) => {
      const value = f.code ? `<pre class="codeblock">${esc(f.value)}</pre>` : md(f.value);
      return `<div class="embed-field ${f.inline ? 'inline' : ''}"><div class="embed-field-name">${md(f.name)}</div><div class="embed-field-value">${value}</div></div>`;
    })
    .join('');
  return `<div class="embed-fields">${items}</div>`;
}

function thumbHtml(thumb) {
  if (!thumb) return '<div></div>';
  if (thumb.src) return `<div class="embed-thumb"><img src="${esc(thumb.src)}" alt=""></div>`;
  return '<div class="embed-thumb"></div>';
}

function messageHtml({ color, embed, content, slash }) {
  const time = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const avatar = state.status?.bot?.avatar ? `<img src="${esc(state.status.bot.avatar)}" alt="">` : 'EH';
  const name = state.status?.bot?.tag?.split('#')[0] ?? 'Entuzjaści Hopkostki';
  const icon = state.status?.guild?.icon ? `<img class="embed-author-icon" src="${esc(state.status.guild.icon)}" alt="">` : '';
  return `<div class="msg">
    <div class="msg-avatar">${avatar}</div>
    <div>
      ${slash ? `<div class="msg-reply">↱ <b>${SAMPLE.mod}</b> użył <span class="mention">${slash}</span></div>` : ''}
      <div class="msg-head"><span class="msg-name">${esc(name)}</span><span class="msg-app">APP</span><span class="msg-time">Dzisiaj o ${time}</span></div>
      ${content ? `<div>${md(content)}</div>` : ''}
      <div class="embed" style="border-left-color:${esc(color)}">
        <div>
          ${embed.author ? `<div class="embed-author">${icon}${esc(embed.author)}</div>` : ''}
          <div class="embed-title">${md(embed.title)}</div>
          ${embed.description ? `<div class="embed-desc">${md(embed.description)}</div>` : ''}
          ${fieldsHtml(embed.fields)}
        </div>
        ${thumbHtml(embed.thumb)}
        <div class="embed-footer">${esc(embed.footer)} • Dzisiaj o ${time}</div>
      </div>
    </div>
  </div>`;
}

function renderPreview() {
  if (!state.draft || state.view !== 'embedy') return;
  const data = previewData(state.embedAction);
  $('#preview-channel').innerHTML = messageHtml({
    color: data.color,
    embed: data.channel,
    content: data.channel.content,
    slash: SLASH_NAMES[state.embedAction],
  });
  $('#preview-dm').innerHTML = state.draft.dmUsers
    ? messageHtml({ color: data.color, embed: data.dm })
    : '<p class="muted small">Wysyłanie DM jest wyłączone w ustawieniach.</p>';
}

// ---------- Ostrzeżenia ----------
async function loadWarns() {
  try {
    const data = await api('/warns');
    state.warnUsers = data.users;
    renderWarns();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function lifeBar(w) {
  if (!w.expiresAt) return '<span class="muted small">nie wygasa</span>';
  return `<div class="countdown" data-expires="${w.expiresAt}">${formatCountdown(w.expiresAt - Date.now())}</div>
    <div class="lifebar" title="Wygasa ${esc(fullDate(w.expiresAt))}"><i data-created="${w.createdAt}" data-until="${w.expiresAt}"></i></div>`;
}

function renderWarns() {
  const query = $('#warn-search').value.trim().toLowerCase();
  const users = state.warnUsers.filter((u) => !query || u.userTag?.toLowerCase().includes(query) || u.userId.includes(query));
  const scale = state.config.escalation.rules.at(-1)?.points ?? 10;

  if (!users.length) {
    $('#warn-users').innerHTML = `<p class="empty">${query ? 'Nic nie znaleziono.' : 'Nikt nie ma aktywnych ostrzeżeń.'}</p>`;
    return;
  }
  $('#warn-users').innerHTML = users
    .map((u) => {
      const ratio = u.points / scale;
      const color = ratio >= 1 ? 'var(--red)' : ratio >= 0.5 ? '#f0883e' : 'var(--yellow)';
      const rows = u.warns
        .map(
          (w) => `<div class="warn-row">
            <strong>#${w.id}</strong>
            <span class="badge" style="background:var(--yellow)">${w.points} pkt</span>
            <div class="reason">${esc(w.reason)}<span class="note">od ${esc(w.moderatorTag)} • ${esc(shortDate(w.createdAt))}</span></div>
            <div>${lifeBar(w)}</div>
            <button type="button" class="btn danger small" data-del-warn="${w.id}">Usuń</button>
          </div>`,
        )
        .join('');
      return `<details class="warn-user" data-user="${u.userId}" ${state.openWarnUsers.has(u.userId) ? 'open' : ''}>
        <summary>
          <span class="who">${esc(u.userTag)}</span>
          <code>${esc(u.userId)}</code>
          <span class="muted small">${u.count} ${plural(u.count, ['ostrzeżenie', 'ostrzeżenia', 'ostrzeżeń'])}</span>
          <span class="points">${u.points} pkt</span>
          <span class="severity" title="${u.points}/${scale} pkt"><i style="width:${Math.min(100, ratio * 100)}%;background:${color}"></i></span>
        </summary>
        <div class="warn-list">${rows}</div>
      </details>`;
    })
    .join('');
  tick();
}

$('#warn-search').addEventListener('input', (event) => {
  event.stopPropagation();
  renderWarns();
});
$('#warn-users').addEventListener(
  'toggle',
  (event) => {
    const id = event.target.dataset?.user;
    if (!id) return;
    if (event.target.open) state.openWarnUsers.add(id);
    else state.openWarnUsers.delete(id);
  },
  true,
);
$('#warn-users').addEventListener('click', async (event) => {
  const id = event.target.closest('[data-del-warn]')?.dataset.delWarn;
  if (!id || !confirm(`Usunąć ostrzeżenie #${id}?`)) return;
  try {
    await api(`/warns/${id}`, { method: 'DELETE' });
    toast(`Usunięto ostrzeżenie #${id}`);
    loadWarns();
  } catch (error) {
    toast(error.message, 'error');
  }
});

// ---------- Sprawy ----------
async function loadCases() {
  const params = new URLSearchParams({
    page: state.casesPage,
    limit: 25,
    user: $('#case-search').value.trim(),
    type: $('#case-type').value,
  });
  try {
    const data = await api(`/cases?${params}`);
    $('#cases-table').innerHTML = casesTable(data.items);
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    $('#cases-pager').innerHTML = `
      <button type="button" class="btn ghost small" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>← Nowsze</button>
      <span class="muted small">Strona ${data.page} z ${pages} • ${data.total} spraw</span>
      <button type="button" class="btn ghost small" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>Starsze →</button>`;
  } catch (error) {
    toast(error.message, 'error');
  }
}
let caseSearchTimer = null;
$('#case-search').addEventListener('input', (event) => {
  event.stopPropagation();
  clearTimeout(caseSearchTimer);
  caseSearchTimer = setTimeout(() => {
    state.casesPage = 1;
    loadCases();
  }, 300);
});
$('#case-type').addEventListener('change', (event) => {
  event.stopPropagation();
  state.casesPage = 1;
  loadCases();
});
$('#cases-pager').addEventListener('click', (event) => {
  const page = event.target.closest('[data-page]')?.dataset.page;
  if (!page) return;
  state.casesPage = Number(page);
  loadCases();
});

// ---------- Tymczasowe bany ----------
async function loadBans() {
  try {
    const { bans } = await api('/tempbans');
    const rows = bans
      .map(
        (b) => `<tr>
          <td><strong>${esc(b.userTag)}</strong><span class="note">${esc(b.userId)}</span></td>
          <td><div class="countdown" data-expires="${b.expiresAt}">${formatCountdown(b.expiresAt - Date.now())}</div><span class="note">${esc(fullDate(b.expiresAt))}</span></td>
          <td>#${b.caseId}</td>
          <td><button type="button" class="btn success small" data-unban="${esc(b.userId)}">Odbanuj teraz</button></td>
        </tr>`,
      )
      .join('');
    $('#bans-table').innerHTML = bans.length
      ? `<thead><tr><th>Użytkownik</th><th>Pozostało</th><th>Sprawa</th><th></th></tr></thead><tbody>${rows}</tbody>`
      : '<tr><td class="empty">Brak aktywnych tymczasowych banów.</td></tr>';
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#bans-table').addEventListener('click', async (event) => {
  const userId = event.target.closest('[data-unban]')?.dataset.unban;
  if (!userId || !confirm('Zdjąć tego bana teraz?')) return;
  try {
    await api(`/tempbans/${userId}/unban`, { method: 'POST' });
    toast('Ban zdjęty');
  } catch (error) {
    toast(error.message, 'error');
  }
  loadBans();
});

// ---------- Odliczanie (co sekundę) ----------
function tick() {
  const now = Date.now();
  let expired = false;
  $$('[data-expires]').forEach((el) => {
    const left = Number(el.dataset.expires) - now;
    el.textContent = formatCountdown(left);
    if (left <= 0) expired = true;
  });
  $$('[data-until]').forEach((el) => {
    const created = Number(el.dataset.created);
    const until = Number(el.dataset.until);
    const left = Math.max(0, Math.min(1, (until - now) / (until - created)));
    el.style.width = `${(left * 100).toFixed(2)}%`;
  });
  // Bot sprawdza wygasanie co 30 s — po chwili odświeżamy listę.
  if (expired && !state.reloadPending) {
    state.reloadPending = true;
    setTimeout(() => {
      state.reloadPending = false;
      if (state.view === 'ostrzezenia') loadWarns();
      if (state.view === 'bany') loadBans();
    }, 35_000);
  }
}

boot();
