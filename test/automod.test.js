import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, snowflake } from './support/discord.js';
import {
  onMessageAutomod,
  onMemberJoinAutomod,
  normalizeText,
  findBannedWord,
  capsStats,
  inviteCodes,
  resetSpamMemory,
} from '../supabase/functions/hopkostki-bot/lib/automod.js';
import { sanitizeConfig } from '../supabase/functions/hopkostki-bot/lib/configSchema.js';
import { DEFAULT_CONFIG } from '../supabase/functions/hopkostki-bot/lib/defaults.js';

const CHAN = '100000000000000300';
const LOG = '100000000000000301';
const FREE = '100000000000000302';
const T = Date.UTC(2026, 10, 16, 12, 0);

async function setup(automod = {}) {
  resetSpamMemory();
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ modLogChannelId: LOG, automod: { enabled: true, ...automod } });
  return { store, discord, bot };
}

let n = 0;
const msg = (content, extra = {}) => ({
  id: String(200000000000000000n + BigInt(++n)),
  guild_id: GUILD,
  channel_id: CHAN,
  author: { id: 'target', username: 'hurownik_og' },
  member: { roles: ['r-member'] },
  content,
  mentions: [],
  mention_roles: [],
  timestamp: new Date(T).toISOString(),
  ...extra,
});
const deletes = (s) => s.discord.state.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith(`/channels/${CHAN}/messages/`)).length;
const lastLog = (s) => s.discord.state.channels.get(LOG)?.at(-1);

test('tekst: normalizacja, zakazane słowa (polskie znaki, leet, rozstrzelone litery, prefiks), CAPS, kody zaproszeń', () => {
  assert.equal(normalizeText('ŻÓŁĆ k0rw@!'), 'zolc korwai');
  const list = ['debil', 'kurw*', 'głupi koń'];
  assert.equal(findBannedWord('ty DEBIL', list), 'debil');
  assert.equal(findBannedWord('d3b1l jesteś', list), 'debil');
  assert.equal(findBannedWord('kurwiszon', list), 'kurw*');
  assert.equal(findBannedWord('k u r w a mać', list), 'kurw*');
  assert.equal(findBannedWord('Głupi Koń biega', list), 'głupi koń');
  assert.equal(findBannedWord('debilizm to nie debil?', ['debilizmy']), null);
  assert.equal(findBannedWord('zwykła wiadomość', list), null);
  assert.deepEqual(capsStats('AAAA bbb <@123> https://X.COM'), { letters: 7, ratio: 4 / 7 });
  assert.deepEqual(inviteCodes('wbij discord.gg/abc-12 i https://discord.com/invite/XyZ'), ['abc-12', 'XyZ']);
});

test('zaproszenia: obce usuwane z krótką informacją i logiem; zaproszenie na nasz serwer przechodzi', async () => {
  const s = await setup();
  s.discord.state.publicInvites = { nasz: { code: 'nasz', guild: { id: GUILD } }, obcy: { code: 'obcy', guild: { id: '999' } } };
  assert.equal(await onMessageAutomod(s.bot, msg('zapraszam discord.gg/nasz')), null);
  const hit = await onMessageAutomod(s.bot, msg('reklama discord.gg/obcy'));
  assert.deepEqual([hit.filter, hit.action, hit.outcome], ['invites', 'delete', 'usunięto wiadomość']);
  assert.equal(deletes(s), 1);
  assert.match(s.discord.state.channels.get(CHAN).at(-1).content, /^<@target>, zaproszenia do innych serwerów/);
  assert.match(lastLog(s).embeds[0].description, /discord\.gg\/obcy/);
  const expired = await onMessageAutomod(s.bot, msg('discord.gg/wygaslo'));
  assert.equal(expired.filter, 'invites', 'nieznane zaproszenie też jest reklamą');
});

