// Uprawnienia komend ustawione w samym Discordzie: Ustawienia serwera → Integracje → bot → Zarządzaj.
// Administracja serwera może tam zablokować komendy bota rolom, osobom i kanałom - dla całej aplikacji albo
// dla pojedynczej komendy. Te nadpisania działają niezależnie od list ról bota (zakładka „Uprawnienia”,
// config.commandPermissions): zablokowana komenda znika z listy komend, choć lista bota na nią pozwala.
//
// Bot może je tylko ODCZYTAĆ (GET z tokenem bota). Zmienić je może wyłącznie osoba z uprawnieniami
// Zarządzanie serwerem i Zarządzanie rolami - API przyjmuje do tego tylko jej token Bearer (OAuth2, scope
// applications.commands.permissions.update), a token bota dostaje błąd. Dlatego panel je pokazuje, porównuje
// z listami bota i podpowiada, co kliknąć w Discordzie.
//
// Jak Discord liczy dostęp do komendy (Permissions v2, dokumentacja „Application Commands → Permissions”
// i change log z 17.11.2022):
// - kanał: wpis komendy dla tego kanału → jej „Wszystkie kanały” (id = guild_id − 1) → to samo w ustawieniach
//   całej aplikacji (wpis o id = id aplikacji) → domyślnie wszędzie. Ograniczenia kanałów dotyczą też
//   administratorów (na serwerze admin mógł użyć /powiedz tylko na kanale dopuszczonym w Discordzie);
// - osoba: właściciel serwera i Administrator - zawsze. Inaczej wpis komendy dla tej osoby → dla jej ról
//   (wystarczy jedna zezwalająca) → dla @everyone (id = guild_id); gdy komenda nie ma takiego wpisu - te same
//   kroki w ustawieniach całej aplikacji (jej blokada działa, zgoda nie znosi default_member_permissions);
//   na końcu default_member_permissions komendy (bot ich nie ustawia, więc domyślnie może każdy).

import { DiscordError } from './rest.js';
import { cached, getApp, getGuildContext } from './moderation.js';
import { P, has, EVERYONE } from './permissions.js';

// Rodzaje wpisów w nadpisaniach Discorda (application command permission type).
export const PERMISSION_TYPE = { ROLE: 1, USER: 2, CHANNEL: 3 };
// Kanały, na których da się użyć komendy: tekstowe, głosowe (czat), ogłoszeń, sceny, fora i media.
const COMMAND_CHANNEL_TYPES = new Set([0, 2, 5, 13, 15, 16]);
const CACHE_KEY = 'discordCommandPerms';
const CACHE_MS = 30_000;
// Tyle osób z własnymi wpisami sprawdzamy na serwerze (nazwa i role) i tyle nazw pokazujemy w jednym zdaniu.
const MAX_MEMBERS = 20;
const MAX_NAMES = 8;
const ENTRY_ORDER = { everyone: 0, role: 1, user: 2, allChannels: 3, channel: 4 };

// Stała Discorda „Wszystkie kanały” = guild_id − 1 (null, gdy ID serwera nie jest liczbą).
export function allChannelsId(guildId) {
  return /^\d+$/.test(String(guildId ?? '')) ? String(BigInt(guildId) - 1n) : null;
}

// ---------- Odczyt z Discorda ----------

