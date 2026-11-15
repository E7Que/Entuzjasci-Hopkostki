import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, commandPayload, snowflake } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import {
  levelProgress,
  totalXpForLevel,
  xpToNext,
  weekKey,
  levelUpText,
  parseImport,
  onMessageLevels,
  onReactionLevels,
  voiceXpTick,
  highlightsTick,
  firstPlaceTick,
  onMemberLeaveLevels,
  importLevels,
  levelProfilesTick,
} from '../supabase/functions/hopkostki-bot/lib/levels.js';

const LVL5 = '100000000000000060';
const LVL10 = '100000000000000061';
const BOOST = '100000000000000062';
const NOXP = '100000000000000063';
const PING = '100000000000000064';
const FIRST = '100000000000000065';
const LEVELUP = '100000000000000066';
const RANKING = '100000000000000067';
const NOXP_CHANNEL = '100000000000000068';
const ARCANE = { curve: 'linear', multiplier: 1, maxLevel: 0 };

async function setup(levels = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({
    levels: {
      enabled: true,
      message: { min: 10, max: 10, cooldown: 60 },
      rewards: [{ level: 5, roleId: LVL5 }, { level: 10, roleId: LVL10 }],
      ...levels,
    },
  });
  return { store, discord, bot };
}

const message = (author, extra = {}) => ({
  id: snowflake(),
  guild_id: GUILD,
  channel_id: 'chan',
  author: { id: author, username: author },
  member: { roles: [] },
  content: 'hej',
  attachments: [],
  ...extra,
});

test('formuła jak w Arcane („Linear”): 100·poziom + 75 XP na kolejny poziom — progi zgodne z rankingiem Arcane', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map((l) => xpToNext(l, ARCANE)), [75, 175, 275, 375, 1075]);
  assert.deepEqual([1, 2, 3, 4, 24, 31].map((l) => totalXpForLevel(l, ARCANE)), [75, 250, 525, 900, 29400, 48825]);
  // Z rankingu Arcane: 49.7K → 31, 43.9K → 29, 30K → 24, 531 → 3, 482 → 2, 244 → 1, 83 → 1.
  for (const [xp, level] of [[49700, 31], [43900, 29], [30000, 24], [531, 3], [482, 2], [244, 1], [83, 1], [74, 0]]) {
    assert.equal(levelProgress(xp, ARCANE).level, level, `${xp} XP`);
  }
  assert.deepEqual(levelProgress(300, ARCANE), { level: 2, current: 50, needed: 275, maxed: false });
  assert.equal(levelProgress(10_000, { ...ARCANE, maxLevel: 5 }).level, 5, 'maksymalny poziom');
  assert.equal(xpToNext(0, { curve: 'standard', multiplier: 2 }), 200);
  assert.equal(weekKey(Date.parse('2026-11-15T12:00:00Z')), '2026-11-15', 'tydzień od niedzieli');
  assert.equal(weekKey(Date.parse('2026-11-21T23:59:00Z')), '2026-11-15');
});

test('tagi wiadomości o awansie jak w Arcane, z {earned:…} tylko przy zdobytej roli', () => {
  const user = { id: '42', username: 'kasia' };
  const template = '{user.mention} ({user.name}) ma poziom {user.level} i {user.xp} XP!{earned: Rola {name} — {mention}!}';
  assert.equal(levelUpText(template, { user, level: 5, xp: 1375, earned: [] }), '<@42> (kasia) ma poziom 5 i 1375 XP!');
  assert.equal(
    levelUpText(template, { user, level: 5, xp: 1375, earned: [{ roleId: LVL5 }], roleName: () => '| Level 5' }),
    `<@42> (kasia) ma poziom 5 i 1375 XP! Rola | Level 5 — <@&${LVL5}>!`,
  );
});

