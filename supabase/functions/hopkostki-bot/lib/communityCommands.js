// Komendy „na co dzień”, wzorowane na Carl-bocie, ProBocie i StartIT: ankiety, przypomnienia, konkursy,
// snipe, profil, informacje o roli, emoji, pisanie jako bot, liczba członków, AFK, propozycje, losowanie
// i ranking bumpów. Każda ma własną listę ról w panelu (zakładka Uprawnienia), jak pozostałe komendy.

import { UNIT_CHOICES, toMs, formatDuration, discordTimestamp } from './duration.js';
import { P, has } from './permissions.js';
import * as embeds from './embeds.js';
import { avatarUrl, guildIconUrl, messageUrl } from './rest.js';
import { ActionError, getGuildContext } from './moderation.js';
import { setAfk, startGiveaway, endGiveaway, postSuggestion } from './community.js';

const T = { SUB: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8 };
const CH = { TEXT: 0, ANNOUNCEMENT: 5 };
const GUILD_ONLY = { contexts: [0] };
const user = (name, description, required = false) => ({ type: T.USER, name, description, required });
const str = (name, description, extra = {}) => ({ type: T.STRING, name, description, ...extra });
const int = (name, description, extra = {}) => ({ type: T.INTEGER, name, description, ...extra });
const bool = (name, description) => ({ type: T.BOOLEAN, name, description });
const sub = (name, description, options = []) => ({ type: T.SUB, name, description, options });
const channelOpt = (description, required = false) => ({ type: T.CHANNEL, name: 'kanal', description, channel_types: [CH.TEXT, CH.ANNOUNCEMENT], required });
const roleOpt = (name, description, required = false) => ({ type: T.ROLE, name, description, required });

