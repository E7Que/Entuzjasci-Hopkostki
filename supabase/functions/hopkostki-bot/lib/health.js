// Alerty o awarii bota, w dwóch warstwach:
//  1. healthTick (w każdym przebiegu crona, co 30 s): funkcja bota działa, ale coś jest nie tak — nie łączy się
//     z Discordem (gateway), Discord nie przesyła komend albo któreś zadanie okresowe ciągle się wysypuje.
//     Wiadomość o problemie i o jego końcu idzie przez API bota na kanał alertów.
//  2. Strażnik w bazie (bot.health_watchdog, pg_cron co 5 min — migracja 20261116010000): gdy sama funkcja bota
//     przestaje odpowiadać, wysyła alarm przez webhook na tym samym kanale. Webhook zakłada tu funkcja bota
//     i zapisuje go w bot.state('alert_webhook') razem z ustawieniami, które czyta strażnik.

import { COLORS } from './embeds.js';

const WEBHOOK_RETRY_MS = 30 * 60_000;
const STEP_FAIL_LIMIT = 10; // ~5 min nieudanych przebiegów crona z rzędu

export const webhookUrl = (hook) => `https://discord.com/api/webhooks/${hook.id}/${hook.token}`;

// Kanał alertów: własny albo kanał logów moderacji.
export function alertChannel(config) {
  return config.alerts.channelId || config.modLogChannelId || '';
}

// Webhook na kanale alertów (dla strażnika w bazie) + ustawienia strażnika w bot.state.
async function ensureWebhook(bot, config, now) {
  const a = config.alerts;
  const channelId = alertChannel(config);
  const saved = (await bot.store.getState('alert_webhook')) ?? {};
  const settings = { enabled: Boolean(a.enabled && channelId), minutes: a.minutes, pingRoleId: a.pingRoleId || null };
  if (!settings.enabled) {
    if (saved.enabled !== false) await bot.store.setState('alert_webhook', { ...saved, ...settings });
    return saved;
  }
  if (saved.url && saved.channelId === channelId) {
    if (saved.enabled !== settings.enabled || saved.minutes !== settings.minutes || saved.pingRoleId !== settings.pingRoleId) {
      await bot.store.setState('alert_webhook', { ...saved, ...settings });
    }
    return saved;
  }
  if (saved.error && saved.channelId === channelId && now - (saved.triedAt ?? 0) < WEBHOOK_RETRY_MS) return saved;
  try {
    const hook = await bot.discord.post(`/channels/${channelId}/webhooks`, { name: 'Strażnik bota' }, { reason: 'Alarm, gdy bot przestanie działać' });
    if (saved.id && saved.channelId !== channelId) await bot.discord.delete(`/webhooks/${saved.id}`).catch(() => {});
    const next = { ...settings, channelId, id: hook.id, url: webhookUrl(hook), error: null, triedAt: now };
    await bot.store.setState('alert_webhook', next);
    return next;
  } catch (error) {
    const next = { ...saved, ...settings, channelId, url: saved.channelId === channelId ? saved.url : null, error: error.message, triedAt: now };
    await bot.store.setState('alert_webhook', next);
    return next;
  }
}

const minutesSince = (now, ms) => Math.max(1, Math.round((now - ms) / 60_000));

// Aktualne problemy: { klucz: tekst }.
async function currentProblems(bot, config, report, health, now) {
  const problems = {};
  const limitMs = config.alerts.minutes * 60_000;
  const gw = await bot.store.getState('gateway_status');
  if (gw?.connectedAt) health.gatewayGoodAt = Math.max(health.gatewayGoodAt ?? 0, gw.connectedAt);
  health.gatewayGoodAt ??= now; // pierwszy przebieg po wdrożeniu — dajemy botowi czas
  if (bot.env.token && now - health.gatewayGoodAt > limitMs) {
    const why = gw?.error ? ` Ostatni błąd: ${gw.error}` : gw?.endedAt && now - gw.endedAt > limitMs ? ' Sesje połączenia w ogóle się nie uruchamiają (zadanie „hopkostki-bot-gateway” w pg_cron).' : '';
    problems.gateway = `Bot nie łączy się z Discordem od ${minutesSince(now, health.gatewayGoodAt)} min — nie widzi wiadomości i zdarzeń serwera (XP, automoderacja, logi). Komendy i przyciski działają dalej.${why}`;
  }
  const setup = await bot.store.getState('setup');
  if (setup?.endpointError) problems.endpoint = `Discord nie przesyła komend do bota: ${setup.endpointError}`;
  health.stepFails ??= {};
  for (const [name, result] of Object.entries(report ?? {})) {
    const failed = result && typeof result === 'object' && 'error' in result && Object.keys(result).length === 1;
    health.stepFails[name] = failed ? (health.stepFails[name] ?? 0) + 1 : 0;
    if (health.stepFails[name] >= STEP_FAIL_LIMIT) problems[`step:${name}`] = `Zadanie okresowe „${name}” nie działa: ${result.error}`;
  }
  return problems;
}

