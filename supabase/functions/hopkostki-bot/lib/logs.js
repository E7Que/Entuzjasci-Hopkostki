// Logi serwera w układzie Carl-bota (kanał domyślny + osobne kanały dla członków, serwera, głosowych,
// wiadomości i wejść/wyjść): usunięte/edytowane wiadomości, wejścia i wyjścia, role, nazwy, zdjęcia
// profilowe, bany, timeouty, kanały, wątki, role serwera, emoji i kanały głosowe.
//
// Źródła zdarzeń (gateway.js):
// - wiadomości: MESSAGE_CREATE/UPDATE/DELETE(_BULK) + bot.message_cache (Discord nie podaje starej treści),
// - wejścia/wyjścia: GUILD_MEMBER_ADD/REMOVE (intencja „Server Members”),
// - zdjęcie profilowe i nazwa użytkownika: GUILD_MEMBER_UPDATE + bot.member_profiles (poprzednia wersja),
// - głosowe: VOICE_STATE_UPDATE + bot.voice_states (poprzedni kanał),
// - reszta: GUILD_AUDIT_LOG_ENTRY_CREATE - dziennik zdarzeń mówi też, KTO coś zrobił i ze zmianami przed/po.

import { getApp, isOurGuild, resolveGuildId } from './moderation.js';
import { avatarUrl, messageUrl } from './rest.js';
import { COLORS, escapeMarkdown } from './embeds.js';
import { discordTimestamp } from './duration.js';
import { detectInvite, inviteLine } from './invites.js';

// Grupa = karta w panelu i własny kanał logów (logs.<grupa>ChannelId, puste = kanał domyślny).
export const GROUPS = {
  messages: ['messageDelete', 'messageEdit', 'messageBulk'],
  joinLeave: ['memberJoin', 'memberLeave', 'memberInvite'],
  members: ['memberRoles', 'memberNick', 'memberAvatar', 'memberBan', 'memberUnban', 'memberTimeout', 'memberTimeoutRemove', 'memberKick'],
  server: [
    'channelCreate', 'channelUpdate', 'channelDelete', 'threadCreate', 'threadUpdate', 'threadDelete',
    'roleCreate', 'roleUpdate', 'roleDelete', 'serverUpdate', 'emojiUpdate', 'inviteCreate',
  ],
  voice: ['voiceJoin', 'voiceMove', 'voiceLeave'],
};
// Zdarzenia z dziennika zdarzeń Discorda (reszta ma własne źródła).
const AUDIT_EVENTS = [...GROUPS.members.filter((e) => e !== 'memberAvatar'), ...GROUPS.server];
const GROUP_OF = Object.fromEntries(Object.entries(GROUPS).flatMap(([group, events]) => events.map((e) => [e, group])));
export const LOG_EVENTS = Object.keys(GROUP_OF);

const COLOR = { red: COLORS.error, green: COLORS.success, blue: COLORS.info, orange: 0xf0883e, yellow: COLORS.warning, grey: 0x99aab5 };
const MESSAGE_TYPES = new Set([0, 19, 20]); // zwykła, odpowiedź, komenda
const clip = (text, max) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const code = (text) => `\`${String(text ?? '').replace(/`/g, 'ˋ').slice(0, 200)}\``;

export function logChannelFor(logs, event) {
  if (!logs?.enabled || !logs.events?.[event]) return null;
  return logs[`${GROUP_OF[event]}ChannelId`] || logs.channelId || null;
}

export const messageLogsOn = (config) => GROUPS.messages.some((e) => logChannelFor(config.logs, e));
export const auditLogsOn = (config) => AUDIT_EVENTS.some((e) => logChannelFor(config.logs, e));
export const joinLogsOn = (config) => Boolean(logChannelFor(config.logs, 'memberJoin') || logChannelFor(config.logs, 'memberLeave'));
// Zmiany zdjęć profilowych i nazw użytkowników - też przez GUILD_MEMBER_UPDATE (intencja „Server Members”).
export const profileLogsOn = (config) => Boolean(logChannelFor(config.logs, 'memberAvatar') || logChannelFor(config.logs, 'memberNick'));

async function send(bot, config, event, payload, options) {
  const channelId = logChannelFor(config.logs, event);
  if (!channelId) return null;
  return bot.discord
    .post(`/channels/${channelId}/messages`, { allowed_mentions: { parse: [] }, ...payload }, options)
    .catch((error) => {
      console.warn(`[logi:${event}] ${error.message}`);
      return null;
    });
}