test('XP za wiadomości: cooldown, awans z wiadomością na kanale i rolą za poziom, ograniczenia i boostery', async () => {
  const s = await setup({
    levelUp: { enabled: true, target: 'current', message: '{user.mention} poziom {user.level}{earned: + {name}}', card: true },
    restrictions: { channelIds: [NOXP_CHANNEL], roleIds: [NOXP] },
    boosters: { stack: true, roles: [{ roleId: BOOST, percent: 100 }], effort: { enabled: true, words: 3, images: 0, percent: 50 } },
  });
  await onMessageLevels(s.bot, message('target'));
  await onMessageLevels(s.bot, message('target'));
  let row = await s.store.getLevel('target');
  assert.equal(row.xp, 10, 'drugi raz w ciągu minuty bez XP');
  assert.equal(row.messages, 1);

  // Kanał i rola bez XP.
  await s.store.query("update bot.levels set last_message_at = null");
  await onMessageLevels(s.bot, message('target', { channel_id: NOXP_CHANNEL }));
  await onMessageLevels(s.bot, message('target', { member: { roles: [NOXP] } }));
  assert.equal((await s.store.getLevel('target')).xp, 10);

  // Booster roli (+100%) i „wysiłku” (+50%, co najmniej 3 słowa) sumują się: 10 × 2,5 = 25.
  await onMessageLevels(s.bot, message('target', { member: { roles: [BOOST] }, content: 'to jest dłuższa wiadomość' }));
  row = await s.store.getLevel('target');
  assert.equal(row.xp, 35);
  assert.equal(row.weekKey, weekKey());
  assert.equal(row.weekXp, 35);

  // Awans na 5 → rola za poziom 5 i wiadomość na tym samym kanale z kartą poziomu.
  await s.store.query("update bot.levels set xp = 1370, last_message_at = null");
  await onMessageLevels(s.bot, message('target'));
  row = await s.store.getLevel('target');
  assert.equal(row.level, 5);
  assert.ok(s.discord.state.members.get('target').roles.includes(LVL5));
  const up = s.discord.state.channels.get('chan').at(-1);
  assert.match(up.content, /^<@target> poziom 5 \+ /);
  assert.deepEqual(up.allowed_mentions, { users: ['target'], roles: [] });
  assert.equal(up.embeds[0].title, 'Poziom 5 • #1 w rankingu');
});

test('wątki, fora, czat kanałów głosowych i komendy slash — według przełączników; tryb „tylko te kanały”', async () => {
  const [THREAD, THREAD_PARENT, FORUM_POST, FORUM, VOICE, OTHER, CHAN] = ['101', '102', '103', '104', '105', '106', '107'].map((n) => `100000000000000${n}`);
  const s = await setup({ restrictions: { threads: false, forums: true, voiceText: false, slashCommands: true, channelMode: 'allow', channelIds: [FORUM, THREAD_PARENT, CHAN] } });
  s.discord.state.channelInfo = {
    [THREAD]: { type: 11, parent_id: THREAD_PARENT },
    [FORUM_POST]: { type: 11, parent_id: FORUM },
    [FORUM]: { type: 15 },
    [VOICE]: { type: 2 },
    [OTHER]: { type: 0 },
  };
  await onMessageLevels(s.bot, message('a', { channel_id: THREAD }));
  await onMessageLevels(s.bot, message('b', { channel_id: FORUM_POST }));
  await onMessageLevels(s.bot, message('c', { channel_id: VOICE }));
  await onMessageLevels(s.bot, message('d', { channel_id: OTHER }));
  // Komenda slash innego bota: XP dla osoby, która jej użyła.
  await onMessageLevels(s.bot, message('innybot', { channel_id: CHAN, author: { id: 'innybot', bot: true }, interaction_metadata: { user: { id: 'target', username: 'hurownik_og' } } }));
  const ids = (await s.store.levelLeaderboard({ limit: 10 })).map((r) => r.userId).sort();
  assert.deepEqual(ids, ['b', 'target'], 'XP tylko na forum (dozwolone) i za komendę slash');
});

