import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD } from './support/discord.js';
import { onVoiceStateUpdate, syncGuildVoiceStates, cleanupTempVoice, fillChannelName } from '../supabase/functions/hopkostki-bot/lib/voice.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { P } from '../supabase/functions/hopkostki-bot/lib/permissions.js';

const HUB = '100000000000000001';
const CATEGORY = '100000000000000002';

async function setup({ generator = {}, dashboard = true } = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({
    tempVoice: {
      enabled: true,
      generators: [{ hubId: HUB, categoryId: CATEGORY, name: 'Kanał {nick}', limit: 5, private: false, ...generator }],
      dashboard: { enabled: dashboard },
    },
  });
  const voice = (userId, channelId, nick) =>
    onVoiceStateUpdate(bot, { guild_id: GUILD, user_id: userId, channel_id: channelId, member: { nick, user: { id: userId, username: userId } } });
  return { store, discord, bot, voice };
}

// Kliknięcie w przycisk / wybór z listy / wysłanie okna - tak, jak przysyła to Discord.
function interaction(customId, { user = 'target', permissions = '0', type = 3, values, components, channel } = {}) {
  return {
    type,
    id: 'i2',
    application_id: 'app',
    token: `tok-${customId.replace(/\W/g, "-")}`,
    guild_id: GUILD,
    channel_id: channel?.id ?? 'vc',
    channel,
    member: { user: { id: user, username: user }, roles: [], permissions },
    data: { custom_id: customId, ...(values ? { values } : {}), ...(components ? { components } : {}) },
  };
}

async function run(bot, body) {
  const result = await handleInteraction(body, bot);
  await result.task?.();
  return result;
}

test('nazwa kanału: zmienne i limit 100 znaków', () => {
  assert.equal(fillChannelName('Kanał {nick} #{numer}', { nick: 'Hurek', numer: 3 }), 'Kanał Hurek #3');
  assert.equal(fillChannelName('', { nick: 'x' }), 'Kanał x');
  assert.equal(fillChannelName('{nick}', { nick: 'a'.repeat(150) }).length, 100);
});

test('wejście na kanał do dołączenia tworzy własny kanał, przenosi, wysyła panel; wyjście go usuwa', async () => {
  const s = await setup();
  await s.voice('target', HUB, 'Hurek');

  const [created] = s.discord.state.createdChannels;
  assert.equal(created.name, 'Kanał Hurek');
  assert.equal(created.type, 2);
  assert.equal(created.parent_id, CATEGORY);
  assert.equal(created.user_limit, 5);
  assert.deepEqual(s.discord.state.moves, [{ id: 'target', channel: created.id }]);

  const temp = await s.store.getTempVoice(created.id);
  assert.equal(temp.ownerId, 'target');
  assert.ok(temp.dashboardMessageId, 'panel wysłany na czat kanału');
  const dashboard = s.discord.state.channels.get(created.id)[0];
  assert.equal(dashboard.embeds[0].title, 'Panel kanału');
  const labels = dashboard.components.flatMap((row) => row.components.map((c) => c.label));
  assert.deepEqual(labels, ['Ustaw jako prywatny', 'Dodaj osoby', 'Zmień nazwę', 'Zmień właściciela', 'Zmień limit', 'Zbanuj', 'Wyrzuć']);

  // Discord przysyła potwierdzenie przeniesienia, potem wyjście z kanału.
  await s.voice('target', created.id, 'Hurek');
  await s.voice('target', null, 'Hurek');
  assert.deepEqual(s.discord.state.deletedChannels, [created.id]);
  assert.equal(await s.store.getTempVoice(created.id), null);
});

test('kanał nie znika, dopóki ktoś na nim jest; ponowne wejście na hub przenosi na istniejący kanał', async () => {
  const s = await setup();
  await s.voice('target', HUB, 'Hurek');
  const channelId = s.discord.state.createdChannels[0].id;
  await s.voice('target', channelId);
  await s.voice('mod', channelId);

  await s.voice('target', HUB);
  assert.equal(s.discord.state.createdChannels.length, 1, 'bez drugiego kanału');
  assert.deepEqual(s.discord.state.moves.at(-1), { id: 'target', channel: channelId });

  await s.voice('target', null);
  assert.deepEqual(s.discord.state.deletedChannels, [], 'mod nadal siedzi na kanale');
  await s.voice('mod', null);
  assert.deepEqual(s.discord.state.deletedChannels, [channelId]);
});

test('wyłączone kanały na żądanie i zwykłe kanały nic nie tworzą; lista z GUILD_CREATE zastępuje stan', async () => {
  const s = await setup();
  await s.store.updateConfig({ tempVoice: { enabled: false } });
  await s.voice('target', HUB);
  assert.equal(s.discord.state.createdChannels.length, 0);

  await s.store.updateConfig({ tempVoice: { enabled: true } });
  await s.voice('target', '100000000000000009');
  assert.equal(s.discord.state.createdChannels.length, 0);

  await syncGuildVoiceStates(s.bot, { id: GUILD, voice_states: [{ user_id: 'mod', channel_id: '5' }, { user_id: 'owner', channel_id: '5' }] });
  assert.deepEqual((await s.store.voiceMembers('5')).sort(), ['mod', 'owner']);
  assert.equal(await s.store.getVoiceChannel('target'), null);
});