const userTag = (user) => user?.global_name ?? user?.username ?? 'Nieznany';
const authorOf = (user, suffix = '') => ({ name: clip(`${user?.username ?? 'Nieznany'}${suffix}`, 256), icon_url: avatarUrl(user ?? {}, 64) });
const now = () => new Date().toISOString();
const ignored = (config, channelId) => config.logs.ignoredChannelIds.includes(channelId);

async function botId(bot) {
  const app = await getApp(bot).catch(() => null);
  return app?.bot?.id ?? app?.id ?? null;
}

async function fetchUser(bot, id) {
  if (!id) return null;
  const key = `user:${id}`;
  const hit = bot.cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const user = await bot.discord.get(`/users/${id}`).catch(() => null);
  bot.cache.set(key, { at: Date.now(), value: user });
  return user;
}

// ---------- Wiadomości ----------

function attachmentList(list) {
  return (list ?? []).map((a) => ({ name: a.filename ?? a.name ?? 'plik', url: a.url ?? '' }));
}

export async function onMessageCreateLog(bot, message) {
  if (!message?.guild_id || !MESSAGE_TYPES.has(message.type ?? 0) || message.webhook_id) return;
  const config = await bot.store.getConfig();
  if (!messageLogsOn(config) || ignored(config, message.channel_id)) return;
  if (message.author?.bot && config.logs.ignoreBots) return;
  if (!(await isOurGuild(bot, message.guild_id))) return;
  await bot.store.cacheMessage({
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author.id,
    authorTag: message.author.username,
    authorAvatar: message.author.avatar ?? null,
    content: message.content ?? '',
    attachments: attachmentList(message.attachments),
    createdAt: message.timestamp,
  });
}

const cachedAuthor = (m) => ({ id: m.authorId, username: m.authorTag, avatar: m.authorAvatar });

function contentBlock(m) {
  const text = m.content ? clip(m.content, 3500) : '*brak treści (np. sam załącznik albo naklejka)*';
  const files = m.attachments?.length ? `\n\n**Załączniki:**\n${m.attachments.map((a) => `[${clip(a.name, 60)}](${a.url})`).join('\n')}` : '';
  return clip(text + files, 4000);
}

export async function onMessageDelete(bot, data) {
  const config = await bot.store.getConfig();
  if (!messageLogsOn(config) || !(await isOurGuild(bot, data?.guild_id))) return;
  const [message] = await bot.store.deleteCachedMessages([data.id]);
  // Wiadomości sprzed włączenia logów (albo botów) nie znamy - takich nie logujemy.
  if (!message || !config.logs.events.messageDelete) return;
  await send(bot, config, 'messageDelete', {
    embeds: [
      {
        color: COLOR.red,
        author: authorOf(cachedAuthor(message)),
        description: `**Wiadomość od <@${message.authorId}> usunięta na <#${message.channelId}>**\n${contentBlock(message)}`,
        footer: { text: `Autor: ${message.authorId} | Wiadomość: ${message.id}` },
        timestamp: now(),
      },
    ],
  });
}

export async function onMessageUpdate(bot, data) {
  if (typeof data?.content !== 'string' || !data.edited_timestamp) return;
  const config = await bot.store.getConfig();
  if (!messageLogsOn(config) || ignored(config, data.channel_id)) return;
  if (data.author?.bot && config.logs.ignoreBots) return;
  if (!(await isOurGuild(bot, data.guild_id))) return;
  const before = await bot.store.editCachedMessage(data.id, data.content);
  // Zmiana bez nowej treści (np. doczytany podgląd linku) albo wiadomość, której nie znamy.
  if (!before || before.content === data.content || !config.logs.events.messageEdit) return;
  await send(bot, config, 'messageEdit', {
    embeds: [
      {
        color: COLOR.blue,
        author: authorOf(data.author ?? cachedAuthor(before)),
        description: `**Wiadomość od <@${before.authorId}> edytowana na <#${data.channel_id}>** [Przejdź do wiadomości](${messageUrl(data.guild_id, data.channel_id, data.id)})`,
        fields: [
          { name: 'Przed', value: clip(before.content || '*pusta*', 1024) },
          { name: 'Po', value: clip(data.content || '*pusta*', 1024) },
        ],
        footer: { text: `Autor: ${before.authorId} | Wiadomość: ${data.id}` },
        timestamp: now(),
      },
    ],
  });
}

