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
  levelAccentTick,
  nitroLook,
  dayKey,
  textHash,
  xpEventsTick,
  activeXpEvent,
  xpEventsOverview,
  multiplierText,
  winnersArchiveTick,
  periodLabel,
  canManageXp,
  XP_EVENT_STYLE,
} from '../supabase/functions/hopkostki-bot/lib/levels.js';
import { XP_EVENT_THEMES, XP_EVENT_INTENSITY } from '../supabase/functions/hopkostki-bot/lib/configSchema.js';
import { P } from '../supabase/functions/hopkostki-bot/lib/permissions.js';

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
  const card = up.embeds[0];
  assert.equal(card.title, 'Awans na poziom 5!');
  assert.deepEqual(card.fields.slice(0, 3).map((f) => f.value), ['0 → **5**', '1380', '#1']);
  assert.equal(card.fields[3].value, `<@&${LVL5}>`, 'zdobyta rola w karcie');
  assert.equal(card.color, 0x2fc9a0, 'kolor progu, gdy rola za poziom nie ma koloru');
  assert.equal(card.author.name, 'target');

  // Awans z kanału głosowego: bot sam dociąga avatar i pseudonim z serwera (wcześniej był domyślny avatar).
  s.discord.state.members.set('target', { ...s.discord.state.members.get('target'), nick: 'Celownik', avatar: null, user: { id: 'target', username: 'hurownik_og', avatar: 'a_ruchomy' } });
  s.bot.cache.clear();
  const { levelUpEmbed } = await import('../supabase/functions/hopkostki-bot/lib/levels.js');
  const voiceCard = await levelUpEmbed(s.bot, (await s.store.getConfig()).levels, { user: { id: 'target' }, level: 5, previous: 4, xp: 1375 });
  assert.equal(voiceCard.author.name, 'Celownik');
  assert.equal(voiceCard.thumbnail.url, 'https://cdn.discordapp.com/avatars/target/a_ruchomy.gif?size=256');
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

test('ochrona przed nabijaniem: dzienny limit XP, powtórki i za krótkie wiadomości, ogłuszeni poza minimum osób', async () => {
  const s = await setup({
    message: { min: 40, max: 40, cooldown: 0 },
    antiFarm: { dailyCap: 100, ignoreRepeats: true, minChars: 3 },
    voice: { enabled: true, min: 20, max: 20, cooldown: 180, minMembers: 2, antiAfk: true },
  });
  await onMessageLevels(s.bot, message('target', { content: 'pierwsza wiadomość' }));
  await onMessageLevels(s.bot, message('target', { content: 'Pierwsza   wiadomośććć!!' }));
  let row = await s.store.getLevel('target');
  assert.equal(row.xp, 40, 'powtórka (wielkość liter, znaki, przeciągnięte litery) bez XP');
  assert.equal(row.messages, 1);
  await onMessageLevels(s.bot, message('target', { content: 'ok' }));
  assert.equal((await s.store.getLevel('target')).messages, 1, 'za krótka wiadomość pominięta');

  // Sam obrazek (bez tekstu) daje XP mimo minimum znaków; potem limit 100 XP na dobę: 40 + 40 + 20, dalej 0.
  await onMessageLevels(s.bot, message('target', { content: '', attachments: [{ id: '1', content_type: 'image/png' }] }));
  await onMessageLevels(s.bot, message('target', { content: 'druga' }));
  await onMessageLevels(s.bot, message('target', { content: 'trzecia' }));
  row = await s.store.getLevel('target');
  assert.equal(row.xp, 100, 'dzienny limit');
  assert.equal(row.messages, 4, 'statystyki rosną dalej');
  assert.equal(row.weekXp, 100);
  assert.deepEqual(await s.store.levelDaily('target', { since: dayKey() }), [{ day: dayKey(), xp: 100, messages: 4, voiceMinutes: 0, reactions: 0 }]);

  // Wczorajsze XP nie liczy się do dzisiejszego limitu.
  await s.store.query("update bot.level_daily set day = day - 1");
  await onMessageLevels(s.bot, message('target', { content: 'nowy dzień' }));
  assert.equal((await s.store.getLevel('target')).xp, 140);

  // Komenda slash innego bota: treść to odpowiedź bota — bez sprawdzania długości i powtórek.
  await s.store.updateConfig({ levels: { restrictions: { slashCommands: true } } });
  await onMessageLevels(s.bot, message('innybot', { author: { id: 'innybot', bot: true }, content: '', interaction_metadata: { user: { id: 'slash', username: 'slash' } } }));
  assert.equal((await s.store.getLevel('slash')).xp, 40);

  // Głosowe: ogłuszony nie liczy się do minimum 2 osób, wyciszony (słucha) — tak.
  await s.store.setVoiceState('a', 'vc1');
  await s.store.setVoiceState('b', 'vc1', { deafened: true });
  assert.equal(await voiceXpTick(s.bot), 0, 'ogłuszony nie liczy się do minimum');
  await s.store.setVoiceState('c', 'vc1', { muted: true });
  assert.equal(await voiceXpTick(s.bot), 1);
  assert.equal((await s.store.getLevel('a')).xp, 20);
});