function alertEmbed(title, lines, color) {
  return { title, description: lines.join('\n\n').slice(0, 4000), color, timestamp: new Date().toISOString() };
}

// Wywoływane na końcu każdego przebiegu crona, z jego raportem.
export async function healthTick(bot, report = {}, { now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const a = config.alerts;
  const channelId = alertChannel(config);
  if (bot.discord) await ensureWebhook(bot, config, now);
  const health = (await bot.store.getState('health_state')) ?? {};
  const problems = await currentProblems(bot, config, report, health, now);
  health.active ??= {};
  const started = Object.entries(problems).filter(([key]) => !health.active[key]);
  const ended = Object.keys(health.active).filter((key) => !problems[key]);
  for (const [key, text] of started) health.active[key] = { since: now, text };
  for (const key of ended) delete health.active[key];
  await bot.store.setState('health_state', health);
  if (!a.enabled || !channelId || !bot.discord || (!started.length && !ended.length)) return { problems: Object.keys(problems), sent: 0 };

  const messages = [];
  if (started.length) {
    messages.push({
      ...(a.pingRoleId ? { content: `<@&${a.pingRoleId}>` } : {}),
      embeds: [alertEmbed('⚠️ Bot ma problem', started.map(([, text]) => text), COLORS.error)],
      allowed_mentions: { parse: [], roles: a.pingRoleId ? [a.pingRoleId] : [] },
    });
  }
  if (ended.length) {
    messages.push({ embeds: [alertEmbed('✅ Problem rozwiązany', ended.map((key) => `Już działa: ${LABELS[key.split(':')[0]] ?? key}.`), COLORS.success)], allowed_mentions: { parse: [] } });
  }
  let sent = 0;
  for (const message of messages) {
    await bot.discord
      .post(`/channels/${channelId}/messages`, message)
      .then(() => {
        sent += 1;
      })
      .catch((error) => console.warn(`[alert] ${error.message}`));
  }
  return { problems: Object.keys(problems), sent };
}

const LABELS = {
  gateway: 'połączenie z Discordem',
  endpoint: 'odbieranie komend',
  step: 'zadania okresowe',
};

// Panel → „Wyślij test”: najpierw przez API bota, potem przez webhook strażnika (sprawdza obie drogi).
export async function sendAlertTest(bot, who = 'panel') {
  const config = await bot.store.getConfig();
  const channelId = alertChannel(config);
  if (!channelId) throw new Error('Wybierz kanał alertów albo kanał logów moderacji.');
  await bot.discord.post(`/channels/${channelId}/messages`, {
    embeds: [alertEmbed('🔔 Test alertów', [`Tak będą wyglądać alerty o problemach z botem (test wysłał: ${who}).`], COLORS.info)],
    allowed_mentions: { parse: [] },
  });
  const hook = await ensureWebhook(bot, config, Date.now());
  if (!hook.url) return { bot: true, watchdog: false, error: hook.error ?? 'Brak webhooka' };
  await bot.discord.post(`/webhooks/${hook.id}/${hook.url.split('/').at(-1)}`, {
    username: 'Strażnik bota',
    content: '🔔 Test strażnika: ta wiadomość przyszła przez webhook — dotrze nawet wtedy, gdy funkcja bota przestanie działać.',
    allowed_mentions: { parse: [] },
  });
  return { bot: true, watchdog: true };
}