const snowflakeTime = (id) => (/^\d+$/.test(String(id)) ? Number((BigInt(id) >> 22n) + 1420070400000n) : null);
const stamp = (ms) => (ms ? `${discordTimestamp(ms, 'D')} (${discordTimestamp(ms, 'R')})` : '-');
const clip = (text, max) => (String(text ?? '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text ?? ''));
const MAX_WAIT_MS = 365 * 24 * 60 * 60_000;

function durationFrom(ix, { max = MAX_WAIT_MS } = {}) {
  const amount = ix.opt('za') ?? ix.opt('czas');
  const unit = ix.opt('jednostka') ?? 'm';
  const ms = toMs(amount, unit);
  if (ms > max) throw new ActionError('Maksymalnie rok do przodu.');
  return { ms, text: formatDuration(amount, unit) };
}

// Kanał z opcji: sprawdzamy, czy wywołujący może tam pisać (bot nie może pisać za kogoś tam, gdzie ten nie może).
function pickChannel(ix) {
  const channelId = ix.opt('kanal') ?? ix.channelId;
  const picked = ix.raw.data?.resolved?.channels?.[channelId];
  if (picked?.permissions && !has(picked.permissions, P.VIEW_CHANNEL | P.SEND_MESSAGES)) throw new ActionError(`Nie możesz pisać na <#${channelId}>.`);
  return channelId;
}

// ---------- /ankieta (natywna ankieta Discorda) ----------
const EMOJI_PREFIX = /^(<a?:\w+:(\d+)>|\p{Extended_Pictographic}(?:️)?(?:‍\p{Extended_Pictographic}(?:️)?)*)\s*/u;

export function pollAnswer(raw) {
  const text = String(raw).trim();
  const match = EMOJI_PREFIX.exec(text);
  if (!match) return { poll_media: { text: text.slice(0, 55) } };
  const rest = text.slice(match[0].length).trim() || match[1];
  const emoji = match[2] ? { id: match[2] } : { name: match[1] };
  return { poll_media: { text: rest.slice(0, 55), emoji } };
}

const ankieta = {
  permission: P.MANAGE_MESSAGES,
  defer: 'ephemeral',
  data: {
    name: 'ankieta',
    description: '📊 Utwórz ankietę Discorda (odpowiedzi rozdziel średnikiem ;)',
    ...GUILD_ONLY,
    options: [
      str('pytanie', '❓ O co pytasz?', { required: true, max_length: 300 }),
      str('odpowiedzi', '📝 Odpowiedzi rozdzielone średnikiem, np. Pizza; Kebab; 🍔 Burger (2-10)', { required: true, max_length: 600 }),
      int('godziny', '⏱️ Ile godzin trwa ankieta (domyślnie 24, maks. 768 = 32 dni)', { min_value: 1, max_value: 768 }),
      bool('wielokrotny', '☑️ Czy można wybrać kilka odpowiedzi?'),
      channelOpt('📢 Gdzie wysłać (domyślnie ten kanał)'),
    ],
  },
  async execute(ix, bot) {
    const answers = String(ix.opt('odpowiedzi')).split(';').map((a) => a.trim()).filter(Boolean);
    if (answers.length < 2 || answers.length > 10) throw new ActionError('Podaj od 2 do 10 odpowiedzi rozdzielonych średnikiem ( ; ).');
    const channelId = pickChannel(ix);
    const message = await bot.discord.post(`/channels/${channelId}/messages`, {
      poll: {
        question: { text: ix.opt('pytanie') },
        answers: answers.map(pollAnswer),
        duration: ix.opt('godziny') ?? 24,
        allow_multiselect: ix.opt('wielokrotny') ?? false,
        layout_type: 1,
      },
    });
    return ix.edit({ embeds: [embeds.successEmbed(`Ankieta wysłana na <#${channelId}> - [zobacz](${messageUrl(ix.guildId, channelId, message.id)}).`)] });
  },
};

// ---------- /przypomnij ----------
const przypomnij = {
  permission: null,
  defer: 'ephemeral',
  data: {
    name: 'przypomnij',
    description: '⏰ Przypomnienia - bot napisze do Ciebie o wybranej porze',
    ...GUILD_ONLY,
    options: [
      sub('dodaj', '⏰ Ustaw przypomnienie', [
        int('za', '⏱️ Za ile jednostek czasu, np. 30', { required: true, min_value: 1, max_value: 1000 }),
        str('jednostka', '📅 Minuty, godziny, dni, tygodnie albo miesiące', { required: true, choices: UNIT_CHOICES }),
        str('tresc', '📝 O czym przypomnieć?', { required: true, max_length: 1000 }),
        bool('prywatnie', '✉️ Wysłać w wiadomości prywatnej zamiast na tym kanale?'),
      ]),
      sub('lista', '📋 Twoje przypomnienia'),
      sub('usun', '🗑️ Usuń przypomnienie', [int('numer', '#️⃣ Numer z listy', { required: true, min_value: 1 })]),
    ],
  },
  async execute(ix, bot) {
    if (ix.sub === 'lista') {
      const list = await bot.store.listReminders(ix.user.id);
      const lines = list.map((r) => `**#${r.id}** ${discordTimestamp(r.dueAt, 'R')}${r.channelId === 'dm' ? ' (DM)' : ` na <#${r.channelId}>`} - ${clip(r.text, 80)}`);
      return ix.edit({ embeds: [embeds.simpleEmbed('info', 'Twoje przypomnienia', lines.join('\n') || 'Nie masz żadnych przypomnień.')] });
    }
    if (ix.sub === 'usun') {
      const removed = await bot.store.removeReminder(ix.opt('numer'), ix.user.id);
      if (!removed) throw new ActionError('Nie masz przypomnienia o takim numerze.');
      return ix.edit({ embeds: [embeds.successEmbed(`Usunięto przypomnienie **#${removed.id}**.`)] });
    }
    if ((await bot.store.listReminders(ix.user.id)).length >= 10) throw new ActionError('Możesz mieć najwyżej 10 przypomnień naraz.');
    const { ms, text } = durationFrom(ix);
    const reminder = await bot.store.addReminder({
      userId: ix.user.id,
      channelId: ix.opt('prywatnie') ? 'dm' : ix.channelId,
      text: ix.opt('tresc'),
      dueAt: Date.now() + ms,
    });
    return ix.edit({ embeds: [embeds.successEmbed(`Przypomnę Ci za **${text}** (${discordTimestamp(reminder.dueAt, 'f')}).\n-# Numer: #${reminder.id}`)] });
  },
};

// ---------- /konkurs ----------
const konkurs = {
  permission: P.MANAGE_GUILD,
  defer: 'ephemeral',
  data: {
    name: 'konkurs',
    description: '🎉 Konkursy (giveaway) z przyciskiem „Weź udział” i losowaniem zwycięzców',
    ...GUILD_ONLY,
    options: [
      sub('start', '🎉 Rozpocznij konkurs', [
        str('nagroda', '🎁 Co jest do wygrania?', { required: true, max_length: 200 }),
        int('czas', '⏱️ Ile jednostek czasu trwa konkurs', { required: true, min_value: 1, max_value: 1000 }),
        str('jednostka', '📅 Minuty, godziny, dni, tygodnie albo miesiące', { required: true, choices: UNIT_CHOICES }),
        int('zwyciezcy', '🏆 Ilu zwycięzców (domyślnie 1)', { min_value: 1, max_value: 20 }),
        channelOpt('📢 Gdzie ogłosić (domyślnie ten kanał)'),
        roleOpt('wymagana_rola', '🎭 Tylko osoby z tą rolą mogą wziąć udział (opcjonalnie)'),
      ]),
      sub('zakoncz', '⏹️ Zakończ konkurs teraz i wylosuj zwycięzców', [int('numer', '#️⃣ Numer konkursu (w stopce)', { required: true, min_value: 1 })]),
      sub('losuj', '🔁 Wylosuj ponownie (np. gdy zwycięzca się nie zgłosił)', [int('numer', '#️⃣ Numer konkursu (w stopce)', { required: true, min_value: 1 })]),
      sub('lista', '📋 Ostatnie konkursy'),
    ],
  },
  async execute(ix, bot) {
    if (ix.sub === 'lista') {
      const list = await bot.store.listGiveaways({ limit: 15 });
      const lines = list.map((g) => `**#${g.id}** ${clip(g.prize, 60)} - ${g.ended ? 'zakończony' : `koniec ${discordTimestamp(g.endsAt, 'R')}`} • ${g.entrants.length} os. • <#${g.channelId}>`);
      return ix.edit({ embeds: [embeds.simpleEmbed('info', 'Konkursy', lines.join('\n') || 'Nie było jeszcze żadnych konkursów.')] });
    }
    if (ix.sub === 'zakoncz' || ix.sub === 'losuj') {
      const g = await bot.store.getGiveaway(ix.opt('numer'));
      if (!g) throw new ActionError('Nie ma konkursu o takim numerze.');
      if (ix.sub === 'zakoncz' && g.ended) throw new ActionError('Ten konkurs już się zakończył - użyj `/konkurs losuj`, żeby wylosować ponownie.');
      if (ix.sub === 'losuj' && !g.ended) throw new ActionError('Ten konkurs jeszcze trwa - najpierw `/konkurs zakoncz`.');
      const done = await endGiveaway(bot, g, { reroll: ix.sub === 'losuj' });
      return ix.edit({ embeds: [embeds.successEmbed(done.winnerIds.length ? `Zwycięzcy: ${done.winnerIds.map((id) => `<@${id}>`).join(', ')}` : 'Nie było kogo wylosować.')] });
    }
    const channelId = pickChannel(ix);
    const { ms } = durationFrom(ix, { max: 60 * 24 * 60 * 60_000 });
    const g = await startGiveaway(bot, {
      channelId,
      prize: ix.opt('nagroda'),
      winners: ix.opt('zwyciezcy') ?? 1,
      hostId: ix.user.id,
      requiredRoleId: ix.opt('wymagana_rola') ?? null,
      endsAt: Date.now() + ms,
    });
    return ix.edit({ embeds: [embeds.successEmbed(`Konkurs **#${g.id}** wystartował na <#${channelId}> - [zobacz](${messageUrl(ix.guildId, channelId, g.messageId)}).`)] });
  },
};

// ---------- /snipe ----------
const snipe = {
  permission: P.MANAGE_MESSAGES,
  defer: 'public',
  data: {
    name: 'snipe',
    description: '🕵️ Pokaż ostatnio usuniętą wiadomość z tego kanału (wymaga logów wiadomości)',
    ...GUILD_ONLY,
    options: [int('ktora', '#️⃣ Która od końca (1 = ostatnia, maks. 10)', { min_value: 1, max_value: 10 })],
  },
  async execute(ix, bot) {
    const config = await bot.store.getConfig();
    if (!config.logs.enabled || !config.logs.events.messageDelete) throw new ActionError('Snipe działa, gdy w panelu są włączone logi usuniętych wiadomości (zakładka Logi).');
    const index = (ix.opt('ktora') ?? 1) - 1;
    const list = await bot.store.lastDeletedMessages(ix.channelId, { limit: 10 });
    const m = list[index];
    if (!m) throw new ActionError('Nie ma tu żadnej usuniętej wiadomości z ostatnich 2 godzin.');
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.muted,
          author: { name: m.authorTag ?? 'Nieznany', icon_url: avatarUrl({ id: m.authorId, avatar: m.authorAvatar }, 64) },
          description: clip(m.content || '*brak treści*', 4000),
          ...(m.attachments.length ? { fields: [{ name: 'Załączniki', value: clip(m.attachments.map((a) => a.name).join(', '), 1024) }] } : {}),
          footer: { text: `Usunięta • ${index + 1}/${list.length}` },
          timestamp: new Date(m.deletedAt).toISOString(),
        },
      ],
      allowed_mentions: { parse: [] },
    });
  },
};

