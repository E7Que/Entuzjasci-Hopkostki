// Automoderacja: zaproszenia do innych serwerów, masowe oznaczenia, CAPS, zakazane słowa, flood i powtarzanie
// wiadomości, anty-rajd (dużo wejść naraz). Każdy filtr ma własną karę: usunięcie wiadomości, ostrzeżenie
// (punkty → progi z zakładki Ostrzeżenia) albo timeout. Moderatorzy, administratorzy, role i kanały z wyjątków
// są pomijani. Wszystko trafia na kanał logów automoderacji (albo logów moderacji).

import { P, memberPermissions } from './permissions.js';
import { cached, getGuildContext, isOurGuild, kickUser, timeoutUser, warnUser } from './moderation.js';
import { COLORS, escapeMarkdown } from './embeds.js';

const FILTER_LABELS = {
  invites: 'zaproszenie do innego serwera',
  mentions: 'masowe oznaczenia',
  caps: 'pisanie wielkimi literami',
  words: 'zakazane słowo',
  spam: 'spam',
};
const NOTICES = {
  invites: 'zaproszenia do innych serwerów są tu zabronione.',
  mentions: 'nie oznaczaj tylu osób naraz.',
  caps: 'nie pisz samymi wielkimi literami.',
  words: 'ta wiadomość zawierała niedozwolone słowo.',
  spam: 'zwolnij — za dużo wiadomości naraz.',
};
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([a-z0-9-]{2,32})/gi;
const EXEMPT_PERMS = P.ADMINISTRATOR | P.MANAGE_MESSAGES | P.MANAGE_GUILD | P.MODERATE_MEMBERS;
const NOTICE_MS = 8000;
const SPAM_COOLDOWN_MS = 30_000;
const DAY = 86_400_000;

// ---------- Tekst ----------

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
// Małe litery bez polskich znaków i „leetspeaku” (k0rwa → korwa), żeby filtr słów był odporny na proste obejścia.
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$!]/g, (c) => LEET[c]);
}

// Lista: jedno słowo/fraza na wpis; „słowo*” = wszystko, co się od niego zaczyna. Litery rozstrzelone spacjami
// („k u r w a”) też są łapane. Zwraca pierwszy pasujący wpis albo null.
export function findBannedWord(text, list = []) {
  const norm = normalizeText(text);
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const joined = [];
  let run = '';
  for (const token of tokens) {
    if (token.length === 1) run += token;
    else {
      if (run.length >= 3) joined.push(run);
      run = '';
    }
  }
  if (run.length >= 3) joined.push(run);
  const words = [...tokens, ...joined];
  for (const raw of list) {
    const entry = normalizeText(raw).trim();
    const prefix = entry.endsWith('*');
    const word = entry.replace(/\*+$/, '').trim();
    if (word.length < 2) continue;
    if (/\s/.test(word)) {
      if (` ${tokens.join(' ')} `.includes(` ${word.split(/\s+/).join(' ')} `)) return raw;
    } else if (words.some((t) => (prefix ? t.startsWith(word) : t === word))) {
      return raw;
    }
  }
  return null;
}

// Udział wielkich liter wśród liter (bez emoji, oznaczeń i linków).
export function capsStats(text) {
  const letters = [...String(text ?? '').replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '')].filter((ch) => /\p{L}/u.test(ch));
  const upper = letters.filter((ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase()).length;
  return { letters: letters.length, ratio: letters.length ? upper / letters.length : 0 };
}

export function inviteCodes(text) {
  return [...String(text ?? '').matchAll(INVITE_RE)].map((m) => m[1]);
}

function mentionCount(message) {
  const users = new Set((message.mentions ?? []).map((u) => u.id).filter((id) => id !== message.author?.id));
  const everyone = /@(everyone|here)\b/.test(message.content ?? '') ? 1 : 0;
  return users.size + (message.mention_roles ?? []).length + everyone;
}

// ---------- Wyjątki ----------

async function isExempt(bot, config, message) {
  const a = config.automod;
  const roles = message.member?.roles ?? [];
  if (a.exemptChannelIds.includes(message.channel_id)) return true;
  if (roles.some((id) => a.exemptRoleIds.includes(id) || config.modRoleIds.includes(id))) return true;
  const { guild, roles: byId } = await getGuildContext(bot);
  if (message.author.id === guild.ownerId) return true;
  return (memberPermissions(roles, byId, guild.id) & EXEMPT_PERMS) !== 0n;
}

// ---------- Spam (pamięć w trakcie sesji połączenia — okna liczone w sekundach) ----------

const recent = new Map(); // userId → [{ at, id, channelId, text }]
const cooldowns = new Map(); // userId → do kiedy nie karać ponownie za spam
export function resetSpamMemory() {
  recent.clear();
  cooldowns.clear();
}

