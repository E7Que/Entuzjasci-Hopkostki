import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, commandPayload, snowflake } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { handlePanel } from '../supabase/functions/hopkostki-bot/lib/panel.js';
import { onMessageLevels } from '../supabase/functions/hopkostki-bot/lib/levels.js';
import { membersFeaturesOn, onMemberJoin, onMemberLeave } from '../supabase/functions/hopkostki-bot/lib/members.js';
import { ensureInviteSnapshot } from '../supabase/functions/hopkostki-bot/lib/invites.js';
import { contestScore, contestStatus, messageContestIds } from '../supabase/functions/hopkostki-bot/lib/contests.js';

const BASE = 'https://x.supabase.co/functions/v1/hopkostki-bot/panel';
const DAY = 86_400_000;
const LOG = '100000000000000300';
const PING = '100000000000000301';
const iso = (ms) => new Date(ms).toISOString();
// ID konta założonego `days` dni temu (ID Discorda zawiera czas założenia konta).
const account = (days) => snowflake(Date.now() - days * DAY);
const message = (author, content = 'hej') => ({ id: snowflake(), guild_id: GUILD, channel_id: 'chan', author: { id: author, username: author }, member: { roles: [] }, content, attachments: [] });

async function setup(list = [], extra = {}) {
  const { db, store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({
    levels: { enabled: true, message: { min: 10, max: 10, cooldown: 60 } },
    contests: { logChannelId: LOG, pingRoleId: PING, list },
    ...extra,
  });
  const handle = createHandler(bot);
  const call = async (path, { method = 'GET', session, body } = {}) => {
    const res = await handle(
      new Request(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: 'https://e7que.github.io', ...(session ? { 'x-member-session': session } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return { db, store, discord, bot, call };
}

// /polacz → link z jednorazowym tokenem → strona wymienia go na sesję.
async function connect(s, user = 'target') {
  const out = await handleInteraction(commandPayload('polacz', [], { invoker: user, roles: [], permissions: '0' }), s.bot);
  await out.task?.();
  const reply = s.discord.state.webhook.at(-1).body;
  const url = reply.components[0].components[0].url;
  const token = /#polacz=([\w-]+)$/.exec(url)?.[1];
  const res = await s.call('/public/link', { method: 'POST', body: { token } });
  return { out, reply, url, token, res, session: res.body.token };
}

test('event zaproszeń: /polacz łączy konto, liczą się tylko prawdziwe zaproszenia, pasek postępu i zgłoszenie po progu', async () => {
  const now = Date.now();
  const s = await setup([
    { id: 'zapr0001', name: 'Zaproś znajomych', type: 'invites', startsAt: iso(now - DAY), endsAt: iso(now + 6 * DAY), goal: 2, minAccountDays: 7, prize: 'Nitro' },
  ]);
  const [ok1, ok2, young, leaver, back] = [account(400), account(30), account(2), account(100), account(300)];
  // „back” był już na serwerze przed eventem (powrót się nie liczy).
  await s.db.query(`insert into bot.invite_joins (user_id, inviter_id, code, joined_at) values ($1, 'mod', 'stare', now() - interval '20 days')`, [back]);
  for (const id of [ok1, ok2, young, leaver, back]) await s.store.addInviteJoin({ userId: id, inviterId: 'target', code: 'abc' });
  await s.store.markInviteLeft(leaver);

  const anon = await s.call('/public/contests');
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('access-control-allow-origin'), 'https://e7que.github.io');
  assert.deepEqual([anon.body.contests.length, anon.body.contests[0].status, anon.body.me, anon.body.contests[0].me], [1, 'live', null, null]);
  assert.deepEqual([anon.body.contests[0].goal, anon.body.contests[0].minAccountDays, anon.body.contests[0].prize], [2, 7, 'Nitro']);

  const link = await connect(s);
  assert.equal(link.out.response.data.flags, 64, 'link widzi tylko ta osoba');
  assert.match(link.url, /^https:\/\/e7que\.github\.io\/Entuzjasci-Hopkostki\/ranking\.html#polacz=[\w-]{40,}$/);
  assert.match(link.reply.embeds[0].description, /Zaproś znajomych\*\* — zaproszenia, koniec <t:\d+:R>/);
  assert.equal(link.res.status, 200);
  assert.deepEqual([link.res.body.me.id, link.res.body.me.name], ['target', 'hurownik_og']);
  assert.equal((await s.call('/public/link', { method: 'POST', body: { token: link.token } })).status, 401, 'link działa tylko raz');

  const mine = (await s.call('/public/contests', { session: link.session })).body;
  assert.equal(mine.me.id, 'target');
  const me = mine.contests[0].me;
  assert.deepEqual([me.joined, me.invites, me.score, me.reached, me.canJoin, me.blocker], [false, 2, 2, true, true, null], 'liczą się 2 z 5 (młode konto, wyjście i powrót nie)');

  const joined = await s.call('/public/contests/zapr0001/join', { method: 'POST', session: link.session });
  assert.deepEqual([joined.status, joined.body], [200, { joined: true, already: false }]);
  const log = s.discord.state.channels.get(LOG).at(-1);
  assert.equal(log.content, `<@&${PING}>`);
  assert.deepEqual(log.allowed_mentions, { roles: [PING] });
  assert.match(log.embeds[0].title, /Nowe zgłoszenie — Zaproś znajomych/);
  assert.match(log.embeds[0].description, /<@target> osiągnął.*\n\*\*Wynik:\*\* 2 zaproszenia · próg: 2 zaproszenia\n\*\*Nagroda:\*\* Nitro/);
  assert.equal((await s.call('/public/contests/zapr0001/join', { method: 'POST', session: link.session })).body.already, true);
  assert.equal(s.discord.state.channels.get(LOG).length, 1, 'jedno zgłoszenie = jedno powiadomienie');

  const after = (await s.call('/public/contests', { session: link.session })).body.contests[0];
  assert.deepEqual([after.participants, after.me.joined, after.me.rank], [1, true, 1]);
  assert.deepEqual([after.entries[0].userId, after.entries[0].score, after.entries[0].reached, after.entries[0].me], ['target', 2, true, true]);

  // Ktoś bez zaproszeń nie zgłosi się przed progiem.
  const other = await connect(s, 'mod');
  const blocked = await s.call('/public/contests/zapr0001/join', { method: 'POST', session: other.session });
  assert.deepEqual([blocked.status, blocked.body.error], [400, 'Do zgłoszenia brakuje Ci jeszcze 2 zaproszeń.']);
  const view = (await s.call('/public/contests', { session: other.session })).body.contests[0];
  assert.deepEqual([view.me.canJoin, view.me.score, view.entries[0].me], [false, 0, false]);

  // Nieważna sesja: lista działa (expired), akcje → 401. Rozłączenie kończy sesję.
  const bad = await s.call('/public/contests', { session: 'x'.repeat(43) });
  assert.deepEqual([bad.status, bad.body.expired, bad.body.me], [200, true, null]);
  assert.equal((await s.call('/public/contests/zapr0001/join', { method: 'POST', session: 'x'.repeat(43) })).status, 401);
  assert.equal((await s.call('/public/contests/zapr0001/join', { method: 'POST' })).status, 401);
  assert.equal((await s.call('/public/unlink', { method: 'POST', session: link.session })).body.removed, 1);
  assert.equal((await s.call('/public/contests', { session: link.session })).body.expired, true);
});

test('eventy wiadomości i mieszane: liczą się wiadomości dające XP (cooldown) tylko w trakcie; punkty w mieszanym', async () => {
  const now = Date.now();
  const s = await setup([
    { id: 'wiad0001', name: 'Pisanie', type: 'messages', startsAt: iso(now - 60_000), endsAt: iso(now + DAY), winners: 3 },
    { id: 'mix00001', name: 'Mieszany', type: 'mixed', startsAt: iso(now - 60_000), endsAt: iso(now + DAY), points: { invite: 10, message: 2 } },
    { id: 'stary001', name: 'Stary', type: 'messages', startsAt: iso(now - 10 * DAY), endsAt: iso(now - 5 * DAY) },
    { id: 'zapr0002', name: 'Zaproszenia', type: 'invites', startsAt: iso(now - 60_000), endsAt: iso(now + DAY) },
    { id: 'pozn0001', name: 'Później', type: 'messages', startsAt: iso(now + DAY), endsAt: iso(now + 2 * DAY) },
  ]);
  assert.deepEqual(messageContestIds(await s.store.getConfig()), ['wiad0001', 'mix00001']);
  await onMessageLevels(s.bot, message('target'));
  await onMessageLevels(s.bot, message('target'));
  await onMessageLevels(s.bot, message('mod'));
  assert.deepEqual(Object.fromEntries(await s.store.contestMessages('wiad0001')), { target: 1, mod: 1 }, 'druga wiadomość w cooldownie się nie liczy');
  assert.deepEqual(Object.fromEntries(await s.store.contestMessages('mix00001')), { target: 1, mod: 1 });
  for (const id of ['stary001', 'zapr0002', 'pozn0001']) assert.equal((await s.store.contestMessages(id)).size, 0, id);
  await s.store.addInviteJoin({ userId: account(50), inviterId: 'target', code: 'abc' });

  const link = await connect(s);
  const body = (await s.call('/public/contests', { session: link.session })).body;
  assert.deepEqual(body.contests.map((c) => [c.id, c.status]), [['wiad0001', 'live'], ['mix00001', 'live'], ['zapr0002', 'live'], ['pozn0001', 'upcoming']], 'zakończony ponad 3 dni temu znika');
  const mixed = body.contests.find((c) => c.id === 'mix00001');
  assert.deepEqual([mixed.me.invites, mixed.me.messages, mixed.me.score, mixed.points], [1, 1, 12, { invite: 10, message: 2 }]);
  assert.equal(contestScore({ type: 'mixed', points: { invite: 10, message: 2 } }, { invites: 1, messages: 1 }), 12);

  // Bez progu: dołączyć można od razu, także przed startem; ranking uczestników według wyniku.
  assert.equal((await s.call('/public/contests/pozn0001/join', { method: 'POST', session: link.session })).status, 200);
  assert.equal((await s.call('/public/contests/wiad0001/join', { method: 'POST', session: link.session })).status, 200);
  const other = await connect(s, 'mod');
  await s.call('/public/contests/wiad0001/join', { method: 'POST', session: other.session });
  await s.store.updateConfig({ levels: { message: { cooldown: 0 } } });
  await onMessageLevels(s.bot, message('mod', 'druga, inna wiadomość'));
  const writing = (await s.call('/public/contests')).body.contests.find((c) => c.id === 'wiad0001');
  assert.deepEqual(writing.entries.map((e) => [e.rank, e.userId, e.score]), [[1, 'mod', 2], [2, 'target', 1]]);
  assert.equal(s.discord.state.channels.get(LOG), undefined, 'dołączenie bez progu nie wysyła zgłoszenia');

  // Osoba ukryta komendą /prywatnosc: dla innych „Ukryta osoba”, dla siebie — normalnie.
  await s.store.setLevelHidden('mod', true);
  const seen = (await s.call('/public/contests', { session: link.session })).body.contests.find((c) => c.id === 'wiad0001').entries[0];
  assert.deepEqual([seen.hidden, seen.userId, seen.name, seen.avatar], [true, null, 'Ukryta osoba', null]);
  const self = (await s.call('/public/contests', { session: other.session })).body.contests.find((c) => c.id === 'wiad0001').entries[0];
  assert.deepEqual([self.userId, self.me, self.hidden], ['mod', true, undefined]);
});

test('event z progiem przed startem: zgłoszenia ruszą razem z eventem; osoba spoza serwera nie dołączy', async () => {
  const now = Date.now();
  const s = await setup([{ id: 'zapr0003', name: 'Wkrótce', type: 'invites', startsAt: iso(now + DAY), endsAt: iso(now + 3 * DAY), goal: 3 }]);
  const link = await connect(s);
  const res = await s.call('/public/contests/zapr0003/join', { method: 'POST', session: link.session });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^Zgłoszenia ruszą razem z eventem — /);
  assert.equal(contestStatus((await s.store.getConfig()).contests.list[0], now), 'upcoming');

  await s.store.updateConfig({ contests: { list: [{ id: 'wiad0002', name: 'Teraz', type: 'messages', startsAt: iso(now - 1000), endsAt: iso(now + DAY) }] } });
  s.discord.state.members.delete('target');
  const gone = await s.call('/public/contests/wiad0002/join', { method: 'POST', session: link.session });
  assert.deepEqual([gone.status, gone.body.error], [400, 'Nie ma Cię na serwerze — wróć na niego, żeby wziąć udział.']);
  assert.equal((await s.call('/public/contests/nieznany1/join', { method: 'POST', session: link.session })).status, 400);
});

test('wejścia w czasie eventu zaproszeń: bot sprawdza zaproszenie bez logów, wyjście kasuje punkt; świeży stan zaproszeń na start', async () => {
  const now = Date.now();
  const s = await setup([{ id: 'zapr0004', name: 'Z', type: 'invites', startsAt: iso(now - 60_000), endsAt: iso(now + DAY), minAccountDays: 7 }]);
  assert.equal(membersFeaturesOn(await s.store.getConfig()), true, 'event zaproszeń potrzebuje wejść i wyjść z gatewaya');
  const inv = (code, inviter, uses) => ({ code, uses, max_uses: 0, inviter: { id: inviter }, channel: { id: 'chan' }, expires_at: null });
  s.discord.state.invites = [inv('abc', 'target', 3)];
  // Stan sprzed tygodnia (zaproszenia nie były wtedy śledzone) — pobierany od nowa na start eventu, potem już nie.
  await s.store.setState('invites_snapshot', { at: now - 7 * DAY, invites: { abc: { uses: 1, inviterId: 'target', maxUses: 0, expiresAt: null } }, vanity: null });
  assert.equal(await ensureInviteSnapshot(s.bot, await s.store.getConfig()), 1);
  assert.equal(await ensureInviteSnapshot(s.bot, await s.store.getConfig()), 0);

  const id = account(100);
  s.discord.state.invites[0].uses = 4;
  await onMemberJoin(s.bot, { guild_id: GUILD, user: { id, username: 'nowy' }, roles: [], joined_at: iso(now) });
  const count = async () => (await s.store.contestInvites({ start: now - 60_000, end: now + DAY, minAccountMs: 7 * DAY })).get('target') ?? 0;
  assert.equal(await count(), 1);
  await onMemberLeave(s.bot, { guild_id: GUILD, user: { id, username: 'nowy' } });
  assert.equal(await count(), 0, 'osoba wyszła — zaproszenie się nie liczy');

  // Bez trwającego eventu (i bez logów) nic nie jest sprawdzane.
  await s.store.updateConfig({ contests: { list: [] } });
  s.discord.state.invites[0].uses = 5;
  const calls = s.discord.state.calls.length;
  await onMemberJoin(s.bot, { guild_id: GUILD, user: { id: account(50), username: 'drugi' }, roles: [], joined_at: iso(now) });
  assert.equal(s.discord.state.calls.slice(calls).filter((c) => c.path.endsWith('/invites')).length, 0);
});

test('panel: walidacja eventów, uczestnicy z wynikami i najlepsi spoza listy, usuwanie uczestnika', async () => {
  const now = Date.now();
  const s = await setup();
  const config = await s.store.updateConfig({
    contests: {
      list: [
        { id: 'mix00002', name: '  Wielki   event ', type: 'mixed', startsAt: iso(now - DAY), endsAt: iso(now + DAY), points: { invite: 0, message: 0 }, goal: -5, winners: 99, minAccountDays: 1000, description: 'Opis\r\nlinia' },
        { id: 'krot', name: 'Złe ID', type: 'messages', startsAt: iso(now), endsAt: iso(now + DAY) },
        { id: 'typ00001', name: 'Zły typ', type: 'reactions', startsAt: iso(now), endsAt: iso(now + DAY) },
        { id: 'dat00001', name: 'Złe daty', type: 'invites', startsAt: iso(now + DAY), endsAt: iso(now) },
        { id: 'dlu00001', name: 'Za długi', type: 'invites', startsAt: iso(now), endsAt: iso(now + 100 * DAY) },
      ],
    },
  });
  assert.deepEqual(config.contests.list, [
    {
      id: 'mix00002',
      name: 'Wielki event',
      description: 'Opis\nlinia',
      prize: '',
      type: 'mixed',
      startsAt: iso(now - DAY),
      endsAt: iso(now + DAY),
      goal: 0,
      points: { invite: 10, message: 1 },
      winners: 25,
      minAccountDays: 365,
    },
  ]);

  await s.store.addInviteJoin({ userId: account(500), inviterId: 'owner', code: 'x' });
  await s.store.addInviteJoin({ userId: account(500), inviterId: 'target', code: 'y' });
  const link = await connect(s);
  await s.call('/public/contests/mix00002/join', { method: 'POST', session: link.session });

  const res = await handlePanel(s.bot, { method: 'GET', path: '/contests/mix00002' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries.map((e) => [e.rank, e.userId, e.score, e.invites]), [[1, 'target', 10, 1]]);
  assert.deepEqual(res.body.others.map((o) => [o.userId, o.score]), [['owner', 10]], 'najlepsi spoza listy (nie dołączyli)');
  assert.equal((await handlePanel(s.bot, { method: 'GET', path: '/contests/brak0001' })).status, 404);
  assert.equal((await handlePanel(s.bot, { method: 'DELETE', path: '/contests/mix00002/entries/target' })).status, 200);
  assert.equal((await handlePanel(s.bot, { method: 'DELETE', path: '/contests/mix00002/entries/target' })).status, 404);
  assert.equal((await s.call('/public/contests')).body.contests[0].participants, 0);

  // Moderacja bez części „Eventy” nie widzi uczestników.
  const limited = { kind: 'session', full: false, sections: ['poziomy'], session: { id: 1 }, user: { id: 'mod' } };
  assert.equal((await handlePanel(s.bot, { method: 'GET', path: '/contests/mix00002', auth: limited })).status, 403);
  // Wyłączone eventy: zakładka znika, /polacz odmawia.
  await s.store.updateConfig({ contests: { enabled: false } });
  assert.deepEqual((await s.call('/public/contests')).body.contests, []);
  await handleInteraction(commandPayload('polacz', [], { invoker: 'target', roles: [], permissions: '0' }), s.bot).then((o) => o.task?.());
  assert.match(JSON.stringify(s.discord.state.webhook.at(-1).body), /Eventy są wyłączone/);
});
