import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, ROLES } from './support/discord.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { handlePanel } from '../supabase/functions/hopkostki-bot/lib/panel.js';
import { commandDefinitions } from '../supabase/functions/hopkostki-bot/lib/commands.js';
import { DiscordError } from '../supabase/functions/hopkostki-bot/lib/rest.js';
import { P } from '../supabase/functions/hopkostki-bot/lib/permissions.js';
import { allChannelsId, analyzeCommandPermissions, findConflicts } from '../supabase/functions/hopkostki-bot/lib/discordCommandPerms.js';

// ---------- Logika porównania (dane jak z Discorda, prawdziwe snowflake'i) ----------

const GUILD = '900000000000000100';
const ALL = allChannelsId(GUILD);
const APP = '900000000000000001';
const R = { mod: '900000000000000201', helper: '900000000000000202', admin: '900000000000000203', fan: '900000000000000204' };
const C = { cat: '900000000000000300', ogolny: '900000000000000301', modOnly: '900000000000000302', bot: '900000000000000303' };
const CMD = { powiedz: '900000000000000401', pomoc: '900000000000000402', ban: '900000000000000403' };
const USERS = { helper: '900000000000000501', admin: '900000000000000502' };

const snapshot = (permissions, extra = {}) => ({
  readable: true,
  error: null,
  appId: APP,
  botName: 'Hopkostki',
  guildId: GUILD,
  checkedAt: 0,
  roles: [
    { id: GUILD, name: '@everyone', permissions: '0', position: 0 },
    { id: R.mod, name: '| Moderator', permissions: String(P.MANAGE_MESSAGES), position: 5 },
    { id: R.helper, name: '| Helper', permissions: '0', position: 4 },
    { id: R.admin, name: '| Admin', permissions: String(P.ADMINISTRATOR), position: 9 },
    { id: R.fan, name: 'Fan', permissions: '0', position: 1 },
    { id: '900000000000000299', name: 'Hopkostki Bot', permissions: '0', position: 8, managed: true, tags: { bot_id: APP } },
  ],
  channels: [
    { id: C.cat, name: 'Moderacja', type: 4, position: 0 },
    { id: C.ogolny, name: 'ogolny', type: 0, position: 1 },
    { id: C.modOnly, name: 'moderator-only', type: 0, position: 2 },
    { id: C.bot, name: 'bot-komendy', type: 0, position: 3 },
  ],
  commands: Object.entries(CMD).map(([name, id]) => ({ id, name, default_member_permissions: null })),
  permissions,
  members: {},
  ...extra,
});
const entry = (id, permissions) => ({ id, application_id: APP, guild_id: GUILD, permissions });
const role = (id, permission) => ({ id, type: 1, permission });
const user = (id, permission) => ({ id, type: 2, permission });
const channel = (id, permission) => ({ id, type: 3, permission });
// Listy bota jak u właściciela: /powiedz dla Moderatora, Helpera i Admina, /pomoc dla wszystkich, /ban dla Moderatora.
const CONFIG = { commandPermissions: { powiedz: [R.mod, R.helper, R.admin], pomoc: ['everyone'], ban: [R.mod] } };

test('„Wszystkie kanały” to ID serwera minus 1', () => {
  assert.equal(allChannelsId('900000000000000100'), '900000000000000099');
  assert.equal(allChannelsId('1000000000000000000'), '999999999999999999');
  assert.equal(allChannelsId('g1'), null, 'ID spoza Discorda (atrapa) - bez stałej');
});

test('brak nadpisań w Discordzie = puste listy; nieodczytane dane też nie zgłaszają konfliktów', () => {
  assert.deepEqual(analyzeCommandPermissions(snapshot([]), CONFIG), { overrides: [], conflicts: [] });
  assert.deepEqual(analyzeCommandPermissions({ ...snapshot([entry(CMD.powiedz, [role(R.helper, false)])]), readable: false }, CONFIG), { overrides: [], conflicts: [] });
});