test('wydarzenia XP: mnożnik, limit dzienny × mnożnik, ranking wydarzenia, ogłoszenia startu i końca, publiczne API', async () => {
  const now = Date.now();
  const EVENT_CH = '100000000000000069';
  const iso = (ms) => new Date(ms).toISOString();
  const event = { id: 'ev2x01', name: 'Podwójne XP', multiplier: 2, startsAt: iso(now - 60_000), endsAt: iso(now + 3_600_000), kinds: ['message'], theme: 'fire' };
  const s = await setup({
    publicLeaderboard: true,
    message: { min: 10, max: 10, cooldown: 0 },
    reaction: { enabled: true, awards: 'giver', min: 5, max: 5, cooldown: 0 },
    antiFarm: { dailyCap: 25, ignoreRepeats: false, minChars: 0 },
    events: [event, { id: 'bad', name: 'Złe ID', multiplier: 2, startsAt: iso(now), endsAt: iso(now + 1000), kinds: ['message'] }],
    eventsAnnounce: { enabled: true, channelId: EVENT_CH, roleId: PING },
  });
  assert.deepEqual((await s.store.getConfig()).levels.events.map((e) => e.id), ['ev2x01'], 'błędne wydarzenia odrzucone');

  // ×2 za wiadomości: 10 → 20 XP; limit 25 × 2 = 50 → 20 + 20 + 10. Reakcje (spoza wydarzenia): bez mnożnika.
  for (const content of ['a1', 'b2', 'c3']) await onMessageLevels(s.bot, message('target', { content }));
  assert.equal((await s.store.getLevel('target')).xp, 50);
  await onReactionLevels(s.bot, { guild_id: GUILD, channel_id: 'chan', user_id: 'mod', member: { user: { id: 'mod', username: 'mod' }, roles: [] }, message_author_id: 'target' });
  assert.equal((await s.store.getLevel('mod')).xp, 5);
  assert.deepEqual((await s.store.levelEventTop({ eventId: 'ev2x01' })).map((r) => [r.userId, r.periodXp, r.periodRank]), [['target', 50, 1]]);

  // Ogłoszenie startu (raz) z pingiem roli.
  assert.deepEqual(await xpEventsTick(s.bot, { now }), { started: 1, ended: 0 });
  assert.deepEqual(await xpEventsTick(s.bot, { now }), { started: 0, ended: 0 });
  let posts = s.discord.state.channels.get(EVENT_CH);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, `<@&${PING}>`);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [], roles: [PING] });
  assert.equal(posts[0].embeds[0].title, '🔥 Wydarzenie XP: Podwójne XP');
  assert.match(posts[0].embeds[0].description, /\*\*×2 XP\*\* za wiadomości!/);
  assert.match(posts[0].embeds[0].description, /Dzienny limit XP w tym czasie: \*\*50 XP\*\*/);
  assert.match(posts[0].embeds[0].description, /\/ranking#event/);

  // Publiczne API: wydarzenie trwa → ranking wydarzenia i profil z XP z wydarzenia.
  const handle = createHandler(s.bot);
  const get = async (path) => (await handle(new Request(`https://x.supabase.co/functions/v1/hopkostki-bot/panel/public/${path}`))).json();
  let body = await get('leaderboard?period=event');
  assert.equal(body.period, 'event');
  assert.equal(body.event.id, 'ev2x01');
  assert.deepEqual(body.entries.map((e) => [e.userId, e.periodXp, e.rank]), [['target', 50, 1]]);
  assert.equal(body.events.current.id, 'ev2x01');
  assert.equal(body.events.current.theme, 'fire');
  body = await get('leaderboard?period=event&event=nieznane');
  assert.equal(body.event.id, 'ev2x01', 'nieznane ID → trwające wydarzenie');

  // Koniec: podsumowanie z najlepszymi osobami, bez pingu.
  assert.deepEqual(await xpEventsTick(s.bot, { now: now + 2 * 3_600_000 }), { started: 0, ended: 1 });
  posts = s.discord.state.channels.get(EVENT_CH);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].embeds[0].title, '🏁 Koniec wydarzenia XP: Podwójne XP');
  assert.match(posts[1].embeds[0].description, /🥇 <@target> — \*\*50 XP\*\*/);
  assert.match(posts[1].embeds[0].description, /Łącznie \*\*1\*\* osoba zdobyła \*\*50 XP\*\*/);
  assert.deepEqual(posts[1].allowed_mentions, { parse: [] });

  // Wydarzenie dodane już po końcu: bez ogłoszeń. Bez wydarzeń w ustawieniach: brak rankingu wydarzenia, XP sprzątnięte.
  await s.store.updateConfig({ levels: { events: [event, { ...event, id: 'old0001', startsAt: iso(now - 7_200_000), endsAt: iso(now - 3_600_000) }] } });
  assert.deepEqual(await xpEventsTick(s.bot, { now: now + 2 * 3_600_000 }), { started: 0, ended: 0 });
  assert.equal(s.discord.state.channels.get(EVENT_CH).length, 2);
  await s.store.updateConfig({ levels: { events: [] } });
  await xpEventsTick(s.bot, { now: now + 2 * 3_600_000 });
  assert.deepEqual(await s.store.levelEventTop({ eventId: 'ev2x01' }), []);
  body = await get('leaderboard?period=event');
  assert.deepEqual([body.period, body.event, body.events], ['all', null, { current: null, next: null, last: null }]);
});

