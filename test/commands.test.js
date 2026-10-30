import test from 'node:test';
import assert from 'node:assert/strict';
import { commandDefinitions } from '../supabase/functions/hopkostki-bot/lib/commands.js';

const NAME = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}_-]{1,32}$/u;

function checkOptions(options = [], where) {
  let optionalSeen = false;
  assert.ok(options.length <= 25, `${where}: max 25 opcji`);
  for (const o of options) {
    assert.match(o.name, NAME, `${where}: nazwa ${o.name}`);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, `${where}.${o.name}: opis`);
    if (o.type === 1) checkOptions(o.options, `${where} ${o.name}`);
    else {
      if (o.required) assert.equal(optionalSeen, false, `${where}: wymagana opcja ${o.name} po opcjonalnej`);
      else optionalSeen = true;
      assert.ok((o.choices ?? []).length <= 25);
    }
  }
}

test('definicje komend spełniają zasady API Discorda', () => {
  const defs = commandDefinitions();
  assert.deepEqual(
    defs.map((d) => d.name).sort(),
    [
      'afk', 'ankieta', 'avatar', 'ban', 'bumpy', 'clear', 'czlonkowie', 'emoji', 'historia', 'info', 'kick', 'konkurs', 'lock', 'login', 'losuj',
      'nick', 'notatka', 'ogloszenie', 'pomoc', 'powiedz', 'profil', 'propozycja', 'przypomnij', 'rola', 'rolainfo', 'serwer',
      'slowmode', 'snipe', 'sprawa', 'sprawy', 'timeout', 'unban', 'unlock', 'untimeout', 'warn', 'zaproszenia',
    ],
  );
  for (const def of defs) {
    assert.match(def.name, NAME);
    assert.ok(def.description.length <= 100);
    assert.deepEqual(def.contexts, [0]);
    checkOptions(def.options, def.name);
  }
  assert.ok(JSON.stringify(defs).length < 64_000);
});