test('/powiedz tylko na jednym kanale („Wszystkie kanały” zablokowane) - także dla administratorów', () => {
  const { overrides, conflicts } = analyzeCommandPermissions(snapshot([entry(CMD.powiedz, [channel(ALL, false), channel(C.modOnly, true)])]), CONFIG);
  assert.deepEqual(overrides, [
    {
      id: CMD.powiedz,
      scope: 'command',
      command: 'powiedz',
      label: '/powiedz',
      entries: [
        { id: ALL, type: 'channel', target: 'allChannels', name: 'Wszystkie kanały', allow: false },
        { id: C.modOnly, type: 'channel', target: 'channel', name: '#moderator-only', allow: true },
      ],
    },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'channels');
  assert.equal(conflicts[0].level, 'error');
  assert.deepEqual(conflicts[0].commands, ['powiedz']);
  assert.equal(conflicts[0].text, 'Discord pozwala używać /powiedz tylko na kanale #moderator-only (wszystkie inne kanały wyłączone, także dla administratorów).');
  assert.match(conflicts[0].fix, /^Ustawienia serwera → Integracje → „Hopkostki” → Zarządzaj → kliknij \/powiedz → sekcja „Kanały” → przy „Wszystkie kanały” zaznacz ✓/);
});

test('ograniczenie kanałów dla całej aplikacji: jedno zdanie o bocie i wyjątek z własnym ustawieniem', () => {
  const conflicts = findConflicts(
    snapshot([entry(APP, [channel(ALL, false), channel(C.bot, true)]), entry(CMD.powiedz, [channel(ALL, true)])]),
    CONFIG,
  );
  assert.equal(conflicts.length, 1);
  assert.equal(
    conflicts[0].text,
    'Discord ogranicza bota do kanału #bot-komendy - na wszystkich innych kanałach komendy bota są wyłączone (ustawienie całej aplikacji, także dla administratorów). Wyjątek: /powiedz ma własne ustawienia kanałów.',
  );
  assert.deepEqual(conflicts[0].commands, ['pomoc', 'ban']);
  assert.match(conflicts[0].fix, /ustawienia całej aplikacji \(góra strony\) → sekcja „Kanały” → przy „Wszystkie kanały” zaznacz ✓/);

  // Kilka zablokowanych kanałów (mniej niż dozwolonych) - wymienione są zablokowane.
  const few = findConflicts(snapshot([entry(CMD.ban, [channel(C.ogolny, false)])]), CONFIG);
  assert.deepEqual(few.map((c) => c.text), ['Discord wyłącza /ban na kanale #ogolny (także dla administratorów).']);
  const none = findConflicts(snapshot([entry(APP, [channel(ALL, false)])]), CONFIG);
  assert.deepEqual(none.map((c) => c.text), ['Wszystkie komendy bota są w Discordzie wyłączone na wszystkich kanałach (ustawienie całej aplikacji, także dla administratorów).']);
});

test('@everyone zablokowane dla całej aplikacji: komunikat ogólny i role z list bota, które przez to nie widzą komend', () => {
  const { overrides, conflicts } = analyzeCommandPermissions(snapshot([entry(APP, [role(GUILD, false), role(R.mod, true)])]), CONFIG);
  assert.equal(overrides[0].scope, 'app');
  assert.equal(overrides[0].label, 'Cała aplikacja (wszystkie komendy)');
  assert.deepEqual(overrides[0].entries.map((e) => [e.target, e.name, e.allow]), [['everyone', '@everyone', false], ['role', '| Moderator', true]]);

  assert.deepEqual(
    conflicts.map((c) => [c.kind, c.text]),
    [
      ['app-everyone', 'Wszystkie komendy bota są w Discordzie wyłączone dla @everyone (ustawienie całej aplikacji) - Discord pozwala na nie tylko roli | Moderator i administratorom. Listy bota pozwalają wszystkim na /pomoc.'],
      // | Admin ma uprawnienie Administrator - Discord go nie blokuje; /ban jest tylko dla Moderatora, którego Discord wpuszcza.
      ['role', 'Discord blokuje /powiedz dla roli | Helper (lista bota na to pozwala).'],
    ],
  );
  assert.match(conflicts[0].fix, /sekcja „Role i członkowie” → przy @everyone zaznacz ✓/);
  assert.match(conflicts[1].fix, /ustawienia całej aplikacji \(góra strony\) → przy roli „\| Helper” zaznacz ✓/);
});

test('blokada roli przy komendzie: konflikt tylko, gdy lista bota tej roli pozwala; kilka komend w jednym zdaniu', () => {
  const single = findConflicts(snapshot([entry(CMD.powiedz, [role(R.helper, false)]), entry(CMD.ban, [role(R.helper, false)])]), CONFIG);
  assert.deepEqual(single.map((c) => c.text), ['Discord blokuje /powiedz dla roli | Helper (lista bota na to pozwala).'], '/ban nie jest dla Helpera na liście bota');
  assert.match(single[0].fix, /kliknij \/powiedz → przy roli „\| Helper” zaznacz ✓/);

  const config = { commandPermissions: { ...CONFIG.commandPermissions, ban: [R.mod, R.helper] } };
  const grouped = findConflicts(snapshot([entry(CMD.powiedz, [role(GUILD, false), role(R.mod, true)]), entry(CMD.ban, [role(R.helper, false)])]), config);
  assert.deepEqual(grouped.map((c) => c.text), ['Discord blokuje komendy /powiedz i /ban dla roli | Helper (listy bota na to pozwalają).']);
  assert.match(grouped[0].fix, /kliknij \/powiedz i \/ban →/);

  // Wpis komendy ma pierwszeństwo przed całą aplikacją: zgoda dla Helpera w aplikacji nie znosi blokady @everyone
  // przy samej komendzie. Role w kolejności jak na serwerze (najwyższa pierwsza); | Admin ma Administratora.
  const commandWins = findConflicts(snapshot([entry(APP, [role(R.helper, true)]), entry(CMD.powiedz, [role(GUILD, false)])]), CONFIG);
  assert.deepEqual(commandWins.map((c) => c.text), [
    'Discord blokuje /powiedz dla roli | Moderator (lista bota na to pozwala).',
    'Discord blokuje /powiedz dla roli | Helper (lista bota na to pozwala).',
  ]);
});

test('@everyone zablokowane przy komendzie, którą lista bota daje wszystkim - jedno zdanie z rolami, które Discord wpuszcza', () => {
  const conflicts = findConflicts(snapshot([entry(CMD.pomoc, [role(GUILD, false), role(R.mod, true)])]), CONFIG);
  assert.deepEqual(conflicts.map((c) => c.text), ['Discord blokuje /pomoc dla @everyone (lista bota pozwala wszystkim) - Discord pozwala tylko roli | Moderator i administratorom.']);
  // Wpis zezwalający niczego nie blokuje.
  assert.deepEqual(findConflicts(snapshot([entry(APP, [role(GUILD, true), channel(ALL, true)]), entry(CMD.pomoc, [role(R.fan, true)])]), CONFIG), []);
});

test('blokada pojedynczej osoby: ostrzeżenie, gdy lista bota wpuszcza ją przez role; administratora nie dotyczy', () => {
  const members = { [USERS.helper]: { name: 'helperka', roles: [R.helper], owner: false }, [USERS.admin]: { name: 'adminka', roles: [R.admin], owner: false } };
  const { overrides, conflicts } = analyzeCommandPermissions(snapshot([entry(CMD.powiedz, [user(USERS.helper, false), user(USERS.admin, false), user('900000000000000599', false)])], { members }), CONFIG);
  assert.deepEqual(overrides[0].entries.map((e) => e.name), ['@adminka', '@helperka', 'osoba spoza serwera (900000000000000599)']);
  assert.deepEqual(conflicts.map((c) => [c.level, c.kind, c.text]), [['warn', 'user', 'Discord blokuje /powiedz dla osoby @helperka (lista bota na to pozwala).']]);
});

test('domyślne uprawnienia komendy w Discordzie (default_member_permissions) też są brane pod uwagę', () => {
  const snap = snapshot([entry(APP, [role(R.helper, true)])]);
  snap.commands = snap.commands.map((c) => (c.name === 'powiedz' ? { ...c, default_member_permissions: String(P.MANAGE_MESSAGES) } : c));
  // Zgoda dla całej aplikacji nie znosi wymaganych uprawnień komendy - Helper bez „Zarządzania wiadomościami” nadal jej nie widzi.
  const conflicts = findConflicts(snap, CONFIG);
  assert.deepEqual(conflicts.map((c) => c.text), ['Discord blokuje /powiedz dla roli | Helper (lista bota na to pozwala).']);
  assert.match(conflicts[0].fix, /domyślne wymagane uprawnienia/);
});

// ---------- API panelu z atrapą Discorda ----------

const BASE = 'https://x.supabase.co/functions/v1/hopkostki-bot/panel';
const HELPER = '100000000000000081';
const MODS = '100000000000000082';
// Role z prawdziwymi ID (krótkie ID z atrapy nie przeszłyby walidacji list w konfiguracji).
ROLES.push({ id: HELPER, name: '| Helper', position: 3, permissions: '0', color: 0 });
ROLES.push({ id: MODS, name: '| Moderator', position: 4, permissions: String(P.MANAGE_MESSAGES), color: 0 });

async function setup() {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  discord.state.commands = commandDefinitions();
  const bot = makeBot({ store, discord });
  const handle = createHandler(bot);
  const call = async (path) => {
    const res = await handle(new Request(`${BASE}${path}`, { headers: { 'x-panel-password': 'tajne' } }));
    return { status: res.status, body: await res.json() };
  };
  const commandId = (name) => String(200000000000000000n + BigInt(commandDefinitions().findIndex((c) => c.name === name)));
  const permissionCalls = () => discord.state.calls.filter((c) => c.path.endsWith('/commands/permissions')).length;
  return { store, discord, bot, call, commandId, permissionCalls };
}

test('API panelu: GET /commands/discord pokazuje nadpisania z Integracji i konflikty z listami bota', async () => {
  const s = await setup();
  await s.store.updateConfig({ commandPermissions: { powiedz: [MODS, HELPER], pomoc: ['everyone'] } });
  s.discord.state.commandPermissions = [
    { id: s.commandId('powiedz'), application_id: 'app', guild_id: 'g1', permissions: [role('g1', false), role(MODS, true), channel('chan', false)] },
  ];
  const { status, body } = await s.call('/commands/discord');
  assert.equal(status, 200);
  assert.equal(body.readable, true);
  assert.equal(body.botName, 'Hopkostki');
  assert.deepEqual(body.overrides.map((o) => [o.scope, o.label]), [['command', '/powiedz']]);
  assert.deepEqual(body.overrides[0].entries.map((e) => [e.target, e.name, e.allow]), [
    ['everyone', '@everyone', false],
    ['role', '| Moderator', true],
    ['channel', '#ogolny', false],
  ]);
  assert.deepEqual(body.conflicts.map((c) => c.text), [
    'Discord wyłącza /powiedz na kanale #ogolny (także dla administratorów).',
    'Discord blokuje /powiedz dla roli | Helper (lista bota na to pozwala).',
  ]);
  assert.ok(body.conflicts.every((c) => c.fix.startsWith('Ustawienia serwera → Integracje → „Hopkostki” → Zarządzaj → kliknij /powiedz')));
});

test('API panelu: brak nadpisań, 404 i 403 z Discorda nie psują zakładki; dane pamiętane 30 s, ?fresh=1 pobiera od nowa', async () => {
  const s = await setup();
  const clean = await s.call('/commands/discord');
  assert.deepEqual([clean.status, clean.body.readable, clean.body.overrides, clean.body.conflicts], [200, true, [], []]);
  // Kanały są potrzebne zawsze - do sprawdzenia uprawnienia „Używanie komend aplikacji” (channelBlocks).
  assert.ok(Array.isArray(clean.body.channelBlocks));
  assert.equal(s.discord.state.calls.filter((c) => c.path === '/guilds/g1/channels').length, 1);

  // Druga prośba korzysta z pamięci (nadpisania i kanały), ?fresh=1 pyta Discorda ponownie o nadpisania.
  await s.call('/commands/discord');
  assert.equal(s.permissionCalls(), 1);
  assert.equal(s.discord.state.calls.filter((c) => c.path === '/guilds/g1/channels').length, 1, 'lista kanałów z pamięci (30 s)');
  s.discord.state.commandPermissionsError = new DiscordError(404, { code: 10066, message: 'Unknown application command permissions' });
  const missing = await s.call('/commands/discord?fresh=1');
  assert.equal(s.permissionCalls(), 2);
  assert.deepEqual([missing.status, missing.body.readable, missing.body.overrides], [200, true, []]);

  s.discord.state.commandPermissionsError = new DiscordError(403, { code: 50001, message: 'Missing Access' });
  const denied = await s.call('/commands/discord?fresh=1');
  assert.equal(denied.status, 200);
  assert.equal(denied.body.readable, false);
  assert.match(denied.body.error, /Discord nie pozwolił botowi odczytać uprawnień komend \(Missing Access\)/);
  assert.deepEqual([denied.body.overrides, denied.body.conflicts], [[], []]);
});

test('API panelu: /commands/discord jak /commands - widzi każdy zalogowany, także bez odblokowanych części', async () => {
  const s = await setup();
  const auth = { kind: 'session', full: false, sections: [], session: null, user: { id: 'mod', tag: 'mod' } };
  const result = await handlePanel(s.bot, { method: 'GET', path: '/commands/discord', auth });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.overrides, []);
  assert.equal((await handlePanel(s.bot, { method: 'GET', path: '/commands/discord/x', auth })).status, 403, 'inne ścieżki nadal wymagają pełnego dostępu');

  const offline = await handlePanel({ ...s.bot, discord: null }, { method: 'GET', path: '/commands/discord' });
  assert.equal(offline.status, 503);
});