function checkSpam(settings, message, now) {
  const uid = message.author.id;
  const keepMs = Math.max(settings.seconds * 1000, 60_000);
  const list = (recent.get(uid) ?? []).filter((m) => now - m.at < keepMs);
  const text = normalizeText(message.content).replace(/\s+/g, ' ').trim();
  list.push({ at: now, id: message.id, channelId: message.channel_id, text });
  recent.set(uid, list.slice(-40));
  if ((cooldowns.get(uid) ?? 0) > now) return null;
  const burst = list.filter((m) => now - m.at < settings.seconds * 1000);
  if (settings.messages > 0 && burst.length >= settings.messages) {
    return { reason: `${burst.length} wiadomości w ${settings.seconds} s`, messages: burst };
  }
  const same = text ? list.filter((m) => m.text === text && now - m.at < 60_000) : [];
  if (settings.duplicates > 0 && same.length >= settings.duplicates) {
    return { reason: `ta sama wiadomość ${same.length} razy`, messages: same };
  }
  return null;
}

// ---------- Kary ----------

const automodLogChannel = (config) => config.automod.logChannelId || config.modLogChannelId || '';

async function deleteMessages(bot, messages) {
  const byChannel = new Map();
  for (const m of messages) byChannel.set(m.channelId, [...(byChannel.get(m.channelId) ?? []), m.id]);
  for (const [channelId, ids] of byChannel) {
    const unique = [...new Set(ids)];
    if (unique.length >= 2) {
      await bot.discord.post(`/channels/${channelId}/messages/bulk-delete`, { messages: unique.slice(0, 100) }, { reason: 'Automoderacja' }).catch(() => {});
    } else {
      await bot.discord.delete(`/channels/${channelId}/messages/${unique[0]}`, { reason: 'Automoderacja' }).catch(() => {});
    }
  }
}

