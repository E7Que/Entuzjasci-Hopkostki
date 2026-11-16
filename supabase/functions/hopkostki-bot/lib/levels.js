// Poziomy jak w Arcane: XP za wiadomości, kanały głosowe i reakcje, awanse z wiadomością i nagrodami w rolach,
// boostery (rola, kanał, „wysiłek”), ograniczenia (kanały, role, wątki, fora, czat kanałów głosowych, komendy
// slash), rola za 1. miejsce, tygodniowe i miesięczne rankingi najaktywniejszych z pingiem roli, karta poziomu
// i import XP z rankingu Arcane.

import { P, has } from './permissions.js';
import { avatarUrl, guildIconUrl } from './rest.js';
import { cached, getGuildContext, isOurGuild } from './moderation.js';
import { BRAND, colorInt, escapeMarkdown } from './embeds.js';
import { PANEL_SITE } from './access.js';

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
// Doba według czasu polskiego — dzienny limit XP i historia w bot.level_daily.
export const dayKey = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });

// Skrót treści do wykrywania powtórek: bez wielkości liter, polskich znaków, interpunkcji i powtórzonych liter
// („Siemaaa!!” = „siema”). null, gdy wiadomość nie ma tekstu.
export function textHash(content) {
  const raw = String(content ?? '').trim().toLowerCase();
  if (!raw) return null;
  const letters = raw.replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '').replace(/(.)\1+/gu, '$1');
  let h = 0x811c9dc5;
  for (const ch of letters || raw.replace(/\s+/g, ' ')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
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
export async function awardXp(bot, config, { user, amount, kind, cooldown, minutes = 0, channelId = null, roles, displayName = null, hash = null }) {
  if (!user?.id || amount <= 0) return null;
  // Wydarzenie XP: XP i dzienny limit razy mnożnik, XP liczone też do rankingu wydarzenia.
  const event = activeXpEvent(config, { kind });
  const mult = event?.multiplier ?? 1;
  const row = await bot.store.awardXp({
    userId: user.id,
    userTag: userTag(user),
    displayName: displayName ?? user.global_name ?? null,
    avatar: user.avatar ?? null,
    amount: Math.round(amount * mult),
    kind,
    cooldownSec: cooldown,
    minutes,
    weekKey: weekKey(),
    monthKey: monthKey(),
    dayKey: dayKey(),
    dailyCap: config.antiFarm.dailyCap > 0 ? Math.round(config.antiFarm.dailyCap * mult) : 0,
    textHash: config.antiFarm.ignoreRepeats ? hash : null,
    eventId: event?.id ?? null,
  });
  if (!row) return null;
  const { level } = levelProgress(row.xp, config.formula);
  if (level !== row.level) await bot.store.setLevel(user.id, level);
  if (level > row.level) await onLevelUp(bot, config, { user, level, previous: row.level, xp: row.xp, channelId, roles });
  return { xp: row.xp, level, previous: row.level, granted: row.granted };
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

// Wiadomość o awansie — ta sama przy prawdziwym awansie i przy teście z panelu.
export async function levelUpMessage(bot, config, { user, level, previous, xp, earned = [] }) {
  const gctx = await getGuildContext(bot);
  const person = await levelPerson(bot, user);
  const roleName = (id) => gctx.roles.get(id)?.name ?? 'rola';
  const content = levelUpText(config.levelUp.message, { user: { ...person.user, global_name: person.name }, level, xp, earned, roleName });
  return {
    content: content.slice(0, 2000),
    allowed_mentions: { users: [user.id], roles: [] },
    ...(config.levelUp.card ? { embeds: [await levelUpEmbed(bot, config, { user, level, previous, xp, earned })] } : {}),
  };
}

async function onLevelUp(bot, config, { user, level, previous, xp, channelId, roles }) {
  const earned = await applyRewards(bot, config, { userId: user.id, level, previous, roles });
  const msg = config.levelUp;
  if (!msg.enabled) return;
  const payload = await levelUpMessage(bot, config, { user, level, previous, xp, earned });
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
  const text = String(message.content ?? '');
  // Ochrona przed nabijaniem dotyczy treści pisanej przez osobę (nie odpowiedzi botów na komendy slash).
  const own = !user?.bot;
  const files = (message.attachments ?? []).length + (message.sticker_items ?? []).length;
  if (own && config.antiFarm.minChars > 0 && !files && text.trim().length < config.antiFarm.minChars) return;
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

  const words = text.split(/\s+/).filter(Boolean).length;
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
    hash: own ? textHash(text) : null,
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
// ogłuszonych i kanał AFK serwera, a ogłuszonych (nic nie słyszą) nie liczy też do minimum.
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
    const counted = config.voice.antiAfk ? members.filter((s) => !s.deafened) : members;
    if (counted.length < config.voice.minMembers) continue;
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
    members.map((m) => ({ id: m.user.id, tag: m.user.username, name: m.nick ?? m.user.global_name ?? null, avatar: m.user.avatar ?? null, guildAvatar: m.avatar ?? null })),
  );
}

// ---------- Publiczny profil (karta po kliknięciu na stronie rankingu) ----------

// Personalizacja profilu, którą API Discorda pokazuje botom: styl nazwy (czcionka, efekt, kolory), tabliczka
// z nazwą (nameplate), tag serwera, dekoracja avatara i kolor banera. Kolorów motywu profilu, bio i efektów
// profilu boty nie dostają. Nitro rozpoznajemy po animowanym avatarze, banerze, profilu serwerowym i stylu nazwy.
const safePath = (v) => (typeof v === 'string' && /^[\w\-/.]{1,200}$/.test(v) && !v.includes('..') ? v : null);
export function profileLook(user, member = null) {
  const styles = user?.display_name_styles ?? null;
  const nameColors = (styles?.colors ?? []).map(hexColor).filter(Boolean).slice(0, 2);
  const font = Number.isInteger(styles?.font_id) ? styles.font_id : null;
  const effect = Number.isInteger(styles?.effect_id) ? styles.effect_id : null;
  const plate = user?.collectibles?.nameplate;
  const guildTag = user?.primary_guild;
  const look = {
    font,
    effect,
    nameColors,
    decoration: safePath(user?.avatar_decoration_data?.asset),
    nameplate: safePath(plate?.asset) ? { asset: plate.asset, palette: safePath(plate.palette) } : null,
    tag:
      guildTag?.identity_enabled && typeof guildTag.tag === 'string' && guildTag.tag
        ? { text: guildTag.tag.slice(0, 8), badge: safePath(guildTag.badge), guildId: /^\d+$/.test(String(guildTag.identity_guild_id ?? '')) ? String(guildTag.identity_guild_id) : null }
        : null,
  };
  const nitro = Boolean(String(user?.avatar ?? '').startsWith('a_') || user?.banner || member?.avatar || member?.banner || nameColors.length || font || effect);
  const empty = !font && !effect && !nameColors.length && !look.decoration && !look.nameplate && !look.tag;
  // accent_color to kolor banera „bez obrazka” — przy ustawionym obrazku Discord go nie pokazuje (bywa nieaktualny),
  // więc wtedy kolory karty bierze strona z samego banera i avatara.
  const hasBanner = Boolean(user?.banner || member?.banner);
  return { nitro, accentColor: hasBanner ? null : hexColor(user?.accent_color), nameColors, look: empty ? null : look };
}
export const nitroLook = profileLook;

// Adresy obrazków do strony (dekoracja: statyczna na liście, animowana w profilu).
export function publicLook(look, { animated = false } = {}) {
  if (!look) return null;
  return {
    font: look.font ?? null,
    effect: look.effect ?? null,
    colors: look.nameColors ?? [],
    decoration: look.decoration ? `https://cdn.discordapp.com/avatar-decoration-presets/${look.decoration}.png?size=${animated ? 240 : 96}&passthrough=${animated}` : null,
    nameplate: look.nameplate
      ? { image: `https://cdn.discordapp.com/assets/collectibles/${look.nameplate.asset.replace(/\/?$/, '/')}static.png`, palette: look.nameplate.palette ?? null }
      : null,
    tag: look.tag
      ? { text: look.tag.text, badge: look.tag.badge && look.tag.guildId ? `https://cdn.discordapp.com/guild-tag-badges/${look.tag.guildId}/${look.tag.badge}.png?size=32` : null }
      : null,
  };
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
    const look = profileLook(user ?? member?.user, member);
    await bot.store.setLevelLook(id, { accentColor: look.accentColor, nitro: look.nitro, look: look.look, avatar: user ? user.avatar ?? null : undefined });
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
  const event = rankedXpEvent(config);
  const [weekRank, monthRank, eventStanding] = await Promise.all([
    week > 0 ? bot.store.periodRank({ period: 'week', key: weekKey(), xp: week }) : null,
    month > 0 ? bot.store.periodRank({ period: 'month', key: monthKey(), xp: month }) : null,
    event ? bot.store.eventStanding(event.id, userId) : null,
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
  const look = profileLook(u, member);
  if (user && (look.nitro !== row.nitro || look.accentColor !== row.accentColor || JSON.stringify(look.look) !== JSON.stringify(row.look))) {
    await bot.store.setLevelLook(userId, { accentColor: look.accentColor, nitro: look.nitro, look: look.look, avatar: u.avatar ?? null });
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
    look: publicLook(look.look, { animated: true }),
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
      event: event ? { name: event.name, xp: eventStanding?.xp ?? 0, rank: eventStanding?.rank ?? null } : null,
    },
  };
}

// ---------- Wydarzenia XP ----------

export const XP_EVENT_STYLE = {
  confetti: { emoji: '🎉', color: 0xff4fa3 },
  fire: { emoji: '🔥', color: 0xff6a1a },
  snow: { emoji: '❄️', color: 0x7cc8ff },
  stars: { emoji: '✨', color: 0xf5c04a },
  neon: { emoji: '⚡', color: 0x22e5c8 },
};
const XP_KIND_NAMES = { message: 'wiadomości', voice: 'kanały głosowe', reaction: 'reakcje' };
const listText = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} i ${items.at(-1)}` : (items[0] ?? ''));
export const multiplierText = (m) => `×${String(m).replace('.', ',')}`;
const eventTime = (e, key) => Date.parse(e[key]);

// Wydarzenie trwające w chwili `now` (dla rodzaju XP `kind`, jeśli podany); przy kilku — największy mnożnik.
export function activeXpEvent(config, { kind = null, now = Date.now() } = {}) {
  let best = null;
  for (const e of config.events ?? []) {
    if (eventTime(e, 'startsAt') > now || eventTime(e, 'endsAt') <= now) continue;
    if (kind && !e.kinds.includes(kind)) continue;
    if (!best || e.multiplier > best.multiplier) best = e;
  }
  return best;
}

// Ostatnie zakończone wydarzenie (najwyżej `within` ms temu).
function lastXpEvent(config, now, within = 3 * DAY) {
  return (config.events ?? [])
    .filter((e) => eventTime(e, 'endsAt') <= now && now - eventTime(e, 'endsAt') <= within)
    .sort((a, b) => eventTime(b, 'endsAt') - eventTime(a, 'endsAt'))[0] ?? null;
}

export const publicXpEvent = (e) => (e ? { id: e.id, name: e.name, multiplier: e.multiplier, startsAt: e.startsAt, endsAt: e.endsAt, kinds: e.kinds, theme: e.theme } : null);

// Dla strony rankingu: trwające wydarzenie, najbliższe zaplanowane (do 14 dni) i ostatnie zakończone (do 3 dni).
export function xpEventsOverview(config, now = Date.now()) {
  const next = (config.events ?? [])
    .filter((e) => eventTime(e, 'startsAt') > now && eventTime(e, 'startsAt') - now <= 14 * DAY)
    .sort((a, b) => eventTime(a, 'startsAt') - eventTime(b, 'startsAt'))[0];
  return { current: publicXpEvent(activeXpEvent(config, { now })), next: publicXpEvent(next), last: publicXpEvent(lastXpEvent(config, now)) };
}

// Wydarzenie dla rankingu wydarzenia: wskazane (jeśli już się zaczęło), inaczej trwające albo ostatnie zakończone.
export function rankedXpEvent(config, id = null, now = Date.now()) {
  if (id) {
    const picked = (config.events ?? []).find((e) => e.id === id && eventTime(e, 'startsAt') <= now);
    if (picked) return picked;
  }
  return activeXpEvent(config, { now }) ?? lastXpEvent(config, now);
}

function eventChannel(config) {
  return config.eventsAnnounce.channelId || config.levelUp.channelId || config.highlights.weekly.channelId || config.highlights.monthly.channelId || '';
}

function eventFooter(guild) {
  return { text: `${guild?.name ?? BRAND} • wydarzenie XP`, ...(guildIconUrl(guild) ? { icon_url: guildIconUrl(guild) } : {}) };
}

export function xpEventStartEmbed(config, event, guild = null) {
  const style = XP_EVENT_STYLE[event.theme] ?? XP_EVENT_STYLE.confetti;
  const end = Math.floor(eventTime(event, 'endsAt') / 1000);
  const cap = config.antiFarm.dailyCap > 0 ? Math.round(config.antiFarm.dailyCap * event.multiplier) : 0;
  const lines = [
    `Zdobywasz **${multiplierText(event.multiplier)} XP** za ${listText(event.kinds.map((k) => XP_KIND_NAMES[k]))}!`,
    `Koniec <t:${end}:R> (<t:${end}:f>).`,
    cap ? `Dzienny limit XP w tym czasie: **${pl(cap)} XP**.` : null,
    config.publicLeaderboard ? `\n[Ranking wydarzenia na żywo](${PANEL_SITE}ranking.html#event)` : null,
  ];
  return {
    color: style.color,
    title: `${style.emoji} Wydarzenie XP: ${event.name}`,
    description: lines.filter(Boolean).join('\n'),
    footer: eventFooter(guild),
    timestamp: new Date(Math.max(eventTime(event, 'startsAt'), 0)).toISOString(),
  };
}