// ---------- /profil ----------
const profil = {
  permission: null,
  defer: 'public',
  data: {
    name: 'profil',
    description: '👤 Profil użytkownika: konto, dołączenie, role i boost',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 Czyj profil pokazać (puste = Twój)')],
  },
  async execute(ix, bot) {
    const target = ix.getUser('uzytkownik') ?? ix.user;
    const member = ix.getUser('uzytkownik') ? ix.raw.data?.resolved?.members?.[target.id] : ix.raw.member;
    const { roles } = await getGuildContext(bot);
    const memberRoles = (member?.roles ?? []).map((id) => roles.get(id)).filter(Boolean).sort((a, b) => b.position - a.position);
    const color = memberRoles.find((r) => r.color)?.color ?? embeds.COLORS.info;
    const fields = [
      { name: 'Konto założone', value: stamp(snowflakeTime(target.id)), inline: true },
      { name: 'Na serwerze od', value: member?.joined_at ? stamp(new Date(member.joined_at).getTime()) : '-', inline: true },
    ];
    if (member?.premium_since) fields.push({ name: 'Boostuje od', value: stamp(new Date(member.premium_since).getTime()), inline: true });
    if (member) fields.push({ name: `Role (${memberRoles.length})`, value: clip(memberRoles.map((r) => `<@&${r.id}>`).join(' ') || 'brak', 1024) });
    return ix.edit({
      embeds: [
        {
          color,
          author: { name: target.global_name ?? target.username, icon_url: avatarUrl(target, 64) },
          description: `<@${target.id}> • \`${target.username}\`${member?.nick ? ` • pseudonim: **${embeds.escapeMarkdown(member.nick)}**` : ''}${target.bot ? ' • bot' : ''}`,
          thumbnail: { url: avatarUrl(target, 256) },
          fields,
          footer: { text: `ID: ${target.id}` },
        },
      ],
      allowed_mentions: { parse: [] },
    });
  },
};

