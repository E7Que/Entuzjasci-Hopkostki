import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { badgesText, levelBadges } from '../supabase/functions/hopkostki-bot/lib/levels.js';

test('odznaki: najwyższy zdobyty stopień w kategorii, następny stopień w opisie, wygrane i podium', () => {
  assert.deepEqual(levelBadges({ level: 9, messages: 99, voiceMinutes: 599 }, {}), [], 'nic poniżej pierwszych progów');
  const badges = levelBadges({ level: 27, messages: 1500, voiceMinutes: 30000 }, { week: 2, month: 1, weekPodium: 3, monthPodium: 2 });
  assert.deepEqual(badges.map((b) => [b.id, b.name, b.tier ?? b.count]), [
    ['level', 'Poziom 25', 2],
    ['messages', 'Gaduła', 2],
    ['voice', 'Mieszka na głosowym', 3],
    ['month', 'Zwycięzca miesiąca', 1],
    ['week', 'Zwycięzca tygodnia', 2],
    ['podium', 'Na podium', 2],
  ]);
  assert.match(badges[0].description, /^Zdobyta za poziom 25\. Następny stopień: poziom 50\.$/);
  assert.match(badges[1].description, /Następny stopień: Legenda czatu \(10\D?000 wiadomości\)\./);
  assert.match(badges[2].description, /Najwyższy stopień!/);
  assert.equal(badgesText(badges.slice(3)), '👑 **Zwycięzca miesiąca** · 🏆 **Zwycięzca tygodnia** ×2 · 🥉 **Na podium** ×2');
});

test('odznaki: wygrane i podium z archiwum zwycięzców', async () => {
  const { store } = await createTestStore();
  const top = (...ids) => ids.map((userId, i) => ({ userId, periodXp: 1000 - i }));
  await store.archiveWinners('week', '2026-W45', top('a', 'b', 'c', 'd'));
  await store.archiveWinners('week', '2026-W46', top('b', 'a', 'c'));
  await store.archiveWinners('month', '2026-10', top('a', 'c'));
  assert.deepEqual(await store.levelWins('a'), { week: 1, month: 1, weekPodium: 2, monthPodium: 1 });
  assert.deepEqual(await store.levelWins('c'), { week: 0, month: 0, weekPodium: 2, monthPodium: 1 });
  assert.deepEqual(await store.levelWins('d'), { week: 0, month: 0, weekPodium: 0, monthPodium: 0 }, '4. miejsce się nie liczy');
});