// „5 osób zdobyło”, „2 osoby zdobyły”, „1 osoba zdobyła”.
function peopleEarned(n) {
  if (n === 1) return '**1** osoba zdobyła';
  const few = n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14);
  return `**${pl(n)}** ${few ? 'osoby zdobyły' : 'osób zdobyło'}`;
}

export function xpEventEndEmbed(config, event, top, summary, guild = null) {
  const style = XP_EVENT_STYLE[event.theme] ?? XP_EVENT_STYLE.confetti;
  const lines = top.map((row, i) => `${MEDALS[i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``} <@${row.userId}> — **${pl(row.periodXp)} XP**`);
  const description = top.length
    ? `Najwięcej XP w czasie wydarzenia:\n\n${lines.join('\n')}\n\nŁącznie ${peopleEarned(summary.people)} **${pl(summary.xp)} XP**. Dzięki za udział!`
    : 'Nikt nie zdobył XP w czasie wydarzenia.';
  const thumb = winnerThumbnail(top[0], guild);
  return {
    color: style.color,
    title: `🏁 Koniec wydarzenia XP: ${event.name}`,
    description: description + (config.publicLeaderboard && top.length ? `\n\n[Pełne wyniki](${PANEL_SITE}ranking.html#event)` : ''),
    ...(thumb ? { thumbnail: { url: thumb } } : {}),
    footer: eventFooter(guild),
    timestamp: new Date(eventTime(event, 'endsAt')).toISOString(),
  };
}

