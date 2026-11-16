import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot } from './support/discord.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { maskIp } from '../supabase/functions/hopkostki-bot/lib/loginGuard.js';

const MODLOG = '100000000000000090';
const BASE = 'https://x.supabase.co/functions/v1/hopkostki-bot/panel';

async function setup() {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ modLogChannelId: MODLOG });
  return { store, discord, handle: createHandler(bot) };
}

test('ochrona logowania: 10 złych haseł z adresu → blokada na 15 min (także dobre hasło), alert, inne adresy działają', async () => {
  const s = await setup();
  const call = (password, ip = '203.0.113.42') =>
    s.handle(new Request(`${BASE}/me`, { headers: { 'x-panel-password': password, 'x-forwarded-for': `${ip}, 10.0.0.1` } }));
  assert.equal((await call('tajne')).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await call('zle')).status, 401);
  assert.equal((await call('tajne')).status, 200, 'dobre hasło przed blokadą działa i zeruje licznik');
  assert.equal(await s.store.loginAttempt((await s.store.query('select key from bot.login_attempts'))[0]?.key ?? 'brak'), null);

  for (let i = 0; i < 10; i++) assert.equal((await call('zle')).status, 401);
  const blocked = await call('tajne');
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Za dużo nieudanych prób logowania\. Spróbuj ponownie za 15 min\./);
  assert.equal(blocked.headers.get('retry-after'), '900');
  const alert = s.discord.state.channels.get(MODLOG).at(-1).embeds[0];
  assert.equal(alert.title, '🔐 Zablokowano logowanie do panelu');
  assert.match(alert.description, /•••\.•\.•••\.42/);
  assert.equal(s.discord.state.channels.get(MODLOG).length, 1, 'jeden alert na blokadę');
  assert.equal((await s.store.query('select key from bot.login_attempts'))[0].key.startsWith('ip:'), true, 'adres tylko jako skrót');

  assert.equal((await call('tajne', '198.51.100.7')).status, 200, 'inny adres działa');
  // Sesje (tokeny z /login) nie są liczone ani blokowane przez licznik hasła.
  const session = await s.handle(new Request(`${BASE}/me`, { headers: { 'x-panel-session': 'zly-token', 'x-forwarded-for': '203.0.113.42' } }));
  assert.equal(session.status, 401);

  // Po blokadzie (i oknie) znowu można się zalogować.
  await s.store.query("update bot.login_attempts set locked_until = now() - interval '1 minute', first_at = now() - interval '20 minutes'");
  assert.equal((await call('tajne')).status, 200);
});

test('ochrona logowania: złe dane z /login też się liczą; wyłączone logowanie moderacji — nie', async () => {
  const s = await setup();
  const login = () =>
    s.handle(new Request(`${BASE}/login`, { method: 'POST', body: JSON.stringify({ login: 'kasia', password: 'AAAA-BBBB-CCCC' }), headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.5' } }));
  for (let i = 0; i < 12; i++) assert.equal((await login()).status, 401, 'logowanie moderacji wyłączone — bez licznika');
  await s.store.updateConfig({ panelAccess: { enabled: true } });
  for (let i = 0; i < 10; i++) assert.equal((await login()).status, 401);
  assert.equal((await login()).status, 429);
  assert.equal(maskIp('2001:db8::7334'), '••••:•••::7334');
  assert.equal(maskIp(null), 'nieznany adres');
});