test('wydarzenia XP: wybór wydarzenia dla strony, nakładające się wydarzenia, tekst mnożnika', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const mk = (id, start, end, multiplier = 2, kinds = ['message', 'voice', 'reaction']) => ({ id, name: id, multiplier, startsAt: new Date(now + start * 3_600_000).toISOString(), endsAt: new Date(now + end * 3_600_000).toISOString(), kinds, theme: 'confetti' });
  const config = { events: [mk('teraz2', -1, 5), mk('teraz3', -2, 1, 3, ['voice']), mk('jutro', 24, 30), mk('wczoraj', -30, -20), mk('dawno', -200, -150), mk('zamiesiac', 24 * 30, 24 * 31)] };
  assert.equal(activeXpEvent(config, { now }).id, 'teraz3', 'największy mnożnik');
  assert.equal(activeXpEvent(config, { kind: 'message', now }).id, 'teraz2', 'tylko wydarzenia z danym rodzajem XP');
  assert.equal(activeXpEvent(config, { kind: 'message', now: now + 6 * 3_600_000 }), null);
  const overview = xpEventsOverview(config, now);
  assert.deepEqual([overview.current.id, overview.next.id, overview.last.id], ['teraz3', 'jutro', 'wczoraj']);
  assert.equal(xpEventsOverview(config, now + 10 * 3_600_000).current, null);
  assert.equal(multiplierText(1.5), '×1,5');
  assert.equal(multiplierText(2), '×2');
});

