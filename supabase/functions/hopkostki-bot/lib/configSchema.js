// Walidacja konfiguracji przychodzącej z panelu. Nieznane klucze są ignorowane,
// a błędne wartości zastępowane obecnymi, więc panel nie jest w stanie "zepsuć" bota.

import { DEFAULT_CONFIG } from './defaults.js';
import { isValidUnit } from './duration.js';
import { COMMAND_MAP } from './commands.js';
import { cleanEmoji } from './messages.js';
import { splitWordList } from './automod.js';
import { LOGIN_DAYS } from './access.js';

const SNOWFLAKE = /^\d{15,25}$/;
const EVERYONE = 'everyone';
export const BUTTON_STYLE_NAMES = ['niebieski', 'szary', 'zielony', 'czerwony'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const ESCALATION_ACTIONS = ['alert', 'timeout', 'kick', 'ban'];
export const AUTOMOD_ACTIONS = ['delete', 'warn', 'timeout'];
export const RAID_ACTIONS = ['alert', 'kick'];
export const ACTIVITY_TYPES = ['custom', 'playing', 'listening', 'watching', 'competing'];
export const PRESENCE_STATUSES = ['online', 'idle', 'dnd'];
export const NEW_ACCOUNT_MENTIONS = ['here', 'everyone', 'roles'];
// Serwer info: sekcje i elementy listy (rodzaje jak w serverInfo.js).
const SI_KINDS = ['roles', 'levels', 'commands', 'text'];
const SI_ITEM_KINDS = ['heading', 'role', 'command', 'text'];
const COMMAND_NAME = /^[\p{Ll}\p{N}_-]{1,32}(?: [\p{Ll}\p{N}_-]{1,32}){0,2}$/u;
const siText = (value, max) => String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
function cleanServerInfoItem(item) {
  const kind = SI_ITEM_KINDS.includes(item?.kind) ? item.kind : null;
  if (kind === 'heading' || kind === 'text') {
    const text = siText(item.text, kind === 'heading' ? 100 : 1000);
    return text ? { kind, text } : null;
  }
  if (kind === 'role') return SNOWFLAKE.test(String(item.roleId ?? '')) ? { kind, roleId: String(item.roleId), text: siText(item.text, 600) } : null;
  if (kind === 'command') {
    const command = String(item.command ?? '').trim().toLowerCase().replace(/^\//, '').replace(/\s+/g, ' ');
    if (!COMMAND_NAME.test(command)) return null;
    return { kind, command, commandId: SNOWFLAKE.test(String(item.commandId ?? '')) ? String(item.commandId) : '', text: siText(item.text, 200) };
  }
  return null;
}
function cleanServerInfoSections(input, current) {
  if (!Array.isArray(input)) return current;
  const seen = new Set();
  return input.slice(0, 6).map((s, i) => {
    let id = /^[a-z0-9-]{1,24}$/i.test(String(s?.id ?? '')) ? String(s.id) : `sekcja-${i + 1}`;
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const banner = siText(s?.banner, 500);
    return {
      id,
      kind: SI_KINDS.includes(s?.kind) ? s.kind : 'text',
      title: siText(s?.title, 256),
      intro: siText(s?.intro, 1500),
      banner: /^https:\/\/\S+$/i.test(banner) ? banner : '',
      items: (Array.isArray(s?.items) ? s.items : []).slice(0, 40).map(cleanServerInfoItem).filter(Boolean),
    };
  });
}

export const XP_EVENT_THEMES = ['confetti', 'fire', 'snow', 'stars', 'neon', 'hearts', 'halloween', 'leaves', 'sakura', 'coins', 'storm', 'bubbles', 'matrix'];
// Intensywność efektów na stronie rankingu: none = baner bez animacji i cząsteczek.
export const XP_EVENT_INTENSITY = ['none', 'low', 'medium', 'high'];
export const XP_EVENT_KINDS = ['message', 'voice', 'reaction'];
const XP_EVENT_MAX_MS = 31 * 24 * 60 * 60_000;

// Wydarzenia XP z panelu: poprawne daty (koniec po początku, najwyżej 31 dni), dowolny mnożnik 1,1–10 (do dwóch
// miejsc po przecinku), co najmniej jeden rodzaj XP; styl: motyw, intensywność efektów, opcjonalny własny kolor
// (#rrggbb) i floor — efekt przy dole ekranu (płomienie przy „Ogniu”; domyślnie włączony). Najwyżej 50, posortowane
// po początku.
function cleanXpEvents(input, current) {
  if (!Array.isArray(input)) return current;
  const seen = new Set();
  const out = [];
  for (const e of input.slice(0, 60)) {
    const id = String(e?.id ?? '');
    const start = Date.parse(e?.startsAt);
    const end = Date.parse(e?.endsAt);
    const multiplier = Math.round(Number(e?.multiplier) * 100) / 100;
    const kinds = Array.isArray(e?.kinds) ? XP_EVENT_KINDS.filter((k) => e.kinds.includes(k)) : [];
    if (!/^[a-z0-9]{6,24}$/i.test(id) || seen.has(id)) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > XP_EVENT_MAX_MS) continue;
    if (!(multiplier >= 1.1 && multiplier <= 10) || !kinds.length) continue;
    seen.add(id);
    out.push({
      id,
      name: String(e?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Wydarzenie XP',
      multiplier,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      kinds,
      theme: XP_EVENT_THEMES.includes(e?.theme) ? e.theme : 'confetti',
      intensity: XP_EVENT_INTENSITY.includes(e?.intensity) ? e.intensity : 'medium',
      accent: /^#[0-9a-f]{6}$/i.test(String(e?.accent ?? '')) ? String(e.accent).toLowerCase() : null,
      floor: e?.floor !== false,
    });
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(-50);
}

// Eventy (konkursy) na stronie rankingu: invites — zaproszenia, messages — wiadomości, mixed — punkty za jedno i drugie.
export const CONTEST_TYPES = ['invites', 'messages', 'mixed'];
const CONTEST_MAX_MS = 92 * 24 * 60 * 60_000;
const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const between = (value, min, max, fallback) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Eventy z panelu: poprawne daty (koniec po początku, najwyżej 92 dni), znany typ; goal — próg (0 = bez progu:
// zwykły ranking, inaczej pasek postępu i zgłoszenie po jego osiągnięciu); points — punkty w evencie mieszanym
// (co najmniej jedno niezerowe); winners — ile pierwszych miejsc jest nagradzanych (0–25); minAccountDays —
// zaproszone konta młodsze niż tyle dni się nie liczą. Najwyżej 30, posortowane po początku.
function cleanContests(input, current) {
  if (!Array.isArray(input)) return current;
  const seen = new Set();
  const out = [];
  for (const c of input.slice(0, 40)) {
    const id = String(c?.id ?? '');
    const start = Date.parse(c?.startsAt);
    const end = Date.parse(c?.endsAt);
    if (!/^[a-z0-9]{6,24}$/i.test(id) || seen.has(id) || !CONTEST_TYPES.includes(c?.type)) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > CONTEST_MAX_MS) continue;
    seen.add(id);
    let points = { invite: between(c?.points?.invite, 0, 10_000, 10), message: between(c?.points?.message, 0, 10_000, 1) };
    if (!points.invite && !points.message) points = { invite: 10, message: 1 };
    out.push({
      id,
      name: oneLine(c?.name, 80) || 'Event',
      description: String(c?.description ?? '').replace(/\r/g, '').trim().slice(0, 1500),
      prize: oneLine(c?.prize, 200),
      type: c.type,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      goal: between(c?.goal, 0, 1_000_000, 0),
      points,
      winners: between(c?.winners, 0, 25, 3),
      minAccountDays: between(c?.minAccountDays, 0, 365, 7),
    });
  }
  return out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(-30);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Scala zapisaną konfigurację z domyślną (nowe klucze z domyślnej, tablice nadpisywane w całości).
export function mergeWithDefaults(defaults, stored) {
  if (!isPlainObject(stored)) return structuredClone(defaults);
  const out = {};
  for (const [key, def] of Object.entries(defaults)) {
    const value = stored[key];
    if (key === 'commandPermissions') out[key] = isPlainObject(value) ? structuredClone(value) : {};
    else if (isPlainObject(def)) out[key] = mergeWithDefaults(def, value);
    else if (Array.isArray(def)) out[key] = Array.isArray(value) ? structuredClone(value) : structuredClone(def);
    else out[key] = value === undefined ? def : value;
  }
  return out;
}

function cleanRules(rules, fallback) {
  if (!Array.isArray(rules)) return fallback;
  return rules
    .slice(0, 20)
    .map((rule) => ({
      points: Math.floor(Number(rule?.points)),
      action: String(rule?.action),
      amount: Math.floor(Number(rule?.amount) || 0),
      unit: String(rule?.unit),
    }))
    .filter((rule) =>
      Number.isFinite(rule.points) && rule.points > 0 &&
      ESCALATION_ACTIONS.includes(rule.action) &&
      isValidUnit(rule.unit) && rule.amount >= 0,
    )
    .sort((a, b) => a.points - b.points);
}

function cleanActivities(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  return list
    .slice(0, 10)
    .map((a) => ({ type: String(a?.type), text: String(a?.text ?? '').trim().slice(0, 128) }))
    .filter((a) => ACTIVITY_TYPES.includes(a.type) && a.text);
}

function cleanGenerators(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  const seen = new Set();
  return list
    .slice(0, 10)
    .map((g) => ({
      hubId: String(g?.hubId ?? ''),
      categoryId: SNOWFLAKE.test(String(g?.categoryId ?? '')) ? String(g.categoryId) : '',
      name: String(g?.name ?? '').trim().slice(0, 90) || 'Kanał {nick}',
      limit: Math.min(99, Math.max(0, Math.floor(Number(g?.limit) || 0))),
      private: g?.private === true,
    }))
    .filter((g) => SNOWFLAKE.test(g.hubId) && !seen.has(g.hubId) && seen.add(g.hubId));
}

function cleanRoleIds(input, { everyone = false, max = 50 } = {}) {
  return [...new Set(input.map(String).filter((id) => SNOWFLAKE.test(id) || (everyone && id === EVERYONE)))].slice(0, max);
}

// { nazwaKomendy: ['idRoli' | 'everyone', ...] } — tylko prawdziwe nazwy komend i poprawne ID ról.
function cleanCommandPermissions(input, current) {
  if (!isPlainObject(input)) return current ?? {};
  const out = {};
  for (const [name, ids] of Object.entries(input)) {
    if (!COMMAND_MAP.has(name) || !Array.isArray(ids)) continue;
    out[name] = cleanRoleIds(ids, { everyone: true });
  }
  return out;
}

// Pola formularza ticketu: krótka odpowiedź, długi tekst, liczba (np. liczba członków) albo link
// zaproszenia na serwer Discord (bot sprawdza, czy działa, i podaje obsłudze prawdziwą liczbę członków).
export const TICKET_FIELD_KINDS = ['short', 'long', 'number', 'invite'];

// Starsze rodzaje ticketów miały jedno pole `question` — to formularz z jednym długim polem.
export function ticketFields(type) {
  if (Array.isArray(type?.fields)) return type.fields;
  const question = String(type?.question ?? '').trim();
  return question ? [{ label: question, placeholder: '', kind: 'long', required: true }] : [];
}

// Pole trafia do okienka Discorda: etykieta ma limit 45 znaków, podpowiedź 100, a pól może być 5.
function cleanTicketFields(type) {
  return ticketFields(type)
    .slice(0, 20)
    .map((f) => ({
      label: String(f?.label ?? '').trim().slice(0, 45),
      placeholder: String(f?.placeholder ?? '').trim().slice(0, 100),
      kind: TICKET_FIELD_KINDS.includes(f?.kind) ? f.kind : 'short',
      required: f?.required !== false,
    }))
    .filter((f) => f.label)
    .slice(0, 5);
}

function cleanTicketTypes(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  const out = list
    .slice(0, 5)
    .map((t) => ({
      label: String(t?.label ?? '').trim().slice(0, 80),
      style: BUTTON_STYLE_NAMES.includes(t?.style) ? t.style : 'niebieski',
      emoji: cleanEmoji(t?.emoji),
      // Własne powitanie tego rodzaju ticketu (puste = wspólne z ustawień).
      welcome: String(t?.welcome ?? '').trim().slice(0, 1500),
      // Regulamin pokazywany przed formularzem (z przyciskiem „Akceptuję”); puste = bez ekranu regulaminu.
      rules: String(t?.rules ?? '').trim().slice(0, 3800),
      // Osobne ustawienia tego rodzaju (puste = ustawienia ogólne): kategoria, archiwum, logi, role obsługi.
      categoryId: SNOWFLAKE.test(String(t?.categoryId ?? '')) ? String(t.categoryId) : '',
      archiveCategoryId: SNOWFLAKE.test(String(t?.archiveCategoryId ?? '')) ? String(t.archiveCategoryId) : '',
      logChannelId: SNOWFLAKE.test(String(t?.logChannelId ?? '')) ? String(t.logChannelId) : '',
      supportRoleIds: Array.isArray(t?.supportRoleIds) ? cleanRoleIds(t.supportRoleIds) : [],
      // Co wolno autorowi ticketu.
      authorCanClose: t?.authorCanClose !== false,
      authorCanAdd: t?.authorCanAdd !== false,
      authorCanAttach: t?.authorCanAttach !== false,
      fields: cleanTicketFields(t),
    }))
    .filter((t) => t.label);
  return out.length ? out : fallback;
}

// Poziomy: listy (nagrody, boostery), wybory z listy i liczby z własnymi zakresami. undefined = zwykłe reguły.
const intIn = (input, current, min, max) => {
  const n = Math.floor(Number(input));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : current;
};
const ROLE_ID = (v) => SNOWFLAKE.test(String(v ?? ''));
function cleanLevelValue(path, input, current) {
  const choice = { 'levels.formula.curve': ['linear', 'standard', 'flat'], 'levels.message.mode': ['random', 'perWord'], 'levels.reaction.awards': ['both', 'giver', 'receiver'], 'levels.levelUp.target': ['current', 'channel', 'dm'], 'levels.restrictions.channelMode': ['deny', 'allow'] }[path];
  if (choice) return choice.includes(input) ? input : current;
  if (path === 'levels.formula.multiplier') {
    const n = Number(input);
    return Number.isFinite(n) && n > 0 ? Math.round(Math.min(10, Math.max(0.1, n)) * 100) / 100 : current;
  }
  if (path === 'levels.formula.maxLevel') return intIn(input, current, 0, 1000);
  if (/^levels\.(message|voice|reaction)\.(min|max)$/.test(path)) return intIn(input, current, 0, 10_000);
  if (/^levels\.(message|voice|reaction)\.cooldown$/.test(path)) return intIn(input, current, 0, 86_400);
  if (path === 'levels.voice.minMembers') return intIn(input, current, 1, 99);
  if (path === 'levels.antiFarm.dailyCap') return intIn(input, current, 0, 1_000_000);
  if (path === 'levels.antiFarm.minChars') return intIn(input, current, 0, 200);
  if (path === 'levels.events') return cleanXpEvents(input, current);
  if (/^levels\.boosters\.effort\.(words|images)$/.test(path)) return intIn(input, current, 0, 10_000);
  if (path === 'levels.boosters.effort.percent') return intIn(input, current, 1, 1000);
  if (path === 'levels.firstPlaceRoleId' || path === 'levels.highlights.roleId') return input === '' || input === null ? '' : ROLE_ID(input) ? String(input) : current;
  if (path === 'levels.card.image') {
    const url = String(input ?? '').trim();
    return url === '' || (/^https:\/\/\S+$/.test(url) && url.length <= 500) ? url : current;
  }
  if (path === 'levels.rewards') {
    if (!Array.isArray(input)) return current;
    const seen = new Set();
    return input
      .slice(0, 100)
      .map((r) => ({ level: Math.floor(Number(r?.level)), roleId: String(r?.roleId ?? '') }))
      .filter((r) => Number.isFinite(r.level) && r.level >= 1 && r.level <= 1000 && ROLE_ID(r.roleId) && !seen.has(`${r.level}:${r.roleId}`) && seen.add(`${r.level}:${r.roleId}`))
      .sort((a, b) => a.level - b.level);
  }
  if (path === 'levels.boosters.roles' || path === 'levels.boosters.channels') {
    if (!Array.isArray(input)) return current;
    const key = path.endsWith('roles') ? 'roleId' : 'channelId';
    const seen = new Set();
    return input
      .slice(0, 50)
      .map((b) => ({ [key]: String(b?.[key] ?? ''), percent: Math.floor(Number(b?.percent)) }))
      .filter((b) => ROLE_ID(b[key]) && Number.isFinite(b.percent) && b.percent >= 1 && b.percent <= 1000 && !seen.has(b[key]) && seen.add(b[key]));
  }
  return undefined;
}

const AUTOMOD_LIMITS = {
  'automod.timeoutMinutes': [1, 40320],
  'automod.warnPoints': [1, 100],
  'automod.mentions.limit': [2, 50],
  'automod.caps.percent': [50, 100],
  'automod.caps.minLength': [5, 500],
  'automod.spam.messages': [0, 50],
  'automod.spam.seconds': [2, 60],
  'automod.spam.duplicates': [0, 20],
  'automod.raid.joins': [3, 200],
  'automod.raid.seconds': [5, 600],
  'automod.raid.minutes': [1, 240],
  'automod.raid.accountAgeDays': [0, 365],
};
function cleanAutomodValue(path, input, current) {
  if (AUTOMOD_LIMITS[path]) {
    const [min, max] = AUTOMOD_LIMITS[path];
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : current;
  }
  if (path === 'automod.raid.action') return RAID_ACTIONS.includes(input) ? input : current;
  if (path.endsWith('.action')) return AUTOMOD_ACTIONS.includes(input) ? input : current;
  if (path === 'automod.words.list') {
    // Lista z AutoModa Discorda (słowa po przecinku) rozbita na osobne wpisy; jak w Discordzie maks. 1000 po 60 znaków.
    if (!Array.isArray(input) && typeof input !== 'string') return current;
    const seen = new Set();
    return splitWordList(input)
      .map((w) => w.slice(0, 60))
      .filter((w) => w.replace(/\*/g, '').trim().length >= 2 && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
      .slice(0, 1000);
  }
  return undefined;
}

function cleanValue(path, input, current, def) {
  if (path === 'commandPermissions') return cleanCommandPermissions(input, current);
  if (/roleIds$/i.test(path)) return Array.isArray(input) ? cleanRoleIds(input) : current;
  if (/channelIds$/i.test(path)) return Array.isArray(input) ? cleanRoleIds(input) : current;
  if (path === 'logs.newAccount.mention') return NEW_ACCOUNT_MENTIONS.includes(input) ? input : current;
  if (path === 'logs.newAccount.days') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : current;
  }
  if (path === 'bump.intervalMinutes') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(1440, Math.max(30, n)) : current;
  }
  if (path === 'tickets.types') return cleanTicketTypes(input, current);
  if (path === 'contests.list') return cleanContests(input, current);
  if (path.startsWith('panelAccess.roles.')) return Array.isArray(input) ? cleanRoleIds(input) : current;
  if (path.startsWith('levels.')) {
    const cleaned = cleanLevelValue(path, input, current);
    if (cleaned !== undefined) return cleaned;
  }
  if (path === 'panelAccess.loginDays') return LOGIN_DAYS.includes(Number(input)) ? Number(input) : current;
  if (path === 'tickets.maxOpen') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : current;
  }
  if (path === 'escalation.rules') return cleanRules(input, current);
  if (path === 'presence.activities') return cleanActivities(input, current);
  if (path === 'tempVoice.generators') return cleanGenerators(input, current);
  if (path === 'presence.status') return PRESENCE_STATUSES.includes(input) ? input : current;
  if (path === 'presence.rotateSeconds') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(3600, Math.max(15, n)) : current;
  }
  if (/(channelId|categoryId)$/i.test(path)) {
    if (input === '' || input === null) return '';
    return SNOWFLAKE.test(String(input)) ? String(input) : current;
  }
  if (path.endsWith('.color')) return HEX_COLOR.test(String(input)) ? String(input).toUpperCase() : current;
  if (path.startsWith('automod.')) {
    const cleaned = cleanAutomodValue(path, input, current);
    if (cleaned !== undefined) return cleaned;
  }
  if (path === 'serverInfo.sections') return cleanServerInfoSections(input, current);
  if (path === 'serverInfo.bullet') return input === '' ? '' : cleanEmoji(input) || current;
  if (path === 'serverInfo.footer') return typeof input === 'string' ? input.trim().slice(0, 200) : current;
  if (path === 'appeals.days') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(90, Math.max(1, n)) : current;
  }
  if (path === 'alerts.minutes') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) ? Math.min(120, Math.max(3, n)) : current;
  }
  // Pojedyncza rola (np. alerts.pingRoleId): ID roli albo puste.
  if (/roleId$/i.test(path) && typeof def === 'string') return input === '' || input === null ? '' : SNOWFLAKE.test(String(input)) ? String(input) : current;
  if (path === 'warns.defaultPoints') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) && n >= 1 && n <= 100 ? n : current;
  }

  if (typeof def === 'boolean') return typeof input === 'boolean' ? input : current;
  if (typeof def === 'number') {
    const n = Math.floor(Number(input));
    return Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : current;
  }
  if (typeof def === 'string') return typeof input === 'string' ? input.slice(0, 1500) : current;
  return current;
}

export function sanitizeConfig(input, current, defaults = DEFAULT_CONFIG, prefix = '') {
  const out = {};
  for (const [key, def] of Object.entries(defaults)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = isPlainObject(input) ? input[key] : undefined;
    if (isPlainObject(def)) {
      out[key] = sanitizeConfig(value, current[key], def, path);
    } else if (value === undefined) {
      out[key] = current[key];
    } else {
      out[key] = cleanValue(path, value, current[key], def);
    }
  }
  return out;
}