export async function onMessageDeleteBulk(bot, data) {
  const config = await bot.store.getConfig();
  if (!messageLogsOn(config) || !(await isOurGuild(bot, data?.guild_id))) return;
  const messages = await bot.store.deleteCachedMessages(data.ids ?? []);
  if (!config.logs.events.messageBulk || ignored(config, data.channel_id)) return;
  const lines = messages.map((m) => `[${new Date(m.createdAt).toISOString().replace('T', ' ').slice(0, 19)}] ${m.authorTag} (${m.authorId}): ${m.content}${m.attachments.length ? ` [załączniki: ${m.attachments.map((a) => a.url).join(', ')}]` : ''}`);
  const files = lines.length ? [{ name: `usuniete-${data.channel_id}.txt`, content: lines.join('\n') }] : undefined;
  await send(
    bot,
    config,
    'messageBulk',
    {
      embeds: [
        {
          color: COLOR.red,
          description: `**Usunięto zbiorczo ${data.ids.length} wiadomości na <#${data.channel_id}>**${messages.length ? `\nZapisane treści: ${messages.length} (w pliku).` : ''}`,
          timestamp: now(),
        },
      ],
    },
    { files },
  );
}

// ---------- Wejścia i wyjścia ----------

// Oznaczenie przy nowym koncie: @here / @everyone albo wybrane role.
export function newAccountPing(alert) {
  if (alert.mention === 'roles') {
    return alert.roleIds.length ? { content: alert.roleIds.map((id) => `<@&${id}>`).join(' '), allowed_mentions: { roles: alert.roleIds } } : {};
  }
  const who = alert.mention === 'everyone' ? '@everyone' : '@here';
  return { content: who, allowed_mentions: { parse: ['everyone'] } };
}

// invite: wynik detectInvite policzony już przy wejściu (np. dla eventu zaproszeń); undefined = sprawdzamy tutaj.
export async function logMemberJoin(bot, member, memberCount, invite = undefined) {
  const config = await bot.store.getConfig();
  if (!logChannelFor(config.logs, 'memberJoin')) return;
  const user = member.user;
  const created = Number((BigInt(user.id) >> 22n) + 1420070400000n);
  const alert = config.logs.newAccount;
  const young = Date.now() - created < alert.days * 24 * 60 * 60_000;
  const limit = alert.days === 1 ? '1 dzień' : `${alert.days} dni`;
  // Kto zaprosił - liczone przed wysłaniem logu, żeby było w tej samej wiadomości.
  const used = config.logs.events.memberInvite ? (invite !== undefined ? invite : await detectInvite(bot, member).catch(() => null)) : undefined;
  const inviteText = config.logs.events.memberInvite ? `\n${inviteLine(used)}` : '';
  await send(bot, config, 'memberJoin', {
    ...(young && alert.ping && !user.bot ? newAccountPing(alert) : {}),
    embeds: [
      {
        color: young ? COLOR.yellow : COLOR.green,
        author: authorOf(user, ' dołączył(a)'),
        thumbnail: { url: avatarUrl(user, 128) },
        description: `<@${user.id}> ${escapeMarkdown(userTag(user))}${user.bot ? ' (bot)' : ''}\n**Konto założone:** ${discordTimestamp(created, 'f')} (${discordTimestamp(created, 'R')})${young ? `\n**Uwaga:** nowe konto - ma mniej niż ${limit}.` : ''}${inviteText}`,
        footer: { text: `ID: ${user.id}${memberCount ? ` • Członków: ${memberCount}` : ''}` },
        timestamp: now(),
      },
    ],
  });
}

export async function logMemberLeave(bot, data) {
  const config = await bot.store.getConfig();
  if (!logChannelFor(config.logs, 'memberLeave')) return;
  const user = data.user;
  const joined = config.logs.events.memberInvite ? await bot.store.inviteJoinFor(user.id).catch(() => null) : null;
  const invitedBy = joined?.inviterId ? `\n**Zaproszony/a przez:** <@${joined.inviterId}> (\`${joined.code}\`)` : joined?.code ? `\n**Wszedł/weszła przez:** własny link serwera` : '';
  await send(bot, config, 'memberLeave', {
    embeds: [
      {
        color: COLOR.orange,
        author: authorOf(user, ' wyszedł/wyszła'),
        thumbnail: { url: avatarUrl(user, 128) },
        description: `<@${user.id}> ${escapeMarkdown(userTag(user))}${invitedBy}`,
        footer: { text: `ID: ${user.id}` },
        timestamp: now(),
      },
    ],
  });
}

// ---------- Zdjęcie profilowe i nazwa użytkownika ----------