// Co przebieg crona: ogłoszenie początku i końca każdego wydarzenia (raz), sprzątanie XP usuniętych wydarzeń.
// Wydarzenie dodane już po końcu nie jest ogłaszane; koniec ogłaszamy tylko, gdy był ogłoszony początek.
export async function xpEventsTick(bot, { now = Date.now() } = {}) {
  const config = (await bot.store.getConfig()).levels;
  const events = config.events ?? [];
  const seen = (await bot.store.getState('xp_events')) ?? {};
  const channelId = eventChannel(config);
  const announce = Boolean(config.enabled && config.eventsAnnounce.enabled && channelId && bot.discord);
  const next = {};
  const report = { started: 0, ended: 0 };
  let guild;
  const send = async (payload) => {
    guild ??= (await getGuildContext(bot).catch(() => null))?.guild ?? null;
    await bot.discord.post(`/channels/${channelId}/messages`, payload(guild));
    return true;
  };
  for (const event of events) {
    const mark = { ...(seen[event.id] ?? {}) };
    const started = eventTime(event, 'startsAt') <= now;
    const ended = eventTime(event, 'endsAt') <= now;
    if (started && !ended && !mark.started) {
      mark.started = true;
      if (announce) {
        const roleId = config.eventsAnnounce.roleId;
        const sent = await send((g) => ({
          ...(roleId ? { content: `<@&${roleId}>` } : {}),
          embeds: [xpEventStartEmbed(config, event, g)],
          allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] },
        })).catch((error) => console.warn(`[poziomy] Wydarzenie XP (start): ${error.message}`));
        if (sent) report.started += 1;
      }
    } else if (ended && !mark.ended) {
      const wasAnnounced = mark.started;
      mark.started = true;
      mark.ended = true;
      if (announce && wasAnnounced) {
        const [top, summary] = await Promise.all([bot.store.levelEventTop({ eventId: event.id, limit: 5 }), bot.store.eventSummary(event.id)]);
        const sent = await send((g) => ({ embeds: [xpEventEndEmbed(config, event, top, summary, g)], allowed_mentions: { parse: [] } }))
          .catch((error) => console.warn(`[poziomy] Wydarzenie XP (koniec): ${error.message}`));
        if (sent) report.ended += 1;
      }
    }
    next[event.id] = mark;
  }
  if (JSON.stringify(next) !== JSON.stringify(seen)) {
    await bot.store.setState('xp_events', next);
    await bot.store.pruneEventXp(events.map((e) => e.id));
  }
  return report;
}