// Dane do porównania, pamiętane 30 s (fresh = pobierz od nowa):
// { readable, error, appId, botName, guildId, checkedAt, roles, permissions, commands, channels, members }.
// readable: false - Discord nie pozwolił odczytać nadpisań (403); 404 i pusta lista = brak nadpisań.
export function loadDiscordCommandPermissions(bot, { fresh = false } = {}) {
  if (fresh) bot.cache.delete(CACHE_KEY);
  return cached(bot, CACHE_KEY, CACHE_MS, async () => {
    const app = await getApp(bot);
    const gctx = await getGuildContext(bot);
    const guildId = gctx.guild.id;
    const snapshot = {
      readable: true,
      error: null,
      appId: String(app.id),
      botName: app.name ?? gctx.botUser?.username ?? null,
      guildId,
      checkedAt: Date.now(),
      roles: gctx.rawRoles,
      permissions: [],
      commands: [],
      channels: [],
      members: {},
    };
    let list;
    try {
      list = await bot.discord.get(`/applications/${app.id}/guilds/${guildId}/commands/permissions`);
    } catch (error) {
      if (error instanceof DiscordError && error.status === 404) return snapshot;
      if (error instanceof DiscordError && error.status === 403) {
        return { ...snapshot, readable: false, error: `Discord nie pozwolił botowi odczytać uprawnień komend (${error.message}).` };
      }
      throw error;
    }
    snapshot.permissions = (Array.isArray(list) ? list : []).filter((entry) => entry?.permissions?.length);
    if (!snapshot.permissions.length) return snapshot;

    const [commands, channels] = await Promise.all([
      bot.discord.get(`/applications/${app.id}/guilds/${guildId}/commands`),
      bot.discord.get(`/guilds/${guildId}/channels`),
    ]);
    snapshot.commands = (commands ?? []).map((c) => ({ id: String(c.id), name: c.name, default_member_permissions: c.default_member_permissions ?? null }));
    snapshot.channels = (channels ?? []).map((c) => ({ id: String(c.id), name: c.name, type: c.type, position: c.position ?? 0 }));
    // Osoby z własnymi wpisami: nazwa i role (do porównania z listami bota); null = nie ma jej na serwerze.
    const userIds = [
      ...new Set(snapshot.permissions.flatMap((e) => e.permissions.filter((p) => p.type === PERMISSION_TYPE.USER).map((p) => String(p.id)))),
    ].slice(0, MAX_MEMBERS);
    const members = await Promise.all(
      userIds.map(async (id) => {
        const member = await bot.discord.get(`/guilds/${guildId}/members/${id}`).catch(() => null);
        const name = member?.nick ?? member?.user?.global_name ?? member?.user?.username ?? id;
        return [id, member ? { name, roles: (member.roles ?? []).map(String), owner: id === gctx.guild.ownerId } : null];
      }),
    );
    snapshot.members = Object.fromEntries(members);
    return snapshot;
  });
}

// ---------- Logika Discorda ----------

// Wpisy jednego poziomu (cała aplikacja albo jedna komenda): id → true (zezwala) / false (blokuje).
function levelOf(entry) {
  const level = { roles: new Map(), users: new Map(), channels: new Map() };
  const maps = { [PERMISSION_TYPE.ROLE]: level.roles, [PERMISSION_TYPE.USER]: level.users, [PERMISSION_TYPE.CHANNEL]: level.channels };
  for (const p of entry?.permissions ?? []) maps[p.type]?.set(String(p.id), p.permission === true);
  return level;
}

// Wpis jednego poziomu dla osoby: { allowed, via: 'user' | 'role' | 'everyone' } albo null (brak wpisu).
function personEntry(level, person, guildId) {
  if (!level) return null;
  if (person.userId && level.users.has(person.userId)) return { allowed: level.users.get(person.userId), via: 'user' };
  const values = person.roleIds.filter((id) => level.roles.has(id)).map((id) => level.roles.get(id));
  if (values.length) return { allowed: values.includes(true), via: 'role' };
  if (level.roles.has(guildId)) return { allowed: level.roles.get(guildId), via: 'everyone' };
  return null;
}

// Czy Discord pokaże komendę tej osobie (bez kanałów) i co o tym zdecydowało:
// { allowed, source: 'admin' | 'command' | 'app' | 'default', via }.
function personAccess(command, levels, person, guildId) {
  if (person.admin) return { allowed: true, source: 'admin', via: null };
  const own = personEntry(levels.command, person, guildId);
  if (own) return { ...own, source: 'command' };
  const app = personEntry(levels.app, person, guildId);
  if (app && !app.allowed) return { ...app, source: 'app' };
  // default_member_permissions: null = każdy, "0" = tylko administratorzy, inaczej wymagane uprawnienia.
  const required = command.default_member_permissions;
  const allowed = required == null || (required !== '0' && has(person.permissions, BigInt(required)));
  return { allowed, source: 'default', via: null };
}

// Czy komendy można użyć na kanale (dotyczy wszystkich, także administratorów): { allowed, source }.
function channelAccess(levels, channelId, allId) {
  for (const source of ['command', 'app']) {
    const level = levels[source];
    if (!level) continue;
    if (level.channels.has(channelId)) return { allowed: level.channels.get(channelId), source };
    if (allId && level.channels.has(allId)) return { allowed: level.channels.get(allId), source };
  }
  return { allowed: true, source: 'default' };
}

// ---------- Nazwy i zdania ----------