// ---------- /rolainfo ----------
const KEY_PERMISSIONS = [
  [P.ADMINISTRATOR, 'Administrator'],
  [P.MANAGE_GUILD, 'Zarządzanie serwerem'],
  [P.MANAGE_ROLES, 'Zarządzanie rolami'],
  [P.MANAGE_CHANNELS, 'Zarządzanie kanałami'],
  [P.BAN_MEMBERS, 'Banowanie'],
  [P.KICK_MEMBERS, 'Wyrzucanie'],
  [P.MODERATE_MEMBERS, 'Timeouty'],
  [P.MANAGE_MESSAGES, 'Zarządzanie wiadomościami'],
  [P.MENTION_EVERYONE, 'Oznaczanie @everyone'],
  [P.MANAGE_NICKNAMES, 'Zarządzanie pseudonimami'],
  [P.VIEW_AUDIT_LOG, 'Dziennik zdarzeń'],
];

const rolainfo = {
  permission: null,
  defer: 'ephemeral',
  data: { name: 'rolainfo', description: '🎭 Informacje o roli: kolor, pozycja, uprawnienia', ...GUILD_ONLY, options: [roleOpt('rola', '🎭 Która rola', true)] },
  async execute(ix, bot) {
    const { roles } = await getGuildContext(bot);
    const role = roles.get(ix.opt('rola'));
    if (!role) throw new ActionError('Nie znaleziono tej roli.');
    const bits = BigInt(role.permissions ?? 0);
    const keys = KEY_PERMISSIONS.filter(([p]) => (bits & p) === p).map(([, name]) => name);
    const hex = `#${Number(role.color ?? 0).toString(16).padStart(6, '0').toUpperCase()}`;
    return ix.edit({
      embeds: [
        {
          color: role.color || embeds.COLORS.info,
          title: role.name,
          fields: [
            { name: 'ID', value: `\`${role.id}\``, inline: true },
            { name: 'Kolor', value: role.color ? hex : 'domyślny', inline: true },
            { name: 'Pozycja', value: String(role.position), inline: true },
            { name: 'Utworzona', value: stamp(snowflakeTime(role.id)), inline: true },
            { name: 'Wyświetlana osobno', value: role.hoist ? 'tak' : 'nie', inline: true },
            { name: 'Można oznaczać', value: role.mentionable ? 'tak' : 'nie', inline: true },
            ...(role.managed ? [{ name: 'Zarządzana', value: 'przez integrację (np. bota)', inline: true }] : []),
            { name: 'Kluczowe uprawnienia', value: keys.join(', ') || 'brak' },
          ],
        },
      ],
    });
  },
};

