import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, EMOJIS, commandPayload, snowflake } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { sendDueReminders, finishDueGiveaways, onMessageAfk, pickWinners } from '../supabase/functions/hopkostki-bot/lib/community.js';
import { pollAnswer } from '../supabase/functions/hopkostki-bot/lib/communityCommands.js';
import { cleanMessageData, buildMessagePayload } from '../supabase/functions/hopkostki-bot/lib/messages.js';
import { getGuildContext } from '../supabase/functions/hopkostki-bot/lib/moderation.js';

const ADMIN = String(1n << 3n);
const SUGGEST = '100000000000000040';

async function setup(config = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  if (Object.keys(config).length) await store.updateConfig(config);
  return { store, discord, bot };
}

async function run(bot, name, options = [], extra = {}) {
  const result = await handleInteraction(commandPayload(name, options, extra), bot);
  await result.task?.();
  return result;
}
const sub = (name, options = []) => [{ name, type: 1, options }];
const opt = (name, value, type = 3) => ({ name, type, value });
const lastReply = (s) => s.discord.state.webhook.at(-1).body;

test('/przypomnij: dodanie, lista, wysyłka po czasie na kanale i w DM', async () => {
  const s = await setup();
  await run(s.bot, 'przypomnij', sub('dodaj', [opt('za', 10, 4), opt('jednostka', 'm'), opt('tresc', 'wyjąć pizzę')]), { invoker: 'target', roles: [], permissions: '0' });
  assert.match(lastReply(s).embeds[0].description, /Przypomnę Ci za \*\*10 minut\*\*/);
  await run(s.bot, 'przypomnij', sub('dodaj', [opt('za', 1, 4), opt('jednostka', 'h'), opt('tresc', 'prywatnie'), opt('prywatnie', true, 5)]), { invoker: 'target', roles: [], permissions: '0' });
  await run(s.bot, 'przypomnij', sub('lista'), { invoker: 'target', roles: [], permissions: '0' });
  assert.match(lastReply(s).embeds[0].description, /#1.*wyjąć pizzę\n\*\*#2\*\*.*\(DM\)/s);

  assert.equal(await sendDueReminders(s.bot), 0);
  await s.store.query("update bot.reminders set due_at = now() - interval '1 minute'");
  assert.equal(await sendDueReminders(s.bot), 2);
  const onChannel = s.discord.state.channels.get('chan').at(-1);
  assert.equal(onChannel.content, '<@target>');
  assert.equal(onChannel.embeds[0].description, 'wyjąć pizzę');
  assert.equal(s.discord.state.dms.at(-1).embeds[0].description, 'prywatnie');
  assert.equal(await sendDueReminders(s.bot), 0, 'każde tylko raz');
});

test('/konkurs: start z przyciskiem, zapis i wypisanie, wymagana rola, losowanie przez crona i ponowne', async () => {
  const s = await setup();
  await run(s.bot, 'konkurs', sub('start', [opt('nagroda', 'Nitro'), opt('czas', 1, 4), opt('jednostka', 'h'), opt('zwyciezcy', 1, 4)]), { permissions: ADMIN });
  const post = s.discord.state.channels.get('chan').find((m) => m.embeds?.[0]?.title === 'Nitro');
  assert.equal(post.components[0].components[0].custom_id, 'gw|join|1');

  const click = (user, roles = []) => ({
    type: 3,
    id: 'c',
    application_id: 'app',
    token: `tok-gw-${user}`,
    guild_id: GUILD,
    channel_id: 'chan',
    member: { user: { id: user, username: user }, roles, permissions: '0' },
    data: { custom_id: 'gw|join|1', component_type: 2 },
  });
  const press = async (user) => {
    const r = await handleInteraction(click(user), s.bot);
    await r.task();
  };
  await press('target');
  await press('owner');
  await press('owner');
  assert.deepEqual((await s.store.getGiveaway(1)).entrants, ['target'], 'drugie kliknięcie wypisuje');
  assert.match(s.discord.state.editedMessages.at(-1).body.components[0].components[0].label, /Weź udział \(1\)/);

  await s.store.query("update bot.giveaways set ends_at = now() - interval '1 second'");
  assert.equal(await finishDueGiveaways(s.bot), 1);
  const ended = await s.store.getGiveaway(1);
  assert.deepEqual(ended.winnerIds, ['target']);
  const announce = s.discord.state.channels.get('chan').at(-1);
  assert.match(announce.content, /Gratulacje <@target>! Wygrywasz \*\*Nitro\*\*!/);
  assert.equal(announce.message_reference.message_id, post.id);

  await run(s.bot, 'konkurs', sub('losuj', [opt('numer', 1, 4)]), { permissions: ADMIN });
  assert.ok(s.discord.state.channels.get('chan').some((m) => /nie ma już kogo wylosować/.test(m.content ?? '')));

  const r = await handleInteraction(click('owner'), s.bot);
  await r.task();
  assert.match(lastReply(s).embeds[0].description, /już się zakończył/);
});

test('pickWinners: bez powtórzeń i bez wykluczonych', () => {
  const winners = pickWinners(['a', 'b', 'c', 'd'], 3, ['a']);
  assert.equal(new Set(winners).size, 3);
  assert.ok(!winners.includes('a'));
});

test('/ankieta: natywna ankieta Discorda z emoji w odpowiedziach', async () => {
  const s = await setup();
  await run(s.bot, 'ankieta', [opt('pytanie', 'Co na obiad?'), opt('odpowiedzi', 'Pizza; 🍔 Burger; <:hopka:100000000000000070> Hopka'), opt('godziny', 2, 4)], { permissions: ADMIN });
  const poll = s.discord.state.channels.get('chan').find((m) => m.poll).poll;
  assert.equal(poll.question.text, 'Co na obiad?');
  assert.equal(poll.duration, 2);
  assert.deepEqual(poll.answers, [
    { poll_media: { text: 'Pizza' } },
    { poll_media: { text: 'Burger', emoji: { name: '🍔' } } },
    { poll_media: { text: 'Hopka', emoji: { id: '100000000000000070' } } },
  ]);
  assert.deepEqual(pollAnswer('👍'), { poll_media: { text: '👍', emoji: { name: '👍' } } });

  await run(s.bot, 'ankieta', [opt('pytanie', 'x'), opt('odpowiedzi', 'tylko jedna')], { permissions: ADMIN });
  assert.match(lastReply(s).embeds[0].description, /od 2 do 10 odpowiedzi/);
});

test('/afk: oznaczenie osoby AFK dostaje odpowiedź, jej wiadomość zdejmuje status', async () => {
  const s = await setup();
  await run(s.bot, 'afk', [opt('powod', 'obiad')], { invoker: 'target', roles: [], permissions: '0' });
  const mention = { id: snowflake(), guild_id: GUILD, channel_id: 'chan', author: { id: 'mod' }, mentions: [{ id: 'target' }], content: '<@target> jesteś?' };
  s.bot.cache.delete('afk');
  await onMessageAfk(s.bot, mention);
  const reply = s.discord.state.channels.get('chan').at(-1);
  assert.match(reply.content, /<@target> jest AFK: obiad/);
  assert.equal(reply.message_reference.message_id, mention.id);

  await s.store.query("update bot.afk set since = now() - interval '5 minutes'");
  s.bot.cache.delete('afk');
  await onMessageAfk(s.bot, { id: snowflake(), guild_id: GUILD, channel_id: 'chan', author: { id: 'target' }, mentions: [] });
  assert.match(s.discord.state.channels.get('chan').at(-1).content, /Witaj z powrotem, <@target>/);
  assert.deepEqual(await s.store.listAfk(), []);
});

test('/losuj, /powiedz jako odpowiedź, /propozycja z reakcjami i wątkiem', async () => {
  const s = await setup({ suggestions: { enabled: true, channelId: SUGGEST } });
  await run(s.bot, 'losuj', sub('kostka', [opt('scianki', 6, 4), opt('ile', 3, 4)]), { invoker: 'target', roles: [], permissions: '0' });
  assert.match(lastReply(s).embeds[0].description, /^\*\*[1-6]\*\* \+ \*\*[1-6]\*\* \+ \*\*[1-6]\*\* = \*\*\d+\*\*$/);

  await run(s.bot, 'powiedz', [opt('tresc', 'Hej\\nco tam'), opt('odpowiedz_na', 'https://discord.com/channels/g1/chan/123456789012345678')], { permissions: ADMIN });
  const said = s.discord.state.channels.get('chan').find((m) => m.content === 'Hej\nco tam');
  assert.equal(said.message_reference.message_id, '123456789012345678');
  assert.deepEqual(said.allowed_mentions.parse, [], 'bez @everyone i pingów ról');

  await run(s.bot, 'propozycja', [opt('tresc', 'Kanał z memami')], { invoker: 'target', roles: [], permissions: '0' });
  const [suggestion] = s.discord.state.channels.get(SUGGEST);
  assert.equal(suggestion.embeds[0].title, 'Propozycja #1');
  assert.deepEqual(s.discord.state.reactions.map((r) => r.emoji), ['👍', '👎']);
  assert.equal(s.discord.state.threads[0].name, 'Propozycja #1 - dyskusja');
});

test('/emoji dodaj: kradnie emoji z innego serwera (pobiera obrazek z CDN)', async () => {
  const s = await setup();
  s.bot.fetch = async (url) => {
    assert.equal(url, 'https://cdn.discordapp.com/emojis/123456789012345678.png');
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  };
  await run(s.bot, 'emoji', sub('dodaj', [opt('emoji', '<:pepe:123456789012345678>')]), { permissions: ADMIN });
  assert.equal(s.discord.state.emojis[0].name, 'pepe');
  assert.equal(s.discord.state.emojis[0].image, 'data:image/png;base64,iVBORw==');
  assert.match(lastReply(s).embeds[0].description, /Dodano emoji <:pepe:\d+>/);
});

test('wybór ról: własne emoji serwera i zwykłe emoji na przyciskach i liście; obce emoji odrzucone', async () => {
  const s = await setup();
  const gctx = await getGuildContext(s.bot);
  const base = { channelId: 'chan', content: 'Wybierz', roles: { mode: 'buttons', items: [{ roleId: 'r-fan', emoji: `<:hopka:${EMOJIS[0].id}>` }, { roleId: 'r-member', emoji: '🎮' }] } };
  // Role w atrapie mają krótkie ID - przepuszczamy je przez walidację ręcznie.
  const data = { ...cleanMessageData(base), roles: { ...cleanMessageData(base).roles, items: base.roles.items.map((i) => ({ ...i, label: '', description: '', style: 'niebieski' })) } };
  const buttons = buildMessagePayload(data, gctx).components[0].components;
  assert.deepEqual(buttons.map((b) => b.emoji), [{ id: EMOJIS[0].id, name: 'hopka', animated: false }, { name: '🎮' }]);

  const select = buildMessagePayload({ ...data, roles: { ...data.roles, mode: 'select' } }, gctx).components[0].components[0];
  assert.deepEqual(select.options[1].emoji, { name: '🎮' });

  const foreign = { ...data, roles: { ...data.roles, items: [{ ...data.roles.items[0], emoji: '<:obce:999999999999999999>' }] } };
  assert.throws(() => buildMessagePayload(foreign, gctx), /nie jest z tego serwera/);
  assert.equal(cleanMessageData({ roles: { mode: 'buttons', items: [{ roleId: '100000000000000001', emoji: 'zwykły tekst' }] } }).roles.items[0].emoji, '');
});