function makeNames(snapshot) {
  const roles = new Map(snapshot.roles.map((r) => [String(r.id), r]));
  const channels = new Map(snapshot.channels.map((c) => [c.id, c]));
  const allId = allChannelsId(snapshot.guildId);
  return {
    role: (id) => (id === snapshot.guildId ? '@everyone' : roles.get(id)?.name ?? `usunięta rola (${id})`),
    user: (id) => (snapshot.members?.[id] ? `@${snapshot.members[id].name}` : `osoba spoza serwera (${id})`),
    channel: (id) => {
      if (id === allId) return 'Wszystkie kanały';
      const channel = channels.get(id);
      if (!channel) return `usunięty kanał (${id})`;
      return channel.type === 4 ? `kategoria ${channel.name}` : `#${channel.name}`;
    },
  };
}

// „a, b i c” (najwyżej MAX_NAMES nazw, reszta jako „i jeszcze N”).
function listNames(names) {
  const shown = names.slice(0, MAX_NAMES);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} i jeszcze ${rest}`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} i ${shown.at(-1)}` : (shown[0] ?? '');
}
const slashList = (commands) => listNames(commands.map((c) => `/${c}`));
// Komendy w bierniku („wyłącza /a” / „wyłącza komendy /a i /b”) i dopełniaczu („używać komend /a i /b”).
const commandsAcc = (commands) => (commands.length === 1 ? `/${commands[0]}` : `komendy ${slashList(commands)}`);
const commandsGen = (commands) => (commands.length === 1 ? `/${commands[0]}` : `komend ${slashList(commands)}`);
const onChannels = (channels) => (channels.length === 1 ? `kanale ${channels[0].label}` : `kanałach ${listNames(channels.map((c) => c.label))}`);
const toChannels = (channels) => (channels.length === 1 ? `kanału ${channels[0].label}` : `kanałów ${listNames(channels.map((c) => c.label))}`);
const roleWord = (names) => `${names.length === 1 ? 'roli' : 'rolom'} ${listNames(names)}`;
const integrationsPath = (botName) => `Ustawienia serwera → Integracje → ${botName ? `„${botName}”` : 'bot'} → Zarządzaj`;
const APP_PLACE = 'ustawienia całej aplikacji (góra strony)';

// Gdzie w Discordzie jest blokada: komenda (kliknij ją na liście) i/lub ustawienia całej aplikacji.
function fixPlaces(items) {
  const own = [...new Set(items.filter((i) => i.source === 'command').map((i) => i.command))];
  const defaults = [...new Set(items.filter((i) => i.source === 'default').map((i) => i.command))];
  const places = [];
  if (own.length) places.push(`kliknij ${slashList(own)}`);
  if (defaults.length) places.push(`kliknij ${slashList(defaults)} (komenda ma w Discordzie domyślne wymagane uprawnienia)`);
  if (items.some((i) => i.source === 'app')) places.push(APP_PLACE);
  return places.join(' oraz ');
}

// ---------- Opis nadpisań ----------

// Nadpisania czytelnie, najpierw cała aplikacja, potem komendy w kolejności jak w bocie:
// [{ id, scope: 'app' | 'command' | 'unknown', command, label,
//    entries: [{ id, type: 'role' | 'user' | 'channel', target: 'everyone' | 'role' | 'user' | 'allChannels' | 'channel', name, allow }] }]
export function describeOverrides(snapshot) {
  if (!snapshot?.readable) return [];
  const names = makeNames(snapshot);
  const allId = allChannelsId(snapshot.guildId);
  const commands = new Map(snapshot.commands.map((c, index) => [c.id, { ...c, index }]));
  return snapshot.permissions
    .map((entry) => {
      const id = String(entry.id);
      const command = commands.get(id);
      const scope = id === snapshot.appId ? 'app' : command ? 'command' : 'unknown';
      const entries = entry.permissions
        .map((p) => {
          const pid = String(p.id);
          const allow = p.permission === true;
          if (p.type === PERMISSION_TYPE.ROLE) return { id: pid, type: 'role', target: pid === snapshot.guildId ? 'everyone' : 'role', name: names.role(pid), allow };
          if (p.type === PERMISSION_TYPE.USER) return { id: pid, type: 'user', target: 'user', name: names.user(pid), allow };
          if (p.type === PERMISSION_TYPE.CHANNEL) return { id: pid, type: 'channel', target: pid === allId ? 'allChannels' : 'channel', name: names.channel(pid), allow };
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => ENTRY_ORDER[a.target] - ENTRY_ORDER[b.target] || a.name.localeCompare(b.name, 'pl'));
      const label = scope === 'app' ? 'Cała aplikacja (wszystkie komendy)' : command ? `/${command.name}` : `Nieznana komenda (${id})`;
      return { id, scope, command: command?.name ?? null, label, entries, order: scope === 'app' ? -1 : (command?.index ?? Infinity) };
    })
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...override }) => override);
}

