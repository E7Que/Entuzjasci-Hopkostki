import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, commandPayload, snowflake } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { handlePanel } from '../supabase/functions/hopkostki-bot/lib/panel.js';
import { ensureSetup } from '../supabase/functions/hopkostki-bot/lib/cron.js';
import { onMessageLevels } from '../supabase/functions/hopkostki-bot/lib/levels.js';
import { membersFeaturesOn, onMemberJoin, onMemberLeave } from '../supabase/functions/hopkostki-bot/lib/members.js';
import { ensureInviteSnapshot } from '../supabase/functions/hopkostki-bot/lib/invites.js';
import { OAUTH_REDIRECT, contestsTick, messageContestIds, requirementText } from '../supabase/functions/hopkostki-bot/lib/contests.js';

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
    levels: { enabled: true, message: { min: 10, max: 10, cooldown: 0 } },
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
const join = (s, id, session) => s.call(`/public/contests/${id}/join`, { method: 'POST', session });
const view = async (s, session, id) => (await s.call('/public/contests', { session })).body.contests.find((c) => c.id === id);

test('event zaproszeń: zapis najpierw, potem liczą się prawdziwe zaproszenia od chwili zapisu; po warunku „dostał(a) się” i ogłoszenie', async () => {
  const now = Date.now();
  const s = await setup([
    { id: 'zapr0001', name: 'Zaproś znajomych', startsAt: iso(now - DAY), endsAt: iso(now + 6 * DAY), invites: 3, minAccountDays: 7, prize: 'Nitro' },
  ]);
  const before = account(300);
  // Zaproszenie sprzed zapisu się nie liczy.
  await s.db.query(`insert into bot.invite_joins (user_id, inviter_id, code, joined_at) values ($1, 'target', 'abc', now() - interval '1 hour')`, [before]);

  const anon = await s.call('/public/contests');
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('access-control-allow-origin'), 'https://e7que.github.io');
  const c0 = anon.body.contests[0];
  assert.deepEqual([c0.status, c0.type, c0.invites, c0.messages, c0.minAccountDays, c0.prize, c0.me], ['live', 'invites', 3, 0, 7, 'Nitro', null]);
  assert.equal(anon.body.oauth, null, 'logowanie przez Discord niegotowe (brak adresu w Redirects)');

  const link = await connect(s);
  assert.equal(link.out.response.data.flags, 64, 'link widzi tylko ta osoba');
  assert.match(link.url, /^https:\/\/e7que\.github\.io\/Entuzjasci-Hopkostki\/ranking\.html#polacz=[\w-]{40,}$/);
  assert.match(link.reply.embeds[0].description, /Zaproś znajomych\*\* — trzeba zaprosić 3 osoby, koniec <t:\d+:R>/);
  assert.equal((await s.call('/public/link', { method: 'POST', body: { token: link.token } })).status, 401, 'link działa tylko raz');

  let me = (await view(s, link.session, 'zapr0001')).me;
  assert.deepEqual([me.joined, me.canJoin, me.invites], [false, true, 0]);
  assert.deepEqual((await join(s, 'zapr0001', link.session)).body, { joined: true, already: false });
  assert.equal((await join(s, 'zapr0001', link.session)).body.already, true);

  // Po zapisie: 2 dobre, młode konto, wyjście, powrót (wcześniejsze wejście) i znany wcześniej profil — nie.
  const [ok1, ok2, young, leaver, back, known] = [account(400), account(30), account(2), account(100), account(200), account(150)];
  await s.db.query(`insert into bot.invite_joins (user_id, inviter_id, code, joined_at) values ($1, 'mod', 'x', now() - interval '20 days')`, [back]);
  await s.db.query(`insert into bot.member_profiles (user_id, username, updated_at) values ($1, 'stary', now() - interval '30 days')`, [known]);
  await new Promise((r) => setTimeout(r, 5));
  for (const id of [ok1, ok2, young, leaver, back, known]) await s.store.addInviteJoin({ userId: id, inviterId: 'target', code: 'abc' });
  await s.store.markInviteLeft(leaver);
  me = (await view(s, link.session, 'zapr0001')).me;
  assert.deepEqual([me.joined, me.invites, me.reached, me.rank], [true, 2, false, 1]);
  assert.equal(await contestsTick(s.bot), 0, 'warunek jeszcze niespełniony');

  await s.store.addInviteJoin({ userId: account(90), inviterId: 'target', code: 'abc' });
  me = (await view(s, link.session, 'zapr0001')).me;
  assert.deepEqual([me.invites, me.reached], [3, true]);
  assert.equal(await contestsTick(s.bot), 1);
  assert.equal(await contestsTick(s.bot), 0, 'ogłoszenie tylko raz');
  const log = s.discord.state.channels.get(LOG);
  assert.equal(log.length, 1);
  assert.equal(log[0].content, `<@&${PING}>`);
  assert.match(log[0].embeds[0].title, /Dostał\(a\) się — Zaproś znajomych/);
  assert.match(log[0].embeds[0].description, /<@target> spełnił\(a\) warunek eventu: zaprosił\(a\) \*\*3 osoby\*\* \(warunek: 3\)\.\n\*\*Nagroda:\*\* Nitro/);

  // Druga osoba: zapisana, bez zaproszeń — niżej; lista: kto się dostał, ten wyżej.
  const other = await connect(s, 'mod');
  await join(s, 'zapr0001', other.session);
  const c1 = await view(s, other.session, 'zapr0001');
  assert.deepEqual([c1.participants, c1.qualified], [2, 1]);
  assert.deepEqual(c1.entries.map((e) => [e.rank, e.userId, e.invites, e.reached, e.me]), [[1, 'target', 3, true, false], [2, 'mod', 0, false, true]]);
  assert.ok(c1.entries[0].qualifiedAt);

  // Nieważna sesja: lista działa (expired), akcje → 401. Rozłączenie kończy sesję.
  const bad = await s.call('/public/contests', { session: 'x'.repeat(43) });
  assert.deepEqual([bad.status, bad.body.expired, bad.body.me], [200, true, null]);
  assert.equal((await join(s, 'zapr0001', 'x'.repeat(43))).status, 401);
  assert.equal((await join(s, 'zapr0001')).status, 401);
  assert.equal((await s.call('/public/unlink', { method: 'POST', session: link.session })).body.removed, 1);
  assert.equal((await s.call('/public/contests', { session: link.session })).body.expired, true);
});

