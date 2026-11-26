// Wspólna logika wszystkich kar: hierarchia ról, zapis sprawy, DM, wykonanie akcji przez REST API,
// ogłoszenie na kanale i log. Komendy tylko zbierają dane i wołają funkcje z tego pliku.
//
// "bot" = { env, store, discord (klient REST), cache (Map) } - przekazywany wszędzie.

import { DiscordError, messageUrl } from './rest.js';
import { toMs, MAX_TIMEOUT_MS } from './duration.js';
import { P, has, rolesById, highestPosition, memberPermissions, EVERYONE } from './permissions.js';
import * as embeds from './embeds.js';

export class ActionError extends Error {}

const API_ERRORS = {
  10007: 'Tego użytkownika nie ma na serwerze.',
  10013: 'Nie znaleziono takiego użytkownika.',
  10026: 'Ten użytkownik nie jest zbanowany.',
  50001: 'Bot nie ma dostępu do tego kanału.',
  50013: 'Brakuje mi uprawnień - sprawdź, czy moja rola jest wyżej niż rola tego użytkownika.',
};

export function describeError(error) {
  if (error instanceof ActionError) return error.message;
  if (error instanceof DiscordError && API_ERRORS[error.code]) return API_ERRORS[error.code];
  return `Nieoczekiwany błąd: ${error?.message ?? error}`;
}

// ---------- Informacje o aplikacji i serwerze (z pamięcią podręczną) ----------

export async function cached(bot, key, ttlMs, load) {
  const hit = bot.cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  bot.cache.set(key, { at: Date.now(), value });
  return value;
}

export function getApp(bot, { force = false } = {}) {
  if (force) bot.cache.delete('app');
  return cached(bot, 'app', 10 * 60_000, () => bot.discord.get('/applications/@me'));
}

export async function resolveGuildId(bot) {
  if (bot.env.guildId) return bot.env.guildId;
  return cached(bot, 'guildId', 10 * 60_000, async () => {
    const stored = await bot.store.getState('guild_id');
    if (stored) return stored;
    const guilds = await bot.discord.get('/users/@me/guilds');
    if (!guilds?.length) throw new ActionError('Bot nie jest na żadnym serwerze - zaproś go linkiem z README.');
    await bot.store.setState('guild_id', guilds[0].id);
    return guilds[0].id;
  });
}

// Zdarzenia z gatewaya dotyczą tylko „naszego” serwera.
export async function isOurGuild(bot, guildId) {
  if (!guildId) return false;
  if (bot.env.guildId) return guildId === bot.env.guildId;
  return guildId === (await resolveGuildId(bot).catch(() => null));
}

export async function getGuildContext(bot, { force = false } = {}) {
  if (force) bot.cache.delete('guildCtx');
  return cached(bot, 'guildCtx', 60_000, async () => {
    const app = await getApp(bot);
    const guildId = await resolveGuildId(bot);
    const [guild, botMember] = await Promise.all([
      bot.discord.get(`/guilds/${guildId}`, { query: { with_counts: true } }),
      bot.discord.get(`/guilds/${guildId}/members/${app.bot?.id ?? app.id}`),
    ]);
    return {
      guild: {
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        ownerId: guild.owner_id,
        afkChannelId: guild.afk_channel_id ?? null,
        memberCount: guild.approximate_member_count ?? null,
        onlineCount: guild.approximate_presence_count ?? null,
      },
      roles: rolesById(guild.roles ?? []),
      rawRoles: guild.roles ?? [],
      emojis: (guild.emojis ?? []).map((e) => ({ id: e.id, name: e.name, animated: Boolean(e.animated), available: e.available !== false })),
      botUser: botMember.user ?? app.bot,
      botMember,
    };
  });
}

// ---------- Uprawnienia ----------

