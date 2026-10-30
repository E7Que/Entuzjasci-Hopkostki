import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, commandPayload, ROLES } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { createHandler, PANEL_SITE } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { P } from '../supabase/functions/hopkostki-bot/lib/permissions.js';

const LOGIN_CHANNEL = '100000000000000095';
const MOD_ROLE = '100000000000000096';
const TICKET_ROLE = '100000000000000097';
const HELPER_ROLE = '100000000000000098';
const HIGH_ROLE = '100000000000000099';
const BASE = 'https://x.supabase.co/functions/v1/hopkostki-bot/panel';
const ADMIN = String(1n << 3n);
const DAY = 24 * 60 * 60_000;

// Role z prawdziwymi (liczbowymi) ID: jedna pod rolą bota (pozycja 8), druga nad nią.
ROLES.push({ id: HELPER_ROLE, name: 'Test Helper', position: 2, permissions: String(P.KICK_MEMBERS | P.MANAGE_MESSAGES), color: 0 });
ROLES.push({ id: HIGH_ROLE, name: 'Wysoka', position: 10, permissions: String(P.KICK_MEMBERS), color: 0 });

async function setup(panelAccess = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({
    panelAccess: { enabled: true, channelId: LOGIN_CHANNEL, roles: { tickety: [TICKET_ROLE], ostrzezenia: [MOD_ROLE], sprawy: [MOD_ROLE] }, ...panelAccess },
  });
  // „mod” ma na serwerze tylko rolę od ticketów.
  discord.state.members.set('mod', { user: discord.state.users.get('mod'), roles: [TICKET_ROLE] });
  const handle = createHandler(bot);
  const call = (path, { method = 'GET', session, password, body, origin } = {}) =>
    handle(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(session ? { 'x-panel-session': session } : {}),
          ...(password ? { 'x-panel-password': password } : {}),
          ...(origin ? { origin } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { store, discord, bot, call };
}

// /login tak, jak wysyła go Discord, na wybranym kanale.
async function slash(s, { user = 'mod', roles = [TICKET_ROLE], permissions = '0', channel = LOGIN_CHANNEL, renew } = {}) {
  const body = commandPayload('login', renew === undefined ? [] : [{ name: 'nowy', type: 5, value: renew }], { invoker: user, roles, permissions });
  body.channel_id = channel;
  const result = await handleInteraction(body, s.bot);
  await result.task?.();
  return { response: result.response, reply: s.discord.state.webhook.at(-1).body };
}
function credentials({ reply }) {
  const text = reply.embeds[0].description;
  return { login: /\*\*Login:\*\* `([^`]+)`/.exec(text)?.[1], password: /\|\|`([A-Z2-9-]{14})`\|\|/.exec(text)?.[1] };
}

async function signIn(s, login, password) {
  const res = await s.call('/login', { method: 'POST', body: { login, password } });
  return { status: res.status, ...(await res.json()) };
}

test('/login: tylko na wybranym kanale i z rolą; login i hasło widzi tylko ta osoba; nowy:True wymusza nowe hasło', async () => {
  const s = await setup();
  assert.match((await slash(s, { channel: 'chan' })).reply.embeds[0].description, new RegExp(`tylko na kanale <#${LOGIN_CHANNEL}>`));
  assert.match((await slash(s, { user: 'target', roles: ['r-member'] })).reply.embeds[0].description, /Żadna z Twoich ról nie odblokowuje panelu/);

  const first = await slash(s);
  assert.equal(first.response.data.flags, 64, 'odpowiedź widoczna tylko dla tej osoby');
  const { login, password } = credentials(first);
  assert.equal(login, 'dfgbh65', 'login = nazwa na Discordzie');
  assert.match(password, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const text = first.reply.embeds[0].description;
  assert.match(text, /✅ \*\*Możesz zmieniać:\*\* Tickety/);
  assert.match(text, /🔒 \*\*Tylko podgląd:\*\* Ustawienia, Uprawnienia komend/);
  assert.match(text, /\*\*Ważny do:\*\* <t:\d+:f>/);
  assert.equal(first.reply.components[0].components[0].url, `${PANEL_SITE}#login=dfgbh65&haslo=${password}`);

  // W bazie tylko skrót hasła.
  const rows = await s.store.query('select kind, login, token_hash from bot.panel_sessions');
  assert.deepEqual(rows.map((r) => [r.kind, r.login]), [['login', 'dfgbh65']]);
  assert.ok(!rows[0].token_hash.includes(password.replace(/-/g, '')));

  // Drugi /login: ten sam login, hasła nie da się pokazać drugi raz.
  const again = await slash(s);
  assert.match(again.reply.embeds[0].description, /Masz już aktywny login \*\*`dfgbh65`\*\*/);
  assert.equal(credentials(again).password, undefined);
  assert.equal(again.reply.components[0].components[0].url, `${PANEL_SITE}#login=dfgbh65`);
  assert.equal((await signIn(s, login, password)).status, 200, 'stare hasło dalej działa');

  // nowy:True — nowe hasło, stare i jego zalogowania przestają działać.
  const session = (await signIn(s, login, password)).token;
  const renewed = credentials(await slash(s, { renew: true }));
  assert.equal(renewed.login, 'dfgbh65');
  assert.notEqual(renewed.password, password);
  assert.equal((await signIn(s, login, password)).status, 401);
  assert.equal((await s.call('/me', { session })).status, 401, 'zalogowania starym hasłem wylogowane');
  assert.equal((await signIn(s, login, renewed.password)).status, 200);

  await s.store.updateConfig({ panelAccess: { channelId: '' } });
  assert.match((await slash(s)).reply.embeds[0].description, /nie wybrał jeszcze kanału/);
  await s.store.updateConfig({ panelAccess: { enabled: false, channelId: LOGIN_CHANNEL } });
  assert.match((await slash(s)).reply.embeds[0].description, /Logowanie do panelu jest wyłączone/);
});

test('logowanie loginem i hasłem: sesja widzi i zapisuje tylko odblokowane części panelu', async () => {
  const s = await setup();
  const { login, password } = credentials(await slash(s));
  assert.equal((await signIn(s, login, 'ZLE-HASLO')).status, 401);
  assert.equal((await signIn(s, 'ktos-inny', password)).status, 401);

  // Wielkość liter i myślniki nie mają znaczenia; jednym loginem można się zalogować na kilku urządzeniach.
  const phone = await signIn(s, login.toUpperCase(), password.toLowerCase().replace(/-/g, ''));
  assert.equal(phone.status, 200);
  assert.deepEqual([phone.me.kind, phone.me.full, phone.me.sections, phone.me.user.id], ['session', false, ['tickety'], 'mod']);
  const loginRow = await s.store.getPanelLoginForUser('mod');
  assert.equal(phone.me.expiresAt, loginRow.expiresAt, 'zalogowanie kończy się razem z loginem');
  const token = (await signIn(s, login, password)).token;
  assert.notEqual(token, phone.token);

  assert.equal((await s.call('/tickets', { session: token })).status, 200);
  for (const path of ['/cases', '/warns', '/tempbans', '/messages', '/voice', '/bump', '/giveaways', '/access/logins']) {
    assert.equal((await s.call(path, { session: token })).status, 403, path);
  }
  assert.equal((await s.call('/password', { method: 'POST', session: token, body: { next: 'nowehaslo123' } })).status, 403);
  assert.equal((await s.call('/setup', { method: 'POST', session: token })).status, 403);
  assert.equal((await s.call(`/roles/${HELPER_ROLE}/permissions`, { method: 'POST', session: token, body: { permission: 'KICK_MEMBERS', value: false } })).status, 403);
  const status = await (await s.call('/status', { session: token })).json();
  assert.deepEqual(status.recent, [], 'ostatnie sprawy tylko z dostępem do spraw');

  const before = await s.store.getConfig();
  const put = await s.call('/config', {
    method: 'PUT',
    session: token,
    body: { tickets: { maxOpen: 3 }, logs: { enabled: !before.logs.enabled }, panelAccess: { roles: { sprawy: [TICKET_ROLE] } } },
  });
  assert.equal(put.status, 200);
  const after = await s.store.getConfig();
  assert.equal(after.tickets.maxOpen, 3, 'tickety odblokowane — zapisane');
  assert.equal(after.logs.enabled, before.logs.enabled, 'logi niedostępne — bez zmian');
  assert.deepEqual(after.panelAccess.roles.sprawy, [MOD_ROLE], 'dostęp do panelu zmienia tylko pełny dostęp');

  assert.equal((await s.call('/tickets')).status, 401);
  assert.equal((await s.call('/tickets', { session: 'zly-token' })).status, 401);
});

test('role sprawdzane na bieżąco: zmiana ról w panelu działa od razu, odebrana rola albo wyjście z serwera wylogowuje', async () => {
  const s = await setup();
  const { login, password } = credentials(await slash(s));
  const { token } = await signIn(s, login, password);
  assert.equal((await s.call('/cases', { session: token })).status, 403);
  await s.store.updateConfig({ panelAccess: { roles: { sprawy: [MOD_ROLE, TICKET_ROLE] } } });
  assert.equal((await s.call('/cases', { session: token })).status, 200, 'nowa rola w „Sprawy” od razu odblokowuje sprawy');

  s.discord.state.members.set('mod', { user: s.discord.state.users.get('mod'), roles: [] });
  assert.equal((await s.call('/cases', { session: token })).status, 200, 'do następnego sprawdzenia ról zostaje poprzedni stan');
  await s.store.query("update bot.panel_sessions set checked_at = now() - interval '6 minutes'");
  const gone = await s.call('/cases', { session: token });
  assert.equal(gone.status, 401);
  assert.match((await gone.json()).error, /Nie masz już ról/);
  assert.equal((await signIn(s, login, password)).status, 401, 'bez ról nie da się też zalogować');

  s.discord.state.members.set('mod', { user: s.discord.state.users.get('mod'), roles: [TICKET_ROLE] });
  const second = await signIn(s, login, password);
  s.discord.state.members.delete('mod');
  await s.store.query("update bot.panel_sessions set checked_at = now() - interval '6 minutes'");
  const left = await s.call('/tickets', { session: second.token });
  assert.equal(left.status, 401);
  assert.match((await left.json()).error, /Nie ma Cię już na serwerze/);
});

test('administrator: pełny dostęp, lista loginów, wymuszenie nowego loginu i uprawnienia ról w Discordzie', async () => {
  const s = await setup();
  // Właściciel serwera i osoba z rolą z uprawnieniem Administrator mają wszystko.
  const ownerCreds = credentials(await slash(s, { user: 'owner', roles: [] }));
  const owner = await signIn(s, ownerCreds.login, ownerCreds.password);
  assert.equal(owner.me.full, true);
  s.discord.state.members.set('target', { user: s.discord.state.users.get('target'), roles: ['r-admin'] });
  const adminCreds = credentials(await slash(s, { user: 'target', roles: ['r-admin'], permissions: ADMIN }));
  const admin = await signIn(s, adminCreds.login, adminCreds.password);
  assert.equal(admin.me.full, true);
  const modCreds = credentials(await slash(s));
  const mod = await signIn(s, modCreds.login, modCreds.password);
  await signIn(s, modCreds.login, modCreds.password);

  const list = await (await s.call('/access/logins', { session: owner.token })).json();
  assert.deepEqual(
    list.logins.map((x) => [x.login, x.full, x.sections.length, x.sessions]).sort(),
    [['dfgbh65', false, 1, 2], ['hurownik_og', true, 13, 1], ['wlasciciel', true, 13, 1]],
  );
  assert.ok(list.logins.every((x) => !('tokenHash' in x) && !('token_hash' in x)));

  // Wymuszenie nowego loginu: stare hasło i oba zalogowania przestają działać, /login daje nowy.
  const modLogin = list.logins.find((x) => x.login === 'dfgbh65');
  assert.equal((await s.call(`/access/logins/${modLogin.id}`, { method: 'DELETE', session: owner.token })).status, 200);
  assert.equal((await s.call('/tickets', { session: mod.token })).status, 401);
  assert.equal((await signIn(s, modCreds.login, modCreds.password)).status, 401);
  assert.ok(credentials(await slash(s)).password, 'po unieważnieniu /login daje nowe hasło');

  // Uprawnienia roli w Discordzie: tylko wybrane uprawnienia i tylko role pod rolą bota.
  const kick = await s.call(`/roles/${HELPER_ROLE}/permissions`, { method: 'POST', session: owner.token, body: { permission: 'KICK_MEMBERS', value: false } });
  assert.equal(kick.status, 200);
  assert.deepEqual(s.discord.state.roleEdits.at(-1).body, { permissions: String(P.MANAGE_MESSAGES) });
  assert.match(s.discord.state.roleEdits.at(-1).reason, /wlasciciel.*odebrano/);
  const notAllowed = await s.call(`/roles/${HELPER_ROLE}/permissions`, { method: 'POST', password: 'tajne', body: { permission: 'ADMINISTRATOR', value: true } });
  assert.equal(notAllowed.status, 400);
  const high = await s.call(`/roles/${HIGH_ROLE}/permissions`, { method: 'POST', password: 'tajne', body: { permission: 'KICK_MEMBERS', value: false } });
  assert.equal(high.status, 400);
  assert.match((await high.json()).error, /wyżej niż rola bota/);
  assert.equal(s.discord.state.roleEdits.length, 1);

  assert.equal((await s.call('/logout', { method: 'POST', session: owner.token })).status, 200);
  assert.equal((await s.call('/me', { session: owner.token })).status, 401);
  const me = await (await s.call('/me', { password: 'tajne' })).json();
  assert.deepEqual([me.me.kind, me.me.full], ['password', true]);
  assert.equal((await s.call('/access/logins', { method: 'DELETE', password: 'tajne' })).status, 200);
  assert.equal((await s.call('/me', { session: admin.token })).status, 401, 'wymuszenie nowych loginów dla wszystkich');
});

test('login wygasa po ustawionym czasie razem z zalogowaniami; wyłączenie logowania zamyka sesje; CORS przepuszcza nagłówek sesji', async () => {
  const s = await setup({ loginDays: 30 });
  await s.store.updateConfig({ panelAccess: { loginDays: 9 } });
  assert.equal((await s.store.getConfig()).panelAccess.loginDays, 30, 'tylko 7, 14 albo 30 dni');

  const creds = credentials(await slash(s));
  const loginRow = await s.store.getPanelLoginForUser('mod');
  assert.ok(Math.abs(loginRow.expiresAt - (Date.now() + 30 * DAY)) < 60_000, 'ważny 30 dni');
  const { token } = await signIn(s, creds.login, creds.password);

  await s.store.query("update bot.panel_sessions set expires_at = now() - interval '1 second'");
  assert.equal((await s.call('/me', { session: token })).status, 401);
  assert.equal((await signIn(s, creds.login, creds.password)).status, 401);
  const fresh = credentials(await slash(s));
  assert.ok(fresh.password, 'po wygaśnięciu /login daje nowy login');

  const next = await signIn(s, fresh.login, fresh.password);
  assert.equal((await s.call('/me', { session: next.token })).status, 200);
  await s.store.updateConfig({ panelAccess: { enabled: false } });
  const off = await s.call('/me', { session: next.token });
  assert.equal(off.status, 401);
  assert.match((await off.json()).error, /wyłączone/);

  const origin = new URL(PANEL_SITE).origin;
  const preflight = await s.call('/me', { method: 'OPTIONS', origin });
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-panel-session/);
});