async function punish(bot, config, message, { filter, detail, action, messages }) {
  const a = config.automod;
  await deleteMessages(bot, messages ?? [{ id: message.id, channelId: message.channel_id }]);
  const { botUser } = await getGuildContext(bot);
  const moderator = { id: botUser?.id ?? 'automod', username: 'AutoMod' };
  const target = { id: message.author.id, username: message.author.username };
  const reason = `AutoMod: ${FILTER_LABELS[filter]}${detail ? ` (${detail})` : ''}`;
  let outcome = 'usunięto wiadomość';
  try {
    if (action === 'warn') {
      await warnUser(bot, { target, moderator, reason, points: a.warnPoints, channelId: message.channel_id, auto: true, announce: false });
      outcome = `ostrzeżenie (${a.warnPoints} pkt)`;
    } else if (action === 'timeout') {
      await timeoutUser(bot, { target, moderator, reason, duration: { amount: a.timeoutMinutes, unit: 'm' }, auto: true, announce: false });
      outcome = `timeout na ${a.timeoutMinutes} min`;
    }
  } catch (error) {
    outcome += ` — kara się nie udała: ${error.message}`;
  }

  const tasks = [];
  if (a.notify) {
    // Krótka informacja na kanale, znika sama po kilku sekundach.
    tasks.push(
      bot.discord
        .post(`/channels/${message.channel_id}/messages`, { content: `<@${target.id}>, ${NOTICES[filter]}`, allowed_mentions: { users: [target.id] } })
        .then((notice) => {
          const timer = setTimeout(() => bot.discord.delete(`/channels/${message.channel_id}/messages/${notice.id}`).catch(() => {}), NOTICE_MS);
          timer?.unref?.();
        })
        .catch(() => {}),
    );
  }
  const logChannel = automodLogChannel(config);
  if (logChannel) {
    const excerpt = String(message.content ?? '').slice(0, 900);
    tasks.push(
      bot.discord
        .post(`/channels/${logChannel}/messages`, {
          embeds: [
            {
              title: `🛡️ Automoderacja: ${FILTER_LABELS[filter]}`,
              color: COLORS.warning,
              description: [
                `**Kto:** <@${target.id}> (${escapeMarkdown(target.username ?? '')})`,
                `**Kanał:** <#${message.channel_id}>`,
                `**Kara:** ${outcome}`,
                detail ? `**Powód:** ${escapeMarkdown(detail)}` : null,
                excerpt ? `**Treść:**\n>>> ${escapeMarkdown(excerpt)}` : null,
              ]
                .filter(Boolean)
                .join('\n'),
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: { parse: [] },
        })
        .catch((error) => console.warn(`[automod] Log: ${error.message}`)),
    );
  }
  await Promise.all(tasks);
  return { filter, action, outcome };
}

// ---------- Wiadomości ----------

// Zwraca { filter, action, outcome } po ukaraniu albo null. edited = edycja wiadomości (bez liczenia spamu).
export async function onMessageAutomod(bot, message, { edited = false, now } = {}) {
  if (!message?.guild_id || !message.author || message.author.bot || message.webhook_id || !message.member) return null;
  const config = await bot.store.getConfig();
  const a = config.automod;
  if (!a.enabled) return null;
  if (!(await isOurGuild(bot, message.guild_id))) return null;
  if (await isExempt(bot, config, message)) return null;
  const at = now ?? (Date.parse(message.timestamp ?? '') || Date.now());
  const content = message.content ?? '';

  if (a.words.enabled && a.words.list.length) {
    const word = findBannedWord(content, a.words.list);
    if (word) return punish(bot, config, message, { filter: 'words', detail: `„${word}”`, action: a.words.action });
  }
  if (a.invites.enabled) {
    const codes = inviteCodes(content);
    if (codes.length) {
      const { guild } = await getGuildContext(bot);
      for (const code of codes) {
        const invite = await cached(bot, `automodInvite:${code}`, 10 * 60_000, () => bot.discord.get(`/invites/${code}`).catch(() => null));
        if (!(a.invites.allowOwn && invite?.guild?.id === guild.id)) {
          return punish(bot, config, message, { filter: 'invites', detail: `discord.gg/${code}`, action: a.invites.action });
        }
      }
    }
  }
  if (a.mentions.enabled) {
    const count = mentionCount(message);
    if (count >= a.mentions.limit) return punish(bot, config, message, { filter: 'mentions', detail: `${count} oznaczeń`, action: a.mentions.action });
  }
  if (a.caps.enabled) {
    const caps = capsStats(content);
    if (caps.letters >= a.caps.minLength && caps.ratio * 100 >= a.caps.percent) {
      return punish(bot, config, message, { filter: 'caps', detail: `${Math.round(caps.ratio * 100)}% wielkich liter`, action: a.caps.action });
    }
  }
  if (a.spam.enabled && !edited) {
    const hit = checkSpam(a.spam, message, at);
    if (hit) {
      cooldowns.set(message.author.id, at + SPAM_COOLDOWN_MS);
      recent.delete(message.author.id);
      return punish(bot, config, message, { filter: 'spam', detail: hit.reason, action: a.spam.action, messages: hit.messages });
    }
  }
  return null;
}

// ---------- Anty-rajd ----------

const snowflakeTime = (id) => {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return 0;
  }
};

// GUILD_MEMBER_ADD: tyle wejść w tyle sekund = rajd. Alert (z pingiem roli alertów) i opcjonalnie wyrzucanie
// nowych kont (młodszych niż X dni) przez czas trwania trybu anty-rajdu — także tych, które weszły w tej fali.
export async function onMemberJoinAutomod(bot, data, { now = Date.now() } = {}) {
  const config = await bot.store.getConfig();
  const a = config.automod;
  const raid = a.raid;
  if (!a.enabled || !raid.enabled || !data?.user || data.user.bot) return null;
  if (!(await isOurGuild(bot, data.guild_id))) return null;
  const state = (await bot.store.getState('raid_state')) ?? { joins: [] };
  state.joins = [...(state.joins ?? []).filter((j) => now - j.at < raid.seconds * 1000), { at: now, id: data.user.id, name: data.user.username }].slice(-200);
  const active = (state.activeUntil ?? 0) > now;
  let started = false;
  if (!active && state.joins.length >= raid.joins) {
    started = true;
    state.activeUntil = now + raid.minutes * 60_000;
    state.startedAt = now;
  }
  await bot.store.setState('raid_state', state);
  if (!active && !started) return null;

  const young = (id) => raid.accountAgeDays === 0 || now - snowflakeTime(id) < raid.accountAgeDays * DAY;
  const toKick = raid.action === 'kick' ? (started ? state.joins : [state.joins.at(-1)]).filter((j) => young(j.id)) : [];
  let kicked = 0;
  if (toKick.length) {
    const { botUser } = await getGuildContext(bot);
    const moderator = { id: botUser?.id ?? 'automod', username: 'AutoMod' };
    for (const j of toKick) {
      await kickUser(bot, { target: { id: j.id, username: j.name }, moderator, reason: 'AutoMod: anty-rajd (masowe wejścia)', auto: true, announce: false })
        .then(() => {
          kicked += 1;
        })
        .catch((error) => console.warn(`[anty-rajd] ${error.message}`));
    }
  }
  if (started) {
    const channelId = automodLogChannel(config);
    const ping = config.alerts.pingRoleId;
    if (channelId) {
      const until = new Date(state.activeUntil).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
      await bot.discord
        .post(`/channels/${channelId}/messages`, {
          ...(ping ? { content: `<@&${ping}>` } : {}),
          embeds: [
            {
              title: '🚨 Możliwy rajd',
              color: COLORS.error,
              description: [
                `**${state.joins.length} osób** weszło na serwer w ${raid.seconds} s.`,
                raid.action === 'kick'
                  ? `Tryb anty-rajdu do **${until}**: nowe konta${raid.accountAgeDays ? ` (młodsze niż ${raid.accountAgeDays} dni)` : ''} są wyrzucane — teraz: ${kicked}.`
                  : `Tryb anty-rajdu do **${until}** — sprawdźcie nowe osoby (kara automatyczna wyłączona).`,
                `Ostatnie wejścia: ${state.joins.slice(-10).map((j) => `<@${j.id}>`).join(' ')}`,
              ].join('\n'),
              timestamp: new Date().toISOString(),
            },
          ],
          allowed_mentions: { parse: [], roles: ping ? [ping] : [] },
        })
        .catch((error) => console.warn(`[anty-rajd] Alert: ${error.message}`));
    }
  }
  return { started, active: true, kicked };
}
