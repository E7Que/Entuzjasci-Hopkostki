// Poziomy jak w Arcane: XP za wiadomości, kanały głosowe i reakcje, awanse z wiadomością i nagrodami w rolach,
// boostery (rola, kanał, „wysiłek”), ograniczenia (kanały, role, wątki, fora, czat kanałów głosowych, komendy
// slash), rola za 1. miejsce, tygodniowe i miesięczne rankingi najaktywniejszych z pingiem roli, karta poziomu
// i import XP z rankingu Arcane.

import { P, has } from './permissions.js';
import { avatarUrl } from './rest.js';
import { cached, getGuildContext, isOurGuild } from './moderation.js';
import { BRAND, colorInt, escapeMarkdown } from './embeds.js';

const DAY = 24 * 60 * 60_000;
const THREAD_TYPES = new Set([10, 11, 12]);
const FORUM_TYPES = new Set([15, 16]);
const VOICE_TYPES = new Set([2, 13]);
export const LEVEL_CURVES = ['linear', 'standard', 'flat'];

// ---------- Formuła ----------

// XP potrzebne, żeby z poziomu `level` wejść na następny.
// linear — jak Arcane („Linear”): 100·poziom + 75, standard — jak MEE6: 5·poziom² + 50·poziom + 100, flat — zawsze 100.
export function xpToNext(level, formula) {
  const base = formula.curve === 'standard' ? 5 * level * level + 50 * level + 100 : formula.curve === 'flat' ? 100 : 100 * level + 75;
  return Math.max(1, Math.round(base * (formula.multiplier || 1)));
}

const maxLevel = (formula) => (formula.maxLevel > 0 ? formula.maxLevel : 1000);

// Poziom z łącznego XP oraz postęp w bieżącym poziomie.
export function levelProgress(xp, formula) {
  let level = 0;
  let rest = Math.max(0, Number(xp) || 0);
  while (level < maxLevel(formula)) {
    const need = xpToNext(level, formula);
    if (rest < need) return { level, current: rest, needed: need, maxed: false };
    rest -= need;
    level += 1;
  }
  return { level, current: rest, needed: 0, maxed: true };
}

export function totalXpForLevel(level, formula) {
  let total = 0;
  for (let i = 0; i < Math.min(level, maxLevel(formula)); i += 1) total += xpToNext(i, formula);
  return total;
}

// ---------- Okresy rankingów (tydzień od niedzieli, UTC — jak Arcane; miesiąc kalendarzowy) ----------

export function weekKey(ms = Date.now()) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay())).toISOString().slice(0, 10);
}
export const monthKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 7);
const previousWeekKey = (ms = Date.now()) => weekKey(Date.parse(`${weekKey(ms)}T00:00:00Z`) - 1);
const previousMonthKey = (ms = Date.now()) => monthKey(Date.parse(`${monthKey(ms)}-01T00:00:00Z`) - 1);

// ---------- Pomocnicze ----------

const random = (min, max) => {
  const [lo, hi] = min <= max ? [min, max] : [max, min];
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};
const userTag = (user) => user?.username ?? null;

// Rodzaj kanału (wątek, forum, czat kanału głosowego) — z Discorda, z pamięcią na 30 minut.
async function channelInfo(bot, channelId) {
  if (!channelId) return null;
  return cached(bot, `chan:${channelId}`, 30 * 60_000, async () => {
    const channel = await bot.discord.get(`/channels/${channelId}`).catch(() => null);
    if (!channel) return { id: channelId, type: 0, parentId: null, thread: false, forum: false, voiceText: false };
    const thread = THREAD_TYPES.has(channel.type);
    const parent = thread && channel.parent_id ? await channelInfo(bot, channel.parent_id) : null;
    return {
      id: channelId,
      type: channel.type,
      parentId: channel.parent_id ?? null,
      thread,
      forum: thread && FORUM_TYPES.has(parent?.type),
      voiceText: VOICE_TYPES.has(channel.type),
    };
  });
}

