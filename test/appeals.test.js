import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { handlePanel } from '../supabase/functions/hopkostki-bot/lib/panel.js';
import * as moderation from '../supabase/functions/hopkostki-bot/lib/moderation.js';

const APPEALS_CH = '100000000000000080';
const PING = '100000000000000081';
const MODLOG = '100000000000000082';
const target = { id: 'target', username: 'hurownik_og' };
const mod = { id: 'mod', username: 'dfgbh65' };
const BAN_PERMS = String((1n << 2n) | (1n << 40n));

async function setup(appeals = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ modLogChannelId: MODLOG, appeals: { enabled: true, channelId: APPEALS_CH, pingRoleId: PING, days: 14, ...appeals } });
  return { store, discord, bot };
}

const modal = (customId, fields) => ({ custom_id: customId, components: [{ type: 1, components: Object.entries(fields).map(([id, value]) => ({ type: 4, custom_id: id, value })) }] });
// Kliknięcie / formularz w wiadomości prywatnej - bez serwera, osoba w `user`.
function fromDm(customId, { user = 'target', fields = null, messageId = '1' } = {}) {
  return {
    type: fields ? 5 : 3,
    id: 'i',
    application_id: 'app',
    token: `tok-dm-${customId.replace(/\|/g, "-")}`,
    channel_id: `dm-${user}`,
    user: { id: user, username: user },
    message: { id: messageId },
    data: fields ? modal(customId, fields) : { custom_id: customId, component_type: 2 },
  };
}
// Kliknięcie / formularz na kanale odwołań (moderacja).
function fromGuild(customId, { user = 'mod', roles = ['r-mod'], permissions = BAN_PERMS, fields = null } = {}) {
  return {
    type: fields ? 5 : 3,
    id: 'i',
    application_id: 'app',
    token: `tok-g-${customId.replace(/\|/g, "-")}`,
    guild_id: GUILD,
    channel_id: APPEALS_CH,
    member: { user: { id: user, username: user }, roles, permissions },
    data: fields ? modal(customId, fields) : { custom_id: customId, component_type: 2 },
  };
}
async function run(bot, body) {
  const out = await handleInteraction(body, bot);
  await out.task?.();
  return out.response;
}
const errorText = (response) => response.data?.embeds?.[0]?.description ?? '';

