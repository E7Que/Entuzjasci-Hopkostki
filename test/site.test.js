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

test('Strona główna: liczba osób i awatary ostatnio dołączonych (bez botów, ukrytych i niezweryfikowanych)', async () => {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  discord.state.appFlags = 1 << 14; // intencja „Server Members”
  const bot = makeBot({ store, discord });
  const handle = createHandler(bot);
  const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  for (const m of discord.state.members.values()) m.joined_at = ago(1000);
  const add = (id, hours, extra = {}) => discord.state.members.set(id, { user: { id, username: `nick_${id}`, avatar: extra.avatar ?? null, bot: extra.bot ?? false }, roles: [], joined_at: ago(hours), pending: extra.pending ?? false, avatar: extra.guildAvatar ?? null });
  add('hid', 0.5, { avatar: 'h1' });
  add('n1', 1, { avatar: 'a1' });
  add('bot2', 1.5, { bot: true });
  add('pend', 1.7, { pending: true });
  add('n2', 2, { avatar: 'a2', guildAvatar: 'g2' });
  add('n3', 3);
  await store.setLevelHidden('hid', true);

  const res = await handle(new Request(`${BASE}/public/guild`));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.memberCount, 1337);
  assert.equal(body.newcomers.length, 5);
  assert.deepEqual(body.newcomers.slice(0, 3).map((n) => n.avatar), [
    'https://cdn.discordapp.com/avatars/n1/a1.png?size=96',
    'https://cdn.discordapp.com/guilds/g1/users/n2/avatars/g2.png?size=96',
    'https://cdn.discordapp.com/embed/avatars/0.png',
  ]);
  assert.ok(!JSON.stringify(body).includes('nick_'), 'bez nazw osób');
  assert.ok(!JSON.stringify(body).includes('/hid/'), 'bez osób ukrytych na stronie rankingu');

  // Nowa osoba: wejście unieważnia zapisaną listę, następne zapytanie ją pokazuje.
  const { forgetNewcomers } = await import('../supabase/functions/hopkostki-bot/lib/publicGuild.js');
  add('n0', 0.1, { avatar: 'a0' });
  await forgetNewcomers(bot);
  bot.cache.delete('newcomers');
  const again = await (await handle(new Request(`${BASE}/public/guild`))).json();
  assert.equal(again.newcomers[0].avatar, 'https://cdn.discordapp.com/avatars/n0/a0.png?size=96');

  // Bez intencji członków: liczby są, awatarów brak (strona pokazuje wtedy osoby z topki).
  discord.state.appFlags = 0;
  bot.cache.clear();
  await forgetNewcomers(bot);
  const none = await (await handle(new Request(`${BASE}/public/guild`))).json();
  assert.equal(none.memberCount, 1337);
  assert.deepEqual(none.newcomers, []);
});