const animated = (hash) => String(hash ?? '').startsWith('a_');
// Zdjęcie widoczne na serwerze: własne serwerowe (jeśli jest), inaczej zwykłe, inaczej domyślne Discorda.
export function profileAvatarUrl(guildId, userId, profile, size = 512) {
  if (profile.guildAvatar) {
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${profile.guildAvatar}.${animated(profile.guildAvatar) ? 'gif' : 'png'}?size=${size}`;
  }
  if (profile.avatar) return `https://cdn.discordapp.com/avatars/${userId}/${profile.avatar}.${animated(profile.avatar) ? 'gif' : 'png'}?size=${size}`;
  return avatarUrl({ id: userId });
}

// Obrazek pobieramy od razu i dołączamy do logu - stary link z CDN Discorda po zmianie może przestać działać.
async function download(bot, url) {
  try {
    const res = await (bot.fetch ?? fetch)(url);
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? 'image/png').split(';')[0];
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length && bytes.length < 8 * 1024 * 1024 ? { bytes, type } : null;
  } catch {
    return null;
  }
}

async function logAvatarChange(bot, config, user, before, after) {
  const [old, fresh] = await Promise.all([download(bot, before), download(bot, after)]);
  const files = [];
  const attach = (image, name, url) => {
    if (!image) return url;
    const file = `${name}.${image.type.includes('gif') ? 'gif' : 'png'}`;
    files.push({ name: file, content: image.bytes, type: image.type });
    return `attachment://${file}`;
  };
  const beforeRef = attach(old, 'przed', before);
  const afterRef = attach(fresh, 'po', after);
  // Dwa embedy z tym samym linkiem Discord pokazuje jako jedną galerię: najpierw stare, obok nowe zdjęcie.
  const link = `https://discord.com/users/${user.id}`;
  await send(
    bot,
    config,
    'memberAvatar',
    {
      embeds: [
        {
          url: link,
          color: COLOR.blue,
          author: authorOf(user),
          description: `**<@${user.id}> zmienił(a) zdjęcie profilowe**\nPierwsze zdjęcie: **przed**, drugie: **po** zmianie.`,
          image: { url: beforeRef },
          footer: { text: `ID: ${user.id}` },
          timestamp: now(),
        },
        { url: link, image: { url: afterRef } },
      ],
    },
    files.length ? { files } : undefined,
  );
}

export async function onMemberUpdateLog(bot, member) {
  const user = member?.user;
  if (!user?.id) return;
  const config = await bot.store.getConfig();
  if (!profileLogsOn(config) || (user.bot && config.logs.ignoreBots) || !(await isOurGuild(bot, member.guild_id))) return;
  const next = { avatar: user.avatar ?? null, guildAvatar: member.avatar ?? null, username: user.username ?? null, globalName: user.global_name ?? null };
  const prev = await bot.store.swapMemberProfile(user.id, next);
  if (!prev) return; // pierwszy raz widzimy tę osobę - tylko zapamiętujemy

  const before = profileAvatarUrl(member.guild_id, user.id, prev);
  const after = profileAvatarUrl(member.guild_id, user.id, next);
  if (before !== after && logChannelFor(config.logs, 'memberAvatar')) await logAvatarChange(bot, config, user, before, after);

  if ((prev.username !== next.username || prev.globalName !== next.globalName) && logChannelFor(config.logs, 'memberNick')) {
    const label = (p) => `${p.globalName ? `${escapeMarkdown(p.globalName)} ` : ''}(\`${p.username ?? '?'}\`)`;
    await send(bot, config, 'memberNick', {
      embeds: [
        {
          color: COLOR.blue,
          author: authorOf(user),
          description: `**<@${user.id}> zmienił(a) nazwę użytkownika**`,
          fields: [
            { name: 'Przed', value: clip(label(prev), 1024), inline: true },
            { name: 'Po', value: clip(label(next), 1024), inline: true },
          ],
          footer: { text: `ID: ${user.id}` },
          timestamp: now(),
        },
      ],
    });
  }
}

// Zapas (cron co 6 h): zapamiętuje zdjęcia i nazwy wszystkich osób, żeby pierwsza zmiana też miała „przed”.
export async function seedMemberProfiles(bot) {
  const config = await bot.store.getConfig();
  if (!profileLogsOn(config)) return 0;
  const last = await bot.store.getState('profiles_seed');
  if (last && Date.now() - last < 6 * 60 * 60_000) return 0;
  await bot.store.setState('profiles_seed', Date.now());
  const app = await getApp(bot);
  if (!((app?.flags ?? 0) & ((1 << 14) | (1 << 15)))) return 0;
  const guildId = await resolveGuildId(bot);
  let after = '0';
  let seeded = 0;
  for (let page = 0; page < 10; page += 1) {
    const list = await bot.discord.get(`/guilds/${guildId}/members`, { query: { limit: 1000, after } });
    if (!list?.length) break;
    seeded += await bot.store.seedMemberProfiles(
      list.map((m) => ({ userId: m.user.id, avatar: m.user.avatar ?? null, guildAvatar: m.avatar ?? null, username: m.user.username ?? null, globalName: m.user.global_name ?? null })),
    );
    after = list.at(-1).user.id;
    if (list.length < 1000) break;
  }
  return seeded;
}