// ---------- Konflikty z listami bota ----------

// Co blokuje Discord, choć listy bota (config.commandPermissions) na to pozwalają, i co kliknąć, żeby to usunąć:
// [{ level: 'error' | 'warn', kind: 'channels' | 'app-everyone' | 'everyone' | 'role' | 'user', text, fix, commands }].
export function findConflicts(snapshot, config) {
  if (!snapshot?.readable || !snapshot.permissions.length) return [];
  const { guildId } = snapshot;
  const allId = allChannelsId(guildId);
  const names = makeNames(snapshot);
  const path = integrationsPath(snapshot.botName);
  const levelsById = new Map(snapshot.permissions.map((entry) => [String(entry.id), levelOf(entry)]));
  const app = levelsById.get(snapshot.appId) ?? null;
  const lists = config?.commandPermissions ?? {};
  const roleById = new Map(snapshot.roles.map((r) => [String(r.id), r]));
  const isAdmin = (bits) => (bits & P.ADMINISTRATOR) === P.ADMINISTRATOR;
  const everyoneBits = BigInt(roleById.get(guildId)?.permissions ?? 0);

  // „Osoby” do sprawdzenia: ktoś bez ról (@everyone), posiadacz każdej roli z osobna i osoby z własnymi wpisami.
  const everyone = { userId: null, roleIds: [], permissions: everyoneBits, admin: isAdmin(everyoneBits) };
  const roles = snapshot.roles
    .filter((r) => String(r.id) !== guildId && (!r.managed || 'premium_subscriber' in (r.tags ?? {})))
    .sort((a, b) => b.position - a.position)
    .map((r) => {
      const bits = everyoneBits | BigInt(r.permissions ?? 0);
      return { id: String(r.id), name: r.name, userId: null, roleIds: [String(r.id)], permissions: bits, admin: isAdmin(bits) };
    });
  const people = Object.entries(snapshot.members ?? {})
    .filter(([, member]) => member)
    .map(([id, member]) => {
      const bits = member.roles.reduce((acc, roleId) => acc | BigInt(roleById.get(roleId)?.permissions ?? 0), everyoneBits);
      return { id, name: names.user(id), userId: id, roleIds: member.roles, permissions: bits, admin: Boolean(member.owner) || isAdmin(bits) };
    });

  const everyoneBlocks = []; // { command, source, allowedRoles }
  const roleBlocks = new Map(); // id roli → { name, items: [{ command, source, via }] }
  const userBlocks = new Map(); // id osoby → { name, items }
  const usable = snapshot.channels
    .filter((c) => COMMAND_CHANNEL_TYPES.has(c.type))
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, label: names.channel(c.id) }));
  const add = (map, key, name, item) => {
    if (!map.has(key)) map.set(key, { name, items: [] });
    map.get(key).items.push(item);
  };
  // Kanały dzielone na dozwolone i zablokowane (+ skąd blokady). Najpierw samo ustawienie całej aplikacji -
  // komendy z takim samym wynikiem opisuje jedno zdanie, pozostałe mają własne ustawienia kanałów.
  const splitChannels = (levels) => {
    const result = { blocked: [], allowed: [], sources: new Set() };
    for (const channel of usable) {
      const access = channelAccess(levels, channel.id, allId);
      if (access.allowed) result.allowed.push(channel);
      else {
        result.blocked.push(channel);
        result.sources.add(access.source);
      }
    }
    result.key = result.blocked.map((c) => c.id).join(',');
    return result;
  };
  const appChannels = splitChannels({ command: null, app });
  const channelGroups = new Map(); // klucz zablokowanych kanałów → { blocked, allowed, sources, commands }
  const channelExceptions = []; // komendy, które przez własne ustawienia kanałów działają inaczej niż cała aplikacja

  for (const command of snapshot.commands) {
    const levels = { command: levelsById.get(command.id) ?? null, app };
    const access = (person) => personAccess(command, levels, person, guildId);
    const list = Array.isArray(lists[command.name]) ? lists[command.name] : null;
    if (list) {
      const forAll = list.includes(EVERYONE);
      const forEveryone = forAll ? access(everyone) : null;
      if (forEveryone && !forEveryone.allowed) {
        // Lista bota pozwala wszystkim, a Discord blokuje @everyone - wystarczy jedno zdanie (z rolami, które Discord wpuszcza).
        everyoneBlocks.push({ command: command.name, source: forEveryone.source, allowedRoles: roles.filter((r) => !r.admin && access(r).allowed).map((r) => r.name) });
      } else {
        for (const role of roles) {
          if (!forAll && !list.includes(role.id)) continue;
          const result = access(role);
          if (!result.allowed) add(roleBlocks, role.id, role.name, { command: command.name, source: result.source, via: result.via });
        }
      }
      for (const person of people) {
        if (!forAll && !person.roleIds.some((id) => list.includes(id))) continue;
        const result = access(person);
        if (!result.allowed && result.via === 'user') add(userBlocks, person.id, person.name, { command: command.name, source: result.source, via: 'user' });
      }
    }

    // Kanały sprawdzamy dla każdej komendy - ograniczenie kanałów dotyczy też administratorów.
    const channels = splitChannels(levels);
    if (channels.key === appChannels.key) continue;
    channelExceptions.push(command.name);
    if (!channels.blocked.length) continue;
    if (!channelGroups.has(channels.key)) channelGroups.set(channels.key, { ...channels, commands: [] });
    const group = channelGroups.get(channels.key);
    group.commands.push(command.name);
    channels.sources.forEach((source) => group.sources.add(source));
  }

  const conflicts = [];
  const admins = 'także dla administratorów';
  const channelsFix = 'sekcja „Kanały” → przy „Wszystkie kanały” zaznacz ✓ (zezwól) i usuń blokady pojedynczych kanałów';

  // Kanały całej aplikacji (wszystkie komendy bez własnych ustawień kanałów).
  if (appChannels.blocked.length) {
    const { blocked, allowed } = appChannels;
    const scope = `ustawienie całej aplikacji, ${admins}`;
    let text;
    if (!allowed.length) text = `Wszystkie komendy bota są w Discordzie wyłączone na wszystkich kanałach (${scope}).`;
    else if (allowed.length <= blocked.length) text = `Discord ogranicza bota do ${toChannels(allowed)} - na wszystkich innych kanałach komendy bota są wyłączone (${scope}).`;
    else text = `Discord wyłącza komendy bota na ${onChannels(blocked)} (${scope}).`;
    if (channelExceptions.length) {
      text += ` Wyjątek: ${channelExceptions.length === 1 ? `/${channelExceptions[0]} ma` : `${slashList(channelExceptions)} mają`} własne ustawienia kanałów.`;
    }
    const covered = snapshot.commands.map((c) => c.name).filter((name) => !channelExceptions.includes(name));
    conflicts.push({ level: 'error', kind: 'channels', text, fix: `${path} → ${APP_PLACE} → ${channelsFix}.`, commands: covered });
  }

  // Kanały pojedynczych komend (ich własne nadpisania, czasem razem z ustawieniem całej aplikacji).
  for (const group of channelGroups.values()) {
    const { blocked, allowed, commands, sources } = group;
    let text;
    if (!allowed.length) text = `Discord wyłącza ${commandsAcc(commands)} na wszystkich kanałach (${admins}).`;
    else if (allowed.length <= blocked.length) text = `Discord pozwala używać ${commandsGen(commands)} tylko na ${onChannels(allowed)} (wszystkie inne kanały wyłączone, ${admins}).`;
    else text = `Discord wyłącza ${commandsAcc(commands)} na ${onChannels(blocked)} (${admins}).`;
    const places = [...(sources.has('command') ? [`kliknij ${slashList(commands)}`] : []), ...(sources.has('app') ? [APP_PLACE] : [])].join(' oraz ');
    const reset = sources.has('command') ? ' - albo usuń wszystkie nadpisania tej komendy (przywróć domyślne)' : '';
    conflicts.push({ level: 'error', kind: 'channels', text, fix: `${path} → ${places} → ${channelsFix}${reset}.`, commands });
  }

  // @everyone zablokowane dla całej aplikacji.
  if (app?.roles.get(guildId) === false) {
    const affected = everyoneBlocks.filter((b) => b.source === 'app').map((b) => b.command);
    const allowedRoles = [...app.roles].filter(([id, allow]) => allow && id !== guildId).map(([id]) => names.role(id));
    const who = allowedRoles.length ? ` - Discord pozwala na nie tylko ${roleWord(allowedRoles)} i administratorom` : ' - widzą je tylko administratorzy';
    const listed = affected.length ? ` Listy bota pozwalają wszystkim na ${slashList(affected)}.` : '';
    conflicts.push({
      level: affected.length ? 'error' : 'warn',
      kind: 'app-everyone',
      text: `Wszystkie komendy bota są w Discordzie wyłączone dla @everyone (ustawienie całej aplikacji)${who}.${listed}`,
      fix: `${path} → ${APP_PLACE} → sekcja „Role i członkowie” → przy @everyone zaznacz ✓ (zezwól).`,
      commands: affected,
    });
  }

  // @everyone zablokowane przy pojedynczych komendach (albo przez ich domyślne uprawnienia).
  const everyoneGroups = new Map();
  for (const block of everyoneBlocks.filter((b) => b.source !== 'app')) {
    const key = `${block.source}|${block.allowedRoles.join(',')}`;
    if (!everyoneGroups.has(key)) everyoneGroups.set(key, { ...block, commands: [] });
    everyoneGroups.get(key).commands.push(block.command);
  }
  for (const group of everyoneGroups.values()) {
    const one = group.commands.length === 1;
    const who = group.allowedRoles.length ? ` - Discord pozwala tylko ${roleWord(group.allowedRoles)} i administratorom` : '';
    const fix =
      group.source === 'default'
        ? `Komenda ma w Discordzie domyślne wymagane uprawnienia - ${path} → kliknij ${slashList(group.commands)} → przy @everyone zaznacz ✓ (zezwól).`
        : `${path} → kliknij ${slashList(group.commands)} → przy @everyone zaznacz ✓ (zezwól) albo usuń nadpisania tej komendy (przywróć domyślne).`;
    conflicts.push({
      level: 'error',
      kind: 'everyone',
      text: `Discord blokuje ${commandsAcc(group.commands)} dla @everyone (${one ? 'lista bota pozwala wszystkim' : 'listy bota pozwalają na nie wszystkim'})${who}.`,
      fix,
      commands: group.commands,
    });
  }

  // Role z list bota, które Discord blokuje (wpisem roli albo @everyone, przy komendzie albo całej aplikacji).
  for (const { name, items } of roleBlocks.values()) {
    const commands = items.map((i) => i.command);
    conflicts.push({
      level: 'error',
      kind: 'role',
      text: `Discord blokuje ${commandsAcc(commands)} dla roli ${name} (${commands.length === 1 ? 'lista bota na to pozwala' : 'listy bota na to pozwalają'}).`,
      fix: `${path} → ${fixPlaces(items)} → przy roli „${name}” zaznacz ✓ (jeśli jej tam nie ma - dodaj ją z ✓) albo usuń nadpisania, które ją blokują.`,
      commands,
    });
  }

  // Osoby z własną blokadą (lista bota wpuszcza je przez ich role).
  for (const { name, items } of userBlocks.values()) {
    const commands = items.map((i) => i.command);
    conflicts.push({
      level: 'warn',
      kind: 'user',
      text: `Discord blokuje ${commandsAcc(commands)} dla osoby ${name} (${commands.length === 1 ? 'lista bota na to pozwala' : 'listy bota na to pozwalają'}).`,
      fix: `${path} → ${fixPlaces(items)} → przy osobie „${name}” zaznacz ✓ albo usuń jej wpis.`,
      commands,
    });
  }
  return conflicts;
}