test('masowe oznaczenia → timeout (sprawa automatyczna), ostrzeżenie za słowo z punktami', async () => {
  const s = await setup({ mentions: { enabled: true, limit: 3, action: 'timeout' }, words: { enabled: true, list: ['spamik'], action: 'warn' }, warnPoints: 2 });
  const hit = await onMessageAutomod(s.bot, msg('<@a> <@b> <@c>', { mentions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  assert.equal(hit.outcome, 'timeout na 10 min');
  const timeout = s.discord.state.calls.find((c) => c.method === 'PATCH' && c.path === `/guilds/${GUILD}/members/target`);
  assert.ok(timeout.body.communication_disabled_until);
  const cases = await s.store.listCases({ limit: 10 });
  assert.deepEqual([cases.items[0].type, cases.items[0].auto, cases.items[0].moderatorTag], ['timeout', true, 'AutoMod']);
  assert.match(cases.items[0].reason, /AutoMod: masowe oznaczenia \(3 oznaczeń\)/);

  const warned = await onMessageAutomod(s.bot, msg('kup spamik'));
  assert.equal(warned.outcome, 'ostrzeżenie (2 pkt)');
  assert.equal((await s.store.warnSummary('target')).points, 2);
});

test('CAPS i spam (flood oraz powtarzanie) — po karze chwila przerwy', async () => {
  const s = await setup({ caps: { enabled: true, percent: 70, minLength: 10, action: 'delete' }, spam: { enabled: true, messages: 4, seconds: 5, duplicates: 3, action: 'delete' } });
  assert.equal((await onMessageAutomod(s.bot, msg('NIE KRZYCZ NA MNIE!!!'))).filter, 'caps');
  assert.equal(await onMessageAutomod(s.bot, msg('OK')), null, 'za krótkie na CAPS');

  resetSpamMemory();
  const at = (sec) => ({ timestamp: new Date(T + sec * 1000).toISOString() });
  assert.equal(await onMessageAutomod(s.bot, msg('a', at(0))), null);
  assert.equal(await onMessageAutomod(s.bot, msg('b', at(1))), null);
  assert.equal(await onMessageAutomod(s.bot, msg('c', at(2))), null);
  const flood = await onMessageAutomod(s.bot, msg('d', at(3)));
  assert.deepEqual([flood.filter, flood.outcome], ['spam', 'usunięto wiadomość']);
  const bulk = s.discord.state.calls.find((c) => c.path === `/channels/${CHAN}/messages/bulk-delete`);
  assert.equal(bulk.body.messages.length, 4, 'usunięta cała seria');
  assert.equal(await onMessageAutomod(s.bot, msg('e', at(4))), null, '30 s przerwy po karze');

  resetSpamMemory();
  for (const sec of [0, 20]) assert.equal(await onMessageAutomod(s.bot, msg('kup tanio', at(sec))), null);
  assert.match((await onMessageAutomod(s.bot, msg('KUP tanio', at(40)))).outcome, /usunięto/);
});

test('wyjątki: moderatorzy, właściciel, role i kanały z wyjątków; wyłączona automoderacja nic nie robi', async () => {
  const s = await setup({ exemptChannelIds: [FREE], exemptRoleIds: ['100000000000000304'] });
  const bad = 'discord.gg/obcy';
  assert.equal(await onMessageAutomod(s.bot, msg(bad, { member: { roles: ['r-mod'] } })), null, 'Moderator ma timeout = pominięty');
  assert.equal(await onMessageAutomod(s.bot, msg(bad, { member: { roles: ['100000000000000304'] } })), null);
  assert.equal(await onMessageAutomod(s.bot, msg(bad, { channel_id: FREE })), null);
  assert.equal(await onMessageAutomod(s.bot, msg(bad, { author: { id: 'owner', username: 'wlasciciel' } })), null);
  assert.equal(await onMessageAutomod(s.bot, msg(bad, { author: { id: 'x', bot: true } })), null);
  assert.ok(await onMessageAutomod(s.bot, msg(bad)));
  await s.store.updateConfig({ automod: { enabled: false } });
  assert.equal(await onMessageAutomod(s.bot, msg(bad)), null);
});

test('anty-rajd: X wejść w Y s → alert z pingiem roli alertów i wyrzucenie młodych kont z tej fali', async () => {
  const s = await setup({ raid: { enabled: true, joins: 3, seconds: 30, minutes: 10, action: 'kick', accountAgeDays: 7 } });
  await s.store.updateConfig({ alerts: { pingRoleId: '100000000000000303' } });
  const young = () => snowflake(T - 3600_000);
  const old = snowflake(T - 400 * 86_400_000);
  const join = (id, sec) => onMemberJoinAutomod(s.bot, { guild_id: GUILD, user: { id, username: `u${id.slice(-4)}` } }, { now: T + sec * 1000 });
  const ids = [young(), old, young()];
  assert.equal(await join(ids[0], 0), null);
  assert.equal(await join(ids[1], 5), null);
  const raid = await join(ids[2], 10);
  assert.deepEqual(raid, { started: true, active: true, kicked: 2 });
  const kicked = s.discord.state.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith(`/guilds/${GUILD}/members/`)).map((c) => c.path.split('/').at(-1));
  assert.deepEqual(kicked.sort(), [ids[0], ids[2]].sort(), 'stare konto zostaje');
  const alert = lastLog(s);
  assert.equal(alert.content, '<@&100000000000000303>');
  assert.match(alert.embeds[0].description, /3 osób.*nowe konta \(młodsze niż 7 dni\) są wyrzucane — teraz: 2/s);
  const later = await join(young(), 60);
  assert.deepEqual(later, { started: false, active: true, kicked: 1 }, 'w trybie anty-rajdu kolejne nowe konta też');
  assert.equal(await join(young(), 11 * 60), null, 'po 10 min tryb się kończy');
});

test('walidacja ustawień automoderacji z panelu', () => {
  const clean = sanitizeConfig(
    { automod: { timeoutMinutes: 999999, mentions: { limit: 1, action: 'ban' }, raid: { action: 'kick', joins: 1 }, words: { list: ['  Debil ', 'debil', 'x', 'ok słowo'] } } },
    DEFAULT_CONFIG,
  );
  assert.equal(clean.automod.timeoutMinutes, 40320);
  assert.deepEqual([clean.automod.mentions.limit, clean.automod.mentions.action], [2, 'timeout']);
  assert.deepEqual([clean.automod.raid.action, clean.automod.raid.joins], ['kick', 3]);
  assert.deepEqual(clean.automod.words.list, ['Debil', 'ok słowo']);
});