// Czy na tym kanale można zdobywać XP (lista kanałów bez XP albo „tylko te kanały”, wątki, fora, głosowe).
export function channelAllowed(config, channel) {
  if (!channel) return true;
  const r = config.restrictions;
  if (channel.forum && !r.forums) return false;
  if (channel.thread && !channel.forum && !r.threads) return false;
  if (channel.voiceText && !r.voiceText) return false;
  // Wątek liczy się jak jego kanał nadrzędny, a kanał — także jak jego kategoria.
  const ids = [channel.id, channel.parentId].filter(Boolean);
  const listed = ids.some((id) => r.channelIds.includes(id));
  return r.channelMode === 'allow' ? r.channelIds.length === 0 || listed : !listed;
}

const blockedByRole = (config, roles = []) => roles.some((id) => config.restrictions.roleIds.includes(id));

// Procent premii: role i kanały z boosterami oraz „wysiłek” (długa wiadomość albo dużo obrazków).
export function boostPercent(config, { roles = [], channelIds = [], effort = false }) {
  const b = config.boosters;
  const list = [
    ...b.roles.filter((x) => roles.includes(x.roleId)).map((x) => x.percent),
    ...b.channels.filter((x) => channelIds.includes(x.channelId)).map((x) => x.percent),
    ...(effort && b.effort.enabled ? [b.effort.percent] : []),
  ];
  if (!list.length) return 0;
  return b.stack ? list.reduce((a, c) => a + c, 0) : Math.max(...list);
}
const boosted = (amount, percent) => Math.max(0, Math.round(amount * (1 + percent / 100)));

// Członek z rolami (dla autora komendy slash i autora wiadomości przy reakcji) — z pamięcią na 10 minut.
async function memberInfo(bot, userId) {
  return cached(bot, `member:${userId}`, 10 * 60_000, async () => {
    const { guild } = await getGuildContext(bot);
    return bot.discord.get(`/guilds/${guild.id}/members/${userId}`).catch(() => null);
  });
}

// ---------- Przyznawanie XP i awanse ----------

// Dodaje XP (z cooldownem danego rodzaju) i obsługuje awans. Zwraca { xp, level, previous } albo null (cooldown).
export async function awardXp(bot, config, { user, amount, kind, cooldown, minutes = 0, channelId = null, roles, displayName = null }) {
  if (!user?.id || amount <= 0) return null;
  const row = await bot.store.awardXp({
    userId: user.id,
    userTag: userTag(user),
    displayName: displayName ?? user.global_name ?? null,
    avatar: user.avatar ?? null,
    amount,
    kind,
    cooldownSec: cooldown,
    minutes,
    weekKey: weekKey(),
    monthKey: monthKey(),
  });
  if (!row) return null;
  const { level } = levelProgress(row.xp, config.formula);
  if (level !== row.level) await bot.store.setLevel(user.id, level);
  if (level > row.level) await onLevelUp(bot, config, { user, level, previous: row.level, xp: row.xp, channelId, roles });
  return { xp: row.xp, level, previous: row.level };
}

// Nagrody w rolach: przy „Stack Rewards” wszystkie do osiągniętego poziomu, inaczej tylko najwyższa.
// Zwraca role zdobyte tym awansem (do {earned:…} w wiadomości).
export async function applyRewards(bot, config, { userId, level, previous = 0, roles }) {
  const rewards = [...config.rewards].sort((a, b) => a.level - b.level);
  const reached = rewards.filter((r) => r.level <= level);
  if (!reached.length) return [];
  const { guild } = await getGuildContext(bot);
  const holds = (roleId) => (roles ? roles.includes(roleId) : false);
  const wanted = config.stackRewards ? reached : reached.filter((r) => r.level === reached.at(-1).level);
  for (const reward of wanted) {
    if (holds(reward.roleId)) continue;
    await bot.discord
      .put(`/guilds/${guild.id}/members/${userId}/roles/${reward.roleId}`, undefined, { reason: `Nagroda za poziom ${reward.level}` })
      .catch((error) => console.warn(`[poziomy] Rola za poziom ${reward.level}: ${error.message}`));
  }
  if (!config.stackRewards && roles) {
    const keep = new Set(wanted.map((r) => r.roleId));
    for (const reward of rewards) {
      if (keep.has(reward.roleId) || !roles.includes(reward.roleId)) continue;
      await bot.discord.delete(`/guilds/${guild.id}/members/${userId}/roles/${reward.roleId}`, { reason: 'Nagrody za poziomy bez kumulowania' }).catch(() => {});
    }
  }
  return rewards.filter((r) => r.level > previous && r.level <= level);
}