test('XP za reakcje (dający i autor) i za kanały głosowe (minimum osób, anty-AFK, cooldown)', async () => {
  const s = await setup({ reaction: { enabled: true, awards: 'both', min: 25, max: 25, cooldown: 300 }, voice: { enabled: true, min: 20, max: 20, cooldown: 180, minMembers: 2, antiAfk: true } });
  await onReactionLevels(s.bot, { guild_id: GUILD, channel_id: 'chan', user_id: 'mod', member: { user: { id: 'mod', username: 'mod' }, roles: [] }, message_author_id: 'target' });
  assert.equal((await s.store.getLevel('mod')).xp, 25);
  assert.equal((await s.store.getLevel('target')).xp, 25);
  assert.equal((await s.store.getLevel('target')).reactions, 1);

  await s.store.setVoiceState('owner', 'vc1', { muted: false });
  assert.equal(await voiceXpTick(s.bot), 0, 'sam na kanale — nic');
  await s.store.setVoiceState('mod', 'vc1', { muted: true });
  await s.store.setVoiceState('robot', 'vc1', { bot: true });
  assert.equal(await voiceXpTick(s.bot), 1, 'wyciszony liczy się do minimum, ale XP nie dostaje');
  assert.equal((await s.store.getLevel('owner')).xp, 20);
  assert.equal((await s.store.getLevel('owner')).voiceMinutes, 3);
  assert.equal(await voiceXpTick(s.bot), 0, 'cooldown 180 s');
  assert.equal(await s.store.getLevel('robot'), null);
});

test('rankingi tygodnia i miesiąca: najwięcej XP w okresie, ping roli; rola za 1. miejsce; auto reset po wyjściu', async () => {
  const s = await setup({
    highlights: { weekly: { enabled: true, channelId: RANKING }, monthly: { enabled: true, channelId: RANKING }, roleId: PING },
    firstPlaceRoleId: FIRST,
  });
  const lastWeek = weekKey(Date.now() - 7 * 24 * 60 * 60_000);
  const thisWeek = weekKey();
  await s.store.awardXp({ userId: 'a', userTag: 'a', amount: 500, kind: 'message', cooldownSec: 0, weekKey: lastWeek, monthKey: '2026-10' });
  await s.store.awardXp({ userId: 'b', userTag: 'b', amount: 900, kind: 'message', cooldownSec: 0, weekKey: lastWeek, monthKey: '2026-10' });
  await s.store.awardXp({ userId: 'c', userTag: 'c', amount: 5000, kind: 'message', cooldownSec: 0, weekKey: thisWeek, monthKey: '2026-11' });

  // Pierwszy przebieg tylko zapamiętuje okres — bez wysyłania starego rankingu.
  await highlightsTick(s.bot, { now: Date.parse(`${thisWeek}T01:00:00Z`) });
  assert.equal(s.discord.state.channels.get(RANKING), undefined);
  await s.store.setState('levels_highlight_week', 'stary');
  await s.store.setState('levels_highlight_month', 'stary');
  await highlightsTick(s.bot, { now: Date.parse(`${thisWeek}T01:00:00Z`) });
  const posts = s.discord.state.channels.get(RANKING);
  const week = posts.find((p) => p.embeds[0].title.includes('tygodnia'));
  assert.equal(week.content, `<@&${PING}>`);
  assert.deepEqual(week.allowed_mentions, { parse: [], roles: [PING] });
  assert.match(week.embeds[0].description, /🥇 <@b> — \*\*900 XP\*\*[\s\S]*🥈 <@a> — \*\*500 XP\*\*/);
  assert.ok(!week.embeds[0].description.includes('<@c>'), 'XP z bieżącego tygodnia nie liczy się do zakończonego');
  await highlightsTick(s.bot, { now: Date.parse(`${thisWeek}T02:00:00Z`) });
  assert.equal(s.discord.state.channels.get(RANKING).length, posts.length, 'każdy ranking tylko raz');

  s.discord.state.members.set('c', { user: { id: 'c', username: 'c' }, roles: [] });
  assert.equal(await firstPlaceTick(s.bot), 'c');
  assert.ok(s.discord.state.members.get('c').roles.includes(FIRST));

  await onMemberLeaveLevels(s.bot, { guild_id: GUILD, user: { id: 'c' } });
  const c = await s.store.getLevel('c');
  assert.deepEqual([c.xp, c.level, c.messages], [0, 0, 1], 'XP i poziom zerowane, statystyki zostają');
});

