import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainDashes } from '../supabase/functions/hopkostki-bot/lib/dashes.js';
import { createRest } from '../supabase/functions/hopkostki-bot/lib/rest.js';

const EM = '—';
const EN = '–';

test('plainDashes: zamienia pauzy i półpauzy w tekstach, tablicach i obiektach', () => {
  const out = plainDashes({ a: `x ${EM} y`, b: [`1${EN}2`, 3, null], c: { d: `${EM}${EN}` }, e: true });
  assert.deepEqual(out, { a: 'x - y', b: ['1-2', 3, null], c: { d: '--' }, e: true });
});

test('REST: wiadomość wysłana przez bota nie ma pauz ani półpauz', async () => {
  const sent = [];
  const rest = createRest('t', { fetchImpl: async (url, init) => { sent.push(init); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
  await rest.post('/channels/1/messages', { content: `Witaj ${EM} miło Cię widzieć`, embeds: [{ title: `Zasady ${EN} serwer`, fields: [{ name: 'a', value: `b ${EM} c` }] }] });
  const body = JSON.parse(sent[0].body);
  assert.equal(body.content, 'Witaj - miło Cię widzieć');
  assert.equal(body.embeds[0].title, 'Zasady - serwer');
  assert.equal(body.embeds[0].fields[0].value, 'b - c');
});