// ---------- Kanały głosowe ----------

export async function logVoiceChange(bot, state, previousChannelId) {
  const channelId = state.channel_id ?? null;
  if (previousChannelId === channelId) return; // wyciszenie, kamera itp.
  const config = await bot.store.getConfig();
  if (!config.logs.enabled) return;
  const user = state.member?.user ?? (await fetchUser(bot, state.user_id)) ?? { id: state.user_id };
  if (user.bot && config.logs.ignoreBots) return;
  if ((channelId && ignored(config, channelId)) || (previousChannelId && ignored(config, previousChannelId))) return;
  let event;
  let color;
  let text;
  if (!previousChannelId) {
    [event, color, text] = ['voiceJoin', COLOR.green, `**<@${user.id}> dołączył(a) do kanału głosowego <#${channelId}>**`];
  } else if (!channelId) {
    [event, color, text] = ['voiceLeave', COLOR.red, `**<@${user.id}> opuścił(a) kanał głosowy <#${previousChannelId}>**`];
  } else {
    [event, color, text] = ['voiceMove', COLOR.blue, `**<@${user.id}> przeszedł/przeszła z <#${previousChannelId}> na <#${channelId}>**`];
  }
  await send(bot, config, event, { embeds: [{ color, author: authorOf(user), description: text, footer: { text: `ID: ${user.id}` }, timestamp: now() }] });
}

// ---------- Dziennik zdarzeń (audit log) ----------

const AUDIT = {
  GUILD_UPDATE: 1,
  CHANNEL_CREATE: 10,
  CHANNEL_UPDATE: 11,
  CHANNEL_DELETE: 12,
  OVERWRITE_CREATE: 13,
  OVERWRITE_UPDATE: 14,
  OVERWRITE_DELETE: 15,
  MEMBER_KICK: 20,
  MEMBER_BAN_ADD: 22,
  MEMBER_BAN_REMOVE: 23,
  MEMBER_UPDATE: 24,
  MEMBER_ROLE_UPDATE: 25,
  ROLE_CREATE: 30,
  ROLE_UPDATE: 31,
  ROLE_DELETE: 32,
  INVITE_CREATE: 40,
  EMOJI_CREATE: 60,
  EMOJI_UPDATE: 61,
  EMOJI_DELETE: 62,
  THREAD_CREATE: 110,
  THREAD_UPDATE: 111,
  THREAD_DELETE: 112,
};

const PERMISSION_NAMES = [
  'Tworzenie zaproszeń', 'Wyrzucanie członków', 'Banowanie członków', 'Administrator', 'Zarządzanie kanałami',
  'Zarządzanie serwerem', 'Dodawanie reakcji', 'Wyświetlanie dziennika zdarzeń', 'Priorytetowy mówca', 'Wideo',
  'Wyświetlanie kanałów', 'Wysyłanie wiadomości', 'Wiadomości TTS', 'Zarządzanie wiadomościami', 'Osadzanie linków',
  'Załączanie plików', 'Czytanie historii wiadomości', 'Oznaczanie @everyone', 'Zewnętrzne emoji', 'Statystyki serwera',
  'Łączenie', 'Mówienie', 'Wyciszanie członków', 'Ogłuszanie członków', 'Przenoszenie członków', 'Aktywacja głosowa',
  'Zmiana pseudonimu', 'Zarządzanie pseudonimami', 'Zarządzanie rolami', 'Zarządzanie webhookami',
  'Zarządzanie emoji i naklejkami', 'Komendy aplikacji', 'Prośba o zabranie głosu', 'Zarządzanie wydarzeniami',
  'Zarządzanie wątkami', 'Tworzenie wątków publicznych', 'Tworzenie wątków prywatnych', 'Zewnętrzne naklejki',
  'Pisanie w wątkach', 'Aktywności', 'Wyciszanie (timeout)', 'Monetyzacja', 'Dźwięki', 'Tworzenie emoji',
  'Tworzenie wydarzeń', 'Zewnętrzne dźwięki', 'Wiadomości głosowe', null, null, 'Ankiety', 'Zewnętrzne aplikacje',
];