test('import z Arcane: linie z rankingu (12.6K), dopasowanie po nazwie (także przekręconej), poziom jak w Arcane', async () => {
  const s = await setup();
  s.discord.state.members.set('u1', { user: { id: 'u1', username: 'dfgbh65' }, roles: [] });
  s.discord.state.members.set('u2', { user: { id: 'u2', username: 'bapplealt2' }, roles: [] });
  s.discord.state.members.set('u3', { user: { id: 'u3', username: '.lirioz' }, roles: [] });
  const { entries, invalid } = parseImport('1. @dfgbh65 31 49.7K 4.3K 1\n72. @bappleait2 1 177 10\n@.lirioz 8 4.1K 563\nbzdura\n@nieznany 2 300');
  assert.equal(entries.length, 4);
  assert.deepEqual(invalid, ['bzdura']);
  assert.deepEqual(entries[0], { username: 'dfgbh65', level: 31, xp: 49700, messages: 4300, reactions: 1 });
  const result = await importLevels(s.bot, entries);
  assert.equal(result.imported, 3);
  assert.deepEqual(result.notFound, ['nieznany']);
  const u1 = await s.store.getLevel('u1');
  assert.deepEqual([u1.xp, u1.level, u1.messages], [49700, 31, 4300]);
  assert.equal((await s.store.getLevel('u2')).xp, 177, 'l/i w nazwie z odczytu zrzutu');
  assert.equal((await s.store.getLevel('u3')).level, 8);
});

test('/rank, /ranking, /xp (tylko Zarządzanie serwerem; blokada dla właściciela) i API panelu', async () => {
  const s = await setup();
  const ADMIN = String(1n << 3n);
  const run = async (name, options, extra) => {
    const result = await handleInteraction(commandPayload(name, options, extra), s.bot);
    await result.task?.();
    return s.discord.state.webhook.at(-1).body;
  };
  const sub = (name, options = []) => [{ name, type: 1, options }];
  let reply = await run('xp', sub('dodaj', [{ name: 'uzytkownik', type: 6, value: 'target' }, { name: 'ilosc', type: 4, value: 1500 }]), { permissions: ADMIN });
  assert.match(reply.embeds[0].description, /1\D?500 XP\*\*, poziom \*\*5\*\*/);
  assert.ok(s.discord.state.members.get('target').roles.includes(LVL5), 'nagroda także przy ręcznej zmianie');
  reply = await run('xp', sub('poziom', [{ name: 'uzytkownik', type: 6, value: 'target' }, { name: 'poziom', type: 4, value: 10 }]), { permissions: ADMIN });
  assert.match(reply.embeds[0].description, /poziom \*\*10\*\*/);

  reply = await run('rank', [{ name: 'uzytkownik', type: 6, value: 'target' }], { permissions: '0' });
  assert.equal(reply.embeds[0].title, 'Poziom 10 • #1 w rankingu');
  reply = await run('ranking', [], { permissions: '0' });
  assert.match(reply.embeds[0].description, /\*\*1\.\*\* <@target> — poziom \*\*10\*\*/);

  await s.store.updateConfig({ levels: { management: { lockReset: true } } });
  reply = await run('xp', sub('reset', [{ name: 'uzytkownik', type: 6, value: 'target' }]), { permissions: ADMIN });
  assert.match(reply.embeds[0].description, /tylko właściciel/);
  reply = await run('xp', sub('reset', [{ name: 'uzytkownik', type: 6, value: 'target' }]), { invoker: 'owner', permissions: ADMIN });
  assert.match(reply.embeds[0].description, /0 XP\*\*, poziom \*\*0\*\*/);

  const handle = createHandler(s.bot);
  const call = (path, init = {}) => handle(new Request(`https://x.supabase.co/functions/v1/hopkostki-bot/panel${path}`, { ...init, headers: { 'x-panel-password': 'tajne', 'content-type': 'application/json' } }));
  assert.equal((await call('/levels/user/target', { method: 'POST', body: JSON.stringify({ mode: 'set', amount: 525 }) })).status, 200);
  const list = await (await call('/levels')).json();
  assert.deepEqual([list.total, list.entries[0].level], [1, 3]);
  assert.equal((await call('/levels/test', { method: 'POST', body: JSON.stringify({ channelId: LEVELUP }) })).status, 200);
  assert.match(s.discord.state.channels.get(LEVELUP).at(-1).content, /Test wiadomości o awansie/);
  const pub = await (await handle(new Request('https://x.supabase.co/functions/v1/hopkostki-bot/panel/public/leaderboard'))).json();
  assert.deepEqual([pub.enabled, pub.entries[0].level, pub.entries[0].name], [true, 3, 'hurownik_og']);
  const role = await (await call('/roles', { method: 'POST', body: JSON.stringify({ name: '| Level Highlights', color: '#F1C40F' }) })).json();
  assert.equal(role.role.name, '| Level Highlights');
});

