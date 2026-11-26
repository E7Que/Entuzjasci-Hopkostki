import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, snowflake } from './support/discord.js';
import { DISBOARD_ID, bumpInfo, onBumpMessage, bumpReminderTick, bumpScan } from '../supabase/functions/hopkostki-bot/lib/bump.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { commandPayload } from './support/discord.js';

const BUMP_CHANNEL = '100000000000000060';
const PING_ROLE = '100000000000000061';

async function setup(bump = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ bump: { enabled: true, roleIds: [PING_ROLE], ...bump } });
  return { store, discord, bot };
}

const disboard = (userId, { ok = true, id = snowflake(), channel = BUMP_CHANNEL } = {}) => ({
  id,
  guild_id: GUILD,
  channel_id: channel,
  author: { id: DISBOARD_ID, username: 'DISBOARD', bot: true },
  interaction_metadata: { id: 'x', type: 2, name: 'bump', user: { id: userId, username: `u${userId}` } },
  embeds: [
    ok
      ? { description: 'Bump done! :thumbsup:\nCheck it out on DISBOARD.', image: { url: 'https://disboard.org/images/bot-command-image-bump.png' } }
      : { description: 'Please wait another 87 minutes until the server can be bumped' },
  ],
});

test('rozpoznaje udany bump DISBOARD, a „poczekaj jeszcze X minut” i innych botów ignoruje', () => {
  assert.equal(bumpInfo(disboard('target')).user.id, 'target');
  assert.equal(bumpInfo(disboard('target', { ok: false })), null);
  assert.equal(bumpInfo({ ...disboard('target'), author: { id: '1' } }), null);
  // Bez intencji treści embedy są puste - wystarcza nazwa komendy.
  assert.equal(bumpInfo({ ...disboard('target'), embeds: [] }).user.id, 'target');
});

test('bump: podziękowanie jako odpowiedź, po 2 h „Czas na Bump!” z oznaczeniem roli w odpowiedzi na bump', async () => {
  const s = await setup();
  const message = disboard('target');
  await onBumpMessage(s.bot, message);

  const [thanks] = s.discord.state.channels.get(BUMP_CHANNEL);
  assert.equal(thanks.message_reference.message_id, message.id, 'odpowiada na wiadomość z bumpem');
  assert.equal(thanks.embeds[0].title, 'Dzięki za Bumpnięcie serwera!');
  assert.match(thanks.embeds[0].description, /<@target> - to już Twój \*\*1\.\*\* bump\. Kolejny możliwy <t:\d+:R>/);

  // Ta sama wiadomość drugi raz (np. z przeglądu kanału przez crona) nic nie robi.
  await onBumpMessage(s.bot, message);
  assert.equal(s.discord.state.channels.get(BUMP_CHANNEL).length, 1);

  assert.equal(await bumpReminderTick(s.bot), 0, 'za wcześnie');
  const state = await s.store.getState('bump');
  await s.store.setState('bump', { ...state, remindAt: Date.now() - 1000 });
  assert.equal(await bumpReminderTick(s.bot), 1);
  const reminder = s.discord.state.channels.get(BUMP_CHANNEL)[1];
  assert.equal(reminder.content, `<@&${PING_ROLE}>`);
  assert.deepEqual(reminder.allowed_mentions.roles, [PING_ROLE]);
  assert.equal(reminder.embeds[0].title, 'Czas na Bump!');
  assert.match(reminder.embeds[0].description, /<\/bump:947088344167366698>/);
  assert.equal(reminder.message_reference.message_id, message.id);
  assert.equal(await bumpReminderTick(s.bot), 0, 'tylko raz');
});

test('bump: bez podziękowania, gdy wyłączone; przypomnienie na osobnym kanale bez odpowiedzi', async () => {
  const s = await setup({ channelId: '100000000000000062', thanks: { enabled: false } });
  await onBumpMessage(s.bot, disboard('target'));
  assert.equal(s.discord.state.channels.get(BUMP_CHANNEL), undefined);
  const state = await s.store.getState('bump');
  await s.store.setState('bump', { ...state, remindAt: Date.now() - 1 });
  await bumpReminderTick(s.bot);
  const [reminder] = s.discord.state.channels.get('100000000000000062');
  assert.equal(reminder.message_reference, undefined, 'odpowiedź tylko na tym samym kanale');
});

test('bump: cron znajduje bump przegapiony przez gateway; /bumpy pokazuje ranking', async () => {
  const s = await setup({ channelId: BUMP_CHANNEL });
  s.discord.state.channels.set(BUMP_CHANNEL, [disboard('target'), disboard('mod'), disboard('target')].map(({ guild_id, ...m }) => m));
  assert.equal(await bumpScan(s.bot), 3);
  assert.equal(await bumpScan(s.bot), 0, 'co 2 minuty');

  const result = await handleInteraction(commandPayload('bumpy', [{ name: 'ranking', type: 1, options: [] }]), s.bot);
  await result.task();
  const embed = s.discord.state.webhook.at(-1).body.embeds[0];
  assert.match(embed.description, /1\. <@target> - \*\*2\*\* bumpy\n2\. <@mod> - \*\*1\*\* bump/);
});
