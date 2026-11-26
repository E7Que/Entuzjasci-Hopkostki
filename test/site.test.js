import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot } from './support/discord.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';

const BASE = 'https://x.supabase.co/functions/v1/hopkostki-bot/panel';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setup() {
  const { store } = await createTestStore();
  const bot = makeBot({ store, discord: fakeDiscord() });
  const handle = createHandler(bot);
  const call = (path, { method = 'GET', body } = {}) =>
    handle(new Request(`${BASE}${path}`, { method, headers: { 'x-panel-password': 'tajne', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
  return { store, call };
}

test('Wygląd strony: wgrana ikona i osobne banery trafiają do /public/site', async () => {
  const s = await setup();
  const empty = await (await s.call('/public/site')).json();
  assert.deepEqual(empty, { icon: '', banners: { home: '', ranking: '', events: '' } });

  const icon = await (await s.call('/site/image', { method: 'POST', body: { data: PNG } })).json();
  const banner = await (await s.call('/site/image', { method: 'POST', body: { data: PNG } })).json();
  assert.match(icon.url, /\/panel\/public\/asset\/[a-f0-9]{24}\.png$/);

  const config = await (await s.call('/config')).json();
  const saved = await s.call('/config', { method: 'PUT', body: { ...config, site: { icon: icon.url, bannerHome: '', bannerRanking: banner.url, bannerEvents: 'https://zly.example/obrazek.png' } } });
  assert.equal(saved.status, 200);
  const look = await (await s.call('/public/site')).json();
  assert.equal(look.icon, icon.url);
  assert.equal(look.banners.ranking, banner.url);
  assert.equal(look.banners.home, '');
  assert.equal(look.banners.events, '', 'obcy adres obrazka nie przechodzi');

  const file = await s.call(new URL(look.icon).pathname.replace('/functions/v1/hopkostki-bot/panel', ''));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
});
