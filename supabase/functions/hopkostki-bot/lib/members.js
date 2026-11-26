// Nowe osoby na serwerze: automatyczne role, powitanie, pożegnanie i log wejść/wyjść (z wiekiem konta).
// Zdarzenia GUILD_MEMBER_* przychodzą z gatewaya tylko z intencją „Server Members”, którą bot włącza sam
// (flaga GATEWAY_GUILD_MEMBERS_LIMITED aplikacji), gdy któraś z tych funkcji jest włączona.

import { getApp, getGuildContext, isOurGuild } from './moderation.js';
import { avatarUrl } from './rest.js';
import { COLORS, colorInt, escapeMarkdown, fillTemplate } from './embeds.js';
import { joinLogsOn, logMemberJoin, logMemberLeave, messageLogsOn, profileLogsOn } from './logs.js';
import { detectInvite } from './invites.js';
import { inviteContestLive, inviteContestPlanned } from './contests.js';

const FLAG = { MEMBERS: 1 << 14, MEMBERS_LIMITED: 1 << 15, CONTENT: 1 << 18, CONTENT_LIMITED: 1 << 19 };
const RECENT_JOIN_MS = 30 * 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;
const SWEEP_WINDOW_MS = 24 * 60 * 60_000;

export const membersIntentOn = (app) => Boolean((app?.flags ?? 0) & (FLAG.MEMBERS | FLAG.MEMBERS_LIMITED));
export const contentIntentOn = (app) => Boolean((app?.flags ?? 0) & (FLAG.CONTENT | FLAG.CONTENT_LIMITED));

export function membersFeaturesOn(config) {
  const m = config.members;
  // Poziomy: auto reset po wyjściu z serwera i import z rankingu (lista członków).
  const levels = config.levels.enabled && config.levels.autoReset;
  // Automoderacja: anty-rajd liczy wejścia na serwer.
  const raid = config.automod.enabled && config.automod.raid.enabled;
  // Eventy zaproszeń: kto kogo zaprosił i kto wyszedł z serwera (GUILD_MEMBER_ADD/REMOVE).
  return m.autoRole.enabled || m.welcome.enabled || m.goodbye.enabled || joinLogsOn(config) || profileLogsOn(config) || levels || raid || inviteContestPlanned(config);
}

// Treść cudzych wiadomości: zapis ticketów, logi usuniętych/edytowanych wiadomości, embed DISBOARD przy bumpie.
export function contentFeaturesOn(config) {
  // Poziomy: XP za słowa i booster „wysiłku” liczą słowa w wiadomości.
  // Automoderacja: filtry czytają treść wiadomości.
  return config.tickets.enabled || config.bump.enabled || messageLogsOn(config) || (config.levels.enabled && config.levels.message.enabled) || config.automod.enabled;
}

// Włącza w aplikacji intencje potrzebne do włączonych funkcji (tylko wersje "limited" da się włączyć przez API -
// wystarczą dla botów na mniej niż 100 serwerach). Zwraca aktualny stan dla panelu.
export async function ensureIntentFlags(bot, config) {
  const app = await getApp(bot);
  const needMembers = membersFeaturesOn(config) && !membersIntentOn(app);
  const needContent = contentFeaturesOn(config) && !contentIntentOn(app);
  let flags = app.flags ?? 0;
  let error = null;
  if (needMembers || needContent) {
    try {
      const updated = await bot.discord.patch('/applications/@me', {
        flags: flags | (needMembers ? FLAG.MEMBERS_LIMITED : 0) | (needContent ? FLAG.CONTENT_LIMITED : 0),
      });
      flags = updated?.flags ?? flags;
      bot.cache.delete('app');
    } catch (e) {
      error = e.message;
    }
  }
  return { members: membersIntentOn({ flags }), content: contentIntentOn({ flags }), error };
}

// ---------- Zdarzenia ----------

function vars(member, guild, count) {
  const user = member.user ?? {};
  return {
    uzytkownik: `<@${user.id}>`,
    nick: escapeMarkdown(user.global_name ?? user.username ?? ''),
    serwer: escapeMarkdown(guild?.name ?? ''),
    liczba: count ?? '?',
  };
}

export async function giveAutoRoles(bot, guildId, member, autoRole) {
  const wanted = member.user?.bot ? autoRole.botRoleIds : autoRole.roleIds;
  const missing = wanted.filter((id) => !member.roles?.includes(id));
  for (const roleId of missing) {
    await bot.discord
      .put(`/guilds/${guildId}/members/${member.user.id}/roles/${roleId}`, undefined, { reason: 'Automatyczna rola dla nowej osoby' })
      .catch((error) => console.warn(`[autorole] ${member.user.id} ${roleId}: ${error.message}`));
  }
  return missing.length;
}