test('panel kanału: tylko właściciel, prywatność, dostęp, bany, limit i nazwa', async () => {
  const s = await setup();
  await s.voice('target', HUB, 'Hurek');
  const channelId = s.discord.state.createdChannels[0].id;
  await s.voice('target', channelId);
  await s.voice('mod', channelId);

  const stranger = await run(s.bot, interaction(`tv|privacy|${channelId}`, { user: 'mod' }));
  assert.match(stranger.response.data.embeds[0].description, /Tylko właściciel/);

  // Prywatny: @everyone nie może dołączyć, bot ma dostęp, panel się odświeża.
  const privacy = await run(s.bot, interaction(`tv|privacy|${channelId}`));
  assert.equal(privacy.response.type, 5);
  assert.equal((await s.store.getTempVoice(channelId)).private, true);
  const everyone = s.discord.state.calls.find((c) => c.method === 'PUT' && c.path === `/channels/${channelId}/permissions/${GUILD}`);
  assert.equal(BigInt(everyone.body.deny) & P.CONNECT, P.CONNECT);
  assert.equal(s.discord.state.editedMessages.at(-1).body.components[0].components[0].label, 'Ustaw jako publiczny');

  // Przycisk "Dodaj osoby" otwiera listę wyboru osób z zaznaczonymi obecnymi.
  const picker = await run(s.bot, interaction(`tv|members|${channelId}`));
  assert.equal(picker.response.data.components[0].components[0].type, 5);
  await run(s.bot, interaction(`tvs|members|${channelId}`, { values: ['owner'] }));
  assert.deepEqual((await s.store.getTempVoice(channelId)).allowed, ['owner']);
  const ownerOverwrite = s.discord.state.calls.findLast((c) => c.path === `/channels/${channelId}/permissions/owner`);
  assert.equal(BigInt(ownerOverwrite.body.allow) & P.CONNECT, P.CONNECT);

  // Ban: nadpisanie "nie może dołączyć" + wyrzucenie z kanału, jeśli na nim jest.
  await run(s.bot, interaction(`tvs|ban|${channelId}`, { values: ['mod'] }));
  const temp = await s.store.getTempVoice(channelId);
  assert.deepEqual(temp.banned, ['mod']);
  const modOverwrite = s.discord.state.calls.findLast((c) => c.path === `/channels/${channelId}/permissions/mod`);
  assert.equal(BigInt(modOverwrite.body.deny) & P.CONNECT, P.CONNECT);
  assert.deepEqual(s.discord.state.moves.at(-1), { id: 'mod', channel: null });

  // Limit i nazwa przez okno z formularzem.
  const modal = await run(s.bot, interaction(`tv|limit|${channelId}`));
  assert.equal(modal.response.type, 9);
  const form = (value) => [{ type: 1, components: [{ type: 4, custom_id: 'value', value }] }];
  await run(s.bot, interaction(`tvm|limit|${channelId}`, { type: 5, components: form('3') }));
  assert.equal((await s.store.getTempVoice(channelId)).limit, 3);
  assert.deepEqual(s.discord.state.channelEdits.at(-1), { id: channelId, body: { user_limit: 3 } });
  await run(s.bot, interaction(`tvm|limit|${channelId}`, { type: 5, components: form('500') }));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /od 0 do 99/);
  await run(s.bot, interaction(`tvm|name|${channelId}`, { type: 5, components: form('Pokój Hurka') }));
  assert.deepEqual(s.discord.state.channelEdits.at(-1).body, { name: 'Pokój Hurka' });

  // Przekazanie kanału: nowy właściciel, stary zostaje z dostępem.
  await run(s.bot, interaction(`tvs|owner|${channelId}`, { values: ['owner'] }));
  const moved = await s.store.getTempVoice(channelId);
  assert.equal(moved.ownerId, 'owner');
  assert.ok(moved.allowed.includes('target'));

  // Moderator z uprawnieniem "Zarządzanie kanałami" też może zarządzać.
  const asMod = await run(s.bot, interaction(`tv|kick|${channelId}`, { user: 'mod', permissions: String(P.MANAGE_CHANNELS) }));
  assert.equal(asMod.response.type, 5);
});

test('cron sprząta puste kanały tylko przy działającym gatewayu i po okresie ochronnym', async () => {
  const s = await setup({ dashboard: false });
  await s.store.addTempVoice({ channelId: '300000000000000001', guildId: GUILD, ownerId: 'target' });
  await s.store.addTempVoice({ channelId: '300000000000000002', guildId: GUILD, ownerId: 'mod' });
  await s.store.query(`update bot.temp_voice set created_at = now() - interval '5 minutes'`);
  await s.store.setVoiceState('mod', '300000000000000002');

  assert.equal(await cleanupTempVoice(s.bot), 0, 'bez świeżego gatewaya nic nie usuwamy');
  await s.store.setState('gateway_status', { startedAt: Date.now() - 10_000, endedAt: Date.now(), error: null });
  assert.equal(await cleanupTempVoice(s.bot), 1);
  assert.deepEqual(s.discord.state.deletedChannels, ['300000000000000001']);
  assert.ok(await s.store.getTempVoice('300000000000000002'));
});

test('konfiguracja kanałów na żądanie: tylko poprawne ID, limit 0-99, bez duplikatów', async () => {
  const { store } = await createTestStore();
  const config = await store.updateConfig({
    tempVoice: {
      generators: [
        { hubId: HUB, categoryId: 'zle', name: '', limit: 500, private: 'tak' },
        { hubId: HUB, name: 'duplikat' },
        { hubId: 'nie-id' },
      ],
    },
  });
  assert.deepEqual(config.tempVoice.generators, [{ hubId: HUB, categoryId: '', name: 'Kanał {nick}', limit: 99, private: false }]);
  assert.equal(config.tempVoice.dashboard.title, 'Panel kanału');
});