// ---------- Rankingi tygodnia i miesiąca ----------

const MEDALS = ['🥇', '🥈', '🥉'];
const pl = (n) => Number(n).toLocaleString('pl-PL');

// Avatar zwycięzcy (serwerowy, jeśli jest) — miniatura embedów z rankingami.
function winnerThumbnail(winner, guild) {
  if (!winner) return null;
  if (winner.guildAvatar && guild?.id) return cdnImage(`guilds/${guild.id}/users/${winner.userId}/avatars`, winner.guildAvatar, 256);
  return winner.avatar ? cdnImage(`avatars/${winner.userId}`, winner.avatar, 256) : avatarUrl({ id: winner.userId }, 256);
}

// Ranking tygodnia — turkus, miesiąca — złoto; miniatura: avatar zwycięzcy.
export function highlightsEmbed(config, period, key, top, guild = null) {
  const title = period === 'week' ? '🏆 Najaktywniejsi tygodnia' : '🏆 Najaktywniejsi miesiąca';
  const range =
    period === 'week'
      ? (() => {
          const start = Date.parse(`${key}T00:00:00Z`);
          const fmt = (ms) => new Date(ms).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', timeZone: 'UTC' });
          return `${fmt(start)} – ${fmt(start + 6 * DAY)}`;
        })()
      : new Date(`${key}-01T00:00:00Z`).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const lines = top.map((row, i) => `${MEDALS[i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``} <@${row.userId}> — **${pl(row.periodXp)} XP** · poziom ${row.level}`);
  const winnerAvatar = winnerThumbnail(top[0], guild);
  return {
    color: config.card.autoColor === false ? colorInt(config.card.color, LEVEL_COLOR) : period === 'week' ? LEVEL_COLOR : 0xffc83d,
    title,
    description: `Osoby, które zdobyły najwięcej XP (${range}):\n\n${lines.join('\n')}`,
    ...(winnerAvatar ? { thumbnail: { url: winnerAvatar } } : {}),
    footer: { text: `${guild?.name ?? BRAND} • gratulacje!`, ...(guildIconUrl(guild) ? { icon_url: guildIconUrl(guild) } : {}) },
    timestamp: new Date().toISOString(),
  };
}