export async function onMemberJoin(bot, member) {
  if (!(await isOurGuild(bot, member?.guild_id))) return;
  const config = await bot.store.getConfig();
  const { members } = config;
  // Przy weryfikacji członkostwa (regulamin) rolę dostaje się dopiero po akceptacji - patrz onMemberUpdate.
  if (members.autoRole.enabled && !member.pending) await giveAutoRoles(bot, member.guild_id, member, members.autoRole);

  const logJoins = joinLogsOn(config);
  const needsGuild = members.welcome.enabled || logJoins;
  // Trwa event zaproszeń - kto zaprosił, sprawdzamy od razu (raz; wynik trafia też do logu wejść).
  const invite = inviteContestLive(config) ? await detectInvite(bot, member).catch(() => null) : undefined;
  const gctx = needsGuild ? await getGuildContext(bot, { force: true }).catch(() => null) : null;
  const user = member.user;

  if (members.welcome.enabled && members.welcome.channelId && !user.bot) {
    const w = members.welcome;
    const v = vars(member, gctx?.guild, gctx?.guild?.memberCount);
    await bot.discord
      .post(`/channels/${w.channelId}/messages`, {
        content: `<@${user.id}>`,
        allowed_mentions: { users: [user.id] },
        embeds: [
          {
            color: colorInt(w.color, COLORS.success),
            ...(w.title ? { title: fillTemplate(w.title, v) } : {}),
            description: fillTemplate(w.message, v),
            thumbnail: { url: avatarUrl(user) },
          },
        ],
      })
      .catch((error) => console.warn(`[powitanie] ${error.message}`));
  }

  if (logJoins) await logMemberJoin(bot, member, gctx?.guild?.memberCount, invite);
}

// Po zaakceptowaniu regulaminu (pending: true → false) dostaje role, których nie mógł dostać przy wejściu.
export async function onMemberUpdate(bot, member) {
  if (member?.pending || !(await isOurGuild(bot, member?.guild_id))) return;
  const { members } = await bot.store.getConfig();
  if (!members.autoRole.enabled) return;
  const joined = member.joined_at ? new Date(member.joined_at).getTime() : 0;
  if (Date.now() - joined > RECENT_JOIN_MS) return;
  await giveAutoRoles(bot, member.guild_id, member, members.autoRole);
}

export async function onMemberLeave(bot, data) {
  if (!(await isOurGuild(bot, data?.guild_id))) return;
  // Zaproszenie osoby, która wyszła, przestaje się liczyć w eventach zaproszeń.
  if (data.user?.id) await bot.store.markInviteLeft(data.user.id).catch((error) => console.warn(`[eventy] Wyjście: ${error.message}`));
  const config = await bot.store.getConfig();
  const { members } = config;
  if (!members.goodbye.enabled && !joinLogsOn(config)) return;
  const gctx = await getGuildContext(bot, { force: true }).catch(() => null);
  const user = data.user;
  if (members.goodbye.enabled && members.goodbye.channelId && !user.bot) {
    await bot.discord
      .post(`/channels/${members.goodbye.channelId}/messages`, {
        embeds: [{ color: COLORS.muted, description: fillTemplate(members.goodbye.message, vars(data, gctx?.guild, gctx?.guild?.memberCount)) }],
        allowed_mentions: { parse: [] },
      })
      .catch((error) => console.warn(`[pożegnanie] ${error.message}`));
  }
  await logMemberLeave(bot, data);
}

// Zapas w cronie (co 5 min): osoby, które weszły w ostatniej dobie, a nie mają automatycznych ról
// (np. weszły, gdy bot był akurat rozłączony z gatewayem).
export async function autoRoleSweep(bot) {
  const { members } = await bot.store.getConfig();
  if (!members.autoRole.enabled) return 0;
  const last = await bot.store.getState('autorole_sweep');
  if (last && Date.now() - last < SWEEP_EVERY_MS) return 0;
  await bot.store.setState('autorole_sweep', Date.now());
  if (!membersIntentOn(await getApp(bot))) return 0;
  const { guild } = await getGuildContext(bot);
  let given = 0;
  let after = '0';
  for (let page = 0; page < 10; page += 1) {
    const list = await bot.discord.get(`/guilds/${guild.id}/members`, { query: { limit: 1000, after } });
    if (!list?.length) break;
    for (const member of list) {
      const joined = member.joined_at ? new Date(member.joined_at).getTime() : 0;
      if (member.pending || Date.now() - joined > SWEEP_WINDOW_MS) continue;
      given += await giveAutoRoles(bot, guild.id, member, members.autoRole);
    }
    after = list.at(-1).user.id;
    if (list.length < 1000) break;
  }
  return given;
}