test('findChannelBlocks: kanały bez „Używania komend aplikacji” dla ról z list (administrator omija)', async () => {
  const { findChannelBlocks } = await import('../supabase/functions/hopkostki-bot/lib/discordCommandPerms.js');
  const G = '100';
  const USE = 1n << 31n;
  const VIEW = 1n << 10n;
  const roles = [
    { id: G, permissions: String(VIEW | (1n << 11n)) },
    { id: 'mod', name: '| Moderator', permissions: String(USE | (1n << 13n)), position: 5 },
    { id: 'adm', name: '| Admin', permissions: '8', position: 9 },
    { id: 'bot', name: 'Bot', permissions: '8', position: 10, managed: true },
  ];
  const channels = [
    { id: 'c1', name: 'ogolny', type: 0, position: 1, permission_overwrites: [{ id: G, type: 0, allow: '0', deny: String(USE) }] },
    { id: 'c2', name: 'moderator-only', type: 0, position: 2, permission_overwrites: [{ id: G, type: 0, allow: '0', deny: String(VIEW | USE) }, { id: 'mod', type: 0, allow: String(VIEW | USE), deny: '0' }] },
    { id: 'c3', name: 'kategoria', type: 4, position: 0 },
  ];
  const config = { modRoleIds: ['mod'], commandPermissions: { powiedz: ['mod', 'adm', 'everyone'], ban: ['bot'] } };
  const result = findChannelBlocks({ guildId: G, roles, channels, config });
  const byId = Object.fromEntries(result.map((r) => [r.roleId, r]));
  assert.equal(byId.bot, undefined, 'role zarządzane (boty) pomijamy');
  assert.equal(byId.adm.admin, true);
  assert.deepEqual(byId.adm.blocked, []);
  assert.deepEqual(byId.mod.blocked.map((c) => c.name), ['ogolny'], 'moderator widzi oba kanały, komendy ma tylko na moderator-only');
  assert.equal(byId.mod.visible, 2);
  assert.deepEqual(byId[G].blocked.map((c) => c.name), ['ogolny']);
  assert.equal(byId[G].visible, 1, 'kanału moderacji @everyone nie widzi - nie liczy się');
});