// Tagi jak w Arcane: {user.mention} {user.name} {user.level} {user.xp} oraz {earned:…} — tekst pokazywany tylko,
// gdy awans dał rolę ({name} = nazwa roli, {mention} = oznaczenie roli).
export function levelUpText(template, { user, level, xp, earned = [], roleName = (id) => id }) {
  let text = String(template ?? '');
  for (;;) {
    const start = text.indexOf('{earned:');
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    const inner = text.slice(start + '{earned:'.length, end);
    const replacement = earned.length
      ? inner.replace(/\{name\}/g, earned.map((r) => roleName(r.roleId)).join(', ')).replace(/\{mention\}/g, earned.map((r) => `<@&${r.roleId}>`).join(', '))
      : '';
    text = text.slice(0, start) + replacement + text.slice(end + 1);
  }
  return text
    .replace(/\{user\.mention\}/g, `<@${user.id}>`)
    .replace(/\{user\.name\}/g, escapeMarkdown(user.global_name ?? user.username ?? ''))
    .replace(/\{user\.level\}/g, String(level))
    .replace(/\{user\.xp\}/g, Number(xp).toLocaleString('pl-PL'))
    .trim();
}

async function onLevelUp(bot, config, { user, level, previous, xp, channelId, roles }) {
  const earned = await applyRewards(bot, config, { userId: user.id, level, previous, roles });
  const msg = config.levelUp;
  if (!msg.enabled) return;
  const gctx = await getGuildContext(bot);
  const roleName = (id) => gctx.roles.get(id)?.name ?? 'rola';
  const content = levelUpText(msg.message, { user, level, xp, earned, roleName });
  const payload = {
    content: content.slice(0, 2000),
    allowed_mentions: { users: [user.id], roles: [] },
    ...(msg.card ? { embeds: [await rankCardEmbed(bot, config, user)] } : {}),
  };
  if (!payload.content && !payload.embeds) return;
  let target = null;
  if (msg.target === 'dm') {
    target = await bot.discord.post('/users/@me/channels', { recipient_id: user.id }).then((c) => c.id).catch(() => null);
  } else if (msg.target === 'channel') {
    target = msg.channelId || null;
  } else {
    target = channelId || msg.channelId || null;
  }
  if (!target) return;
  await bot.discord.post(`/channels/${target}/messages`, payload).catch((error) => console.warn(`[poziomy] Wiadomość o awansie: ${error.message}`));
}

// ---------- Źródła XP ----------

export async function onMessageLevels(bot, message) {
  if (!message?.guild_id || message.webhook_id) return;
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled || !config.message.enabled) return;
  if (!(await isOurGuild(bot, message.guild_id))) return;

  let user = message.author;
  let roles = message.member?.roles;
  let nick = message.member?.nick ?? null;
  if (user?.bot) {
    // Komendy slash dowolnego bota: XP dla osoby, która jej użyła (jeśli włączone).
    const invoker = message.interaction_metadata?.user ?? message.interaction?.user;
    if (!config.restrictions.slashCommands || !invoker || invoker.bot) return;
    user = invoker;
    const member = await memberInfo(bot, invoker.id);
    roles = member?.roles ?? [];
    nick = member?.nick ?? null;
  }
  if (!user || blockedByRole(config, roles)) return;
  const channel = await channelInfo(bot, message.channel_id);
  if (!channelAllowed(config, channel)) return;

  const words = String(message.content ?? '').split(/\s+/).filter(Boolean).length;
  const images = (message.attachments ?? []).filter((a) => String(a.content_type ?? '').startsWith('image/')).length;
  const base = config.message.mode === 'perWord' ? Math.min(Math.max(words, config.message.min), config.message.max) : random(config.message.min, config.message.max);
  const effort = (config.boosters.effort.words > 0 && words >= config.boosters.effort.words) || (config.boosters.effort.images > 0 && images >= config.boosters.effort.images);
  const percent = boostPercent(config, { roles, channelIds: [channel?.id, channel?.parentId].filter(Boolean), effort });
  await awardXp(bot, config, {
    user,
    amount: boosted(base, percent),
    kind: 'message',
    cooldown: config.message.cooldown,
    channelId: message.channel_id,
    roles,
    displayName: nick,
  });
}

