// Walidacja konfiguracji przychodzącej z panelu. Nieznane klucze są ignorowane,
// a błędne wartości zastępowane obecnymi, więc panel nie jest w stanie "zepsuć" bota.

import { DEFAULT_CONFIG } from './defaults.js';
import { isValidUnit } from './duration.js';
import { COMMAND_MAP } from './commands.js';
import { cleanEmoji } from './messages.js';

const SNOWFLAKE = /^\d{15,25}$/;
const EVERYONE = 'everyone';
export const BUTTON_STYLE_NAMES = ['niebieski', 'szary', 'zielony', 'czerwony'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const ESCALATION_ACTIONS = ['alert', 'timeout', 'kick', 'ban'];
export const ACTIVITY_TYPES = ['custom', 'playing', 'listening', 'watching', 'competing'];
export const PRESENCE_STATUSES = ['online', 'idle', 'dnd'];
export const NEW_ACCOUNT_MENTIONS = ['here', 'everyone', 'roles'];

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
      fields: cleanTicketFields(t),
    }))
    .filter((t) => t.label);
  return out.length ? out : fallback;
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
