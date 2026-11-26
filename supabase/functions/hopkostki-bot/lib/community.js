// Funkcje społecznościowe (jak w Carl-bocie / ProBocie / StartIT): status AFK, przypomnienia,
// konkursy z przyciskiem „Weź udział” i propozycje z głosowaniem. Komendy są w communityCommands.js,
// tu jest logika używana też przez gateway (AFK), crona (przypomnienia, koniec konkursów) i przyciski.

import { isOurGuild, describeError, ActionError } from './moderation.js';
import { avatarUrl } from './rest.js';
import { COLORS, errorEmbed, escapeMarkdown, successEmbed } from './embeds.js';
import { discordTimestamp } from './duration.js';

const EPHEMERAL = 64;
const AFK_GRACE_MS = 30_000;
const GOLD = 0xf1c40f;

// ---------- AFK ----------

async function afkMap(bot) {
  const hit = bot.cache.get('afk');
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  const value = new Map((await bot.store.listAfk()).map((a) => [a.userId, a]));
  bot.cache.set('afk', { at: Date.now(), value });
  return value;
}

export async function setAfk(bot, userId, reason) {
  await bot.store.setAfk(userId, reason);
  bot.cache.delete('afk');
}

// Pierwsza wiadomość osoby AFK zdejmuje status; oznaczenie osoby AFK dostaje odpowiedź z powodem.
export async function onMessageAfk(bot, message) {
  if (!message?.guild_id || message.author?.bot || message.webhook_id) return;
  const afk = await afkMap(bot);
  if (!afk.size || !(await isOurGuild(bot, message.guild_id))) return;
  const reply = (content) =>
    bot.discord
      .post(`/channels/${message.channel_id}/messages`, {
        content,
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: message.id, channel_id: message.channel_id, fail_if_not_exists: false },
      })
      .catch((error) => console.warn(`[afk] ${error.message}`));

  const own = afk.get(message.author.id);
  if (own && Date.now() - own.since > AFK_GRACE_MS) {
    await bot.store.removeAfk(message.author.id);
    bot.cache.delete('afk');
    await reply(`Witaj z powrotem, <@${message.author.id}>! Zdjąłem Twój status AFK (ustawiony ${discordTimestamp(own.since, 'R')}).`);
  }

  const mentioned = [...new Set((message.mentions ?? []).map((u) => u.id))].filter((id) => id !== message.author.id && afk.has(id));
  if (mentioned.length) {
    const lines = mentioned.slice(0, 5).map((id) => {
      const entry = afk.get(id);
      return `<@${id}> jest AFK${entry.reason ? `: ${escapeMarkdown(entry.reason)}` : ''} (od ${discordTimestamp(entry.since, 'R')})`;
    });
    await reply(lines.join('\n'));
  }
}

// ---------- Przypomnienia ----------

export async function sendDueReminders(bot) {
  const due = await bot.store.takeDueReminders();
  for (const r of due) {
    const payload = {
      content: `<@${r.userId}>`,
      allowed_mentions: { users: [r.userId] },
      embeds: [
        {
          color: COLORS.info,
          title: 'Przypomnienie',
          description: r.text.slice(0, 4000),
          footer: { text: `Ustawione ${new Date(r.createdAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}` },
        },
      ],
    };
    try {
      if (r.channelId === 'dm') {
        const channel = await bot.discord.post('/users/@me/channels', { recipient_id: r.userId });
        await bot.discord.post(`/channels/${channel.id}/messages`, payload);
      } else {
        await bot.discord.post(`/channels/${r.channelId}/messages`, payload);
      }
    } catch (error) {
      console.warn(`[przypomnienie #${r.id}] ${error.message}`);
    }
  }
  return due.length;
}

// ---------- Konkursy ----------

export const isGiveawayCustomId = (customId) => /^gw\|/.test(String(customId ?? ''));