// MESSAGE_REACTION_ADD: XP dla dodającego reakcję, autora wiadomości albo obu.
export async function onReactionLevels(bot, data) {
  if (!data?.guild_id) return;
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled || !config.reaction.enabled) return;
  if (!(await isOurGuild(bot, data.guild_id))) return;
  const channel = await channelInfo(bot, data.channel_id);
  if (!channelAllowed(config, channel)) return;
  const channelIds = [channel?.id, channel?.parentId].filter(Boolean);
  const targets = [];
  const giver = data.member?.user;
  if (config.reaction.awards !== 'receiver' && giver && !giver.bot) targets.push({ user: giver, roles: data.member.roles ?? [], nick: data.member.nick ?? null });
  if (config.reaction.awards !== 'giver' && data.message_author_id && data.message_author_id !== data.user_id) {
    const author = await memberInfo(bot, data.message_author_id);
    if (author?.user && !author.user.bot) targets.push({ user: author.user, roles: author.roles ?? [], nick: author.nick ?? null });
  }
  for (const { user, roles, nick } of targets) {
    if (blockedByRole(config, roles)) continue;
    const amount = boosted(random(config.reaction.min, config.reaction.max), boostPercent(config, { roles, channelIds }));
    await awardXp(bot, config, { user, amount, kind: 'reaction', cooldown: config.reaction.cooldown, channelId: data.channel_id, roles, displayName: nick });
  }
}

// Co przebieg crona: XP dla osób na kanałach głosowych (co „cooldown” sekund dla każdej osoby).
// Kanał liczy się, gdy jest na nim co najmniej „minimum osób” (bez botów); anty-AFK pomija wyciszonych,
// ogłuszonych i kanał AFK serwera.
export async function voiceXpTick(bot) {
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled || !config.voice.enabled) return 0;
  const states = (await bot.store.listVoiceStates()).filter((s) => !s.bot);
  if (!states.length) return 0;
  const { guild } = await getGuildContext(bot);
  const byChannel = new Map();
  for (const s of states) byChannel.set(s.channelId, [...(byChannel.get(s.channelId) ?? []), s]);
  let awarded = 0;
  for (const [channelId, members] of byChannel) {
    if (members.length < config.voice.minMembers) continue;
    if (config.voice.antiAfk && channelId === guild.afkChannelId) continue;
    const channel = await channelInfo(bot, channelId);
    const listCheck = channel ? { ...channel, voiceText: false } : null;
    if (!channelAllowed(config, listCheck)) continue;
    for (const s of members) {
      if (config.voice.antiAfk && (s.muted || s.deafened)) continue;
      if (blockedByRole(config, s.roles)) continue;
      const amount = boosted(random(config.voice.min, config.voice.max), boostPercent(config, { roles: s.roles, channelIds: [channelId, channel?.parentId].filter(Boolean) }));
      const user = { id: s.userId, username: s.userTag ?? undefined };
      const result = await awardXp(bot, config, { user, amount, kind: 'voice', cooldown: config.voice.cooldown, minutes: Math.max(1, Math.round(config.voice.cooldown / 60)), roles: s.roles });
      if (result) awarded += 1;
    }
  }
  return awarded;
}

// Auto reset: osoba, która wyjdzie z serwera, traci XP i poziom (statystyki zostają).
export async function onMemberLeaveLevels(bot, data) {
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled || !config.autoReset || !data?.user?.id) return;
  if (!(await isOurGuild(bot, data.guild_id))) return;
  await bot.store.resetLevels({ userId: data.user.id });
}

// ---------- Rola za 1. miejsce (co godzinę) ----------