export function permissionDiff(before, after) {
  const a = BigInt(before ?? 0);
  const b = BigInt(after ?? 0);
  const names = (bits) => PERMISSION_NAMES.map((name, i) => (name && (bits >> BigInt(i)) & 1n ? name : null)).filter(Boolean);
  return { added: names(b & ~a), removed: names(a & ~b) };
}

const CHANNEL_TYPES = { 0: 'tekstowy', 2: 'głosowy', 4: 'kategoria', 5: 'ogłoszeń', 10: 'wątek ogłoszeń', 11: 'wątek publiczny', 12: 'wątek prywatny', 13: 'scena', 15: 'forum', 16: 'media' };
const CHANGE_LABELS = {
  name: 'Nazwa',
  topic: 'Temat',
  nsfw: 'NSFW',
  rate_limit_per_user: 'Tryb powolny',
  bitrate: 'Bitrate',
  user_limit: 'Limit osób',
  parent_id: 'Kategoria',
  rtc_region: 'Region',
  color: 'Kolor',
  hoist: 'Wyświetlana osobno',
  mentionable: 'Można oznaczać',
  icon_hash: 'Ikona',
  unicode_emoji: 'Emoji roli',
  description: 'Opis',
  afk_channel_id: 'Kanał AFK',
  afk_timeout: 'Czas do AFK',
  system_channel_id: 'Kanał systemowy',
  rules_channel_id: 'Kanał z zasadami',
  verification_level: 'Poziom weryfikacji',
  explicit_content_filter: 'Filtr treści',
  vanity_url_code: 'Własny link',
  banner_hash: 'Baner',
  splash_hash: 'Tło zaproszenia',
  owner_id: 'Właściciel',
  default_message_notifications: 'Domyślne powiadomienia',
  premium_progress_bar_enabled: 'Pasek boostów',
  type: 'Typ',
  archived: 'Zarchiwizowany',
  locked: 'Zablokowany',
  invitable: 'Każdy może zapraszać',
  auto_archive_duration: 'Automatyczna archiwizacja',
};

function formatValue(key, value) {
  if (value === undefined || value === null || value === '') return '*brak*';
  if (typeof value === 'boolean') return value ? 'tak' : 'nie';
  if (/_channel_id$|^parent_id$/.test(key)) return `<#${value}>`;
  if (key === 'owner_id') return `<@${value}>`;
  if (key === 'color') return `#${Number(value).toString(16).padStart(6, '0')}`;
  if (key === 'rate_limit_per_user') return Number(value) ? `${value} s` : 'wyłączony';
  if (key === 'type') return CHANNEL_TYPES[value] ?? String(value);
  if (key === 'auto_archive_duration') return Number(value) >= 1440 ? `${Number(value) / 1440} d` : `${Number(value) / 60} h`;
  if (/_hash$/.test(key)) return 'zmieniona';
  return code(value);
}

function changeLines(changes = []) {
  const lines = [];
  for (const change of changes) {
    if (change.key === 'permissions') {
      const { added, removed } = permissionDiff(change.old_value, change.new_value);
      if (added.length) lines.push(`**Dodane uprawnienia:** ${added.join(', ')}`);
      if (removed.length) lines.push(`**Zabrane uprawnienia:** ${removed.join(', ')}`);
      continue;
    }
    const label = CHANGE_LABELS[change.key];
    if (!label) continue; // pozycja, flagi, nadpisania itp. - szum
    lines.push(`**${label}:** ${formatValue(change.key, change.old_value)} → ${formatValue(change.key, change.new_value)}`);
  }
  return lines;
}

const changeOf = (entry, key) => entry.changes?.find((c) => c.key === key);
const byLine = (entry, targetId) => (entry.user_id && entry.user_id !== targetId ? `\n**Przez:** <@${entry.user_id}>` : '');
const reasonLine = (entry) => (entry.reason ? `\n**Powód:** ${clip(entry.reason, 500)}` : '');

function userEmbed(user, color, text, entry, suffix = '') {
  return {
    color,
    author: authorOf(user ?? { id: entry.target_id, username: entry.target_id }, suffix),
    description: text + byLine(entry, entry.target_id) + reasonLine(entry),
    footer: { text: `ID: ${entry.target_id}` },
    timestamp: now(),
  };
}

