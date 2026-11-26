// Przypominajka o bumpie na DISBOARD (jak Fibo). Gdy ktoś użyje /bump i DISBOARD potwierdzi podbicie,
// bot odpowiada na tę wiadomość podziękowaniem, a po intervalMinutes wysyła „Czas na Bump!” jako
// odpowiedź na ostatni bump, oznaczając wybrane role. Wiadomości DISBOARD przychodzą z gatewaya
// (MESSAGE_CREATE); cron co 2 minuty przegląda też kanał bumpów na wypadek, gdyby gateway coś przegapił.

import { isOurGuild, resolveGuildId } from './moderation.js';
import { colorInt, escapeMarkdown, fillTemplate } from './embeds.js';
import { discordTimestamp } from './duration.js';

export const DISBOARD_ID = '302050872383242240';
const SCAN_EVERY_MS = 2 * 60_000;
const THANKS_MAX_AGE_MS = 5 * 60_000;

const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

// Czy to potwierdzenie udanego bumpa? Zwraca { user } albo null (np. „poczekaj jeszcze 50 minut”).
export function bumpInfo(message) {
  if (message?.author?.id !== DISBOARD_ID) return null;
  const name = message.interaction_metadata?.name ?? message.interaction?.name ?? null;
  const user = message.interaction_metadata?.user ?? message.interaction?.user ?? null;
  if (!user || (name && name !== 'bump')) return null;
  const embed = message.embeds?.[0];
  const text = `${embed?.title ?? ''} ${embed?.description ?? ''} ${message.content ?? ''}`;
  // Udany bump ma obrazek „bot-command-image-bump”; odmowa („poczekaj jeszcze X minut”) go nie ma.
  if (/bot-command-image-bump/i.test(embed?.image?.url ?? '')) return { user };
  if (/wait|poczekaj|odczekaj|minut|cooldown/i.test(text)) return null;
  if (/bump done|:thumbsup:|👍|podbit/i.test(text)) return { user };
  // Bez intencji treści wiadomości Discord nie pokazuje embedów - wtedy wystarcza nazwa komendy.
  if (!embed && !message.content && name === 'bump') return { user };
  return null;
}

const replyTo = (channelId, messageId) => ({ message_id: messageId, channel_id: channelId, fail_if_not_exists: false });

export async function onBumpMessage(bot, message, { thanks = true } = {}) {
  if (message?.author?.id !== DISBOARD_ID) return null;
  const { bump } = await bot.store.getConfig();
  if (!bump.enabled || !(await isOurGuild(bot, message.guild_id))) return null;
  const info = bumpInfo(message);
  if (!info) return null;

  // Unikalny message_id: gateway i przegląd kanału przez crona nie policzą tego samego bumpa dwa razy.
  const saved = await bot.store.addBump({ userId: info.user.id, channelId: message.channel_id, messageId: message.id });
  if (!saved) return null;
  const at = snowflakeTime(message.id);
  const remindAt = at + bump.intervalMinutes * 60_000;
  const previous = await bot.store.getState('bump');
  if (!previous?.messageId || BigInt(message.id) > BigInt(previous.messageId)) {
    await bot.store.setState('bump', { userId: info.user.id, channelId: message.channel_id, messageId: message.id, at, remindAt, reminded: false });
  }

  if (thanks && bump.thanks.enabled && Date.now() - at < THANKS_MAX_AGE_MS) {
    const vars = {
      uzytkownik: `<@${info.user.id}>`,
      nick: escapeMarkdown(info.user.global_name ?? info.user.username ?? ''),
      liczba: await bot.store.bumpCount(info.user.id),
      nastepny: discordTimestamp(remindAt, 'R'),
      godzina: discordTimestamp(remindAt, 't'),
    };
    const t = bump.thanks;
    await bot.discord
      .post(`/channels/${message.channel_id}/messages`, {
        embeds: [
          {
            color: colorInt(t.color),
            ...(t.title ? { title: fillTemplate(t.title, vars).slice(0, 256) } : {}),
            description: fillTemplate(t.message, vars).slice(0, 4000) || '​',
          },
        ],
        allowed_mentions: { parse: [], replied_user: false },
        ...(t.reply ? { message_reference: replyTo(message.channel_id, message.id) } : {}),
      })
      .catch((error) => console.warn(`[bump] podziękowanie: ${error.message}`));
  }
  return saved;
}

// Cron: przypomnienie, gdy minął czas od ostatniego bumpa.
export async function bumpReminderTick(bot) {
  const { bump } = await bot.store.getConfig();
  if (!bump.enabled) return 0;
  const state = await bot.store.getState('bump');
  if (!state?.remindAt || state.reminded || Date.now() < state.remindAt) return 0;
  await bot.store.setState('bump', { ...state, reminded: true, remindedAt: Date.now() });

  const channelId = bump.channelId || state.channelId;
  const r = bump.reminder;
  const reply = r.reply && channelId === state.channelId && state.messageId;
  await bot.discord.post(`/channels/${channelId}/messages`, {
    content: bump.roleIds.map((id) => `<@&${id}>`).join(' '),
    allowed_mentions: { roles: bump.roleIds, replied_user: false },
    embeds: [
      {
        color: colorInt(r.color),
        ...(r.title ? { title: r.title.slice(0, 256) } : {}),
        description: fillTemplate(r.message, { uzytkownik: `<@${state.userId}>` }).slice(0, 4000) || '​',
      },
    ],
    ...(reply ? { message_reference: replyTo(state.channelId, state.messageId) } : {}),
  });
  return 1;
}

// Zapas: co 2 minuty ostatnie wiadomości z kanału bumpów (np. bump w chwili przerwy między sesjami gatewaya).
export async function bumpScan(bot) {
  const { bump } = await bot.store.getConfig();
  if (!bump.enabled || !bump.channelId) return 0;
  const last = await bot.store.getState('bump_scan');
  if (last && Date.now() - last < SCAN_EVERY_MS) return 0;
  await bot.store.setState('bump_scan', Date.now());
  const messages = await bot.discord.get(`/channels/${bump.channelId}/messages`, { query: { limit: 15 } });
  const state = await bot.store.getState('bump');
  let found = 0;
  const fresh = (messages ?? [])
    .filter((m) => m.author?.id === DISBOARD_ID && (!state?.messageId || BigInt(m.id) > BigInt(state.messageId)))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  // Wiadomości z REST nie mają guild_id - kanał bumpów jest na naszym serwerze.
  const guildId = fresh.length ? await resolveGuildId(bot) : null;
  for (const message of fresh) {
    if (await onBumpMessage(bot, { guild_id: guildId, ...message })) found += 1;
  }
  return found;
}