async function postHighlights(bot, config, period, key) {
  const settings = period === 'week' ? config.highlights.weekly : config.highlights.monthly;
  const top = await bot.store.levelPeriodTop({ period, key, limit: 10 });
  if (!top.length || !settings.channelId) return false;
  const roleId = config.highlights.roleId;
  const { guild } = await getGuildContext(bot);
  await bot.discord.post(`/channels/${settings.channelId}/messages`, {
    ...(roleId ? { content: `<@&${roleId}>` } : {}),
    embeds: [highlightsEmbed(config, period, key, top, guild)],
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

// ---------- Wygląd embedów poziomów ----------

// Kolor: rola za najwyższy osiągnięty poziom (jeśli ma kolor), a bez niej — kolor progu poziomu.
// Wyłączone „kolory zależne od poziomu” = jeden stały kolor z panelu.
export const LEVEL_COLOR = 0x3cc3d6;
const TIER_COLORS = [[100, 0xff4d6d], [75, 0xffc83d], [50, 0xff8a3d], [25, 0x9b6bff], [10, 0x3b9dff], [5, 0x2fc9a0], [0, LEVEL_COLOR]];
export function levelColor(config, level, roles = null) {
  if (config.card.autoColor === false) return colorInt(config.card.color, LEVEL_COLOR);
  const fromRole = [...config.rewards]
    .filter((r) => r.level <= level)
    .sort((a, b) => b.level - a.level)
    .map((r) => roles?.get(r.roleId)?.color)
    .find((c) => c > 0);
  return fromRole ?? TIER_COLORS.find(([min]) => level >= min)[1];
}

const definedOnly = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => v !== undefined && v !== null));

// Osoba do embedów: pseudonim i avatar z serwera (też animowany), baner z profilu — dane z Discorda z pamięcią.
// Dzięki temu karta ma prawdziwe zdjęcia także przy awansie z kanału głosowego i w teście z panelu.
async function levelPerson(bot, user, { banner = false } = {}) {
  const { guild } = await getGuildContext(bot);
  const member = await memberInfo(bot, user.id);
  const profile = banner || !(member?.user ?? user)?.username
    ? await cached(bot, `publicUser:${user.id}`, 10 * 60_000, () => bot.discord.get(`/users/${user.id}`).catch(() => null))
    : null;
  const u = { ...definedOnly(profile), ...definedOnly(member?.user), ...definedOnly(user) };
  const avatar = (size) =>
    member?.avatar
      ? cdnImage(`guilds/${guild.id}/users/${user.id}/avatars`, member.avatar, size)
      : u.avatar
        ? cdnImage(`avatars/${user.id}`, u.avatar, size)
        : avatarUrl({ id: user.id }, size);
  const bannerUrl = member?.banner
    ? cdnImage(`guilds/${guild.id}/users/${user.id}/banners`, member.banner, 1024)
    : profile?.banner
      ? cdnImage(`banners/${user.id}`, profile.banner, 1024)
      : null;
  return { user: u, name: member?.nick ?? u.global_name ?? u.username ?? 'Użytkownik', avatar, banner: bannerUrl, guild };
}

// Linki do załączników Discorda wygasają po ~24 h — przed wysłaniem bot prosi Discorda o świeży link.
const DISCORD_ATTACHMENT = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/(attachments|ephemeral-attachments)\//;
export async function freshImageUrl(bot, url) {
  if (!url) return null;
  if (!DISCORD_ATTACHMENT.test(url)) return url;
  return cached(bot, `freshUrl:${url}`, 6 * 60 * 60_000, async () => {
    const res = await bot.discord.post('/attachments/refresh-urls', { attachment_urls: [url] }).catch(() => null);
    return res?.refreshed_urls?.[0]?.refreshed ?? url;
  });
}

// Obrazek karty: baner osoby z Discorda (jeśli włączone i go ma), inaczej obrazek z panelu.
async function cardImage(bot, config, person) {
  if (config.card.userBanner !== false && person.banner) return person.banner;
  return freshImageUrl(bot, config.card.image);
}

const footerFor = (guild) => ({ text: guild?.name ?? BRAND, ...(guildIconUrl(guild) ? { icon_url: guildIconUrl(guild) } : {}) });
const voiceText = (min) => (min >= 60 ? `${pl(Math.floor(min / 60))} h ${min % 60} min` : `${pl(min)} min`);

export async function levelUpEmbed(bot, config, { user, level, previous, xp, earned = [] }) {
  const person = await levelPerson(bot, user, { banner: config.card.userBanner !== false });
  const { roles } = await getGuildContext(bot);
  const row = await bot.store.getLevel(user.id);
  const total = xp ?? row?.xp ?? 0;
  const p = levelProgress(total, config.formula);
  const pct = p.needed ? Math.floor((p.current / p.needed) * 100) : 100;
  const next = [...config.rewards].sort((a, b) => a.level - b.level).find((r) => r.level > level && roles.has(r.roleId));
  const fields = [
    { name: 'Poziom', value: `${previous ?? Math.max(0, level - 1)} → **${level}**`, inline: true },
    { name: 'Łącznie XP', value: pl(total), inline: true },
    { name: 'Miejsce', value: row?.rank ? `#${row.rank}` : '—', inline: true },
  ];
  if (earned.length) fields.push({ name: earned.length > 1 ? 'Nowe role' : 'Nowa rola', value: earned.map((r) => `<@&${r.roleId}>`).join(' '), inline: false });
  else if (next) fields.push({ name: 'Następna nagroda', value: `<@&${next.roleId}> na poziomie **${next.level}**`, inline: false });
  const image = await cardImage(bot, config, person);
  return {
    color: levelColor(config, level, roles),
    author: { name: person.name, icon_url: person.avatar(64) },
    title: `Awans na poziom ${level}!`,
    description: p.maxed
      ? `${progressBar(1, 1)} maksymalny poziom`
      : `${progressBar(p.current, p.needed)} **${pct}%**\n${pl(p.current)} / ${pl(p.needed)} XP do poziomu ${level + 1}`,
    fields,
    thumbnail: { url: person.avatar(256) },
    ...(image ? { image: { url: image } } : {}),
    footer: footerFor(person.guild),
    timestamp: new Date().toISOString(),
  };
}

export async function rankCardEmbed(bot, config, user) {
  const person = await levelPerson(bot, user, { banner: config.card.userBanner !== false });
  const { roles } = await getGuildContext(bot);
  const row = (await bot.store.getLevel(user.id)) ?? { xp: 0, messages: 0, voiceMinutes: 0, reactions: 0, weekXp: 0, rank: null };
  const p = levelProgress(row.xp, config.formula);
  const pct = p.needed ? Math.floor((p.current / p.needed) * 100) : 100;
  const image = await cardImage(bot, config, person);
  return {
    color: levelColor(config, p.level, roles),
    author: { name: person.name, icon_url: person.avatar(64) },
    title: `Poziom ${p.level}${row.rank ? ` • #${row.rank} w rankingu` : ''}`,
    description: p.maxed
      ? `${progressBar(1, 1)} maksymalny poziom`
      : `${progressBar(p.current, p.needed)} **${pct}%**\n${pl(p.current)} / ${pl(p.needed)} XP do poziomu ${p.level + 1}`,
    fields: [
      { name: 'Łącznie XP', value: pl(row.xp), inline: true },
      { name: 'Wiadomości', value: pl(row.messages), inline: true },
      { name: 'Na głosowych', value: voiceText(row.voiceMinutes), inline: true },
      { name: 'Ten tydzień', value: `${pl(row.weekKey === weekKey() ? row.weekXp : 0)} XP`, inline: true },
      { name: 'Ten miesiąc', value: `${pl(row.monthKey === monthKey() ? row.monthXp : 0)} XP`, inline: true },
      { name: 'Reakcje', value: pl(row.reactions), inline: true },
    ],
    thumbnail: { url: person.avatar(256) },
    ...(image ? { image: { url: image } } : {}),
    footer: footerFor(person.guild),
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