test('wydarzenia XP: własny mnożnik, efekt, intensywność, własny kolor i płomienie na dole (zapis, publiczne API, ogłoszenie)', async () => {
  const now = Date.now();
  const EVENT_CH = '100000000000000069';
  const iso = (ms) => new Date(ms).toISOString();
  const base = { name: 'Burza', startsAt: iso(now - 60_000), endsAt: iso(now + 3_600_000), kinds: ['message'] };
  const s = await setup({
    publicLeaderboard: true,
    message: { min: 10, max: 10, cooldown: 0 },
    events: [
      { ...base, id: 'evstorm1', multiplier: 1.257, theme: 'storm', intensity: 'high', accent: '#3B82F6', floor: false },
      { ...base, id: 'evlow001', multiplier: 1.05, theme: 'storm' },
      { ...base, id: 'evhigh01', multiplier: 10.5, theme: 'storm' },
      { ...base, id: 'evodd001', multiplier: 3, theme: 'disco', intensity: 'max', accent: 'red', startsAt: iso(now + 86_400_000), endsAt: iso(now + 90_000_000) },
    ],
    eventsAnnounce: { enabled: true, channelId: EVENT_CH },
  });
  // Mnożnik dowolny od ×1,1 do ×10 (2 miejsca po przecinku); nieznany efekt/intensywność/kolor → domyślne.
  assert.deepEqual((await s.store.getConfig()).levels.events.map((e) => [e.id, e.multiplier, e.theme, e.intensity, e.accent, e.floor]), [
    ['evstorm1', 1.26, 'storm', 'high', '#3b82f6', false],
    ['evodd001', 3, 'confetti', 'medium', null, true],
  ]);
  await onMessageLevels(s.bot, message('target', { content: 'hej' }));
  assert.equal((await s.store.getLevel('target')).xp, 13, '10 XP × 1,26 = 12,6 → 13');

  const handle = createHandler(s.bot);
  const body = await (await handle(new Request('https://x.supabase.co/functions/v1/hopkostki-bot/panel/public/leaderboard'))).json();
  assert.deepEqual(
    [body.events.current.theme, body.events.current.intensity, body.events.current.accent, body.events.current.multiplier, body.events.current.floor],
    ['storm', 'high', '#3b82f6', 1.26, false],
  );
  assert.deepEqual([body.events.next.theme, body.events.next.intensity, body.events.next.accent, body.events.next.floor], ['confetti', 'medium', null, true]);

  // Ogłoszenie: emoji efektu, kolor z własnego koloru wydarzenia, mnożnik z przecinkiem.
  await xpEventsTick(s.bot, { now });
  const post = s.discord.state.channels.get(EVENT_CH)[0].embeds[0];
  assert.equal(post.title, '⛈️ Wydarzenie XP: Burza');
  assert.equal(post.color, 0x3b82f6);
  assert.match(post.description, /\*\*×1,26 XP\*\* za wiadomości!/);
});

