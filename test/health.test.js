import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot } from './support/discord.js';
import { healthTick, sendAlertTest } from '../supabase/functions/hopkostki-bot/lib/health.js';

const LOGS = '100000000000000900';
const ALERTS = '100000000000000901';
const PING = '100000000000000902';
const MIN = 60_000;

async function setup(config = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ modLogChannelId: LOGS, ...config });
  return { store, discord, bot };
}

test('alert: brak połączenia z Discordem dłużej niż X min → jedna wiadomość z pingiem, potem „rozwiązany”', async () => {
  const s = await setup({ alerts: { pingRoleId: PING, minutes: 5 } });
  const t0 = Date.UTC(2026, 10, 16, 1, 0);
  await s.store.setState('gateway_status', { connectedAt: t0, endedAt: t0 + 55_000, error: null });

  let r = await healthTick(s.bot, {}, { now: t0 + 2 * MIN });
  assert.deepEqual(r, { problems: [], sent: 0 });
  const hook = await s.store.getState('alert_webhook');
  assert.deepEqual([hook.channelId, hook.enabled, hook.minutes, hook.pingRoleId], [LOGS, true, 5, PING], 'webhook strażnika na kanale logów');
  assert.match(hook.url, /^https:\/\/discord\.com\/api\/webhooks\/wh-/);

  await s.store.setState('gateway_status', { connectedAt: t0, endedAt: t0 + 8 * MIN, error: 'Discord odrzucił token bota.', closeCode: 4004 });
  r = await healthTick(s.bot, {}, { now: t0 + 8 * MIN });
  assert.deepEqual(r, { problems: ['gateway'], sent: 1 });
  const alert = s.discord.state.channels.get(LOGS).at(-1);
  assert.equal(alert.content, `<@&${PING}>`);
  assert.deepEqual(alert.allowed_mentions, { parse: [], roles: [PING] });
  assert.equal(alert.embeds[0].title, '⚠️ Bot ma problem');
  assert.match(alert.embeds[0].description, /od 8 min.*Ostatni błąd: Discord odrzucił token bota\./s);

  r = await healthTick(s.bot, {}, { now: t0 + 9 * MIN });
  assert.equal(r.sent, 0, 'bez powtarzania tego samego alertu');

  await s.store.setState('gateway_status', { connectedAt: t0 + 10 * MIN, endedAt: t0 + 11 * MIN, error: null });
  r = await healthTick(s.bot, {}, { now: t0 + 11 * MIN });
  assert.deepEqual(r, { problems: [], sent: 1 });
  const ok = s.discord.state.channels.get(LOGS).at(-1);
  assert.equal(ok.embeds[0].title, '✅ Problem rozwiązany');
  assert.match(ok.embeds[0].description, /połączenie z Discordem/);
});

test('alert: zadanie okresowe wysypuje się 10 razy z rzędu; komendy nie docierają; własny kanał alertów', async () => {
  const s = await setup({ alerts: { channelId: ALERTS } });
  const t0 = Date.now();
  await s.store.setState('gateway_status', { connectedAt: t0, endedAt: t0 });
  for (let i = 0; i < 9; i += 1) assert.equal((await healthTick(s.bot, { voiceXp: { error: 'boom' } }, { now: t0 })).sent, 0);
  let r = await healthTick(s.bot, { voiceXp: { error: 'boom' }, warns: 0 }, { now: t0 });
  assert.deepEqual(r, { problems: ['step:voiceXp'], sent: 1 });
  assert.match(s.discord.state.channels.get(ALERTS).at(-1).embeds[0].description, /„voiceXp” nie działa: boom/);
  assert.equal(s.discord.state.channels.get(LOGS), undefined, 'alerty na własnym kanale');

  await s.store.setState('setup', { ok: false, endpointError: 'Discord nie zaakceptował adresu' });
  r = await healthTick(s.bot, { voiceXp: 3 }, { now: t0 });
  assert.equal(r.sent, 2, 'nowy problem + koniec starego');
  const [problem, fixed] = s.discord.state.channels.get(ALERTS).slice(-2);
  assert.match(problem.embeds[0].description, /nie przesyła komend/);
  assert.match(fixed.embeds[0].description, /zadania okresowe/);
});

test('alerty wyłączone: brak wiadomości, strażnik w bazie wyłączony; brak uprawnień do webhooka nie psuje crona', async () => {
  const s = await setup({ alerts: { enabled: false } });
  const t0 = Date.now();
  await s.store.setState('gateway_status', { connectedAt: t0 - 60 * MIN, endedAt: t0 - 60 * MIN });
  await s.store.setState('health_state', { gatewayGoodAt: t0 - 60 * MIN });
  const r = await healthTick(s.bot, {}, { now: t0 });
  assert.deepEqual(r, { problems: ['gateway'], sent: 0 });
  assert.equal((await s.store.getState('alert_webhook')).enabled, false);

  const t = await setup();
  t.discord.state.webhooksFail = true;
  await healthTick(t.bot, {}, { now: t0 });
  const hook = await t.store.getState('alert_webhook');
  assert.match(hook.error, /Missing Permissions/);
  assert.equal(hook.url, null);
  t.discord.state.webhooksFail = false;
  await healthTick(t.bot, {}, { now: t0 + 5 * MIN });
  assert.equal((await t.store.getState('alert_webhook')).url, null, 'ponowna próba dopiero po 30 min');
  await healthTick(t.bot, {}, { now: t0 + 31 * MIN });
  assert.match((await t.store.getState('alert_webhook')).url, /webhooks\/wh-/);
});

test('test alertów z panelu: wiadomość przez API bota i przez webhook strażnika', async () => {
  const s = await setup();
  const result = await sendAlertTest(s.bot, 'Kasia');
  assert.deepEqual(result, { bot: true, watchdog: true });
  assert.match(s.discord.state.channels.get(LOGS).at(-1).embeds[0].description, /test wysłał: Kasia/);
  assert.match(s.discord.state.webhookPosts.at(-1).body.content, /Test strażnika/);
  const noChannel = await setup({ modLogChannelId: '' });
  await assert.rejects(sendAlertTest(noChannel.bot), /Wybierz kanał alertów/);
});
