import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot } from './support/discord.js';
import { createHandler, PANEL_SITE } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { createPanelServer } from '../panel/server.js';

const BASE = 'https://x.supabase.co/functions/v1/hopkostki-bot/panel';

async function setup() {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  const handle = createHandler(bot);
  const call = (path, { method = 'GET', body, password = 'tajne' } = {}) =>
    handle(new Request(`${BASE}${path}`, { method, headers: { 'x-panel-password': password, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
  return { store, discord, bot, handle, call };
}

test('API panelu wymaga hasła', async () => {
  const s = await setup();
  assert.equal((await s.call('/status', { password: 'zle' })).status, 401);
  assert.equal((await s.call('/status', { password: '' })).status, 401);
});

test('API panelu: status, kanały, role i zapis konfiguracji', async () => {
  const s = await setup();
  const status = await (await s.call('/status')).json();
  assert.equal(status.ready, true);
  assert.equal(status.guild.name, 'Entuzjaści Hopkostki');
  assert.equal(status.guild.memberCount, 1337);
  assert.equal(status.setup.tokenConfigured, true);

  const guild = await (await s.call('/guild')).json();
  assert.deepEqual(guild.channels.map((c) => [c.name, c.category]), [['ogolny', null], ['mod-logi', 'Moderacja']]);
  assert.deepEqual(guild.roles.map((r) => r.name), ['Admin', 'Bot', 'Moderator', 'Fan', 'Entuzjasta']);

  const { config } = await (await s.call('/config', { method: 'PUT', body: { replyReaction: { emoji: '🍞' } } })).json();
  assert.equal(config.replyReaction.emoji, '🍞');
  assert.equal((await s.store.getConfig()).replyReaction.emoji, '🍞');
});

test('API panelu: metadane komend i nadpisania uprawnień', async () => {
  const s = await setup();
  const { commands } = await (await s.call('/commands')).json();
  assert.ok(commands.length >= 20);
  const kick = commands.find((c) => c.name === 'kick');
  assert.equal(kick.permissionLabel, 'Wyrzucanie członków');
  const pomoc = commands.find((c) => c.name === 'pomoc');
  assert.equal(pomoc.permission, null);
  assert.equal(pomoc.permissionLabel, 'Każdy (bez wymaganych uprawnień)');

  const guild = await (await s.call('/guild')).json();
  assert.ok(guild.roles.every((r) => typeof r.permissions === 'string' && typeof r.position === 'number'));

  const roleId = '100000000000000099'; // ID jak prawdziwy snowflake — krótkie ID z atrapy Discorda odpadłyby w sanitizerze
  const { config } = await (
    await s.call('/config', { method: 'PUT', body: { commandPermissions: { kick: [roleId], falszywa: ['x'] } } })
  ).json();
  assert.deepEqual(config.commandPermissions, { kick: [roleId] });
});

test('hasło panelu: zmienione w panelu ma pierwszeństwo przed sekretem, bez sekretu generuje się samo', async () => {
  const s = await setup();
  assert.equal((await s.call('/password', { method: 'POST', body: { next: 'nowehaslo123' } })).status, 200);
  assert.equal((await s.call('/status')).status, 401, 'hasło z sekretu przestaje działać');
  assert.equal((await s.call('/status', { password: 'nowehaslo123' })).status, 200);

  // Bez sekretu PANEL_PASSWORD hasło jest generowane automatycznie i trzymane w bot.state.
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord, env: { panelPassword: '' } });
  const handle = createHandler(bot);
  const call = (path, opts = {}) => handle(new Request(`${BASE}${path}`, { method: opts.method ?? 'GET', headers: { 'x-panel-password': opts.password ?? '', 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined }));

  const denied = await call('/status');
  assert.equal(denied.status, 401);
  const generated = await store.getState('panel_password');
  assert.ok(generated && generated.length >= 20, 'hasło wygenerowane samo przy pierwszym użyciu');
  assert.equal((await call('/status', { password: generated })).status, 200);

  const changed = await call('/password', { method: 'POST', password: generated, body: { next: 'moje-nowe-haslo' } });
  assert.equal(changed.status, 200);
  assert.equal(await store.getState('panel_password'), 'moje-nowe-haslo');
  assert.equal((await call('/status', { password: generated })).status, 401, 'stare hasło już nie działa');
  assert.equal((await call('/status', { password: 'moje-nowe-haslo' })).status, 200);

  const tooShort = await call('/password', { method: 'POST', password: 'moje-nowe-haslo', body: { next: 'x' } });
  assert.equal(tooShort.status, 400);
});

test('adres panelu w funkcji przekierowuje na GitHub Pages, a API wpuszcza tylko stronę panelu (CORS)', async () => {
  const s = await setup();
  for (const url of ['https://x.supabase.co/functions/v1/hopkostki-bot/panel', `${BASE}/`]) {
    const res = await s.handle(new Request(url));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), PANEL_SITE);
  }

  const origin = new URL(PANEL_SITE).origin;
  const preflight = await s.handle(new Request(`${BASE}/config`, { method: 'OPTIONS', headers: { origin } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-panel-password/);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);

  const ok = await s.handle(new Request(`${BASE}/status`, { headers: { origin, 'x-panel-password': 'tajne' } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), origin);
  const denied = await s.handle(new Request(`${BASE}/status`, { headers: { origin } }));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), origin, 'przeglądarka musi móc przeczytać „złe hasło”');

  const stranger = await s.handle(new Request(`${BASE}/status`, { headers: { origin: 'https://evil.example', 'x-panel-password': 'tajne' } }));
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);

  // Konto na GitHubie zmieniło nazwę (NotKairo → E7Que): strona jest teraz na e7que.github.io, a starą
  // domenę może zająć ktoś inny, więc nie jest już wpuszczana.
  assert.equal(origin, 'https://e7que.github.io');
  const old = await s.handle(new Request(`${BASE}/status`, { headers: { origin: 'https://notkairo.github.io', 'x-panel-password': 'tajne' } }));
  assert.equal(old.headers.get('access-control-allow-origin'), null);
});