export async function firstPlaceTick(bot, { now = Date.now() } = {}) {
  const config = (await bot.store.getConfig()).levels;
  const state = (await bot.store.getState('levels_first_place')) ?? {};
  if (!config.enabled || !config.firstPlaceRoleId) return null;
  if (state.roleId === config.firstPlaceRoleId && state.at && now - state.at < 60 * 60_000) return null;
  const [top] = await bot.store.levelLeaderboard({ limit: 1 });
  const { guild } = await getGuildContext(bot);
  const roleId = config.firstPlaceRoleId;
  if (state.userId && (state.userId !== top?.userId || state.roleId !== roleId)) {
    await bot.discord.delete(`/guilds/${guild.id}/members/${state.userId}/roles/${state.roleId ?? roleId}`, { reason: 'Już nie 1. miejsce w rankingu poziomów' }).catch(() => {});
  }
  if (top) {
    await bot.discord.put(`/guilds/${guild.id}/members/${top.userId}/roles/${roleId}`, undefined, { reason: '1. miejsce w rankingu poziomów' }).catch((error) => console.warn(`[poziomy] Rola za 1. miejsce: ${error.message}`));
  }
  await bot.store.setState('levels_first_place', { userId: top?.userId ?? null, roleId, at: now });
  return top?.userId ?? null;
}

// Co 30 min: pseudonimy, nazwy i avatary osób z rankingu z listy członków serwera (do publicznej strony).
export async function levelProfilesTick(bot, { now = Date.now() } = {}) {
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled) return null;
  const last = Number(await bot.store.getState('levels_profiles_sync')) || 0;
  if (now - last < 30 * 60_000) return null;
  await bot.store.setState('levels_profiles_sync', now);
  const members = (await guildMembers(bot)).filter((m) => m.user && !m.user.bot);
  return bot.store.syncLevelProfiles(
    members.map((m) => ({ id: m.user.id, tag: m.user.username, name: m.nick ?? m.user.global_name ?? null, avatar: m.user.avatar ?? null })),
  );
}

// ---------- Publiczny profil (karta po kliknięciu na stronie rankingu) ----------

// Nitro po tym, co bot widzi w API: animowany avatar, własny baner, avatar albo baner tylko na tym serwerze,
// styl nazwy wyświetlanej. Kolorów motywu profilu Nitro API botom nie daje — jest kolor banera (accent_color).
export function nitroLook(user, member = null) {
  const styles = user?.display_name_styles ?? null;
  const nameColors = (styles?.colors ?? []).map(hexColor).filter(Boolean).slice(0, 2);
  const nitro = Boolean(
    String(user?.avatar ?? '').startsWith('a_') || user?.banner || member?.avatar || member?.banner || nameColors.length || styles?.font_id || styles?.effect_id,
  );
  return { nitro, accentColor: hexColor(user?.accent_color), nameColors };
}

// Co przebieg crona kilka osób z rankingu: kolor akcentu i Nitro (każda osoba najwyżej co 12 h).
export async function levelAccentTick(bot, { batch = 5 } = {}) {
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled || !config.publicLeaderboard) return 0;
  const ids = await bot.store.levelsNeedingLook(batch);
  for (const id of ids) {
    const [user, member] = await Promise.all([
      cached(bot, `publicUser:${id}`, 10 * 60_000, () => bot.discord.get(`/users/${id}`).catch(() => null)),
      memberInfo(bot, id),
    ]);
    const look = nitroLook(user ?? member?.user, member);
    await bot.store.setLevelLook(id, { accentColor: look.accentColor, nitro: look.nitro });
  }
  return ids.length;
}

const cdnImage = (path, hash, size) => `https://cdn.discordapp.com/${path}/${hash}.${String(hash).startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
const hexColor = (n) => (Number.isInteger(n) && n > 0 ? `#${n.toString(16).padStart(6, '0')}` : null);
const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const isoOrNull = (v) => (v ? new Date(v).toISOString() : null);

