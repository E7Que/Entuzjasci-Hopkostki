import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, ROLES, commandPayload } from './support/discord.js';
import { onMemberJoin, onMemberLeave, onMemberUpdate, autoRoleSweep, ensureIntentFlags } from '../supabase/functions/hopkostki-bot/lib/members.js';
import { fillCommandPermissions, commandPermissionDefaults, COMMANDS } from '../supabase/functions/hopkostki-bot/lib/commands.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';

const ROLE = '100000000000000090';
const BOT_ROLE = '100000000000000091';
const WELCOME = '100000000000000092';
const LOGS = '100000000000000093';
const MEMBERS_LIMITED = 1 << 15;
// Role z ID jak prawdziwe: straż ma „Banowanie członków”, szef - administratora.
const GUARD = '100000000000000094';
const BOSS = '100000000000000095';
ROLES.push(
  { id: GUARD, name: 'Straż', position: 5, permissions: String(1n << 2n), color: 0 },
  { id: BOSS, name: 'Szef', position: 7, permissions: String(1n << 3n), color: 0 },
);

async function setup(members = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ modLogChannelId: LOGS, members });
  return { store, discord, bot };
}

const joined = (id, extra = {}) => ({ guild_id: GUILD, user: { id, username: `u-${id}` }, roles: [], joined_at: new Date().toISOString(), ...extra });
const roleCalls = (discord) => discord.state.calls.filter((c) => c.method === 'PUT' && /\/roles\//.test(c.path)).map((c) => c.path);

test('autorole: nowa osoba dostaje role, bot - role dla botów; oczekujący na regulamin dopiero po akceptacji', async () => {
  const s = await setup({ autoRole: { enabled: true, roleIds: [ROLE], botRoleIds: [BOT_ROLE] } });
  await onMemberJoin(s.bot, joined('111111111111111111'));
  await onMemberJoin(s.bot, joined('222222222222222222', { user: { id: '222222222222222222', username: 'robot', bot: true } }));
  assert.deepEqual(roleCalls(s.discord), [
    `/guilds/g1/members/111111111111111111/roles/${ROLE}`,
    `/guilds/g1/members/222222222222222222/roles/${BOT_ROLE}`,
  ]);

  await onMemberJoin(s.bot, joined('333333333333333333', { pending: true }));
  assert.equal(roleCalls(s.discord).length, 2, 'czeka na akceptację regulaminu');
  await onMemberUpdate(s.bot, joined('333333333333333333', { pending: false }));
  assert.equal(roleCalls(s.discord).at(-1), `/guilds/g1/members/333333333333333333/roles/${ROLE}`);
  await onMemberUpdate(s.bot, joined('444444444444444444', { joined_at: '2020-01-01T00:00:00Z' }));
  assert.equal(roleCalls(s.discord).length, 3, 'stare osoby nie dostają roli przy każdej zmianie');
});

test('powitanie, pożegnanie i log wejść z ostrzeżeniem o młodym koncie', async () => {
  const s = await setup({
    welcome: { enabled: true, channelId: WELCOME, title: 'Hej {nick}!', message: 'Witaj {uzytkownik} na {serwer}, jesteś {liczba}.' },
    goodbye: { enabled: true, channelId: WELCOME, message: '{nick} wyszedł, zostało {liczba}.' },
  });
  await s.store.updateConfig({ logs: { enabled: true, joinLeaveChannelId: LOGS } });
  const fresh = String((BigInt(Date.now() - 1420070400000) << 22n));
  await onMemberJoin(s.bot, joined(fresh, { user: { id: fresh, username: 'nowy' } }));
  const [welcome, bye] = [s.discord.state.channels.get(WELCOME)[0]];
  assert.equal(welcome.content, `<@${fresh}>`);
  assert.equal(welcome.embeds[0].title, 'Hej nowy!');
  assert.equal(welcome.embeds[0].description, `Witaj <@${fresh}> na Entuzjaści Hopkostki, jesteś 1337.`);
  const joinLog = s.discord.state.channels.get(LOGS)[0];
  assert.match(joinLog.embeds[0].description, /nowe konto - ma mniej niż 1 dzień/);
  assert.equal(joinLog.content, '@here', 'nowe konto oznacza @here');
  assert.deepEqual(joinLog.allowed_mentions, { parse: ['everyone'] });

  await onMemberLeave(s.bot, { guild_id: GUILD, user: { id: fresh, username: 'nowy' } });
  assert.equal(s.discord.state.channels.get(WELCOME)[1].embeds[0].description, 'nowy wyszedł, zostało 1337.');
  assert.match(s.discord.state.channels.get(LOGS)[1].embeds[0].author.name, /wyszedł/);
  assert.equal(bye, undefined);

  await onMemberJoin(s.bot, { ...joined('555555555555555555'), guild_id: 'inny-serwer' });
  assert.equal(s.discord.state.channels.get(WELCOME).length, 2, 'inne serwery ignorowane');
});

test('intencje: bot sam włącza „Server Members” (limited), gdy są włączone funkcje członków', async () => {
  const s = await setup();
  let state = await ensureIntentFlags(s.bot, await s.store.getConfig());
  assert.equal(state.members, false);
  assert.ok(!s.discord.state.calls.some((c) => c.method === 'PATCH' && c.path === '/applications/@me'), 'nic nie włączamy bez potrzeby');

  const config = await s.store.updateConfig({ members: { welcome: { enabled: true } } });
  state = await ensureIntentFlags(s.bot, config);
  assert.equal(state.members, true);
  assert.equal(s.discord.state.appFlags & MEMBERS_LIMITED, MEMBERS_LIMITED);
});

test('cron: autorole dla osób z ostatniej doby, które jej nie mają (co 5 minut)', async () => {
  const s = await setup({ autoRole: { enabled: true, roleIds: [ROLE] } });
  s.discord.state.appFlags = MEMBERS_LIMITED;
  const given = await autoRoleSweep(s.bot);
  assert.ok(given >= 3);
  assert.equal(await autoRoleSweep(s.bot), 0, 'drugi raz dopiero po 5 minutach');
});

test('uprawnienia: każda komenda dostaje własną listę ról według obecnego dostępu (z rolami administratorów), „wszyscy” działa', async () => {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  const { changed, config } = await fillCommandPermissions(bot);
  assert.equal(changed, COMMANDS.length);
  assert.deepEqual(config.commandPermissions.ban, [BOSS, GUARD], 'rola z „Banowaniem członków” i rola z Administratorem (wyżej, więc pierwsza)');
  assert.deepEqual(config.commandPermissions.kick, [BOSS], '„Wyrzucanie” ma tylko administrator - i trafia na listę, żeby nie stracić dostępu');
  assert.deepEqual(config.commandPermissions.pomoc, ['everyone']);
  assert.equal((await fillCommandPermissions(bot)).changed, 0, 'drugi raz nic nie zmienia');

  await store.updateConfig({ commandPermissions: { ...config.commandPermissions, kick: ['everyone'], ban: [] } });
  const options = [{ name: 'uzytkownik', type: 6, value: 'target' }, { name: 'powod', type: 3, value: 'x' }];
  const kick = await handleInteraction(commandPayload('kick', options, { invoker: 'target', roles: [], permissions: '0' }), bot);
  assert.equal(kick.response.type, 5, '„wszyscy” wpuszcza każdego');
  const ban = await handleInteraction(commandPayload('ban', options), bot);
  assert.match(ban.response.data.embeds[0].description, /Nie masz uprawnień/, 'pusta lista: moderator nie ma dostępu');
  const admin = await handleInteraction(commandPayload('ban', options, { roles: [BOSS], permissions: String(1n << 3n) }), bot);
  assert.match(admin.response.data.embeds[0].description, /Nie masz uprawnień/, 'pusta lista: administrator też nie');
  const owner = await handleInteraction(commandPayload('ban', options, { invoker: 'owner', roles: [], permissions: String(1n << 3n) }), bot);
  assert.equal(owner.response.type, 5, 'pusta lista = tylko właściciel serwera');
});

test('domyślne listy ról: role z Administratorem są na listach, @everyone i role integracji - nie', () => {
  const MOD_ROLE = '100000000000000096';
  const INTEGRATION = '100000000000000097';
  const rawRoles = [
    { id: GUILD, position: 0, permissions: String(1n << 3n) },
    { id: GUARD, position: 5, permissions: String(1n << 2n) },
    { id: BOSS, position: 7, permissions: String(1n << 3n) },
    { id: INTEGRATION, position: 8, permissions: String(1n << 3n), managed: true },
    { id: MOD_ROLE, position: 3, permissions: '0' },
  ];
  const defaults = commandPermissionDefaults(rawRoles, GUILD, { modRoleIds: [MOD_ROLE] });
  assert.deepEqual(defaults.ban, [BOSS, GUARD, MOD_ROLE]);
  assert.deepEqual(defaults.lock, [BOSS, MOD_ROLE], 'Administrator ma każde uprawnienie Discorda');
  assert.deepEqual(defaults.pomoc, ['everyone']);
  assert.ok(Object.values(defaults).every((list) => !list.includes(GUILD) && !list.includes(INTEGRATION)));
});