test('event wiadomości i oba warunki: liczą się tylko wiadomości zapisanych (od zapisu), oba warunki muszą być spełnione', async () => {
  const now = Date.now();
  const s = await setup([
    { id: 'wiad0001', name: 'Pisanie', startsAt: iso(now - 60_000), endsAt: iso(now + DAY), messages: 2 },
    { id: 'oba00001', name: 'Oba', startsAt: iso(now - 60_000), endsAt: iso(now + DAY), invites: 1, messages: 1 },
    { id: 'stary001', name: 'Stary', startsAt: iso(now - 10 * DAY), endsAt: iso(now - 5 * DAY), messages: 1 },
    { id: 'pozn0001', name: 'Później', startsAt: iso(now + DAY), endsAt: iso(now + 2 * DAY), messages: 5 },
  ]);
  assert.deepEqual(messageContestIds(await s.store.getConfig()), ['wiad0001', 'oba00001']);
  assert.equal(requirementText((await s.store.getConfig()).contests.list.find((c) => c.id === 'oba00001')), 'zaprosić 1 osobę i napisać 1 wiadomość');
  await onMessageLevels(s.bot, message('target', 'przed zapisem'));
  const link = await connect(s);
  for (const id of ['wiad0001', 'oba00001', 'pozn0001']) assert.equal((await join(s, id, link.session)).status, 200, id);
  assert.deepEqual((await join(s, 'stary001', link.session)).status, 400, 'zakończony ponad 3 dni temu — nie ma go');
  await onMessageLevels(s.bot, message('target', 'pierwsza'));
  await onMessageLevels(s.bot, message('mod', 'niezapisany'));
  let w = await view(s, link.session, 'wiad0001');
  assert.deepEqual([w.me.messages, w.me.reached, w.entries.length], [1, false, 1], 'wiadomość sprzed zapisu i niezapisanych się nie liczy');
  await onMessageLevels(s.bot, message('target', 'druga'));
  w = await view(s, link.session, 'wiad0001');
  assert.deepEqual([w.me.messages, w.me.reached], [2, true]);
  const both = await view(s, link.session, 'oba00001');
  assert.deepEqual([both.type, both.me.messages, both.me.invites, both.me.reached], ['mixed', 2, 0, false], 'brakuje zaproszenia');
  await s.store.addInviteJoin({ userId: account(50), inviterId: 'target', code: 'abc' });
  assert.equal((await view(s, link.session, 'oba00001')).me.reached, true);
  const later = await view(s, link.session, 'pozn0001');
  assert.deepEqual([later.status, later.me.joined, later.me.reached], ['upcoming', true, false], 'przed startem nic się nie liczy');
  assert.equal(await contestsTick(s.bot), 2);
  assert.equal(s.discord.state.channels.get(LOG).length, 2);

  // Osoba ukryta komendą /prywatnosc: dla innych „Ukryta osoba”, dla siebie — normalnie.
  await s.store.setLevelHidden('target', true);
  const other = await connect(s, 'mod');
  const seen = (await view(s, other.session, 'wiad0001')).entries[0];
  assert.deepEqual([seen.hidden, seen.userId, seen.name, seen.avatar], [true, null, 'Ukryta osoba', null]);
  const self = (await view(s, link.session, 'wiad0001')).entries[0];
  assert.deepEqual([self.userId, self.me, self.hidden], ['target', true, undefined]);
});