// ---------- /emoji ----------
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{15,25})>$/;

async function imageDataUri(bot, url) {
  const res = await (bot.fetch ?? fetch)(url);
  if (!res.ok) throw new ActionError('Nie udało się pobrać obrazka.');
  const type = res.headers.get('content-type') ?? 'image/png';
  if (!/^image\/(png|gif|jpeg|webp)/.test(type)) throw new ActionError('To nie jest obrazek PNG, GIF, JPG ani WEBP.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 256 * 1024) throw new ActionError('Obrazek jest za duży - emoji może mieć najwyżej 256 KB.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type.split(';')[0]};base64,${btoa(binary)}`;
}

const emoji = {
  permission: P.MANAGE_GUILD_EXPRESSIONS,
  defer: 'ephemeral',
  data: {
    name: 'emoji',
    description: '😀 Dodaj emoji z innego serwera lub z linku (steal) albo pokaż je w dużym rozmiarze',
    ...GUILD_ONLY,
    options: [
      sub('dodaj', '➕ Dodaj emoji na serwer', [
        str('emoji', '😀 Wklej emoji z innego serwera albo link do obrazka (https://…)', { required: true, max_length: 500 }),
        str('nazwa', '🏷️ Nazwa (litery, cyfry, _) - domyślnie ta sama', { max_length: 32 }),
      ]),
      sub('info', '🔎 Pokaż emoji w dużym rozmiarze z linkiem', [str('emoji', '😀 Wklej własne emoji', { required: true, max_length: 100 })]),
    ],
  },
  async execute(ix, bot) {
    const input = String(ix.opt('emoji')).trim();
    const custom = CUSTOM_EMOJI.exec(input);
    if (ix.sub === 'info') {
      if (!custom) throw new ActionError('Podaj własne emoji serwera (zwykłe emoji Unicode nie mają obrazka do pobrania).');
      const url = `https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'png'}?size=256`;
      return ix.edit({ embeds: [{ color: embeds.COLORS.info, title: `:${custom[2]}:`, description: `ID: \`${custom[3]}\`\n[Pobierz](${url})`, image: { url } }] });
    }
    let url;
    let name = ix.opt('nazwa');
    if (custom) {
      url = `https://cdn.discordapp.com/emojis/${custom[3]}.${custom[1] ? 'gif' : 'png'}`;
      name = name ?? custom[2];
    } else if (/^https:\/\/\S+$/i.test(input)) {
      url = input;
      if (!name) throw new ActionError('Przy dodawaniu z linku podaj też nazwę.');
    } else {
      throw new ActionError('Wklej własne emoji (np. z innego serwera) albo link https:// do obrazka.');
    }
    if (!/^\w{2,32}$/.test(name)) throw new ActionError('Nazwa emoji: 2-32 znaki, tylko litery, cyfry i _.');
    const created = await bot.discord.post(`/guilds/${ix.guildId}/emojis`, { name, image: await imageDataUri(bot, url) }, { reason: `Emoji dodane przez ${ix.user.username}` });
    const tag = `<${created.animated ? 'a' : ''}:${created.name}:${created.id}>`;
    return ix.edit({ embeds: [embeds.successEmbed(`Dodano emoji ${tag} \`:${created.name}:\`.`)] });
  },
};