test('API panelu: usuwanie ostrzeżenia i ręczne odbanowanie', async () => {
  const s = await setup();
  const warn = await s.store.addWarn({ guildId: 'g1', userId: 'target', userTag: 'a', moderatorId: 'm', moderatorTag: 'mod', reason: 'r', points: 1, caseId: null }, 60);
  const list = await (await s.call('/warns')).json();
  assert.equal(list.users[0].warns[0].id, warn.id);
  assert.equal((await s.call(`/warns/${warn.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(await s.store.getWarn(warn.id), null);

  s.discord.state.bans.set('target', { user: s.discord.state.users.get('target') });
  await s.store.setTempBan({ guildId: 'g1', userId: 'target', userTag: 'hurownik_og', expiresAt: Date.now() + 1e6, caseId: 1 });
  assert.equal((await s.call('/tempbans/target/unban', { method: 'POST' })).status, 404, 'tylko liczbowe ID');
});

test('lokalny panel serwuje frontend i przekazuje resztę żądań do bota z hasłem przeglądarki', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, password: req.headers['x-panel-password'], session: req.headers['x-panel-session'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const botUrl = `http://127.0.0.1:${upstream.address().port}/functions/v1/hopkostki-bot`;
  const panel = createPanelServer({ botUrl });
  await new Promise((resolve) => panel.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${panel.address().port}`;
  try {
    // Statyka: serwowana lokalnie, bez pytania bota.
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Panel — Entuzjaści Hopkostki/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(seen.length, 0);

    // Wszystko inne: przekazane 1:1 do bota razem z hasłem, jakie wysłała przeglądarka.
    assert.deepEqual(await (await fetch(`${base}/cases?page=2`, { headers: { 'x-panel-password': 'tajne' } })).json(), { ok: true });
    assert.deepEqual(seen[0], { method: 'GET', url: '/functions/v1/hopkostki-bot/panel/cases?page=2', password: 'tajne', session: undefined });

    const write = await fetch(`${base}/config`, { method: 'PUT', body: '{}', headers: { 'x-panel-password': 'inne' } });
    assert.equal(write.status, 200, 'proxy nie blokuje zapisów — hasło sprawdza sam bot');
    assert.equal(seen[1].password, 'inne');

    // Sesja moderatora z kodu /login też idzie do bota (to on sprawdza jej role).
    await fetch(`${base}/tickets`, { headers: { 'x-panel-session': 'token-sesji' } });
    assert.equal(seen[2].session, 'token-sesji');

    const evil = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: panel.address().port, path: '/', headers: { Host: 'evil.example.com' } }, (res) => resolve(res.statusCode));
    });
    assert.equal(evil, 403);
  } finally {
    panel.close();
    upstream.close();
  }
});