test('logowanie przez Discord: kod z PKCE → sesja; adres strony musi być na liście Redirects aplikacji', async () => {
  const s = await setup([{ id: 'zapr0002', name: 'Z', startsAt: iso(Date.now() - 1000), endsAt: iso(Date.now() + DAY), invites: 1 }]);
  // Bot sprawdza listę Redirects przy konfiguracji (Discord nie pozwala jej zmienić przez API).
  s.discord.state.redirectUris = ['https://example.com/'];
  assert.equal((await ensureSetup(s.bot, { force: true })).oauthRedirect, false);
  assert.equal((await s.call('/public/contests')).body.oauth, null);
  assert.equal((await s.call('/public/oauth', { method: 'POST', body: { code: 'kod-1234567890', verifier: 'v'.repeat(43) } })).status, 400);
  s.discord.state.redirectUris = ['https://example.com/', OAUTH_REDIRECT];
  assert.equal((await ensureSetup(s.bot, { force: true })).oauthRedirect, true);
  assert.deepEqual((await s.call('/public/contests')).body.oauth, { clientId: 'app', redirectUri: OAUTH_REDIRECT });

  const verifier = 'v'.repeat(30) + 'ABCDEFGHIJKLMNOP';
  s.discord.state.oauthCodes = { 'kod-1234567890': { userId: 'target', verifier } };
  assert.equal((await s.call('/public/oauth', { method: 'POST', body: { code: 'kod-1234567890', verifier: 'x'.repeat(46) } })).status, 401, 'zły code_verifier');
  s.discord.state.oauthCodes = { 'kod-1234567890': { userId: 'target', verifier } };
  const ok = await s.call('/public/oauth', { method: 'POST', body: { code: 'kod-1234567890', verifier } });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.me.id, ok.body.me.name], ['target', 'hurownik_og']);
  assert.equal((await s.call('/public/oauth', { method: 'POST', body: { code: 'kod-1234567890', verifier } })).status, 401, 'kod działa raz');
  assert.equal((await join(s, 'zapr0002', ok.body.token)).status, 200, 'z sesji z logowania można się zapisać');
  assert.equal((await s.call('/public/oauth', { method: 'POST', body: { code: '<script>', verifier } })).status, 401);

  // Panel pokazuje, czy logowanie jest gotowe.
  assert.deepEqual((await handlePanel(s.bot, { method: 'GET', path: '/contests' })).body.oauth.registered, true);
  delete s.discord.state.redirectUris;
  assert.equal((await ensureSetup(s.bot, { force: true })).oauthRedirect, null, 'Discord nie podał listy — nie wiadomo');
});

test('event przed startem: zapis od razu, liczenie od startu; po końcu i spoza serwera — bez zapisu', async () => {
  const now = Date.now();
  const s = await setup([{ id: 'zapr0003', name: 'Wkrótce', startsAt: iso(now + DAY), endsAt: iso(now + 3 * DAY), invites: 3 }]);
  const link = await connect(s);
  assert.equal((await join(s, 'zapr0003', link.session)).status, 200);
  await s.store.addInviteJoin({ userId: account(100), inviterId: 'target', code: 'abc' });
  assert.equal((await view(s, link.session, 'zapr0003')).me.invites, 0, 'zaproszenie przed startem się nie liczy');

  await s.store.updateConfig({ contests: { list: [{ id: 'wiad0002', name: 'Było', startsAt: iso(now - 2 * DAY), endsAt: iso(now - DAY), messages: 1 }, { id: 'wiad0003', name: 'Teraz', startsAt: iso(now - 1000), endsAt: iso(now + DAY), messages: 1 }] } });
  assert.deepEqual((await join(s, 'wiad0002', link.session)).body.error, 'Ten event już się skończył.');
  s.discord.state.members.delete('target');
  const gone = await join(s, 'wiad0003', link.session);
  assert.deepEqual([gone.status, gone.body.error], [400, 'Nie ma Cię na serwerze — wróć na niego, żeby się zapisać.']);
  assert.equal((await join(s, 'nieznany1', link.session)).status, 400);
});