// ---------- /powiedz ----------
function messageIdFrom(value) {
  const match = /(\d{15,25})\/?$/.exec(String(value ?? '').trim());
  return match ? match[1] : null;
}

const powiedz = {
  permission: P.MANAGE_MESSAGES,
  defer: 'ephemeral',
  data: {
    name: 'powiedz',
    description: '💬 Napisz wiadomość jako bot (także jako odpowiedź na czyjąś wiadomość)',
    ...GUILD_ONLY,
    options: [
      str('tresc', '📝 Treść - nową linię zrobisz wpisując \\n', { required: true, max_length: 2000 }),
      channelOpt('📢 Gdzie napisać (domyślnie ten kanał)'),
      str('odpowiedz_na', '↩️ Link albo ID wiadomości, na którą bot ma odpowiedzieć (opcjonalnie)', { max_length: 200 }),
    ],
  },
  async execute(ix, bot) {
    const channelId = pickChannel(ix);
    const replyId = ix.opt('odpowiedz_na') ? messageIdFrom(ix.opt('odpowiedz_na')) : null;
    if (ix.opt('odpowiedz_na') && !replyId) throw new ActionError('Nie rozpoznaję tej wiadomości - wklej link („Kopiuj link do wiadomości”) albo ID.');
    const message = await bot.discord.post(`/channels/${channelId}/messages`, {
      content: String(ix.opt('tresc')).replace(/\\n/g, '\n'),
      allowed_mentions: { parse: [], replied_user: true },
      ...(replyId ? { message_reference: { message_id: replyId, channel_id: channelId, fail_if_not_exists: true } } : {}),
    });
    return ix.edit({ embeds: [embeds.successEmbed(`Wysłano na <#${channelId}> - [zobacz](${messageUrl(ix.guildId, channelId, message.id)}).`)] });
  },
};

// ---------- /czlonkowie ----------
const czlonkowie = {
  permission: null,
  defer: 'public',
  data: { name: 'czlonkowie', description: '👥 Ile osób jest na serwerze i ile jest online', ...GUILD_ONLY },
  async execute(ix, bot) {
    const guild = await bot.discord.get(`/guilds/${ix.guildId}`, { query: { with_counts: true } });
    const icon = guildIconUrl(guild, 128);
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.info,
          author: icon ? { name: guild.name, icon_url: icon } : { name: guild.name },
          fields: [
            { name: 'Członkowie', value: `**${guild.approximate_member_count ?? '?'}**`, inline: true },
            { name: 'Online', value: `**${guild.approximate_presence_count ?? '?'}**`, inline: true },
            { name: 'Boosty', value: `**${guild.premium_subscription_count ?? 0}**`, inline: true },
          ],
        },
      ],
    });
  },
};

// ---------- /afk ----------
const afk = {
  permission: null,
  defer: 'public',
  data: { name: 'afk', description: '💤 Ustaw status AFK - kto Cię oznaczy, dostanie odpowiedź', ...GUILD_ONLY, options: [str('powod', '📝 Dlaczego Cię nie ma (opcjonalnie)', { max_length: 200 })] },
  async execute(ix, bot) {
    const reason = ix.opt('powod') ?? '';
    await setAfk(bot, ix.user.id, reason);
    return ix.edit({
      embeds: [embeds.simpleEmbed('info', 'Status AFK', `<@${ix.user.id}> jest teraz AFK${reason ? `: ${embeds.escapeMarkdown(reason)}` : ''}.\n-# Status zniknie, gdy coś napiszesz.`)],
      allowed_mentions: { parse: [] },
    });
  },
};