test('publiczny ranking: pseudonim + nazwa, tydzień/miesiąc, liczba osób, synchronizacja nazw i profil po kliknięciu', async () => {
  const s = await setup({ publicLeaderboard: true });
  const A = '100000000000000070';
  const B = '100000000000000071';
  s.discord.state.members.set(A, { user: { id: A, username: 'kasia_123', global_name: 'Kasia' }, nick: 'Kasia z serwera', roles: [], joined_at: '2025-01-02T10:00:00.000Z' });
  s.discord.state.members.set(B, { user: { id: B, username: 'bartek' }, roles: [] });
  await onMessageLevels(s.bot, message(A, { author: { id: A, username: 'kasia_123', global_name: 'Kasia' }, member: { roles: [], nick: 'Kasia z serwera' } }));
  await s.store.importLevel({ userId: B, userTag: 'bartek', xp: 900 });

  const handle = createHandler(s.bot);
  const get = async (path) => {
    const res = await handle(new Request(`https://x.supabase.co/functions/v1/hopkostki-bot/panel/public/${path}`));
    return { status: res.status, body: await res.json() };
  };
  let { body } = await get('leaderboard?limit=1');
  assert.deepEqual([body.total, body.entries.length, body.entries[0].name, body.entries[0].displayName], [2, 1, 'bartek', null]);
  ({ body } = await get('leaderboard?offset=1&limit=1'));
  assert.deepEqual([body.entries[0].rank, body.entries[0].name, body.entries[0].displayName], [2, 'kasia_123', 'Kasia z serwera']);
  ({ body } = await get('leaderboard?search=z%20serwera'));
  assert.deepEqual(body.entries.map((e) => e.name), ['kasia_123'], 'szukanie także po pseudonimie');
  ({ body } = await get('leaderboard?period=week'));
  assert.deepEqual([body.total, body.entries[0].name, body.entries[0].periodXp, body.entries[0].rank], [1, 'kasia_123', 10, 1], 'import nie liczy się do tygodnia');
  ({ body } = await get('leaderboard?period=month&search=kasia'));
  assert.deepEqual([body.total, body.entries[0].rank], [1, 1]);
  ({ body } = await get('leaderboard?period=week&search=bartek'));
  assert.deepEqual([body.total, body.entries.length], [0, 0]);
  assert.deepEqual(body.rewards, [], 'nagrody bez ról na serwerze są pomijane');
  assert.equal(body.totals.members, 2);

  s.discord.state.members.set(B, { user: { id: B, username: 'bartek', global_name: 'Bartuś', avatar: 'abc' }, roles: [] });
  assert.equal(await levelProfilesTick(s.bot), 1, 'tylko zmienione wiersze');
  assert.equal(await levelProfilesTick(s.bot), null, 'najwyżej co 30 minut');
  ({ body } = await get('leaderboard'));
  assert.deepEqual([body.entries[0].displayName, body.entries[0].avatar], ['Bartuś', `https://cdn.discordapp.com/avatars/${B}/abc.png?size=128`]);

  const profile = await get(`profile?id=${A}`);
  assert.equal(profile.status, 200);
  assert.deepEqual(
    [profile.body.displayName, profile.body.username, profile.body.joinedAt, profile.body.stats.messages, profile.body.stats.weekXp, profile.body.stats.weekRank, profile.body.stats.rank],
    ['Kasia z serwera', 'kasia_123', '2025-01-02T10:00:00.000Z', 1, 10, 1, 2],
  );
  assert.ok(profile.body.lastActive, 'ostatnia aktywność');
  assert.equal((await get('profile?id=100000000000000099')).status, 404, 'tylko osoby z rankingu');
  assert.equal((await get('profile?id=../../users/@me')).status, 404);
  await s.store.updateConfig({ levels: { publicLeaderboard: false } });
  assert.equal((await get(`profile?id=${A}`)).status, 404, 'wyłączony publiczny ranking = brak profili');
});