// Kto może użyć komendy. O dostępie decyduje lista ról komendy z panelu (zakładka "Uprawnienia",
// config.commandPermissions[commandName]) - także dla ról z uprawnieniem Administratora:
// 1. Właściciel serwera (ownerId) ma dostęp zawsze. To bezpiecznik: serwer nigdy nie zablokuje sam siebie,
//    nawet gdy ktoś zapisze puste listy. ownerId podaje bramka (canUseCommand niżej: guild.ownerId
//    z getGuildContext); bez ownerId liczą się same listy.
// 2. Komenda ma listę: wpuszcza „wszystkich” (EVERYONE) albo osoby z którąś z ról z listy. Nic więcej -
//    Administrator, uprawnienia Discorda i modRoleIds nie omijają listy.
// 3. Komenda bez listy (stara konfiguracja): uprawnienie Discorda (has() - Administrator ma każde) albo rola
//    moderatora z modRoleIds; komenda bez wymaganego uprawnienia jest otwarta dla wszystkich.
export function hasModAccess(member, permission, config, commandName, ownerId = null) {
  if (!member) return false;
  if (ownerId && member.id === ownerId) return true;
  const list = commandName ? config.commandPermissions?.[commandName] : undefined;
  if (Array.isArray(list)) return list.includes(EVERYONE) || list.some((id) => member.roles?.includes(id));
  if (!permission) return true;
  if (has(member.permissions, permission)) return true;
  return config.modRoleIds.some((id) => member.roles?.includes(id));
}

// Ta sama logika, ale dla pojedynczej roli (bez konkretnego członka) - podgląd w panelu, kto może użyć jakiej
// komendy (panel liczy to samo w app.js/roleCanUse). Właściciela tu nie ma: to osoba, nie rola.
export function roleHasAccess(role, permission, config, commandName) {
  const list = commandName ? config.commandPermissions?.[commandName] : undefined;
  if (Array.isArray(list)) return list.includes(EVERYONE) || list.includes(role.id);
  if (!permission) return true;
  if (has(role.permissions, permission)) return true;
  return config.modRoleIds.includes(role.id);
}

// ID właściciela serwera z kontekstu serwera (pamięć podręczna, odświeżana co minutę). Gdy Discord
// nie odpowiada, zwraca null - wtedy liczą się same listy ról.
export async function guildOwnerId(bot) {
  try {
    return (await getGuildContext(bot)).guild.ownerId ?? null;
  } catch (error) {
    console.warn(`[uprawnienia] Nie udało się sprawdzić właściciela serwera: ${error.message}`);
    return null;
  }
}

// Bramka komend, autouzupełniania i list ze stronami. Najpierw sama lista ról - bez pytania Discorda, więc
// zwykłe użycie komendy na nic nie czeka. Właściciela serwera sprawdzamy dopiero, gdy lista odmówi.
export async function canUseCommand(bot, member, permission, config, commandName) {
  if (hasModAccess(member, permission, config, commandName)) return true;
  if (!member) return false;
  return hasModAccess(member, permission, config, commandName, await guildOwnerId(bot));
}

const REQUIRED = { ban: P.BAN_MEMBERS, kick: P.KICK_MEMBERS, timeout: P.MODERATE_MEMBERS, untimeout: P.MODERATE_MEMBERS, nick: P.MANAGE_NICKNAMES };
const PERMISSION_NAMES = {
  ban: 'Banowanie członków',
  kick: 'Wyrzucanie członków',
  timeout: 'Wyciszanie członków',
  untimeout: 'Wyciszanie członków',
  nick: 'Zarządzanie pseudonimami',
};

// Zwraca komunikat błędu albo null, jeśli akcję można wykonać.
// moderator = { id, roles } (null przy automatycznych karach), targetMember = { roles } albo null.
export function checkTarget({ gctx, moderator, target, targetMember, action }) {
  const { guild, roles, botUser, botMember } = gctx;
  if (moderator && target.id === moderator.id) return 'Nie możesz użyć tej komendy na sobie.';
  if (target.id === botUser.id) return 'Nie mogę ukarać samego siebie. 🥲';
  if (target.id === guild.ownerId) return 'Nie można ukarać właściciela serwera.';

  const botPerms = memberPermissions(botMember.roles, roles, guild.id);
  if (REQUIRED[action] && !has(botPerms, REQUIRED[action])) {
    return `Nie mam uprawnienia **${PERMISSION_NAMES[action]}** - nadaj je mojej roli.`;
  }
  if (!targetMember) return action === 'ban' ? null : 'Tego użytkownika nie ma na serwerze.';

  const targetPosition = highestPosition(targetMember.roles, roles);
  if (moderator && moderator.id !== guild.ownerId && targetPosition >= highestPosition(moderator.roles, roles)) {
    return 'Ten użytkownik ma rolę równą lub wyższą od Twojej.';
  }
  const targetPerms = memberPermissions(targetMember.roles, roles, guild.id);
  if (action === 'timeout' && (targetPerms & P.ADMINISTRATOR) === P.ADMINISTRATOR) {
    return 'Nie można wyciszyć administratora.';
  }
  if (action !== 'warn' && highestPosition(botMember.roles, roles) <= targetPosition) {
    return 'Nie mam uprawnień, żeby to zrobić - moja rola musi być wyżej niż rola tego użytkownika.';
  }
  return null;
}