test('odwołanie od ostrzeżenia: przycisk w DM → formularz → kanał moderacji → przyjęcie usuwa ostrzeżenie', async () => {
  const s = await setup();
  const { entry } = await moderation.warnUser(s.bot, { target, moderator: mod, reason: 'Spam na czacie', points: 2 });
  const dm = s.discord.state.dms.at(-1);
  assert.deepEqual(dm.components[0].components[0].custom_id, `apl|open|${entry.id}`);
  assert.match(dm.embeds[0].fields.find((f) => f.name === '💬 Odwołania').value, /Odwołaj się/);

  // Przycisk otwiera formularz - tylko dla ukaranej osoby.
  let res = await run(s.bot, fromDm(`apl|open|${entry.id}`, { messageId: dm.id }));
  assert.equal(res.type, 9);
  assert.equal(res.data.custom_id, `aplm|send|${entry.id}`);
  res = await run(s.bot, fromDm(`apl|open|${entry.id}`, { user: 'owner' }));
  assert.match(errorText(res), /Nie znaleziono tej sprawy/);
  res = await run(s.bot, fromDm(`aplm|send|${entry.id}`, { fields: { text: 'za krótko' } }));
  assert.match(errorText(res), /co najmniej 20 znaków/);

  // Wysłany formularz: odwołanie z pingiem roli i przyciskami, przycisk w DM wyłączony.
  res = await run(s.bot, fromDm(`aplm|send|${entry.id}`, { messageId: dm.id, fields: { text: 'To był żart z kolegą, nie spam - przepraszam za zamieszanie.' } }));
  assert.equal(res.type, 5);
  const posted = s.discord.state.channels.get(APPEALS_CH).at(-1);
  assert.equal(posted.content, `<@&${PING}>`);
  assert.equal(posted.embeds[0].title, `📨 Odwołanie od kary #${entry.id}`);
  assert.match(posted.embeds[0].fields.find((f) => f.name === '💬 Odwołanie').value, /żart z kolegą/);
  assert.deepEqual(posted.components[0].components.map((b) => b.custom_id), ['apl|ok|1', 'apl|no|1']);
  const disabled = s.discord.state.editedMessages.find((m) => m.channel === 'dm-target');
  assert.equal(disabled.body.components[0].components[0].disabled, true);
  assert.match(JSON.stringify(s.discord.state.webhook.at(-1).body), /Wysłano odwołanie/);
  res = await run(s.bot, fromDm(`apl|open|${entry.id}`));
  assert.match(errorText(res), /już czeka na decyzję/);

  // Decyzja: osoba ukarana i ktoś bez uprawnień - nie; właściciel serwera zawsze; moderator - okienko, potem przyjęcie.
  res = await run(s.bot, fromGuild('apl|ok|1', { user: 'target', roles: [], permissions: '0' }));
  assert.match(errorText(res), /własnego odwołania/);
  res = await run(s.bot, fromGuild('apl|ok|1', { user: 'czlonek', roles: [], permissions: '0' }));
  assert.match(errorText(res), /Nie masz uprawnień/);
  res = await run(s.bot, fromGuild('apl|ok|1', { user: 'owner', roles: [], permissions: '0' }));
  assert.equal(res.type, 9, 'właściciel serwera (po ID, nie po uprawnieniach) może rozpatrzyć odwołanie');
  res = await run(s.bot, fromGuild('apl|ok|1'));
  assert.equal(res.type, 9);
  assert.equal(res.data.custom_id, 'apld|ok|1');
  assert.equal((await s.store.getWarns('target')).length, 1);
  res = await run(s.bot, fromGuild('apld|ok|1', { fields: { note: 'Ok, tym razem bez kary.' } }));
  assert.equal(res.type, 5);
  assert.equal((await s.store.getWarns('target')).length, 0, 'ostrzeżenie usunięte');
  const appeal = await s.store.getAppeal(1);
  assert.deepEqual([appeal.status, appeal.decidedBy, appeal.decisionNote, appeal.undoResult], ['accepted', 'mod', 'Ok, tym razem bez kary.', 'ostrzeżenie usunięte']);
  assert.match((await s.store.getCase(entry.id)).note, /Cofnięte po odwołaniu/);
  const edited = s.discord.state.editedMessages.find((m) => m.channel === APPEALS_CH);
  assert.equal(edited.body.components.length, 0, 'bez przycisków po decyzji');
  assert.ok(edited.body.embeds[0].fields.some((f) => f.name === '✅ Przyjęte'));
  const answer = s.discord.state.dms.at(-1);
  assert.equal(answer.embeds[0].title, '✅ Odwołanie przyjęte');
  assert.match(answer.embeds[0].description, /Ok, tym razem bez kary/);
  assert.match(JSON.stringify(s.discord.state.channels.get(MODLOG).at(-1)), /Odwołanie od kary #1 przyjęte/);
  res = await run(s.bot, fromGuild('apld|no|1', { fields: { note: '' } }));
  assert.match(errorText(res), /już rozpatrzone/);

  // Panel: lista odwołań i status w sprawach.
  const list = await handlePanel(s.bot, { method: 'GET', path: '/appeals' });
  assert.deepEqual([list.status, list.body.total, list.body.items[0].status, list.body.items[0].caseType], [200, 1, 'accepted', 'warn']);
  const cases = await handlePanel(s.bot, { method: 'GET', path: '/cases' });
  assert.equal(cases.body.items.find((c) => c.id === entry.id).appealStatus, 'accepted');
});

test('odwołanie od bana: odrzucenie zostawia bana, przyjęcie zdejmuje bana; termin i wyłączone odwołania', async () => {
  const s = await setup();
  const { entry } = await moderation.banUser(s.bot, { target, moderator: mod, reason: 'Obrażanie' });
  assert.ok(s.discord.state.bans.has('target'));
  const text = { text: 'Proszę o drugą szansę, to się więcej nie powtórzy.' };
  await run(s.bot, fromDm(`aplm|send|${entry.id}`, { fields: text }));
  // Odrzucenie: ban zostaje, osoba dostaje odpowiedź.
  await run(s.bot, fromGuild('apld|no|1', { fields: { note: 'Za poważne naruszenie.' } }));
  assert.ok(s.discord.state.bans.has('target'));
  assert.equal(s.discord.state.dms.at(-1).embeds[0].title, '❌ Odwołanie odrzucone');
  assert.equal((await s.store.getAppeal(1)).status, 'rejected');

  // Drugi ban → przyjęte odwołanie zdejmuje bana (z nową sprawą „unban”).
  const second = await moderation.banUser(s.bot, { target, moderator: mod, reason: 'Spam' });
  await run(s.bot, fromDm(`aplm|send|${second.entry.id}`, { fields: text }));
  const { items } = await s.store.listAppeals({ status: 'pending' });
  assert.equal(items.length, 1);
  await run(s.bot, fromGuild(`apld|ok|${items[0].id}`, { fields: { note: '' } }));
  assert.equal(s.discord.state.bans.has('target'), false, 'ban zdjęty');
  assert.equal((await s.store.getAppeal(items[0].id)).undoResult, 'ban zdjęty');
  assert.equal((await s.store.listCases({ type: 'unban' })).total, 1);
  // Bez uprawnień do banowania (ani roli moderatora) nie da się rozpatrzyć odwołania od bana.
  const third = await moderation.banUser(s.bot, { target, moderator: mod, reason: 'Znowu' });
  await run(s.bot, fromDm(`aplm|send|${third.entry.id}`, { fields: text }));
  const pending = (await s.store.listAppeals({ status: 'pending' })).items[0];
  const res = await run(s.bot, fromGuild(`apl|ok|${pending.id}`, { user: 'czlonek', roles: [], permissions: String(1n << 40n) }));
  assert.match(errorText(res), /Nie masz uprawnień/);

  // Po terminie: odwołanie niemożliwe.
  await s.store.query(`update bot.cases set created_at = now() - interval '20 days' where id = $1::int`, [entry.id]);
  await s.store.query('delete from bot.appeals where case_id = $1::int', [entry.id]);
  assert.match(errorText(await run(s.bot, fromDm(`apl|open|${entry.id}`))), /Czas na odwołanie minął/);

  // Wyłączone odwołania: DM bez przycisku, przycisk ze starego DM - komunikat.
  await s.store.updateConfig({ appeals: { enabled: false } });
  await moderation.timeoutUser(s.bot, { target, moderator: mod, reason: 'Spam', duration: { amount: 1, unit: 'h' } });
  assert.deepEqual(s.discord.state.dms.at(-1).components, []);
  assert.match(errorText(await run(s.bot, fromDm(`apl|open|${third.entry.id}`))), /wyłączone/);
});