// Nadpisania i konflikty razem - dane dla panelu (GET /commands/discord).
export function analyzeCommandPermissions(snapshot, config) {
  return { overrides: describeOverrides(snapshot), conflicts: findConflicts(snapshot, config) };
}

// ---------- Uprawnienie kanału „Używanie komend aplikacji” ----------
// Niezależnie od Integracji Discord pozwala użyć komendy tylko na kanale, na którym osoba ma uprawnienie
// „Używanie komend aplikacji” (zwykłe uprawnienia roli i kanału). Serwery często odbierają je @everyone na
// większości kanałów - wtedy np. moderator może używać komend bota tylko tam, gdzie jego rola ma je dodane.
// Administrator omija uprawnienia kanałów, dlatego jemu działa wszędzie.
const USE_APPLICATION_COMMANDS = 1n << 31n;
const VIEW_CHANNEL = 1n << 10n;

// Uprawnienia na kanale dla osoby z rolami roleIds (bez wpisów dla pojedynczych osób) - algorytm Discorda:
// rola @everyone + role → nadpisanie @everyone na kanale → nadpisania ról (zgody wygrywają z blokadami).
export function channelPermissionsFor({ guildId, everyonePerms, rolePerms = [], roleIds = [] }, channel) {
  let perms = BigInt(everyonePerms ?? 0);
  for (const p of rolePerms) perms |= BigInt(p ?? 0);
  if (has(perms, P.ADMINISTRATOR)) return { admin: true, perms };
  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => String(o.id) === String(guildId));
  if (everyone) perms = (perms & ~BigInt(everyone.deny ?? 0)) | BigInt(everyone.allow ?? 0);
  let deny = 0n;
  let allow = 0n;
  for (const o of overwrites) {
    if (Number(o.type) === 0 && roleIds.includes(String(o.id))) {
      deny |= BigInt(o.deny ?? 0);
      allow |= BigInt(o.allow ?? 0);
    }
  }
  perms = (perms & ~deny) | allow;
  return { admin: false, perms };
}