// Tylko osoby z XP w rankingu i tylko gdy publiczny ranking jest włączony. Zwraca null, gdy nie ma kogo pokazać.
export async function publicProfile(bot, userId) {
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled || !config.publicLeaderboard || !/^\d{15,22}$/.test(String(userId ?? ''))) return null;
  const row = await bot.store.getLevel(userId);
  if (!row || row.xp <= 0) return null;
  const { guild, roles: byId } = await getGuildContext(bot);
  const [user, member] = await Promise.all([
    cached(bot, `publicUser:${userId}`, 10 * 60_000, () => bot.discord.get(`/users/${userId}`).catch(() => null)),
    memberInfo(bot, userId),
  ]);
  const u = user ?? member?.user ?? { id: userId, username: row.userTag };
  const p = levelProgress(row.xp, config.formula);
  const week = row.weekKey === weekKey() ? row.weekXp : 0;
  const month = row.monthKey === monthKey() ? row.monthXp : 0;
  const [weekRank, monthRank] = await Promise.all([
    week > 0 ? bot.store.periodRank({ period: 'week', key: weekKey(), xp: week }) : null,
    month > 0 ? bot.store.periodRank({ period: 'month', key: monthKey(), xp: month }) : null,
  ]);
  const roles = (member?.roles ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => b.position - a.position)
    .slice(0, 12)
    .map((r) => ({ name: r.name, color: hexColor(r.color) }));
  const nextReward = [...config.rewards]
    .sort((a, b) => a.level - b.level)
    .find((r) => r.level > p.level && byId.has(r.roleId));
  const nextRole = nextReward ? byId.get(nextReward.roleId) : null;
  const lastActive = [row.lastMessageAt, row.lastVoiceAt, row.lastReactionAt].filter(Boolean).map((d) => new Date(d).getTime());
  const look = nitroLook(u, member);
  if (user && (look.nitro !== row.nitro || look.accentColor !== row.accentColor)) {
    await bot.store.setLevelLook(userId, { accentColor: look.accentColor, nitro: look.nitro });
  }
  return {
    id: userId,
    username: u.username ?? row.userTag ?? null,
    displayName: member?.nick ?? u.global_name ?? row.displayName ?? null,
    avatar: member?.avatar ? cdnImage(`guilds/${guild.id}/users/${userId}/avatars`, member.avatar, 256) : u.avatar ? cdnImage(`avatars/${userId}`, u.avatar, 256) : avatarUrl({ id: userId }, 256),
    banner: member?.banner ? cdnImage(`guilds/${guild.id}/users/${userId}/banners`, member.banner, 600) : u.banner ? cdnImage(`banners/${userId}`, u.banner, 600) : null,
    decoration: u.avatar_decoration_data?.asset ? `https://cdn.discordapp.com/avatar-decoration-presets/${u.avatar_decoration_data.asset}.png?size=240&passthrough=true` : null,
    accentColor: look.accentColor,
    nitro: look.nitro,
    nameColors: look.nameColors,
    inGuild: Boolean(member),
    joinedAt: isoOrNull(member?.joined_at),
    boostingSince: isoOrNull(member?.premium_since),
    createdAt: new Date(snowflakeTime(userId)).toISOString(),
    lastActive: lastActive.length ? new Date(Math.max(...lastActive)).toISOString() : null,
    roles,
    nextReward: nextRole ? { level: nextReward.level, name: nextRole.name, color: hexColor(nextRole.color) } : null,
    stats: {
      rank: row.rank,
      xp: row.xp,
      level: p.level,
      current: p.current,
      needed: p.needed,
      messages: row.messages,
      voiceMinutes: row.voiceMinutes,
      reactions: row.reactions,
      weekXp: week,
      weekRank,
      monthXp: month,
      monthRank,
    },
  };
}

// ---------- Rankingi tygodnia i miesiąca ----------

const MEDALS = ['🥇', '🥈', '🥉'];
const pl = (n) => Number(n).toLocaleString('pl-PL');

export function highlightsEmbed(config, period, key, top) {
  const title = period === 'week' ? '🏆 Najaktywniejsi tygodnia' : '🏆 Najaktywniejsi miesiąca';
  const range =
    period === 'week'
      ? (() => {
          const start = Date.parse(`${key}T00:00:00Z`);
          const fmt = (ms) => new Date(ms).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', timeZone: 'UTC' });
          return `${fmt(start)} – ${fmt(start + 6 * DAY)}`;
        })()
      : new Date(`${key}-01T00:00:00Z`).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lines = top.map((row, i) => `${MEDALS[i] ?? `**${i + 1}.**`} <@${row.userId}> — **${pl(row.periodXp)} XP** · poziom ${row.level}`);
  return {
    color: colorInt(config.card.color),
    title,
    description: `Osoby, które zdobyły najwięcej XP (${range}):\n\n${lines.join('\n')}`,
    footer: { text: `${BRAND} • gratulacje!` },
  };
}