// ---------- Wysyłanie wiadomości ----------

function auditReason(moderator, reason, caseId) {
  return `${moderator.username}: ${reason} (sprawa #${caseId})`.slice(0, 512);
}

export async function sendModLog(bot, config, payload) {
  if (!config.modLogChannelId) return null;
  try {
    return await bot.discord.post(`/channels/${config.modLogChannelId}/messages`, { allowed_mentions: { parse: [] }, ...payload });
  } catch (error) {
    console.warn(`[log] Nie udało się wysłać logu: ${error.message}`);
    return null;
  }
}

export async function sendDm(bot, userId, payload) {
  const channel = await bot.discord.post('/users/@me/channels', { recipient_id: userId });
  const message = await bot.discord.post(`/channels/${channel.id}/messages`, payload);
  return { channelId: channel.id, messageId: message.id };
}

export function announceElsewhere(config, channelId) {
  return Boolean(config.announceChannelId && config.announceChannelId !== channelId);
}

async function publishAnnouncement({ bot, config, interaction, channelId, payload }) {
  if (interaction) {
    if (announceElsewhere(config, interaction.channelId)) {
      try {
        const message = await bot.discord.post(`/channels/${config.announceChannelId}/messages`, payload);
        await interaction.edit({ embeds: [embeds.successEmbed(`Kara została ogłoszona na kanale <#${config.announceChannelId}>.`)] });
        return message;
      } catch (error) {
        console.warn(`[ogłoszenie] Kanał ogłoszeń niedostępny: ${error.message}`);
      }
    }
    return interaction.edit(payload);
  }
  const target = config.announceChannelId || channelId;
  return target ? bot.discord.post(`/channels/${target}/messages`, payload) : null;
}

/**
 * Wykonuje akcję moderacyjną od początku do końca.
 * perform(caseEntry) wykonuje operację na Discordzie i może zwrócić dodatkowe dane do embedów.
 * dmFirst: DM wysyłany przed akcją (ban/kick - potem nie będzie wspólnego serwera).
 */
export async function runAction(bot, {
  action,
  target,
  moderator,
  reason,
  duration = null,
  expiresAt = null,
  auto = false,
  dmFirst = false,
  announce = true,
  interaction = null,
  channelId = null,
  perform,
}) {
  const { store } = bot;
  const config = await store.getConfig();
  const { guild } = await getGuildContext(bot);

  const entry = await store.addCase({
    type: action,
    guildId: guild.id,
    userId: target.id,
    userTag: target.username,
    moderatorId: moderator.id,
    moderatorTag: moderator.username,
    reason,
    duration,
    expiresAt,
    auto,
  });
  const ctx = { action, guild, target, moderator, reason, duration, expiresAt, auto, caseId: entry.id, createdAt: entry.createdAt };

  let dm = null;
  let dmStatus = config.dmUsers ? null : '➖ wyłączone';
  const deliverDm = async () => {
    if (!config.dmUsers) return;
    try {
      dm = await sendDm(bot, target.id, { embeds: [embeds.buildDmEmbed(ctx, config)], components: embeds.appealComponents(ctx, config) });
      dmStatus = '✅ dostarczono';
    } catch {
      dmStatus = '❌ nie udało się (zamknięte DM)';
    }
  };

  if (dmFirst) await deliverDm();
  try {
    Object.assign(ctx, (await perform(entry)) ?? {});
  } catch (error) {
    await store.deleteCase(entry.id);
    if (dm) await bot.discord.delete(`/channels/${dm.channelId}/messages/${dm.messageId}`).catch(() => {});
    throw new ActionError(describeError(error));
  }
  if (!dmFirst) await deliverDm();

  let message = null;
  if (announce) {
    const payload = {
      content: config.mentionTarget ? `<@${target.id}>` : '',
      embeds: [embeds.buildChannelEmbed(ctx, config)],
      allowed_mentions: { users: config.mentionTarget ? [target.id] : [] },
    };
    message = await publishAnnouncement({ bot, config, interaction, channelId, payload }).catch((error) => {
      console.warn(`[akcja] Nie udało się ogłosić kary: ${error.message}`);
      return null;
    });
  }

  const url = message ? messageUrl(guild.id, message.channel_id, message.id) : null;
  if (message) await store.addModMessage(message.id, message.channel_id, entry.id);
  await store.updateCase(entry.id, { dmStatus, ...(url ? { messageUrl: url } : {}) });
  await sendModLog(bot, config, { embeds: [embeds.buildLogEmbed(ctx, config, { dmStatus, messageUrl: url })] });
  return { entry, message, ctx };
}