// ---------- /propozycja ----------
const propozycja = {
  permission: null,
  defer: 'ephemeral',
  data: { name: 'propozycja', description: '💡 Zgłoś propozycję - trafi na kanał propozycji z głosowaniem', ...GUILD_ONLY, options: [str('tresc', '💡 Twoja propozycja', { required: true, max_length: 2000 })] },
  async execute(ix, bot) {
    const result = await postSuggestion(bot, { config: await bot.store.getConfig(), user: ix.user, text: ix.opt('tresc') });
    const link = messageUrl(ix.guildId, result.channelId, result.messageId);
    return ix.edit({ embeds: [embeds.successEmbed(`Twoja propozycja **#${result.number}** trafiła na <#${result.channelId}> - [zobacz](${link}).`)] });
  },
};

// ---------- /losuj ----------
const losuj = {
  permission: null,
  defer: 'public',
  data: {
    name: 'losuj',
    description: '🎲 Rzut kostką, moneta, losowa liczba albo wybór z listy',
    ...GUILD_ONLY,
    options: [
      sub('kostka', '🎲 Rzuć kostką', [
        int('scianki', '🎲 Ile ścianek (domyślnie 6)', { min_value: 2, max_value: 1000 }),
        int('ile', '🔢 Ile kostek (domyślnie 1)', { min_value: 1, max_value: 20 }),
      ]),
      sub('moneta', '🪙 Orzeł czy reszka?'),
      sub('liczba', '🔢 Losowa liczba z zakresu', [
        int('do', '🔢 Do jakiej liczby', { required: true, min_value: -1_000_000, max_value: 1_000_000 }),
        int('od', '🔢 Od jakiej liczby (domyślnie 1)', { min_value: -1_000_000, max_value: 1_000_000 }),
      ]),
      sub('wybor', '🤔 Wybierz jedną z opcji', [str('opcje', '📝 Opcje rozdzielone przecinkiem lub średnikiem', { required: true, max_length: 1000 })]),
    ],
  },
  async execute(ix) {
    const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
    let title;
    let text;
    if (ix.sub === 'kostka') {
      const sides = ix.opt('scianki') ?? 6;
      const rolls = Array.from({ length: ix.opt('ile') ?? 1 }, () => random(1, sides));
      title = `Rzut ${rolls.length > 1 ? `${rolls.length} kostkami` : 'kostką'} k${sides}`;
      text = rolls.length > 1 ? `${rolls.map((r) => `**${r}**`).join(' + ')} = **${rolls.reduce((a, b) => a + b, 0)}**` : `Wypadło **${rolls[0]}**`;
    } else if (ix.sub === 'moneta') {
      title = 'Rzut monetą';
      text = `Wypadł${Math.random() < 0.5 ? ' **orzeł**' : 'a **reszka**'}!`;
    } else if (ix.sub === 'liczba') {
      const a = ix.opt('od') ?? 1;
      const b = ix.opt('do');
      title = `Losowa liczba ${Math.min(a, b)}-${Math.max(a, b)}`;
      text = `**${random(Math.min(a, b), Math.max(a, b))}**`;
    } else {
      const options = String(ix.opt('opcje')).split(/[;,]/).map((o) => o.trim()).filter(Boolean);
      if (options.length < 2) throw new ActionError('Podaj przynajmniej dwie opcje rozdzielone przecinkiem.');
      title = 'Wybieram…';
      text = `**${embeds.escapeMarkdown(options[random(0, options.length - 1)])}**`;
    }
    return ix.edit({ embeds: [{ color: embeds.COLORS.info, title, description: text, footer: { text: `Losował(a): ${ix.user.global_name ?? ix.user.username}` } }], allowed_mentions: { parse: [] } });
  },
};