async function postHighlights(bot, config, period, key) {
  const settings = period === 'week' ? config.highlights.weekly : config.highlights.monthly;
  const top = await bot.store.levelPeriodTop({ period, key, limit: 10 });
  if (!top.length || !settings.channelId) return false;
  const roleId = config.highlights.roleId;
  await bot.discord.post(`/channels/${settings.channelId}/messages`, {
    ...(roleId ? { content: `<@&${roleId}>` } : {}),
    embeds: [highlightsEmbed(config, period, key, top)],
    allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
  });
  return true;
}

// Raz w tygodniu (niedziela 00:00 UTC) i raz w miesiącu (1. dnia 00:00 UTC) ranking osób, które w zakończonym
// okresie zdobyły najwięcej XP. Przy pierwszym uruchomieniu tylko zapamiętujemy okres (bez wysyłania starego).
export async function highlightsTick(bot, { now = Date.now() } = {}) {
  const config = (await bot.store.getConfig()).levels;
  if (!config.enabled) return null;
  const report = {};
  for (const [period, settings, key, stateKey] of [
    ['week', config.highlights.weekly, previousWeekKey(now), 'levels_highlight_week'],
    ['month', config.highlights.monthly, previousMonthKey(now), 'levels_highlight_month'],
  ]) {
    if (!settings.enabled || !settings.channelId) continue;
    const posted = await bot.store.getState(stateKey);
    if (posted === key) continue;
    await bot.store.setState(stateKey, key);
    if (!posted) continue;
    report[period] = await postHighlights(bot, config, period, key).catch((error) => {
      console.warn(`[poziomy] Ranking (${period}): ${error.message}`);
      return false;
    });
  }
  return report;
}

// ---------- Karta poziomu ----------