// Dla każdej roli z list komend bota (i zwykłych członków): na których widocznych dla niej kanałach nie może
// używać komend. Liczone dla samej tej roli (+ @everyone) - osoba z kilkoma rolami może mieć więcej.
export function findChannelBlocks({ guildId, roles, channels, config }) {
  const byId = new Map(roles.map((r) => [String(r.id), r]));
  const everyonePerms = byId.get(String(guildId))?.permissions ?? '0';
  const listed = new Set(config.modRoleIds ?? []);
  for (const list of Object.values(config.commandPermissions ?? {})) for (const id of Array.isArray(list) ? list : []) if (id !== EVERYONE) listed.add(id);
  const targets = [{ id: String(guildId), name: '@everyone (zwykli członkowie)', perms: [] }];
  for (const id of listed) {
    const role = byId.get(String(id));
    if (role && !role.managed) targets.push({ id: String(role.id), name: role.name, perms: [role.permissions], position: role.position ?? 0 });
  }
  const usable = channels.filter((c) => COMMAND_CHANNEL_TYPES.has(c.type)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return targets
    .sort((a, b) => (b.position ?? -1) - (a.position ?? -1))
    .map((t) => {
      const roleIds = t.id === String(guildId) ? [] : [t.id];
      let visible = 0;
      let admin = false;
      const blocked = [];
      for (const channel of usable) {
        const result = channelPermissionsFor({ guildId, everyonePerms, rolePerms: t.perms, roleIds }, channel);
        if (result.admin) {
          admin = true;
          break;
        }
        if ((result.perms & VIEW_CHANNEL) !== VIEW_CHANNEL) continue;
        visible += 1;
        if ((result.perms & USE_APPLICATION_COMMANDS) !== USE_APPLICATION_COMMANDS) blocked.push({ id: String(channel.id), name: channel.name });
      }
      return { roleId: t.id, name: t.name, admin, visible: admin ? usable.length : visible, blocked };
    });
}

// Odpowiedź API panelu: { readable, error, botName, checkedAt, overrides, conflicts, channelBlocks }.
// channelBlocks: [{ roleId, name, admin, visible, blocked: [{ id, name }] }] - kanały, które rola widzi, ale nie
// może na nich używać komend (uprawnienie kanału „Używanie komend aplikacji”); admin = omija (Administrator).
export async function discordCommandPermissions(bot, config, { fresh = false } = {}) {
  const snapshot = await loadDiscordCommandPermissions(bot, { fresh });
  let channelBlocks = [];
  try {
    const gctx = await getGuildContext(bot);
    const channels = await cached(bot, 'guildChannelsRaw', CACHE_MS, () => bot.discord.get(`/guilds/${gctx.guild.id}/channels`));
    channelBlocks = findChannelBlocks({ guildId: gctx.guild.id, roles: gctx.rawRoles, channels: channels ?? [], config });
  } catch (error) {
    console.error('[uprawnienia kanałów]', error);
  }
  return {
    readable: snapshot.readable,
    error: snapshot.error,
    botName: snapshot.botName,
    checkedAt: snapshot.checkedAt,
    ...analyzeCommandPermissions(snapshot, config),
    channelBlocks,
  };
}