// ---------- /zaproszenia ----------
const zaproszenia = {
  permission: null,
  defer: 'public',
  data: {
    name: 'zaproszenia',
    description: '📨 Kto kogo zaprosił: ranking albo osoby zaproszone przez wybraną osobę',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 Czyje zaproszenia pokazać (puste = ranking)')],
  },
  async execute(ix, bot) {
    const target = ix.getUser('uzytkownik');
    if (target) {
      const [count, list, invitedBy] = await Promise.all([bot.store.inviteCount(target.id), bot.store.invitedBy(target.id, 10), bot.store.inviteJoinFor(target.id)]);
      const lines = list.map((j) => `<@${j.userId}> - ${discordTimestamp(j.joinedAt, 'R')} (\`${j.code}\`)`);
      const from = invitedBy?.inviterId ? `\n**Sam(a) wszedł/weszła z zaproszenia:** <@${invitedBy.inviterId}>` : '';
      return ix.edit({
        embeds: [
          {
            color: embeds.COLORS.info,
            author: { name: `Zaproszenia - ${target.global_name ?? target.username}`, icon_url: avatarUrl(target, 64) },
            description: `**Zaprosił(a):** ${count} ${count === 1 ? 'osobę' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'osoby' : 'osób'}${from}${lines.length ? `\n\n**Ostatnio:**\n${lines.join('\n')}` : ''}`,
            footer: { text: 'Liczone od włączenia logów zaproszeń' },
          },
        ],
        allowed_mentions: { parse: [] },
      });
    }
    const ranking = await bot.store.inviteRanking(10);
    const lines = ranking.map((r, i) => `${i + 1}. <@${r.inviterId}> - **${r.count}**`);
    return ix.edit({
      embeds: [{ ...embeds.simpleEmbed('info', 'Ranking zaproszeń', lines.join('\n') || 'Nikt jeszcze nikogo nie zaprosił (liczone od włączenia logów zaproszeń).'), footer: { text: 'Liczone od włączenia logów zaproszeń' } }],
      allowed_mentions: { parse: [] },
    });
  },
};

// ---------- /bumpy ----------
const bumpy = {
  permission: null,
  defer: 'public',
  data: {
    name: 'bumpy',
    description: '📈 Ranking bumpów na DISBOARD i kiedy można zrobić kolejny',
    ...GUILD_ONLY,
    options: [
      sub('ranking', '🏆 Kto bumpuje najczęściej', [
        int('dni', '📅 Z ilu ostatnich dni (puste = od początku)', { choices: [{ name: '7 dni', value: 7 }, { name: '30 dni', value: 30 }, { name: '90 dni', value: 90 }] }),
      ]),
      sub('status', '⏰ Ostatni bump i kiedy następny'),
    ],
  },
  async execute(ix, bot) {
    if (ix.sub === 'status') {
      const state = await bot.store.getState('bump');
      if (!state?.at) throw new ActionError('Nie zapisano jeszcze żadnego bumpa (bot musi mieć włączoną przypominajkę w panelu).');
      const ready = Date.now() >= state.remindAt;
      return ix.edit({
        embeds: [
          embeds.simpleEmbed(
            'info',
            ready ? 'Można bumpować!' : 'Bump jeszcze niedostępny',
            `**Ostatni bump:** <@${state.userId}> ${discordTimestamp(state.at, 'R')}\n**Następny:** ${ready ? 'teraz - użyj </bump:947088344167366698>' : discordTimestamp(state.remindAt, 'R')}`,
          ),
        ],
        allowed_mentions: { parse: [] },
      });
    }
    const days = ix.opt('dni') ?? null;
    const ranking = await bot.store.bumpRanking({ limit: 10, days });
    const medals = ['1.', '2.', '3.'];
    const lines = ranking.map((r, i) => `${medals[i] ?? `${i + 1}.`} <@${r.userId}> - **${r.count}** ${r.count === 1 ? 'bump' : r.count % 10 >= 2 && r.count % 10 <= 4 && (r.count % 100 < 12 || r.count % 100 > 14) ? 'bumpy' : 'bumpów'}`);
    return ix.edit({
      embeds: [embeds.simpleEmbed('info', `Ranking bumpów${days ? ` (${days} dni)` : ''}`, lines.join('\n') || 'Nikt jeszcze nie bumpował.')],
      allowed_mentions: { parse: [] },
    });
  },
};

export const COMMUNITY_COMMANDS = [ankieta, przypomnij, konkurs, snipe, profil, rolainfo, emoji, powiedz, czlonkowie, afk, propozycja, losuj, bumpy, zaproszenia];