export function giveawayMessage(g) {
  const lines = g.ended
    ? [
        g.winnerIds.length ? `**${g.winnerIds.length > 1 ? 'Zwycięzcy' : 'Zwycięzca'}:** ${g.winnerIds.map((id) => `<@${id}>`).join(', ')}` : '**Brak zwycięzców** - nikt nie wziął udziału.',
        `**Zakończony:** ${discordTimestamp(g.endsAt, 'f')}`,
      ]
    : [`Kliknij **Weź udział**, żeby dołączyć!`, '', `**Koniec:** ${discordTimestamp(g.endsAt, 'R')} (${discordTimestamp(g.endsAt, 'f')})`, `**Zwycięzców:** ${g.winners}`];
  lines.push(`**Organizator:** <@${g.hostId}>`);
  if (g.requiredRoleId) lines.push(`**Wymagana rola:** <@&${g.requiredRoleId}>`);
  return {
    embeds: [
      {
        color: g.ended ? 0x99aab5 : GOLD,
        title: g.prize.slice(0, 256),
        description: lines.join('\n'),
        footer: { text: `Konkurs #${g.id} • Uczestników: ${g.entrants.length}` },
        timestamp: new Date(g.endsAt).toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: g.ended ? 2 : 1, label: g.ended ? `Zakończony (${g.entrants.length})` : `Weź udział (${g.entrants.length})`, custom_id: `gw|join|${g.id}`, disabled: g.ended }],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function pickWinners(entrants, count, exclude = []) {
  const pool = entrants.filter((id) => !exclude.includes(id));
  const winners = [];
  while (pool.length && winners.length < count) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return winners;
}

export async function startGiveaway(bot, { channelId, prize, winners, hostId, requiredRoleId, endsAt }) {
  const g = await bot.store.addGiveaway({ channelId, prize, winners, hostId, requiredRoleId, endsAt });
  try {
    const message = await bot.discord.post(`/channels/${channelId}/messages`, giveawayMessage(g));
    await bot.store.setGiveawayMessage(g.id, message.id);
    return { ...g, messageId: message.id };
  } catch (error) {
    await bot.store.deleteGiveaway(g.id);
    throw error;
  }
}

// Losowanie: kończy konkurs (albo losuje ponownie przy reroll) i ogłasza zwycięzców odpowiedzią na konkurs.
export async function endGiveaway(bot, g, { reroll = false } = {}) {
  const winners = pickWinners(g.entrants, g.winners, reroll ? g.winnerIds : []);
  const finished = await bot.store.finishGiveaway(g.id, winners.length || !reroll ? winners : g.winnerIds);
  if (g.messageId) {
    await bot.discord.patch(`/channels/${g.channelId}/messages/${g.messageId}`, giveawayMessage(finished)).catch((error) => console.warn(`[konkurs #${g.id}] ${error.message}`));
  }
  const text = winners.length
    ? `${reroll ? 'Nowe losowanie! ' : ''}Gratulacje ${winners.map((id) => `<@${id}>`).join(', ')}! Wygrywasz **${escapeMarkdown(g.prize)}**!`
    : `Konkurs **${escapeMarkdown(g.prize)}** zakończony - ${reroll ? 'nie ma już kogo wylosować' : 'nikt nie wziął udziału'}.`;
  await bot.discord
    .post(`/channels/${g.channelId}/messages`, {
      content: text,
      allowed_mentions: { users: winners },
      ...(g.messageId ? { message_reference: { message_id: g.messageId, channel_id: g.channelId, fail_if_not_exists: false } } : {}),
    })
    .catch((error) => console.warn(`[konkurs #${g.id}] ${error.message}`));
  return finished;
}

export async function finishDueGiveaways(bot) {
  const due = await bot.store.dueGiveaways();
  for (const g of due) await endGiveaway(bot, g).catch((error) => console.warn(`[konkurs #${g.id}] ${error.message}`));
  return due.length;
}

export function handleGiveawayInteraction(ix, bot) {
  const [, action, rawId] = String(ix.customId).split('|');
  const task = async () => {
    try {
      if (action !== 'join') throw new ActionError('Ten przycisk jest już nieaktualny.');
      const current = await bot.store.getGiveaway(Number(rawId));
      if (!current || current.ended) throw new ActionError('Ten konkurs już się zakończył.');
      if (current.requiredRoleId && !ix.member?.roles?.includes(current.requiredRoleId)) {
        throw new ActionError(`Żeby wziąć udział, potrzebujesz roli <@&${current.requiredRoleId}>.`);
      }
      const updated = await bot.store.toggleGiveawayEntry(current.id, ix.user.id);
      if (!updated) throw new ActionError('Ten konkurs już się zakończył.');
      const joined = updated.entrants.includes(ix.user.id);
      if (updated.messageId) {
        await bot.discord.patch(`/channels/${updated.channelId}/messages/${updated.messageId}`, giveawayMessage(updated)).catch(() => {});
      }
      await ix.edit({
        embeds: [successEmbed(joined ? `Bierzesz udział w konkursie **${escapeMarkdown(updated.prize)}**. Powodzenia!\n-# Kliknij jeszcze raz, żeby się wypisać.` : 'Wypisano Cię z konkursu.')],
      });
    } catch (error) {
      await ix.edit({ embeds: [errorEmbed(describeError(error))] }).catch(() => {});
    }
  };
  return { response: { type: 5, data: { flags: EPHEMERAL } }, task };
}

// ---------- Propozycje ----------

export async function postSuggestion(bot, { config, user, text }) {
  const s = config.suggestions;
  if (!s.enabled || !s.channelId) throw new ActionError('Propozycje są wyłączone - administracja może je włączyć w panelu (zakładka Społeczność).');
  const number = ((await bot.store.getState('suggestion_count')) ?? 0) + 1;
  await bot.store.setState('suggestion_count', number);
  const message = await bot.discord.post(`/channels/${s.channelId}/messages`, {
    embeds: [
      {
        color: COLORS.info,
        author: { name: `${user.global_name ?? user.username}`, icon_url: avatarUrl(user, 64) },
        title: `Propozycja #${number}`,
        description: text.slice(0, 4000),
        footer: { text: `Zagłosuj reakcją • ID autora: ${user.id}` },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  });
  for (const emoji of ['👍', '👎']) {
    await bot.discord.put(`/channels/${s.channelId}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`).catch(() => {});
  }
  if (s.thread) {
    await bot.discord
      .post(`/channels/${s.channelId}/messages/${message.id}/threads`, { name: `Propozycja #${number} - dyskusja`.slice(0, 100), auto_archive_duration: 10080 })
      .catch((error) => console.warn(`[propozycja] wątek: ${error.message}`));
  }
  return { number, channelId: s.channelId, messageId: message.id };
}