// ---------- Konkretne akcje ----------

export async function banUser(bot, { target, moderator, reason, duration = null, deleteMessageSeconds = 0, ...rest }) {
  const { guild } = await getGuildContext(bot);
  const expiresAt = duration ? Date.now() + toMs(duration.amount, duration.unit) : null;
  return runAction(bot, {
    ...rest,
    action: 'ban',
    target,
    moderator,
    reason,
    duration,
    expiresAt,
    dmFirst: true,
    perform: async (entry) => {
      await bot.discord.put(
        `/guilds/${guild.id}/bans/${target.id}`,
        { delete_message_seconds: deleteMessageSeconds },
        { reason: auditReason(moderator, reason, entry.id) },
      );
      if (expiresAt) {
        await bot.store.setTempBan({ guildId: guild.id, userId: target.id, userTag: target.username, expiresAt, caseId: entry.id });
      } else {
        await bot.store.removeTempBan(guild.id, target.id);
      }
    },
  });
}

export async function unbanUser(bot, { target, moderator, reason, ...rest }) {
  const { guild } = await getGuildContext(bot);
  return runAction(bot, {
    ...rest,
    action: 'unban',
    target,
    moderator,
    reason,
    perform: async (entry) => {
      await bot.discord.delete(`/guilds/${guild.id}/bans/${target.id}`, { reason: auditReason(moderator, reason, entry.id) });
      await bot.store.removeTempBan(guild.id, target.id);
    },
  });
}

export async function kickUser(bot, { target, moderator, reason, ...rest }) {
  const { guild } = await getGuildContext(bot);
  return runAction(bot, {
    ...rest,
    action: 'kick',
    target,
    moderator,
    reason,
    dmFirst: true,
    perform: (entry) =>
      bot.discord.delete(`/guilds/${guild.id}/members/${target.id}`, { reason: auditReason(moderator, reason, entry.id) }),
  });
}

export async function timeoutUser(bot, { target, moderator, reason, duration, ...rest }) {
  const { guild } = await getGuildContext(bot);
  const expiresAt = Date.now() + toMs(duration.amount, duration.unit);
  return runAction(bot, {
    ...rest,
    action: 'timeout',
    target,
    moderator,
    reason,
    duration,
    expiresAt,
    perform: (entry) =>
      bot.discord.patch(
        `/guilds/${guild.id}/members/${target.id}`,
        { communication_disabled_until: new Date(expiresAt).toISOString() },
        { reason: auditReason(moderator, reason, entry.id) },
      ),
  });
}

export async function untimeoutUser(bot, { target, moderator, reason, ...rest }) {
  const { guild } = await getGuildContext(bot);
  return runAction(bot, {
    ...rest,
    action: 'untimeout',
    target,
    moderator,
    reason,
    perform: (entry) =>
      bot.discord.patch(
        `/guilds/${guild.id}/members/${target.id}`,
        { communication_disabled_until: null },
        { reason: auditReason(moderator, reason, entry.id) },
      ),
  });
}

export async function warnUser(bot, { target, moderator, reason, points, interaction = null, channelId = null, ...rest }) {
  const { store } = bot;
  const config = await store.getConfig();
  const { guild } = await getGuildContext(bot);
  const before = (await store.warnSummary(target.id)).points;

  const result = await runAction(bot, {
    ...rest,
    action: 'warn',
    target,
    moderator,
    reason,
    interaction,
    channelId,
    perform: async (entry) => {
      const warn = await store.addWarn(
        {
          guildId: guild.id,
          userId: target.id,
          userTag: target.username,
          moderatorId: moderator.id,
          moderatorTag: moderator.username,
          reason,
          points,
          caseId: entry.id,
        },
        config.warns.expiryDays,
      );
      const summary = await store.warnSummary(target.id);
      return { warn: { id: warn.id, points, expiresAt: warn.expiresAt, count: summary.count, totalPoints: summary.points } };
    },
  });

  await applyEscalation(bot, {
    target,
    before,
    after: result.ctx.warn.totalPoints,
    channelId: channelId ?? interaction?.channelId ?? null,
  });
  return result;
}

