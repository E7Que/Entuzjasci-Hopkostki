import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot } from './support/discord.js';
import { handlePanel, configChanges } from '../supabase/functions/hopkostki-bot/lib/panel.js';

test('dziennik zmian ustawień: zapisy z panelu, kto i które części, wpis do cofnięcia, tylko pełny dostęp', async () => {
  const { store } = await createTestStore();
  const bot = makeBot({ store, discord: null });
  const call = (method, path, extra = {}) => handlePanel(bot, { method, path, ...extra });
  await call('PUT', '/config', { body: { levels: { enabled: true }, automod: { enabled: true } } });
  await call('PUT', '/config', { body: { levels: { enabled: true } } });
  // Moderator z dostępem tylko do Ustawień: zapis jego części, podpisany jego nazwą.
  const limited = { kind: 'session', full: false, sections: ['ustawienia'], user: { id: '1', tag: 'kasia' } };
  await call('PUT', '/config', { body: { appealText: 'Nowy dopisek', levels: { enabled: false } }, auth: limited });

  const list = await call('GET', '/config/history');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((h) => [h.sections, h.changedBy]), [
    [['Ustawienia'], 'kasia'],
    [['Poziomy', 'Automoderacja'], 'hasło panelu'],
  ], 'zapis bez zmian nie tworzy wpisu; Poziomy u moderatora bez dostępu — pominięte');
  assert.equal((await store.getConfig()).levels.enabled, true);

  const entry = await call('GET', `/config/history/${list.body.items[1].id}`);
  assert.deepEqual([entry.body.changes.levels.before.enabled, entry.body.changes.levels.after.enabled], [false, true]);
  assert.deepEqual(Object.keys(entry.body.changes), ['levels', 'automod']);
  assert.equal((await call('GET', '/config/history/999')).status, 404);

  // Dziennik pokazuje wszystkie części — tylko dla pełnego dostępu.
  assert.equal((await call('GET', '/config/history', { auth: limited })).status, 403);
  assert.equal((await call('GET', `/config/history/${list.body.items[0].id}`, { auth: limited })).status, 403);
});

test('dziennik zmian: tylko zmienione klucze i najwyżej 100 wpisów', async () => {
  assert.deepEqual(configChanges({ a: 1, b: { c: [1] }, d: 'x' }, { a: 1, b: { c: [1, 2] }, d: 'y' }), {
    b: { before: { c: [1] }, after: { c: [1, 2] } },
    d: { before: 'x', after: 'y' },
  });
  assert.deepEqual(configChanges({ a: 1 }, { a: 1 }), {});
  const { store } = await createTestStore();
  assert.equal(await store.addConfigHistory({ changedBy: 'x', changes: {} }), null, 'bez zmian — bez wpisu');
  for (let i = 0; i < 105; i++) await store.addConfigHistory({ changedBy: `osoba ${i}`, changes: { appealText: { before: `${i}`, after: `${i + 1}` } } });
  const items = await store.listConfigHistory(200);
  assert.equal(items.length, 100);
  assert.equal(items[0].changedBy, 'osoba 104');
  assert.deepEqual(items[0].keys, ['appealText']);
});