test('wejścia w czasie eventu zaproszeń: bot sprawdza zaproszenie bez logów, wyjście kasuje punkt; świeży stan zaproszeń na start', async () => {
  const now = Date.now();
  const s = await setup([{ id: 'zapr0004', name: 'Z', startsAt: iso(now - 60_000), endsAt: iso(now + DAY), invites: 2, minAccountDays: 7 }]);
  assert.equal(membersFeaturesOn(await s.store.getConfig()), true, 'event zaproszeń potrzebuje wejść i wyjść z gatewaya');
  await s.store.addContestEntry({ contestId: 'zapr0004', userId: 'target', userTag: 'hurownik_og' });
  const inv = (code, inviter, uses) => ({ code, uses, max_uses: 0, inviter: { id: inviter }, channel: { id: 'chan' }, expires_at: null });
  s.discord.state.invites = [inv('abc', 'target', 3)];
  // Stan sprzed tygodnia (zaproszenia nie były wtedy śledzone) — pobierany od nowa na start eventu, potem już nie.
  await s.store.setState('invites_snapshot', { at: now - 7 * DAY, invites: { abc: { uses: 1, inviterId: 'target', maxUses: 0, expiresAt: null } }, vanity: null });
  assert.equal(await ensureInviteSnapshot(s.bot, await s.store.getConfig()), 1);
  assert.equal(await ensureInviteSnapshot(s.bot, await s.store.getConfig()), 0);

  const id = account(100);
  s.discord.state.invites[0].uses = 4;
  await new Promise((r) => setTimeout(r, 5));
  await onMemberJoin(s.bot, { guild_id: GUILD, user: { id, username: 'nowy' }, roles: [], joined_at: iso(now) });
  const count = async () => (await s.store.contestProgress('zapr0004', { start: now - 60_000, end: now + DAY, invites: true, minAccountMs: 7 * DAY }))[0].invites;
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

test('panel: walidacja eventów (warunek, stary zapis), zapisani z postępem, usuwanie, dostęp i wyłączenie', async () => {
  const now = Date.now();
  const s = await setup();
  const config = await s.store.updateConfig({
    contests: {
      list: [
        { id: 'oba00002', name: '  Wielki   event ', startsAt: iso(now - DAY), endsAt: iso(now + DAY), invites: 3, messages: 50, minAccountDays: 1000, description: 'Opis\r\nlinia', drawWinners: 99, drawMode: 'zle' },
        { id: 'stary002', name: 'Stary zapis', type: 'invites', goal: 5, startsAt: iso(now), endsAt: iso(now + DAY) },
        { id: 'krot', name: 'Złe ID', invites: 1, startsAt: iso(now), endsAt: iso(now + DAY) },
        { id: 'bezwar01', name: 'Bez warunku', invites: 0, messages: 0, startsAt: iso(now), endsAt: iso(now + DAY) },
        { id: 'dat00001', name: 'Złe daty', invites: 1, startsAt: iso(now + DAY), endsAt: iso(now) },
        { id: 'dlu00001', name: 'Za długi', invites: 1, startsAt: iso(now), endsAt: iso(now + 100 * DAY) },
      ],
    },
  });
  assert.deepEqual(config.contests.list, [
    { id: 'oba00002', name: 'Wielki event', description: 'Opis\nlinia', prize: '', startsAt: iso(now - DAY), endsAt: iso(now + DAY), invites: 3, messages: 50, minAccountDays: 365, drawWinners: 50, drawMode: 'manual' },
    { id: 'stary002', name: 'Stary zapis', description: '', prize: '', startsAt: iso(now), endsAt: iso(now + DAY), invites: 5, messages: 0, minAccountDays: 7, drawWinners: 0, drawMode: 'manual' },
  ]);

  const link = await connect(s);
  await join(s, 'oba00002', link.session);
  await s.store.addInviteJoin({ userId: account(500), inviterId: 'target', code: 'y' });
  const res = await handlePanel(s.bot, { method: 'GET', path: '/contests/oba00002' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries.map((e) => [e.rank, e.userId, e.invites, e.messages, e.reached]), [[1, 'target', 1, 0, false]]);
  assert.equal((await handlePanel(s.bot, { method: 'GET', path: '/contests/brak0001' })).status, 404);
  assert.equal((await handlePanel(s.bot, { method: 'DELETE', path: '/contests/oba00002/entries/target' })).status, 200);
  assert.equal((await handlePanel(s.bot, { method: 'DELETE', path: '/contests/oba00002/entries/target' })).status, 404);
  assert.equal((await s.call('/public/contests')).body.contests[0].participants, 0);

  // Moderacja bez części „Eventy” nie widzi zapisanych.
  const limited = { kind: 'session', full: false, sections: ['poziomy'], session: { id: 1 }, user: { id: 'mod' } };
  assert.equal((await handlePanel(s.bot, { method: 'GET', path: '/contests/oba00002', auth: limited })).status, 403);
  // Wyłączone eventy: zakładka znika, /polacz odmawia.
  await s.store.updateConfig({ contests: { enabled: false } });
  assert.deepEqual((await s.call('/public/contests')).body.contests, []);
  await handleInteraction(commandPayload('polacz', [], { invoker: 'target', roles: [], permissions: '0' }), s.bot).then((o) => o.task?.());
  assert.match(JSON.stringify(s.discord.state.webhook.at(-1).body), /Eventy są wyłączone/);
});

test('losowanie: ręcznie z panelu wśród tych, którzy się dostali (ponowne zastępuje), samo po końcu eventu — raz', async () => {
  const now = Date.now();
  const s = await setup([
    { id: 'los00001', name: 'Losowanie Nitro', startsAt: iso(now - DAY), endsAt: iso(now + DAY), invites: 1, drawWinners: 2, prize: 'Nitro' },
    { id: 'los00002', name: 'Po końcu', startsAt: iso(now - 3 * DAY), endsAt: iso(now - 60_000), messages: 1, drawWinners: 1, drawMode: 'auto' },
    { id: 'los00003', name: 'Później', startsAt: iso(now + DAY), endsAt: iso(now + 2 * DAY), invites: 1, drawWinners: 1 },
  ]);
  for (const user of ['target', 'mod', 'owner']) {
    await s.store.addContestEntry({ contestId: 'los00001', userId: user, userTag: user });
    await s.db.query(`update bot.contest_entries set created_at = now() - interval '1 hour' where user_id = $1`, [user]);
  }
  for (const user of ['target', 'mod']) await s.store.addInviteJoin({ userId: account(100), inviterId: user, code: 'abc' });

  const first = await handlePanel(s.bot, { method: 'POST', path: '/contests/los00001/draw' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.result.winners.map((w) => w.userId).sort(), ['mod', 'target'], 'losowanie tylko wśród tych, którzy się dostali');
  assert.equal(first.body.result.pool, 2);
  const log = s.discord.state.channels.get(LOG).at(-1);
  assert.match(log.embeds[0].title, /Losowanie — Losowanie Nitro/);
  assert.match(log.embeds[0].description, /\*\*Zwycięzcy:\*\*\n🥇 <@(target|mod)>\n🥈 <@(target|mod)>\n\*\*Nagroda:\*\* Nitro\n-# Losowanie wśród 2 osób, które się dostały · losował\(a\): hasło panelu\./);
  assert.deepEqual(log.allowed_mentions.users.sort(), ['mod', 'target'], 'zwycięzcy dostają ping');
  const link = await connect(s);
  const c = await view(s, link.session, 'los00001');
  assert.deepEqual([c.draw.done, c.draw.winners, c.winners.length, c.me.won], [true, 2, 2, true]);
  assert.equal(c.entries.find((e) => e.userId === 'owner').won, false);

  // Ponowne losowanie zastępuje poprzednie; panel widzi zwycięzców.
  assert.equal((await handlePanel(s.bot, { method: 'POST', path: '/contests/los00001/draw' })).status, 200);
  const details = (await handlePanel(s.bot, { method: 'GET', path: '/contests/los00001' })).body;
  assert.equal(details.entries.filter((e) => e.won).length, 2);
  assert.equal(details.draw.pool, 2);
  assert.match((await handlePanel(s.bot, { method: 'POST', path: '/contests/los00003/draw' })).body.error, /jeszcze się nie zaczął/);

  // Samo po końcu eventu: raz (nikt się nie dostał — ogłoszenie, że nie było kogo losować).
  const before = s.discord.state.channels.get(LOG).length;
  await contestsTick(s.bot);
  await contestsTick(s.bot);
  const auto = s.discord.state.channels.get(LOG).slice(before).filter((m) => /^🎲 Losowanie/.test(m.embeds[0].title));
  assert.equal(auto.length, 1, 'jedno losowanie (osobno ogłoszenia o spełnionym warunku)');
  assert.match(auto[0].embeds[0].description, /Nikt nie spełnił warunku — nie było kogo losować\.[\s\S]*automatycznie po końcu eventu/);
});