// ---------- Automatyczne kary za punkty ostrzeżeń ----------

export function crossedRule(rules, before, after) {
  const crossed = rules.filter((rule) => before < rule.points && after >= rule.points);
  return crossed.length ? crossed[crossed.length - 1] : null;
}

export async function fetchMember(bot, userId) {
  const { guild } = await getGuildContext(bot);
  try {
    return await bot.discord.get(`/guilds/${guild.id}/members/${userId}`);
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return null;
    throw error;
  }
}

export async function applyEscalation(bot, { target, before, after, channelId }) {
  const config = await bot.store.getConfig();
  const { escalation, modRoleIds } = config;
  if (!escalation.enabled) return null;
  const rule = crossedRule(escalation.rules, before, after);
  if (!rule) return null;

  const alert = (description) =>
    sendModLog(bot, config, {
      content: modRoleIds.map((id) => `<@&${id}>`).join(' '),
      allowed_mentions: { roles: modRoleIds },
      embeds: [embeds.simpleEmbed('warning', '🚨 Próg ostrzeżeń przekroczony', description)],
    });

  const summary = `<@${target.id}> ma teraz **${after} pkt** ostrzeżeń (próg: ${rule.points} pkt).`;
  if (rule.action === 'alert') {
    await alert(`${summary}\nSprawdź \`/warn status\` i zdecyduj o dalszych krokach.`);
    return rule;
  }

  const gctx = await getGuildContext(bot);
  const targetMember = await fetchMember(bot, target.id);
  const problem = checkTarget({ gctx, moderator: null, target, targetMember, action: rule.action });
  if (problem) {
    await alert(`${summary}\nAutomatyczna kara (**${rule.action}**) nie została nałożona: ${problem}`);
    return rule;
  }

  const duration = rule.amount > 0 && rule.action !== 'kick' ? { amount: rule.amount, unit: rule.unit } : null;
  const base = {
    target,
    moderator: gctx.botUser,
    auto: true,
    channelId,
    reason: `Automatyczna kara: ${after} pkt ostrzeżeń (próg ${rule.points} pkt)`,
  };
  try {
    if (rule.action === 'ban') await banUser(bot, { ...base, duration });
    if (rule.action === 'kick') await kickUser(bot, base);
    if (rule.action === 'timeout') {
      const safe = duration && toMs(duration.amount, duration.unit) <= MAX_TIMEOUT_MS ? duration : { amount: 28, unit: 'd' };
      await timeoutUser(bot, { ...base, duration: safe });
    }
  } catch (error) {
    await alert(`${summary}\nAutomatyczna kara nie powiodła się: ${describeError(error)}`);
  }
  return rule;
}

// ---------- Wygasanie ----------

export async function expireTempBan(bot, ban) {
  const target = await bot.discord.get(`/users/${ban.userId}`).catch(() => null);
  if (!target) {
    await bot.store.removeTempBan(ban.guildId, ban.userId);
    return;
  }
  const { botUser } = await getGuildContext(bot);
  try {
    await unbanUser(bot, {
      target,
      moderator: botUser,
      reason: `Tymczasowy ban wygasł (sprawa #${ban.caseId})`,
      auto: true,
      announce: false,
    });
  } catch (error) {
    // Ktoś już zdjął bana ręcznie - wystarczy usunąć wpis.
    await bot.store.removeTempBan(ban.guildId, ban.userId);
    console.warn(`[tempban] ${target.username}: ${error.message}`);
  }
}

export async function logExpiredWarns(bot, warns) {
  if (!warns.length) return;
  const config = await bot.store.getConfig();
  for (const warn of warns) {
    const left = await bot.store.warnSummary(warn.userId);
    await sendModLog(bot, config, {
      embeds: [
        embeds.simpleEmbed(
          'muted',
          `⌛ Ostrzeżenie #${warn.id} wygasło`,
          [
            `**Użytkownik:** <@${warn.userId}> \`${warn.userTag}\``,
            `**Powód:** ${warn.reason}`,
            `**Punkty:** -${warn.points}`,
            `**Pozostało:** ${left.count} ostrzeżeń (${left.points} pkt)`,
          ].join('\n'),
        ),
      ],
    });
  }
}