export async function onAuditLogEntry(bot, entry) {
  if (!entry || !(await isOurGuild(bot, entry.guild_id))) return;
  const config = await bot.store.getConfig();
  if (!auditLogsOn(config)) return;
  const type = entry.action_type;
  const byBot = entry.user_id && entry.user_id === (await botId(bot));
  const target = entry.target_id;

  // Kary nałożone komendami bota są już w logach moderacji z pełnymi szczegółami.
  const botModeration = byBot && Boolean(config.modLogChannelId);
  // Kanały na żądanie i tickety bot tworzy i zmienia sam - to byłby tylko szum.
  const botChannel = byBot && ((type >= AUDIT.CHANNEL_CREATE && type <= AUDIT.OVERWRITE_DELETE) || (type >= AUDIT.THREAD_CREATE && type <= AUDIT.THREAD_DELETE));
  if (botChannel) return;

  if (type === AUDIT.MEMBER_BAN_ADD || type === AUDIT.MEMBER_BAN_REMOVE || type === AUDIT.MEMBER_KICK) {
    if (botModeration) return;
    const user = await fetchUser(bot, target);
    const [event, color, verb, suffix] = {
      [AUDIT.MEMBER_BAN_ADD]: ['memberBan', COLOR.red, 'został(a) zbanowany/a', ' zbanowany/a'],
      [AUDIT.MEMBER_BAN_REMOVE]: ['memberUnban', COLOR.green, 'został(a) odbanowany/a', ' odbanowany/a'],
      [AUDIT.MEMBER_KICK]: ['memberKick', COLOR.orange, 'został(a) wyrzucony/a', ' wyrzucony/a'],
    }[type];
    return send(bot, config, event, { embeds: [userEmbed(user, color, `**<@${target}> ${verb}**`, entry, suffix)] });
  }

  if (type === AUDIT.MEMBER_UPDATE) {
    const user = await fetchUser(bot, target);
    const nick = changeOf(entry, 'nick');
    if (nick) {
      await send(bot, config, 'memberNick', {
        embeds: [
          {
            ...userEmbed(user, COLOR.blue, `**<@${target}> zmienił(a) pseudonim**`, entry),
            fields: [
              { name: 'Przed', value: clip(nick.old_value || '*brak*', 1024), inline: true },
              { name: 'Po', value: clip(nick.new_value || '*brak*', 1024), inline: true },
            ],
          },
        ],
      });
    }
    const timeout = changeOf(entry, 'communication_disabled_until');
    if (timeout && !botModeration) {
      const until = timeout.new_value ? new Date(timeout.new_value).getTime() : 0;
      const text =
        until > Date.now()
          ? `**<@${target}> dostał(a) timeout do ${discordTimestamp(until, 'f')}** (${discordTimestamp(until, 'R')})`
          : `**<@${target}> - zdjęto timeout**`;
      const event = until > Date.now() ? 'memberTimeout' : 'memberTimeoutRemove';
      await send(bot, config, event, { embeds: [userEmbed(user, until > Date.now() ? COLOR.orange : COLOR.green, text, entry)] });
    }
    return;
  }

  if (type === AUDIT.MEMBER_ROLE_UPDATE) {
    const user = await fetchUser(bot, target);
    const added = changeOf(entry, '$add')?.new_value ?? [];
    const removed = changeOf(entry, '$remove')?.new_value ?? [];
    const lines = [];
    if (added.length) lines.push(`**Dodano ${added.length > 1 ? 'role' : 'rolę'}:** ${added.map((r) => `<@&${r.id}>`).join(', ')}`);
    if (removed.length) lines.push(`**Zabrano ${removed.length > 1 ? 'role' : 'rolę'}:** ${removed.map((r) => `<@&${r.id}>`).join(', ')}`);
    if (!lines.length) return;
    const color = added.length && !removed.length ? COLOR.green : removed.length && !added.length ? COLOR.orange : COLOR.blue;
    return send(bot, config, 'memberRoles', { embeds: [userEmbed(user, color, `**Zmiana ról <@${target}>**\n${lines.join('\n')}`, entry)] });
  }

  const simple = async (event, color, title, lines = []) => {
    const body = [title, ...lines].join('\n') + (entry.user_id ? `\n**Przez:** <@${entry.user_id}>` : '') + reasonLine(entry);
    return send(bot, config, event, { embeds: [{ color, description: clip(body, 4000), footer: { text: `ID: ${target ?? '-'}` }, timestamp: now() }] });
  };
  const name = (key = 'name') => changeOf(entry, key)?.new_value ?? changeOf(entry, key)?.old_value ?? '?';

  switch (type) {
    case AUDIT.CHANNEL_CREATE: {
      const kind = CHANNEL_TYPES[changeOf(entry, 'type')?.new_value] ?? 'kanał';
      return simple('channelCreate', COLOR.green, `**Utworzono kanał (${kind}): <#${target}>** ${code(name())}`);
    }
    case AUDIT.CHANNEL_UPDATE: {
      const lines = changeLines(entry.changes);
      return lines.length ? simple('channelUpdate', COLOR.blue, `**Zmieniono kanał <#${target}>**`, lines) : null;
    }
    case AUDIT.CHANNEL_DELETE:
      return simple('channelDelete', COLOR.red, `**Usunięto kanał ${code(name())}**`);
    case AUDIT.OVERWRITE_CREATE:
    case AUDIT.OVERWRITE_UPDATE:
    case AUDIT.OVERWRITE_DELETE: {
      const who = entry.options?.type === '0' || entry.options?.type === 0 ? `<@&${entry.options?.id}>` : `<@${entry.options?.id}>`;
      const allow = changeOf(entry, 'allow');
      const deny = changeOf(entry, 'deny');
      const lines = [];
      if (allow) {
        const { added, removed } = permissionDiff(allow.old_value, allow.new_value);
        if (added.length) lines.push(`**Zezwolono:** ${added.join(', ')}`);
        if (removed.length) lines.push(`**Już nie zezwolono:** ${removed.join(', ')}`);
      }
      if (deny) {
        const { added, removed } = permissionDiff(deny.old_value, deny.new_value);
        if (added.length) lines.push(`**Zabroniono:** ${added.join(', ')}`);
        if (removed.length) lines.push(`**Już nie zabroniono:** ${removed.join(', ')}`);
      }
      const verb = type === AUDIT.OVERWRITE_DELETE ? 'Usunięto uprawnienia' : 'Zmieniono uprawnienia';
      return simple('channelUpdate', COLOR.blue, `**${verb} na <#${target}> dla ${who}**`, lines);
    }
    case AUDIT.THREAD_CREATE: {
      const kind = CHANNEL_TYPES[changeOf(entry, 'type')?.new_value] ?? 'wątek';
      return simple('threadCreate', COLOR.green, `**Utworzono wątek (${kind}): <#${target}>** ${code(name())}`);
    }
    case AUDIT.THREAD_UPDATE: {
      const lines = changeLines(entry.changes);
      return lines.length ? simple('threadUpdate', COLOR.blue, `**Zmieniono wątek <#${target}>**`, lines) : null;
    }
    case AUDIT.THREAD_DELETE:
      return simple('threadDelete', COLOR.red, `**Usunięto wątek ${code(name())}**`);
    case AUDIT.ROLE_CREATE:
      return simple('roleCreate', COLOR.green, `**Utworzono rolę <@&${target}>** ${code(name())}`);
    case AUDIT.ROLE_UPDATE: {
      const lines = changeLines(entry.changes);
      return lines.length ? simple('roleUpdate', COLOR.blue, `**Zmieniono rolę <@&${target}>**`, lines) : null;
    }
    case AUDIT.ROLE_DELETE:
      return simple('roleDelete', COLOR.red, `**Usunięto rolę ${code(name())}**`);
    case AUDIT.EMOJI_CREATE:
      return simple('emojiUpdate', COLOR.green, `**Dodano emoji <:${name()}:${target}> ${code(name())}**`);
    case AUDIT.EMOJI_UPDATE:
      return simple('emojiUpdate', COLOR.blue, `**Zmieniono emoji <:${name()}:${target}>**`, changeLines(entry.changes));
    case AUDIT.EMOJI_DELETE:
      return simple('emojiUpdate', COLOR.red, `**Usunięto emoji ${code(name())}**`);
    case AUDIT.GUILD_UPDATE: {
      const lines = changeLines(entry.changes);
      return lines.length ? simple('serverUpdate', COLOR.blue, '**Zmieniono ustawienia serwera**', lines) : null;
    }
    case AUDIT.INVITE_CREATE: {
      const maxAge = Number(changeOf(entry, 'max_age')?.new_value ?? 0);
      const maxUses = Number(changeOf(entry, 'max_uses')?.new_value ?? 0);
      const channel = changeOf(entry, 'channel_id')?.new_value;
      return simple('inviteCreate', COLOR.green, `**Utworzono zaproszenie discord.gg/${name('code')}**`, [
        channel ? `**Kanał:** <#${channel}>` : null,
        `**Wygasa:** ${maxAge ? discordTimestamp(Date.now() + maxAge * 1000, 'R') : 'nigdy'}`,
        `**Użycia:** ${maxUses || 'bez limitu'}`,
      ].filter(Boolean));
    }
    default:
      return null;
  }
}