const BAR = 12;
export function progressBar(current, needed) {
  const filled = needed > 0 ? Math.round((current / needed) * BAR) : BAR;
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR - filled)}`;
}

export async function rankCardEmbed(bot, config, user) {
  const row = (await bot.store.getLevel(user.id)) ?? { xp: 0, messages: 0, voiceMinutes: 0, reactions: 0, weekXp: 0, rank: null };
  const p = levelProgress(row.xp, config.formula);
  const pct = p.needed ? Math.floor((p.current / p.needed) * 100) : 100;
  const name = user.global_name ?? user.username ?? row.userTag ?? 'Użytkownik';
  return {
    color: colorInt(config.card.color),
    author: { name, icon_url: avatarUrl(user, 64) },
    title: `Poziom ${p.level}${row.rank ? ` • #${row.rank} w rankingu` : ''}`,
    description: p.maxed
      ? `${progressBar(1, 1)} maksymalny poziom`
      : `${progressBar(p.current, p.needed)} **${pct}%**\n${pl(p.current)} / ${pl(p.needed)} XP do poziomu ${p.level + 1}`,
    fields: [
      { name: 'Łącznie XP', value: pl(row.xp), inline: true },
      { name: 'Wiadomości', value: pl(row.messages), inline: true },
      { name: 'Na głosowych', value: `${pl(row.voiceMinutes)} min`, inline: true },
      { name: 'Ten tydzień', value: `${pl(row.weekKey === weekKey() ? row.weekXp : 0)} XP`, inline: true },
    ],
    thumbnail: { url: avatarUrl(user, 256) },
    ...(config.card.image ? { image: { url: config.card.image } } : {}),
    footer: { text: BRAND },
  };
}

// ---------- Import z rankingu Arcane ----------

// Linie „nazwa poziom xp [wiadomości] [reakcje]” (xp może być w tysiącach: 12.6K). Zwraca wpisy i błędne linie.
export function parseImport(text) {
  const num = (v) => {
    const m = /^([\d.,]+)\s*([km])?$/i.exec(String(v ?? '').trim());
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    return Math.round(n * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1));
  };
  const entries = [];
  const invalid = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*#?\d+[.)]\s+/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const username = parts[0]?.replace(/^@/, '').toLowerCase();
    const level = Number(parts[1]);
    const xp = num(parts[2]);
    if (!username || !Number.isInteger(level) || xp === null) {
      invalid.push(raw.trim());
      continue;
    }
    entries.push({ username, level, xp, messages: num(parts[3]) ?? 0, reactions: num(parts[4]) ?? 0 });
  }
  return { entries, invalid };
}

// Nazwy z odczytu zrzutu bywają przekręcone (l/i/1, o/0) — porównujemy też w uproszczonej postaci.
const looseName = (name) => String(name).toLowerCase().replace(/[il1|]/g, 'i').replace(/[o0]/g, 'o').replace(/[^a-z0-9]/g, '');

async function guildMembers(bot) {
  const { guild } = await getGuildContext(bot);
  const all = [];
  let after = '0';
  for (let page = 0; page < 20; page += 1) {
    const batch = await bot.discord.get(`/guilds/${guild.id}/members`, { query: { limit: 1000, after } });
    if (!batch?.length) break;
    all.push(...batch);
    after = batch.at(-1).user.id;
    if (batch.length < 1000) break;
  }
  return all;
}

// Ustawia XP (nie mniej niż próg poziomu z Arcane, żeby poziom wyszedł taki sam), poziom i statystyki osobom
// dopasowanym po nazwie. Istniejącego większego XP nie zmniejsza.
export async function importLevels(bot, entries) {
  const config = (await bot.store.getConfig()).levels;
  const members = (await guildMembers(bot)).filter((m) => !m.user?.bot);
  const exact = new Map(members.map((m) => [m.user.username.toLowerCase(), m]));
  const loose = new Map();
  for (const m of members) {
    const key = looseName(m.user.username);
    loose.set(key, loose.has(key) ? null : m);
  }
  const imported = [];
  const notFound = [];
  for (const entry of entries) {
    const member = exact.get(entry.username) ?? loose.get(looseName(entry.username)) ?? null;
    if (!member) {
      notFound.push(entry.username);
      continue;
    }
    const floor = totalXpForLevel(entry.level, config.formula);
    const ceiling = totalXpForLevel(entry.level + 1, config.formula) - 1;
    const xp = Math.min(Math.max(entry.xp, floor), ceiling);
    const row = await bot.store.importLevel({
      userId: member.user.id,
      userTag: member.user.username,
      displayName: member.nick ?? member.user.global_name ?? null,
      avatar: member.user.avatar ?? null,
      xp,
      messages: entry.messages,
      reactions: entry.reactions,
    });
    await bot.store.setLevel(member.user.id, levelProgress(row.xp, config.formula).level);
    imported.push({ username: member.user.username, userId: member.user.id, xp: row.xp });
  }
  return { imported: imported.length, notFound, entries: imported };
}

// ---------- Zmiany ręczne (/xp, panel) ----------

// mode: add (może być ujemne), set, level (ustaw poziom), reset. Zwraca nowy stan; nagrody w rolach dochodzą
// przy wzroście poziomu (bez wiadomości o awansie).
export async function changeXp(bot, userId, { mode, amount = 0, user = null }) {
  const config = (await bot.store.getConfig()).levels;
  const before = (await bot.store.getLevel(userId)) ?? { xp: 0, level: 0 };
  let target;
  if (mode === 'reset') target = 0;
  else if (mode === 'set') target = amount;
  else if (mode === 'level') target = totalXpForLevel(amount, config.formula);
  else target = before.xp + amount;
  const row = await bot.store.setXp({ userId, xp: Math.max(0, Math.floor(target)), userTag: user?.username ?? null, avatar: user?.avatar ?? null });
  const { level } = levelProgress(row.xp, config.formula);
  await bot.store.setLevel(userId, level);
  if (level > before.level) {
    const member = await memberInfo(bot, userId);
    await applyRewards(bot, config, { userId, level, previous: before.level, roles: member?.roles });
  }
  return { xp: row.xp, level, previous: before.level };
}

// Czy ktoś może używać /xp (blokada „tylko właściciel”) i resetować XP.
export async function canManageXp(bot, member, { reset = false } = {}) {
  const config = (await bot.store.getConfig()).levels;
  const { guild } = await getGuildContext(bot);
  const owner = member?.id === guild.ownerId;
  if (config.management.lockXpCommand && !owner) return false;
  if (reset && config.management.lockReset && !owner) return false;
  return owner || has(member?.permissions ?? '0', P.MANAGE_GUILD);
}

