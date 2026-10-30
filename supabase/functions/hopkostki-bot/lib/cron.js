// Zadania uruchamiane co 30 s przez pg_cron:
// - konfiguracja aplikacji (rejestracja komend, adres Interactions Endpoint),
// - zdejmowanie wygasłych tymczasowych banów i usuwanie wygasłych ostrzeżeń,
// - reakcje 🫓 pod odpowiedziami na wiadomości o karach (zapas, gdyby sesja gateway coś przegapiła),
// - przypominajka o bumpie, przypomnienia (/przypomnij), koniec konkursów, czyszczenie pamięci wiadomości.

import { commandDefinitions, fillCommandPermissions } from './commands.js';
import { getApp, resolveGuildId, expireTempBan, logExpiredWarns } from './moderation.js';
import { reactionPath } from './rest.js';
import { sha256Hex } from './verify.js';
import { cleanupTempVoice } from './voice.js';
import { autoRoleSweep, ensureIntentFlags } from './members.js';
import { bumpReminderTick, bumpScan } from './bump.js';
import { seedMemberProfiles } from './logs.js';
import { ensureInviteSnapshot } from './invites.js';
import { sendDueReminders, finishDueGiveaways } from './community.js';

const SETUP_EVERY_MS = 10 * 60_000;
const PAGES_PER_CHANNEL = 5;

async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`[cron:${name}]`, error);
    return { error: error.message };
  }
}

export async function ensureSetup(bot, { force = false } = {}) {
  const last = await bot.store.getState('setup');
  if (!force && last?.ok && Date.now() - last.checkedAt < SETUP_EVERY_MS) return { ...last, cached: true };

  const app = await getApp(bot, { force: true });
  await bot.store.setState('app', { id: app.id, verifyKey: app.verify_key, name: app.name });
  const guildId = await resolveGuildId(bot);

  const definitions = commandDefinitions();
  const commandsHash = await sha256Hex(JSON.stringify({ guildId, definitions }));
  let commandsRegisteredAt = last?.commandsRegisteredAt ?? null;
  if (force || last?.commandsHash !== commandsHash || last?.guildId !== guildId) {
    await bot.discord.put(`/applications/${app.id}/guilds/${guildId}/commands`, definitions);
    commandsRegisteredAt = Date.now();
  }

  // Discord sprawdza nowy adres, wysyłając do niego PING — dlatego klucz publiczny zapisujemy wyżej.
  let endpoint = app.interactions_endpoint_url ?? null;
  let endpointError = null;
  if (bot.env.selfUrl && endpoint !== bot.env.selfUrl) {
    try {
      const updated = await bot.discord.patch('/applications/@me', { interactions_endpoint_url: bot.env.selfUrl });
      endpoint = updated?.interactions_endpoint_url ?? bot.env.selfUrl;
      bot.cache.delete('app');
    } catch (error) {
      endpointError = error.message;
    }
  }

  const intents = await ensureIntentFlags(bot, await bot.store.getConfig()).catch((error) => ({ error: error.message }));

  const setup = {
    ok: !endpointError,
    checkedAt: Date.now(),
    appId: app.id,
    appName: app.name,
    guildId,
    commandsHash,
    commandsRegisteredAt,
    endpoint,
    endpointError,
    intents,
  };
  await bot.store.setState('setup', setup);
  return setup;
}

function isBefore(a, b) {
  return BigInt(a) < BigInt(b);
}

function emojiMatches(reactionEmoji, configured) {
  const custom = /^<a?:(\w+):(\d+)>$/.exec(configured.trim());
  return custom ? reactionEmoji?.id === custom[2] : reactionEmoji?.name === configured.trim();
}

export async function pollReplies(bot) {
  const config = await bot.store.getConfig();
  const { enabled, emoji } = config.replyReaction;
  if (!enabled || !emoji) return 0;

  let reacted = 0;
  for (const channel of await bot.store.recentModChannels(7)) {
    let after = channel.cursor && !isBefore(channel.cursor, channel.firstMessageId) ? channel.cursor : channel.firstMessageId;
    try {
      for (let page = 0; page < PAGES_PER_CHANNEL; page += 1) {
        const messages = await bot.discord.get(`/channels/${channel.channelId}/messages`, { query: { after, limit: 100 } });
        if (!messages?.length) break;
        messages.sort((a, b) => (isBefore(a.id, b.id) ? -1 : 1));

        const replies = messages.filter(
          (m) => !m.author?.bot && m.message_reference?.message_id && (m.message_reference.type ?? 0) === 0,
        );
        const modIds = await bot.store.filterModMessages([...new Set(replies.map((m) => m.message_reference.message_id))]);
        for (const reply of replies) {
          if (!modIds.has(reply.message_reference.message_id)) continue;
          if (reply.reactions?.some((r) => r.me && emojiMatches(r.emoji, emoji))) continue;
          await bot.discord
            .put(`/channels/${channel.channelId}/messages/${reply.id}/reactions/${reactionPath(emoji)}/@me`)
            .then(() => {
              reacted += 1;
            })
            .catch((error) => console.warn(`[reakcja] ${error.message}`));
        }

        after = messages.at(-1).id;
        await bot.store.setCursor(channel.channelId, after);
        if (messages.length < 100) break;
      }
    } catch (error) {
      console.warn(`[reakcje] Kanał ${channel.channelId}: ${error.message}`);
    }
  }
  return reacted;
}

export async function runCron(bot, { force = false } = {}) {
  if (!(await bot.store.acquireCronLock())) return { skipped: 'poprzedni przebieg jeszcze trwa' };
  const report = {};
  try {
    report.setup = await step('setup', async () => {
      const setup = await ensureSetup(bot, { force });
      return { ok: setup.ok, cached: Boolean(setup.cached), endpointError: setup.endpointError };
    });
    report.tempBans = await step('tempBans', async () => {
      const due = await bot.store.dueTempBans();
      for (const ban of due) await expireTempBan(bot, ban);
      return due.length;
    });
    report.warns = await step('warns', async () => {
      const expired = await bot.store.expireWarns();
      await logExpiredWarns(bot, expired);
      return expired.length;
    });
    report.reactions = await step('reactions', () => pollReplies(bot));
    report.tempVoice = await step('tempVoice', () => cleanupTempVoice(bot));
    report.permissions = await step('permissions', async () => (await fillCommandPermissions(bot)).changed);
    report.autoRole = await step('autoRole', () => autoRoleSweep(bot));
    report.bump = await step('bump', async () => ({ found: await bumpScan(bot), reminded: await bumpReminderTick(bot) }));
    report.reminders = await step('reminders', () => sendDueReminders(bot));
    report.profiles = await step('profiles', () => seedMemberProfiles(bot));
    report.invites = await step('invites', async () => ensureInviteSnapshot(bot, await bot.store.getConfig()));
    report.giveaways = await step('giveaways', () => finishDueGiveaways(bot));
    await step('prune', async () => {
      await bot.store.pruneModMessages(30);
      await bot.store.pruneMessageCache(7);
      await bot.store.prunePanelSessions();
    });
    await bot.store.setState('cron_last_run', { at: Date.now(), report });
  } finally {
    await bot.store.releaseCronLock();
  }
  return report;
}