test('wydarzenia XP: ta sama lista efektów w bocie, panelu i na stronie rankingu', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../panel/public/app.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../panel/public/ranking.html', import.meta.url), 'utf8');
  const html = await readFile(new URL('../panel/public/index.html', import.meta.url), 'utf8');
  const panelThemes = [...panel.match(/const EV_THEMES = \{([\s\S]*?)\};/)[1].matchAll(/(\w+): '/g)].map((m) => m[1]);
  const pageThemes = JSON.parse(page.match(/const EV_THEMES = (\[[^\]]*\]);/)[1].replaceAll("'", '"'));
  const formThemes = [...html.match(/<select id="ev-theme">([\s\S]*?)<\/select>/)[1].matchAll(/value="(\w+)"/g)].map((m) => m[1]);
  const formLevels = [...html.match(/<select id="ev-intensity">([\s\S]*?)<\/select>/)[1].matchAll(/value="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(panelThemes, XP_EVENT_THEMES, 'panel (app.js)');
  assert.deepEqual(pageThemes, XP_EVENT_THEMES, 'strona rankingu');
  assert.deepEqual(formThemes, XP_EVENT_THEMES, 'formularz w panelu');
  assert.deepEqual(formLevels, XP_EVENT_INTENSITY, 'intensywność w formularzu');
  for (const theme of XP_EVENT_THEMES) assert.ok(XP_EVENT_STYLE[theme], `styl ogłoszenia: ${theme}`);
  const pageLevels = Object.keys(JSON.parse(page.match(/const FX_LEVEL = (\{[^}]*\});/)[1].replace(/(\w+):/g, '"$1":')));
  assert.deepEqual(pageLevels, XP_EVENT_INTENSITY, 'intensywność na stronie rankingu');
});

test('prywatność: /prywatnosc ukrywa osobę na stronie rankingu (anonimowe miejsce, bez wyszukiwania i profilu)', async () => {
  const s = await setup({ publicLeaderboard: true });
  const A = '100000000000000074';
  await s.store.importLevel({ userId: A, userTag: 'kasia', xp: 900 });
  const run = async (value) => {
    const out = await handleInteraction(commandPayload('prywatnosc', [{ type: 3, name: 'strona-rankingu', value }], { invoker: 'target', roles: ['r-member'], permissions: '0' }), s.bot);
    await out.task?.();
    return s.discord.state.webhook.at(-1).body.embeds[0].description;
  };
  assert.match(await run('ukryj'), /Ukryto Cię na \[stronie rankingu\]/);
  assert.equal((await s.store.getLevel('target')).hidden, true, 'ukrycie działa także przed zdobyciem XP');
  await s.store.importLevel({ userId: 'target', userTag: 'hurownik_og', xp: 500 });

  const handle = createHandler(s.bot);
  const get = async (path) => {
    const res = await handle(new Request(`https://x.supabase.co/functions/v1/hopkostki-bot/panel/public/${path}`));
    return { status: res.status, body: await res.json() };
  };
  let { body } = await get('leaderboard');
  assert.deepEqual(body.entries.map((e) => [e.rank, e.name, e.userId, e.hidden ?? false]), [
    [1, 'kasia', A, false],
    [2, 'Ukryta osoba', null, true],
  ]);
  assert.equal(body.entries[1].xp, 500, 'miejsce i XP zostają');
  assert.equal(body.entries[1].avatar, null);
  ({ body } = await get('leaderboard?search=hurownik'));
  assert.equal(body.total, 0, 'ukrytej osoby nie da się wyszukać');
  ({ body } = await get('leaderboard?search=target'));
  assert.equal(body.total, 0, 'ani po ID');
  // Panel (moderacja) widzi wszystkich, z oznaczeniem.
  const panelRows = await s.store.levelLeaderboard({ search: 'hurownik' });
  assert.deepEqual(panelRows.map((r) => [r.userId, r.hidden]), [['target', true]]);

  assert.match(await run('pokaz'), /Znów jesteś widoczny/);
  ({ body } = await get('leaderboard'));
  assert.equal(body.entries[1].name, 'hurownik_og');
});

test('archiwum zwycięzców: zapis przy końcu tygodnia i miesiąca, publiczne archiwum z wydarzeniami i ukrytymi', async () => {
  const now = Date.parse('2026-11-22T00:05:00Z'); // niedziela — zaczyna się tydzień 2026-11-22
  const s = await setup({
    publicLeaderboard: true,
    events: [{ id: 'evarch1', name: 'Halloween XP', multiplier: 2, startsAt: '2026-10-30T18:00:00Z', endsAt: '2026-11-01T22:00:00Z', kinds: ['message'], theme: 'fire' }],
  });
  const ids = ['100000000000000081', '100000000000000082', '100000000000000083', '100000000000000084'];
  for (const [i, id] of ids.entries()) {
    await s.store.query(
      `insert into bot.levels (user_id, user_tag, xp, week_key, week_xp, month_key, month_xp, hidden)
       values ($1::text, $2::text, 1000, '2026-11-15', $3::bigint, '2026-10', $4::bigint, $5::boolean)`,
      [id, `osoba${i}`, 400 - i * 100, 100 + i * 100, i === 1],
    );
  }
  await s.store.query(`insert into bot.level_event_xp (event_id, user_id, xp) values ('evarch1', $1::text, 300), ('evarch1', $2::text, 500)`, [ids[0], ids[2]]);

  // Pierwszy przebieg tylko zapamiętuje okresy.
  assert.deepEqual(await winnersArchiveTick(s.bot, { now }), {});
  assert.deepEqual(await winnersArchiveTick(s.bot, { now }), {});
  // Okresy, które minęły od ostatniego razu → top 10 do archiwum (raz).
  await s.store.setState('levels_archive_week', '2026-11-08');
  await s.store.setState('levels_archive_month', '2026-09');
  assert.deepEqual(await winnersArchiveTick(s.bot, { now }), { week: 4, month: 4 });
  assert.deepEqual(await winnersArchiveTick(s.bot, { now }), {});

  const handle = createHandler(s.bot);
  const res = await handle(new Request('https://x.supabase.co/functions/v1/hopkostki-bot/panel/public/archive'));
  const body = await res.json();
  assert.equal(body.weeks[0].key, '2026-11-15');
  assert.equal(body.weeks[0].label, '15 – 21 listopada');
  assert.deepEqual(body.weeks[0].winners.map((w) => [w.rank, w.name, w.xp, w.hidden ?? false]), [
    [1, 'osoba0', 400, false],
    [2, 'Ukryta osoba', 300, true],
    [3, 'osoba2', 200, false],
  ]);
  assert.equal(body.weeks[0].winners[1].userId, null, 'ukryta osoba bez ID');
  assert.equal(body.months[0].label, 'Październik 2026');
  assert.deepEqual(body.months[0].winners.map((w) => w.name), ['osoba3', 'osoba2', 'Ukryta osoba']);
  assert.deepEqual(body.events.map((e) => [e.name, e.winners.map((w) => [w.name, w.xp])]), [['Halloween XP', [['osoba2', 500], ['osoba0', 300]]]]);
  assert.equal(periodLabel('week', '2026-11-29'), '29 listopada – 5 grudnia');
});

test('skrót wiadomości do wykrywania powtórek', () => {
  assert.equal(textHash(''), null);
  assert.equal(textHash('   '), null);
  assert.equal(textHash('Siemaaa!!'), textHash('siema'));
  assert.equal(textHash('Zażółć gęślą'), textHash('zazolc gesla'));
  assert.notEqual(textHash('siema'), textHash('siemka'));
  assert.equal(textHash('😂😂'), textHash('😂😂'));
  assert.notEqual(textHash('😂'), textHash('🔥'));
  assert.match(textHash('hej'), /^[0-9a-f]{8}$/);
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
  assert.deepEqual(reply.embeds[0].fields.at(-1), { name: 'Odznaki', value: '⭐ **Poziom 10**' }, 'odznaki na karcie /rank');
  assert.match(reply.embeds[0].description, /\[Zobacz na stronie rankingu\]\(https:\/\/\S+\/ranking\?u=target\)$/, 'cudza karta: link bez „to ja”');
  reply = await run('rank', [], { invoker: 'target', permissions: '0' });
  assert.match(reply.embeds[0].description, /\/ranking\?u=target&me=1\)$/, 'własna karta: link zapamiętuje „ja”');
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

test('/xp: o dostępie decyduje lista ról komendy z panelu (nie samo „Zarządzanie serwerem”); blokady z Poziomów zostają', async () => {
  const s = await setup();
  const XP_ROLE = '100000000000000075';
  await s.store.updateConfig({ commandPermissions: { xp: [XP_ROLE] } });
  const run = async (options, extra) => {
    const result = await handleInteraction(commandPayload('xp', options, extra), s.bot);
    await result.task?.();
    return s.discord.state.webhook.at(-1).body;
  };
  const add = [{ name: 'dodaj', type: 1, options: [{ name: 'uzytkownik', type: 6, value: 'target' }, { name: 'ilosc', type: 4, value: 200 }] }];

  // Rola z listy /xp bez „Zarządzania serwerem” — wcześniej dostawała „tylko właściciel serwera”.
  let reply = await run(add, { roles: [XP_ROLE], permissions: '0' });
  assert.match(reply.embeds[0].description, /200 XP\*\*, poziom \*\*1\*\*/);
  assert.equal(await canManageXp(s.bot, { id: 'mod', roles: [XP_ROLE], permissions: '0' }), true);
  assert.equal(await canManageXp(s.bot, { id: 'mod', roles: [], permissions: String(P.MANAGE_GUILD) }), false, 'uprawnienie Discorda bez roli z listy nie wystarcza');

  // Blokady z zakładki Poziomy dalej zostawiają /xp i reset tylko właścicielowi serwera.
  await s.store.updateConfig({ levels: { management: { lockReset: true } } });
  assert.equal(await canManageXp(s.bot, { id: 'mod', roles: [XP_ROLE], permissions: '0' }), true);
  assert.equal(await canManageXp(s.bot, { id: 'mod', roles: [XP_ROLE], permissions: '0' }, { reset: true }), false);
  await s.store.updateConfig({ levels: { management: { lockXpCommand: true } } });
  reply = await run(add, { roles: [XP_ROLE], permissions: '0' });
  assert.match(reply.embeds[0].description, /tylko właściciel serwera/);
  assert.equal(await canManageXp(s.bot, { id: 'owner', roles: [], permissions: '0' }, { reset: true }), true, 'właściciel zawsze');
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
  ({ body } = await get('leaderboard?sort=messages'));
  assert.deepEqual([body.sort, body.entries.map((e) => [e.rank, e.name])], ['messages', [[1, 'kasia_123'], [2, 'bartek']]], 'kolejność według wiadomości');
  ({ body } = await get('leaderboard?period=week&sort=voice'));
  assert.equal(body.sort, 'xp', 'w rankingach okresowych tylko XP');
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
  assert.deepEqual(profile.body.history.map((d) => [d.day, d.xp, d.messages]), [[dayKey(), 10, 1]], 'dzienne XP do wykresu w profilu');
  assert.equal((await get('profile?id=100000000000000099')).status, 404, 'tylko osoby z rankingu');
  assert.equal((await get('profile?id=../../users/@me')).status, 404);

  // Nitro: animowany avatar / baner / profil na serwerze; kolor akcentu = kolor banera z API.
  s.discord.state.users.set(A, {
    id: A,
    username: 'kasia_123',
    global_name: 'Kasia',
    avatar: 'a_anim',
    accent_color: 0x3366ff,
    display_name_styles: { font_id: 3, effect_id: 1, colors: [0xff0000, 0x00ff00] },
    collectibles: { nameplate: { asset: 'nameplates/nameplates/twilight/', palette: 'violet', label: '' } },
    primary_guild: { identity_enabled: true, identity_guild_id: '123456789012345678', tag: 'HOPK', badge: 'abcdef0123' },
    avatar_decoration_data: { asset: 'a_1234abcd', sku_id: '1' },
  });
  s.discord.state.users.set(B, { id: B, username: 'bartek', avatar: 'abc', accent_color: 0x123456 });
  s.bot.cache.clear();
  assert.equal(await levelAccentTick(s.bot), 2);
  assert.equal(await levelAccentTick(s.bot), 0, 'najwyżej co 12 h');
  ({ body } = await get('leaderboard'));
  const byName = Object.fromEntries(body.entries.map((e) => [e.name, e]));
  assert.deepEqual([byName.kasia_123.nitro, byName.kasia_123.accent], [true, '#3366ff']);
  assert.equal(byName.kasia_123.avatarAnim, `https://cdn.discordapp.com/avatars/${A}/a_anim.gif?size=128`);
  assert.deepEqual(byName.kasia_123.look, {
    font: 3,
    effect: 1,
    colors: ['#ff0000', '#00ff00'],
    decoration: 'https://cdn.discordapp.com/avatar-decoration-presets/a_1234abcd.png?size=96&passthrough=false',
    nameplate: { image: 'https://cdn.discordapp.com/assets/collectibles/nameplates/nameplates/twilight/static.png', palette: 'violet' },
    tag: { text: 'HOPK', badge: 'https://cdn.discordapp.com/guild-tag-badges/123456789012345678/abcdef0123.png?size=32' },
  });
  assert.equal(byName.bartek.look, null, 'bez personalizacji = brak');
  assert.deepEqual([byName.bartek.nitro, byName.bartek.accent], [false, null], 'bez Nitro kolor akcentu się nie liczy');
  const nitroProfile = (await get(`profile?id=${A}`)).body;
  assert.deepEqual([nitroProfile.nitro, nitroProfile.accentColor, nitroProfile.nameColors], [true, '#3366ff', ['#ff0000', '#00ff00']]);
  assert.match(nitroProfile.avatar, /a_anim\.gif/);
  assert.match(nitroProfile.look.decoration, /passthrough=true/, 'w profilu animowana dekoracja');
  assert.equal(nitroLook({ collectibles: { nameplate: { asset: '../../evil' } } }).look, null, 'tylko bezpieczne ścieżki do obrazków');
  assert.equal(nitroLook({ avatar: 'x' }, { banner: 'serwerowy' }).nitro, true, 'baner tylko na serwerze = Nitro');
  assert.equal(nitroLook({ avatar: 'x', accent_color: 5 }).nitro, false);
  assert.equal(nitroLook({ banner: 'obrazek', accent_color: 0xfba404 }).accentColor, null, 'przy obrazku banera stary kolor banera się nie liczy');
  assert.equal(nitroLook({ avatar: 'x' }, { banner: 'serwerowy' }).accentColor, null);

  await s.store.updateConfig({ levels: { publicLeaderboard: false } });
  assert.equal((await get(`profile?id=${A}`)).status, 404, 'wyłączony publiczny ranking = brak profili');
});
