// Definicje komend slash (JSON API Discorda) i ich obsługa.
// Każda komenda: { data, permission, defer: 'action' | 'public' | 'ephemeral', execute(ix, bot), autocomplete? }

import { UNIT_CHOICES, MAX_TIMEOUT_MS, toMs, discordTimestamp } from './duration.js';
import { P, has, highestPosition, permissionLabel, EVERYONE } from './permissions.js';
import * as embeds from './embeds.js';
import { avatarUrl, guildIconUrl } from './rest.js';
import {
  ActionError,
  checkTarget,
  getGuildContext,
  banUser,
  unbanUser,
  kickUser,
  timeoutUser,
  untimeoutUser,
  warnUser,
  sendModLog,
  hasModAccess,
} from './moderation.js';
import { VIEWS, renderView } from './views.js';
import { COMMUNITY_COMMANDS } from './communityCommands.js';
import { PANEL_SECTIONS, PANEL_SITE, issueLogin } from './access.js';

// ---------- Budowanie opcji ----------
const T = { SUB: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8 };
const CH = { TEXT: 0, ANNOUNCEMENT: 5, FORUM: 15 };
const GUILD_ONLY = { contexts: [0] };

const user = (name, description, required = false) => ({ type: T.USER, name, description, required });
const str = (name, description, extra = {}) => ({ type: T.STRING, name, description, ...extra });
const int = (name, description, extra = {}) => ({ type: T.INTEGER, name, description, ...extra });
const sub = (name, description, options = []) => ({ type: T.SUB, name, description, options });
const channelOpt = (description, types) => ({ type: T.CHANNEL, name: 'kanal', description, channel_types: types });
const reasonOpt = (description, required = true) => str('powod', description, { required, max_length: 500 });

export class ReplyError extends ActionError {}

// ---------- Pomocnicze ----------
function targetFrom(ix, name = 'uzytkownik') {
  const target = ix.getUser(name);
  if (!target) throw new ReplyError('Nie znaleziono użytkownika.');
  return { target, targetMember: ix.getMember(name) };
}

async function ensureTarget(ix, bot, action, name) {
  const { target, targetMember } = targetFrom(ix, name);
  const gctx = await getGuildContext(bot);
  const problem = checkTarget({ gctx, moderator: ix.member, target, targetMember, action });
  if (problem) throw new ReplyError(problem);
  return { target, targetMember };
}

const snowflakeTime = (id) => (/^\d+$/.test(String(id)) ? Number((BigInt(id) >> 22n) + 1420070400000n) : null);
const stamp = (ms) => (ms ? `${discordTimestamp(ms, 'D')} (${discordTimestamp(ms, 'R')})` : '—');

// ---------- Kary ----------
const ban = {
  permission: P.BAN_MEMBERS,
  defer: 'action',
  data: {
    name: 'ban',
    description: '⛔ Zbanuj użytkownika na określony czas albo na zawsze',
    ...GUILD_ONLY,
    options: [
      user('uzytkownik', '👤 Kogo zbanować (działa też na osoby spoza serwera — wklej ID)', true),
      reasonOpt('📝 Za co? Powód zobaczy ukarany, moderacja i logi'),
      int('czas', '⏱️ Ile jednostek czasu, np. 7 — zostaw puste, żeby zbanować na zawsze', { min_value: 1, max_value: 1000 }),
      str('jednostka', '📅 Jednostka czasu: minuty, godziny, dni, tygodnie lub miesiące (domyślnie dni)', { choices: UNIT_CHOICES }),
      int('usun_wiadomosci', '🧹 Usunąć też ostatnie wiadomości tej osoby?', {
        choices: [
          { name: '❌ Nie usuwaj', value: 0 },
          { name: '🕐 Z ostatniej godziny', value: 3600 },
          { name: '📅 Z ostatnich 24 godzin', value: 86400 },
          { name: '🗓️ Z ostatnich 7 dni', value: 604800 },
        ],
      }),
    ],
  },
  async execute(ix, bot) {
    const { target } = await ensureTarget(ix, bot, 'ban');
    const amount = ix.opt('czas');
    await banUser(bot, {
      interaction: ix,
      target,
      moderator: ix.user,
      reason: ix.opt('powod'),
      duration: amount ? { amount, unit: ix.opt('jednostka') ?? 'd' } : null,
      deleteMessageSeconds: ix.opt('usun_wiadomosci') ?? 0,
    });
  },
};

const unban = {
  permission: P.BAN_MEMBERS,
  // Bez użytkownika pokazujemy listę banów ze stronami, więc odpowiedź jest prywatna.
  defer: (ix) => (ix.opt('uzytkownik') ? 'action' : 'ephemeral'),
  data: {
    name: 'unban',
    description: '✅ Zdejmij bana — podaj osobę albo zostaw puste, żeby zobaczyć listę zbanowanych',
    ...GUILD_ONLY,
    options: [
      str('uzytkownik', '👤 Zbanowana osoba (zacznij pisać nick lub ID) — puste = lista wszystkich banów', { autocomplete: true }),
      reasonOpt('📝 Dlaczego zdejmujesz bana (opcjonalnie)', false),
    ],
  },
  async autocomplete(ix, bot) {
    const query = String(ix.focused() ?? '').toLowerCase();
    const hit = bot.cache.get('bans');
    let bans = hit && Date.now() - hit.at < 15_000 ? hit.value : null;
    if (!bans) {
      bans = await bot.discord.get(`/guilds/${ix.guildId}/bans`, { query: { limit: 1000 } }).catch(() => []);
      bot.cache.set('bans', { at: Date.now(), value: bans });
    }
    return bans
      .filter((b) => b.user.username.toLowerCase().includes(query) || b.user.id.includes(query))
      .slice(0, 25)
      .map((b) => ({ name: `${b.user.username} (${b.user.id})`.slice(0, 100), value: b.user.id }));
  },
  async execute(ix, bot) {
    const option = ix.opt('uzytkownik');
    if (!option) return ix.edit(await renderView(bot, 'b', '-', 1));
    const raw = String(option).replace(/[<@!>]/g, '').trim();
    if (!/^\d{15,25}$/.test(raw)) throw new ReplyError('Wybierz użytkownika z listy albo podaj jego ID.');
    const target = await bot.discord.get(`/users/${raw}`).catch(() => null);
    if (!target) throw new ReplyError('Nie znaleziono użytkownika o takim ID.');
    bot.cache.delete('bans');
    return unbanUser(bot, { interaction: ix, target, moderator: ix.user, reason: ix.opt('powod') ?? 'Nie podano powodu' });
  },
};

const kick = {
  permission: P.KICK_MEMBERS,
  defer: 'action',
  data: {
    name: 'kick',
    description: '👢 Wyrzuć użytkownika z serwera (może wrócić z nowym zaproszeniem)',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 Kogo wyrzucić', true), reasonOpt('📝 Za co? Powód zobaczy wyrzucony i moderacja')],
  },
  async execute(ix, bot) {
    const { target } = await ensureTarget(ix, bot, 'kick');
    await kickUser(bot, { interaction: ix, target, moderator: ix.user, reason: ix.opt('powod') });
  },
};

const timeout = {
  permission: P.MODERATE_MEMBERS,
  defer: 'action',
  data: {
    name: 'timeout',
    description: '🔇 Wycisz użytkownika na określony czas (maksymalnie 28 dni)',
    ...GUILD_ONLY,
    options: [
      user('uzytkownik', '👤 Kogo wyciszyć', true),
      int('czas', '⏱️ Ile jednostek czasu, np. 30', { required: true, min_value: 1, max_value: 40320 }),
      str('jednostka', '📅 Jednostka czasu: minuty, godziny, dni lub tygodnie', { required: true, choices: UNIT_CHOICES }),
      reasonOpt('📝 Za co? Powód zobaczy wyciszony i moderacja'),
    ],
  },
  async execute(ix, bot) {
    const duration = { amount: ix.opt('czas'), unit: ix.opt('jednostka') };
    if (toMs(duration.amount, duration.unit) > MAX_TIMEOUT_MS) {
      throw new ReplyError('Discord pozwala na timeout maksymalnie **28 dni** (4 tygodnie). Na dłużej użyj `/ban`.');
    }
    const { target } = await ensureTarget(ix, bot, 'timeout');
    await timeoutUser(bot, { interaction: ix, target, moderator: ix.user, reason: ix.opt('powod'), duration });
  },
};

const untimeout = {
  permission: P.MODERATE_MEMBERS,
  defer: 'action',
  data: {
    name: 'untimeout',
    description: '🔊 Zdejmij wyciszenie (timeout) przed czasem',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 Komu zdjąć timeout', true), reasonOpt('📝 Dlaczego zdejmujesz timeout (opcjonalnie)', false)],
  },
  async execute(ix, bot) {
    const { target, targetMember } = await ensureTarget(ix, bot, 'untimeout');
    const until = targetMember?.communication_disabled_until;
    if (!until || new Date(until).getTime() < Date.now()) throw new ReplyError('Ten użytkownik nie ma timeoutu.');
    await untimeoutUser(bot, { interaction: ix, target, moderator: ix.user, reason: ix.opt('powod') ?? 'Nie podano powodu' });
  },
};

// ---------- Ostrzeżenia ----------
const warn = {
  permission: P.MODERATE_MEMBERS,
  // "dodaj" ogłasza karę publicznie, reszta podkomend odpowiada tylko moderatorowi.
  defer: (ix) => (ix.sub === 'dodaj' ? 'action' : 'ephemeral'),
  data: {
    name: 'warn',
    description: '⚠️ System ostrzeżeń z punktami (znikają same po 60 dniach)',
    ...GUILD_ONLY,
    options: [
      sub('dodaj', '⚠️ Daj ostrzeżenie — ukarany dostanie wiadomość, punkty widzi tylko moderacja', [
        user('uzytkownik', '👤 Kogo ostrzec', true),
        reasonOpt('📝 Za co? Np. spam, obraza, offtop'),
        int('punkty', '🔢 Ile punktów (1–100, domyślnie z panelu) — im poważniej, tym więcej', { min_value: 1, max_value: 100 }),
      ]),
      sub('status', '📋 Ostrzeżenia, punkty i odliczanie do wygaśnięcia (strony ◀ 1 2 3 ▶)', [
        user('uzytkownik', '👤 Czyje ostrzeżenia pokazać', true),
      ]),
      sub('usun', '🗑️ Wybierz osobę — pokażę jej ostrzeżenia do usunięcia z listy', [
        user('uzytkownik', '👤 Czyje ostrzeżenia usuwasz', true),
        int('numer', '#️⃣ Numer ostrzeżenia, jeśli znasz go od razu (opcjonalnie)', { min_value: 1 }),
      ]),
      sub('wyczysc', '🧹 Usuń od razu WSZYSTKIE ostrzeżenia tej osoby', [user('uzytkownik', '👤 Czyje ostrzeżenia wyczyścić', true)]),
      sub('ranking', '📊 Kto ma najwięcej punktów, czyli kto najbardziej przegina'),
    ],
  },
  async execute(ix, bot) {
    const { store } = bot;
    const config = await store.getConfig();

    if (ix.sub === 'dodaj') {
      const { target } = await ensureTarget(ix, bot, 'warn');
      if (target.bot) throw new ReplyError('Botów nie można ostrzegać.');
      return warnUser(bot, {
        interaction: ix,
        target,
        moderator: ix.user,
        reason: ix.opt('powod'),
        points: ix.opt('punkty') ?? config.warns.defaultPoints,
      });
    }

    if (ix.sub === 'status') return ix.edit(await renderView(bot, 'ws', ix.getUser('uzytkownik').id, 1));

    if (ix.sub === 'usun') {
      const target = ix.getUser('uzytkownik');
      let note = null;
      const id = ix.opt('numer');
      if (id) {
        const found = (await store.getWarns(target.id)).find((w) => w.id === id);
        if (!found) throw new ReplyError(`<@${target.id}> nie ma aktywnego ostrzeżenia **#${id}**.`);
        note = await VIEWS.wd.onSelect(bot, ix, target.id, [String(id)]);
      }
      return ix.edit(await renderView(bot, 'wd', target.id, 1, { note }));
    }

    if (ix.sub === 'wyczysc') {
      const target = ix.getUser('uzytkownik');
      const removed = await store.clearWarns(target.id);
      if (!removed.length) throw new ReplyError(`<@${target.id}> nie ma żadnych ostrzeżeń.`);
      const points = removed.reduce((sum, w) => sum + w.points, 0);
      for (const w of removed) if (w.caseId) await store.updateCase(w.caseId, { note: `Wyczyszczone przez ${ix.user.username}` });
      await sendModLog(bot, config, {
        embeds: [
          embeds.simpleEmbed(
            'success',
            '🧹 Wyczyszczono ostrzeżenia',
            `**Użytkownik:** <@${target.id}>\n**Usunął:** <@${ix.user.id}>\n**Usunięto:** ${removed.length} ostrzeżeń (${points} pkt)`,
          ),
        ],
      });
      return ix.edit(await renderView(bot, 'ws', target.id, 1, { note: `🧹 Usunięto **${removed.length}** ostrzeżeń (${points} pkt).` }));
    }

    return ix.edit(await renderView(bot, 'r', '-', 1));
  },
};

// ---------- Historia, sprawy, notatki ----------
const historia = {
  permission: P.MODERATE_MEMBERS,
  defer: 'ephemeral',
  data: {
    name: 'historia',
    description: '📜 Wszystkie kary danej osoby — bany, kicki, timeouty, ostrzeżenia (strony ◀ 1 2 3 ▶)',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 Czyją historię pokazać', true)],
  },
  execute: async (ix, bot) => ix.edit(await renderView(bot, 'h', ix.getUser('uzytkownik').id, 1)),
};

const CASE_TYPE_CHOICES = [
  { name: '⛔ Bany', value: 'ban' },
  { name: '✅ Unbany', value: 'unban' },
  { name: '👢 Kicki', value: 'kick' },
  { name: '🔇 Timeouty', value: 'timeout' },
  { name: '🔊 Zdjęte timeouty', value: 'untimeout' },
  { name: '⚠️ Ostrzeżenia', value: 'warn' },
];

const sprawy = {
  permission: P.MODERATE_MEMBERS,
  defer: 'ephemeral',
  data: {
    name: 'sprawy',
    description: '🗂️ Ostatnie akcje moderacji na całym serwerze (strony ◀ 1 2 3 ▶)',
    ...GUILD_ONLY,
    options: [str('typ', '🔎 Pokaż tylko jeden rodzaj kar (opcjonalnie)', { choices: CASE_TYPE_CHOICES })],
  },
  execute: async (ix, bot) => ix.edit(await renderView(bot, 'c', ix.opt('typ') ?? 'all', 1)),
};

function caseEmbed(config, entry) {
  const label = entry.type === 'ban' && entry.duration ? 'Tymczasowy ban' : embeds.ACTION_LABELS[entry.type];
  const fields = [
    { name: '👤 Użytkownik', value: `<@${entry.userId}>\n\`${entry.userTag}\``, inline: true },
    { name: '🛡️ Moderator', value: `<@${entry.moderatorId}>${entry.auto ? '\n`🤖 automatycznie`' : ''}`, inline: true },
    { name: '🗓️ Data', value: stamp(entry.createdAt), inline: true },
  ];
  if (entry.expiresAt) fields.push({ name: '📅 Wygasa', value: stamp(entry.expiresAt), inline: true });
  if (entry.dmStatus) fields.push({ name: '✉️ DM', value: entry.dmStatus, inline: true });
  fields.push({ name: '📝 Powód', value: embeds.reasonBlock(entry.reason) });
  if (entry.note) fields.push({ name: '📌 Notatka', value: entry.note });
  if (entry.messageUrl) fields.push({ name: '🔗 Wiadomość', value: `[Przejdź do ogłoszenia](${entry.messageUrl})` });
  return {
    color: embeds.colorInt(config.actions[entry.type]?.color),
    title: `🗂️ Sprawa #${entry.id} • ${label}`,
    fields,
    footer: { text: embeds.BRAND },
  };
}

const sprawa = {
  permission: P.MODERATE_MEMBERS,
  defer: 'ephemeral',
  data: {
    name: 'sprawa',
    description: '🗂️ Podgląd i edycja pojedynczej sprawy moderacyjnej',
    ...GUILD_ONLY,
    options: [
      sub('pokaz', '🔎 Pokaż szczegóły sprawy', [int('numer', '#️⃣ Numer sprawy (widać go w stopce embeda)', { required: true, min_value: 1 })]),
      sub('powod', '✏️ Popraw powód w sprawie', [
        int('numer', '#️⃣ Numer sprawy do poprawienia', { required: true, min_value: 1 }),
        str('nowy_powod', '📝 Nowy, poprawiony powód', { required: true, max_length: 500 }),
      ]),
    ],
  },
  async execute(ix, bot) {
    const config = await bot.store.getConfig();
    const id = ix.opt('numer');
    const entry = await bot.store.getCase(id);
    if (!entry) throw new ReplyError(`Nie ma sprawy **#${id}**.`);
    if (ix.sub === 'pokaz') return ix.edit({ embeds: [caseEmbed(config, entry)] });

    const newReason = ix.opt('nowy_powod');
    const updated = await bot.store.updateCase(id, { reason: newReason });
    if (entry.type === 'warn') await bot.store.updateWarnByCase(id, { reason: newReason });
    await sendModLog(bot, config, {
      embeds: [
        {
          ...embeds.successEmbed(`**Sprawa #${id}** — zmieniono powód\n**Było:** ${entry.reason}\n**Jest:** ${newReason}\n**Zmienił:** <@${ix.user.id}>`),
          title: '✏️ Edycja sprawy',
        },
      ],
    });
    return ix.edit({ embeds: [caseEmbed(config, updated)] });
  },
};

const notatka = {
  permission: P.MODERATE_MEMBERS,
  defer: 'ephemeral',
  data: {
    name: 'notatka',
    description: '📌 Prywatne notatki moderacji o użytkownikach (np. „podejrzany o multikonto”)',
    ...GUILD_ONLY,
    options: [
      sub('dodaj', '📌 Dodaj notatkę — widzi ją tylko moderacja', [
        user('uzytkownik', '👤 Kogo dotyczy notatka', true),
        str('tresc', '✍️ Treść notatki', { required: true, max_length: 1000 }),
      ]),
      sub('lista', '📋 Notatki o osobie (strony ◀ 1 2 3 ▶, usuwanie z listy)', [user('uzytkownik', '👤 Czyje notatki pokazać', true)]),
    ],
  },
  async execute(ix, bot) {
    const target = ix.getUser('uzytkownik');
    if (ix.sub === 'dodaj') {
      const note = await bot.store.addNote({
        guildId: ix.guildId,
        userId: target.id,
        userTag: target.username,
        authorId: ix.user.id,
        authorTag: ix.user.username,
        text: ix.opt('tresc'),
      });
      return ix.edit(await renderView(bot, 'n', target.id, 1, { note: `✅ Dodano notatkę **#${note.id}**.` }));
    }
    return ix.edit(await renderView(bot, 'n', target.id, 1));
  },
};

// ---------- Informacje ----------
const info = {
  permission: P.MODERATE_MEMBERS,
  defer: 'ephemeral',
  data: {
    name: 'info',
    description: '📇 Karta użytkownika: konto, role, kary, ostrzeżenia i notatki (tylko dla moderacji)',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 O kim pokazać informacje', true)],
  },
  async execute(ix, bot) {
    const target = ix.getUser('uzytkownik');
    const member = ix.getMember('uzytkownik');
    const [summary, counts, notes] = await Promise.all([
      bot.store.warnSummary(target.id),
      bot.store.caseCounts(target.id),
      bot.store.listNotes(target.id),
    ]);
    const roles = (member?.roles ?? []).map((id) => `<@&${id}>`);
    const fields = [
      { name: '🆔 ID', value: `\`${target.id}\``, inline: true },
      { name: '📅 Konto założone', value: stamp(snowflakeTime(target.id)), inline: true },
      { name: '📥 Na serwerze od', value: member?.joined_at ? stamp(new Date(member.joined_at).getTime()) : '— (nie ma go na serwerze)', inline: true },
      { name: '⚠️ Ostrzeżenia', value: `**${summary.count}** (${summary.points} pkt)`, inline: true },
      {
        name: '🗂️ Kary',
        value: `⛔ ${counts.ban ?? 0} • 👢 ${counts.kick ?? 0} • 🔇 ${counts.timeout ?? 0}`,
        inline: true,
      },
      { name: '📌 Notatki', value: `**${notes.length}**`, inline: true },
    ];
    const until = member?.communication_disabled_until ? new Date(member.communication_disabled_until).getTime() : 0;
    if (until > Date.now()) fields.push({ name: '🔇 Wyciszony do', value: stamp(until), inline: true });
    fields.push({ name: `🎭 Role (${roles.length})`, value: roles.slice(0, 20).join(' ') || 'brak' });

    const button = (label, kind, emoji) => ({ type: 2, style: 2, label, emoji: { name: emoji }, custom_id: `pg|${kind}|${target.id}|1|i` });
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.info,
          author: { name: `${target.global_name ?? target.username} • Karta użytkownika`, icon_url: avatarUrl(target, 64) },
          description: `<@${target.id}> • \`${target.username}\`${target.bot ? ' • 🤖 bot' : ''}`,
          thumbnail: { url: avatarUrl(target, 256) },
          fields,
          footer: { text: embeds.BRAND },
        },
      ],
      components: [
        {
          type: 1,
          components: [button('Ostrzeżenia', 'ws', '⚠️'), button('Historia kar', 'h', '📜'), button('Notatki', 'n', '📌')],
        },
      ],
    });
  },
};

const VERIFICATION = ['brak', 'niski', 'średni', 'wysoki', 'najwyższy'];

const serwer = {
  permission: null,
  defer: 'ephemeral',
  data: { name: 'serwer', description: '🏠 Informacje o serwerze Entuzjaści Hopkostki', ...GUILD_ONLY },
  async execute(ix, bot) {
    const [guild, channels] = await Promise.all([
      bot.discord.get(`/guilds/${ix.guildId}`, { query: { with_counts: true } }),
      bot.discord.get(`/guilds/${ix.guildId}/channels`),
    ]);
    const count = (types) => channels.filter((c) => types.includes(c.type)).length;
    const icon = guildIconUrl(guild, 256);
    // Statystyki moderacji widzi tylko moderacja.
    const isMod = hasModAccess(ix.member, P.MODERATE_MEMBERS, await bot.store.getConfig());
    const stats = isMod ? await bot.store.stats() : null;
    const embed = {
      color: embeds.COLORS.info,
      title: `🏠 ${guild.name}`,
      description: guild.description ?? 'Serwer Entuzjastów Hopkostki',
      fields: [
        { name: '👑 Właściciel', value: `<@${guild.owner_id}>`, inline: true },
        { name: '📅 Założony', value: stamp(snowflakeTime(guild.id)), inline: true },
        { name: '👥 Członkowie', value: `**${guild.approximate_member_count ?? '?'}** (🟢 ${guild.approximate_presence_count ?? '?'} online)`, inline: true },
        { name: '💬 Kanały', value: `# ${count([0, 5, 15])} tekstowych • 🔊 ${count([2, 13])} głosowych`, inline: true },
        { name: '🎭 Role', value: `**${(guild.roles ?? []).length}**`, inline: true },
        { name: '🚀 Boosty', value: `**${guild.premium_subscription_count ?? 0}** (poziom ${guild.premium_tier ?? 0})`, inline: true },
        { name: '🛡️ Weryfikacja', value: VERIFICATION[guild.verification_level] ?? '?', inline: true },
        ...(stats
          ? [
              { name: '🗂️ Sprawy moderacji', value: `**${stats.cases}**`, inline: true },
              { name: '⚠️ Aktywne ostrzeżenia', value: `**${stats.activeWarns}**`, inline: true },
            ]
          : []),
      ],
      footer: { text: `ID: ${guild.id} • ${embeds.BRAND}` },
    };
    if (icon) embed.thumbnail = { url: icon };
    return ix.edit({ embeds: [embed] });
  },
};

const avatar = {
  permission: null,
  defer: 'public',
  data: {
    name: 'avatar',
    description: '🖼️ Pokaż awatar w dużym rozmiarze',
    ...GUILD_ONLY,
    options: [user('uzytkownik', '👤 Czyj awatar pokazać (puste = Twój)')],
  },
  async execute(ix) {
    const target = ix.getUser('uzytkownik') ?? ix.user;
    const base = avatarUrl(target, 1024);
    const links = target.avatar
      ? ['png', 'webp', 'jpg'].map((ext) => `[${ext.toUpperCase()}](${base.replace(/\.png\?/, `.${ext}?`)})`).join(' • ')
      : '[PNG](' + base + ')';
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.info,
          author: { name: `Awatar — ${target.global_name ?? target.username}`, icon_url: avatarUrl(target, 64) },
          description: `🔗 ${links}`,
          image: { url: base },
          footer: { text: embeds.BRAND },
        },
      ],
    });
  },
};

// ---------- Zarządzanie członkami ----------
const nick = {
  permission: P.MANAGE_NICKNAMES,
  defer: 'ephemeral',
  data: {
    name: 'nick',
    description: '✏️ Zmień albo zresetuj pseudonim użytkownika na serwerze',
    ...GUILD_ONLY,
    options: [
      user('uzytkownik', '👤 Komu zmienić pseudonim', true),
      str('nowy_nick', '🏷️ Nowy pseudonim (puste = przywróć oryginalną nazwę)', { max_length: 32 }),
    ],
  },
  async execute(ix, bot) {
    const { target } = await ensureTarget(ix, bot, 'nick');
    const nickname = ix.opt('nowy_nick') ?? null;
    await bot.discord.patch(`/guilds/${ix.guildId}/members/${target.id}`, { nick: nickname }, { reason: `Nick: ${ix.user.username}` });
    await sendModLog(bot, await bot.store.getConfig(), {
      embeds: [
        embeds.simpleEmbed('info', '✏️ Zmiana pseudonimu', `**Użytkownik:** <@${target.id}>\n**Nowy:** ${nickname ? `\`${nickname}\`` : '*(reset)*'}\n**Moderator:** <@${ix.user.id}>`),
      ],
    });
    return ix.edit({ embeds: [embeds.successEmbed(nickname ? `<@${target.id}> ma teraz pseudonim **${nickname}**.` : `Zresetowano pseudonim <@${target.id}>.`)] });
  },
};

const rola = {
  permission: P.MANAGE_ROLES,
  defer: 'ephemeral',
  data: {
    name: 'rola',
    description: '🎭 Nadaj albo odbierz rolę użytkownikowi',
    ...GUILD_ONLY,
    options: [
      sub('dodaj', '➕ Nadaj rolę', [
        user('uzytkownik', '👤 Komu nadać rolę', true),
        { type: T.ROLE, name: 'rola', description: '🎭 Jaką rolę nadać', required: true },
      ]),
      sub('usun', '➖ Odbierz rolę', [
        user('uzytkownik', '👤 Komu odebrać rolę', true),
        { type: T.ROLE, name: 'rola', description: '🎭 Jaką rolę odebrać', required: true },
      ]),
    ],
  },
  async execute(ix, bot) {
    const target = ix.getUser('uzytkownik');
    const member = ix.getMember('uzytkownik');
    if (!member) throw new ReplyError('Tego użytkownika nie ma na serwerze.');
    const roleId = ix.opt('rola');
    const gctx = await getGuildContext(bot);
    const role = gctx.roles.get(roleId);
    if (!role || role.id === ix.guildId) throw new ReplyError('Tej roli nie można nadać.');
    if (role.managed) throw new ReplyError('Tą rolą zarządza integracja (np. bot) — nie da się jej nadać ręcznie.');
    if (highestPosition(gctx.botMember.roles, gctx.roles) <= role.position) {
      throw new ReplyError('Ta rola jest wyżej niż moja — przesuń moją rolę wyżej w ustawieniach serwera.');
    }
    if (ix.member.id !== gctx.guild.ownerId && highestPosition(ix.member.roles, gctx.roles) <= role.position) {
      throw new ReplyError('Ta rola jest równa lub wyższa od Twojej najwyższej roli.');
    }
    const adding = ix.sub === 'dodaj';
    if (adding && member.roles.includes(roleId)) throw new ReplyError(`<@${target.id}> ma już rolę <@&${roleId}>.`);
    if (!adding && !member.roles.includes(roleId)) throw new ReplyError(`<@${target.id}> nie ma roli <@&${roleId}>.`);

    const path = `/guilds/${ix.guildId}/members/${target.id}/roles/${roleId}`;
    const reason = `${adding ? 'Nadanie' : 'Odebranie'} roli: ${ix.user.username}`;
    if (adding) await bot.discord.put(path, undefined, { reason });
    else await bot.discord.delete(path, { reason });

    await sendModLog(bot, await bot.store.getConfig(), {
      embeds: [
        embeds.simpleEmbed(
          'info',
          adding ? '➕ Nadano rolę' : '➖ Odebrano rolę',
          `**Użytkownik:** <@${target.id}>\n**Rola:** <@&${roleId}>\n**Moderator:** <@${ix.user.id}>`,
        ),
      ],
    });
    return ix.edit({ embeds: [embeds.successEmbed(`${adding ? 'Nadano' : 'Odebrano'} rolę <@&${roleId}> ${adding ? 'dla' : 'od'} <@${target.id}>.`)] });
  },
};

// ---------- Ogłoszenia ----------
const ANNOUNCE_COLORS = [
  { name: '💙 Niebieski', value: '#5865F2' },
  { name: '💚 Zielony', value: '#57F287' },
  { name: '💛 Żółty', value: '#FEE75C' },
  { name: '🧡 Pomarańczowy', value: '#F0883E' },
  { name: '❤️ Czerwony', value: '#ED4245' },
  { name: '💜 Fioletowy', value: '#9B59B6' },
];

const ogloszenie = {
  permission: P.MANAGE_MESSAGES,
  defer: 'ephemeral',
  data: {
    name: 'ogloszenie',
    description: '📢 Wyślij ładne ogłoszenie w embedzie (nowa linia: wpisz \\n)',
    ...GUILD_ONLY,
    options: [
      str('tytul', '🏷️ Tytuł ogłoszenia', { required: true, max_length: 200 }),
      str('tresc', '📝 Treść — nową linię zrobisz wpisując \\n', { required: true, max_length: 4000 }),
      str('kolor', '🎨 Kolor paska z boku embeda', { choices: ANNOUNCE_COLORS }),
      channelOpt('📢 Gdzie wysłać (domyślnie ten kanał)', [CH.TEXT, CH.ANNOUNCEMENT]),
      str('oznacz', '🔔 Kogo powiadomić', {
        choices: [
          { name: '🔕 Nikogo', value: 'none' },
          { name: '📣 @everyone', value: 'everyone' },
          { name: '🟢 @here', value: 'here' },
        ],
      }),
      str('obrazek', '🖼️ Link do obrazka (https://…) pod ogłoszeniem', { max_length: 500 }),
    ],
  },
  async execute(ix, bot) {
    const channelId = ix.opt('kanal') ?? ix.channelId;
    const ping = ix.opt('oznacz') ?? 'none';
    const image = ix.opt('obrazek');
    if (image && !/^https:\/\/\S+$/i.test(image)) throw new ReplyError('Link do obrazka musi zaczynać się od https://');
    // Bot nie może pozwolić oznaczyć @everyone ani pisać tam, gdzie moderator sam nie może.
    if (ping !== 'none' && !has(ix.member.permissions, P.MENTION_EVERYONE)) {
      throw new ReplyError('Nie masz uprawnienia do oznaczania @everyone i @here.');
    }
    const picked = ix.raw.data?.resolved?.channels?.[channelId];
    if (picked?.permissions && !has(picked.permissions, P.VIEW_CHANNEL | P.SEND_MESSAGES)) {
      throw new ReplyError(`Nie możesz pisać na <#${channelId}>.`);
    }
    const { guild } = await getGuildContext(bot);
    const icon = guildIconUrl(guild);
    const embed = {
      color: embeds.colorInt(ix.opt('kolor') ?? '#5865F2'),
      author: icon ? { name: `📢 ${guild.name} • Ogłoszenie`, icon_url: icon } : { name: `📢 ${guild.name} • Ogłoszenie` },
      title: ix.opt('tytul'),
      description: String(ix.opt('tresc')).replace(/\\n/g, '\n'),
      footer: { text: `Ogłosił(a): ${ix.user.global_name ?? ix.user.username} • ${embeds.BRAND}`, icon_url: avatarUrl(ix.user, 64) },
      timestamp: new Date().toISOString(),
    };
    if (image) embed.image = { url: image };
    const message = await bot.discord.post(`/channels/${channelId}/messages`, {
      content: ping === 'none' ? '' : `@${ping}`,
      embeds: [embed],
      allowed_mentions: { parse: ping === 'none' ? [] : ['everyone'] },
    });
    return ix.edit({
      embeds: [embeds.successEmbed(`Ogłoszenie wysłane na <#${channelId}> — [zobacz](https://discord.com/channels/${ix.guildId}/${channelId}/${message.id}).`)],
    });
  },
};

// ---------- Narzędzia kanałów ----------
const CLEAR_FILTERS = [
  ['wszystkie', 'Wszystkie'],
  ['boty', 'Tylko od botów'],
  ['ludzie', 'Tylko od ludzi'],
  ['linki', 'Z linkami'],
  ['zalaczniki', 'Z załącznikami lub obrazkami'],
  ['tekst', 'Zawierające tekst (opcja „tekst”)'],
];
const CLEAR_FILTER_FNS = {
  wszystkie: () => true,
  boty: (m) => Boolean(m.author?.bot),
  ludzie: (m) => !m.author?.bot,
  linki: (m) => /https?:\/\/\S+/i.test(m.content ?? ''),
  zalaczniki: (m) => Boolean(m.attachments?.length || m.embeds?.some((e) => e.image || e.type === 'image')),
  tekst: (m, needle) => String(m.content ?? '').toLowerCase().includes(needle),
};

const clear = {
  permission: P.MANAGE_MESSAGES,
  defer: 'ephemeral',
  data: {
    name: 'clear',
    description: '🧹 Usuń ostatnie wiadomości na tym kanale (maks. 100, nie starsze niż 14 dni)',
    ...GUILD_ONLY,
    options: [
      int('ilosc', '🔢 Ile ostatnich wiadomości sprawdzić (1–100)', { required: true, min_value: 1, max_value: 100 }),
      user('uzytkownik', '👤 Usuń tylko wiadomości tej osoby (opcjonalnie)'),
      str('filtr', '🔎 Usuń tylko wybrane wiadomości (opcjonalnie)', { choices: CLEAR_FILTERS.map(([value, name]) => ({ name, value })) }),
      str('tekst', '🔤 Dla filtra „zawiera tekst” — jaki tekst (bez rozróżniania wielkości liter)', { max_length: 100 }),
    ],
  },
  async execute(ix, bot) {
    const only = ix.getUser('uzytkownik');
    const filter = CLEAR_FILTER_FNS[ix.opt('filtr') ?? 'wszystkie'];
    const needle = String(ix.opt('tekst') ?? '').toLowerCase();
    if (ix.opt('filtr') === 'tekst' && !needle) throw new ReplyError('Podaj tekst w opcji `tekst`.');
    const fetched = await bot.discord.get(`/channels/${ix.channelId}/messages`, { query: { limit: ix.opt('ilosc') } });
    const cutoff = Date.now() - 14 * 86_400_000 + 60_000;
    const ids = fetched
      .filter((m) => snowflakeTime(m.id) > cutoff && (!only || m.author.id === only.id) && filter(m, needle))
      .map((m) => m.id);
    const reason = `Clear: ${ix.user.username}`;
    if (ids.length === 1) await bot.discord.delete(`/channels/${ix.channelId}/messages/${ids[0]}`, { reason });
    if (ids.length > 1) await bot.discord.post(`/channels/${ix.channelId}/messages/bulk-delete`, { messages: ids }, { reason });

    await sendModLog(bot, await bot.store.getConfig(), {
      embeds: [
        embeds.simpleEmbed(
          'info',
          '🧹 Wyczyszczono wiadomości',
          `**Kanał:** <#${ix.channelId}>\n**Moderator:** <@${ix.user.id}>\n**Usunięto:** ${ids.length}${only ? `\n**Tylko od:** <@${only.id}>` : ''}`,
        ),
      ],
    });
    const skipped = only || ix.opt('filtr') ? 0 : fetched.length - ids.length;
    const note = skipped ? `\n-# Pominięto ${skipped} wiadomości starszych niż 14 dni (ograniczenie Discorda).` : '';
    return ix.edit({ embeds: [embeds.successEmbed(`Usunięto **${ids.length}** wiadomości.${note}`)] });
  },
};

function describeSeconds(seconds) {
  if (seconds === 0) return 'wyłączony';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
  return `${Math.floor(seconds / 3600)} h${seconds % 3600 ? ` ${Math.floor((seconds % 3600) / 60)} min` : ''}`;
}

const slowmode = {
  permission: P.MANAGE_CHANNELS,
  defer: 'ephemeral',
  data: {
    name: 'slowmode',
    description: '🐢 Ustaw tryb powolny — co ile sekund można pisać',
    ...GUILD_ONLY,
    options: [
      int('sekundy', '⏱️ Odstęp między wiadomościami w sekundach (0 = wyłącz, maks. 21600 = 6 h)', { required: true, min_value: 0, max_value: 21600 }),
      channelOpt('💬 Na którym kanale (domyślnie ten)', [CH.TEXT, CH.FORUM]),
    ],
  },
  async execute(ix, bot) {
    const seconds = ix.opt('sekundy');
    const channelId = ix.opt('kanal') ?? ix.channelId;
    await bot.discord.patch(`/channels/${channelId}`, { rate_limit_per_user: seconds }, { reason: `Slowmode: ${ix.user.username}` });
    await sendModLog(bot, await bot.store.getConfig(), {
      embeds: [embeds.simpleEmbed('info', '🐢 Tryb powolny', `**Kanał:** <#${channelId}>\n**Ustawienie:** ${describeSeconds(seconds)}\n**Moderator:** <@${ix.user.id}>`)],
    });
    return ix.edit({ embeds: [embeds.successEmbed(`Tryb powolny na <#${channelId}>: **${describeSeconds(seconds)}**.`)] });
  },
};

function lockCommand(name, description, locked) {
  return {
    permission: P.MANAGE_CHANNELS,
    defer: 'ephemeral',
    data: {
      name,
      description,
      ...GUILD_ONLY,
      options: [
        channelOpt(locked ? '🔒 Który kanał zablokować (domyślnie ten)' : '🔓 Który kanał odblokować (domyślnie ten)', [CH.TEXT, CH.ANNOUNCEMENT]),
        reasonOpt('📝 Powód (pokaże się na kanale)', false),
      ],
    },
    async execute(ix, bot) {
      const channelId = ix.opt('kanal') ?? ix.channelId;
      const reason = ix.opt('powod') ?? 'Nie podano powodu';
      const channel = await bot.discord.get(`/channels/${channelId}`);
      const current = channel.permission_overwrites?.find((o) => o.id === ix.guildId) ?? { allow: '0', deny: '0' };
      const bits = P.SEND_MESSAGES | P.SEND_MESSAGES_IN_THREADS;
      let allow = BigInt(current.allow);
      let deny = BigInt(current.deny);
      if (locked) {
        deny |= bits;
        allow &= ~bits;
      } else {
        deny &= ~bits;
      }
      await bot.discord.put(
        `/channels/${channelId}/permissions/${ix.guildId}`,
        { type: 0, allow: String(allow), deny: String(deny) },
        { reason: `${ix.user.username}: ${reason}` },
      );

      const title = locked ? '🔒 Kanał zablokowany' : '🔓 Kanał odblokowany';
      const body = locked
        ? `Pisanie na tym kanale zostało tymczasowo wyłączone przez moderację.\n\n📝 **Powód:** ${reason}`
        : `Można znowu pisać na tym kanale. Miłej rozmowy!\n\n📝 **Powód:** ${reason}`;
      await bot.discord
        .post(`/channels/${channelId}/messages`, { embeds: [{ ...embeds.simpleEmbed(locked ? 'error' : 'success', title, body), footer: { text: embeds.BRAND } }] })
        .catch(() => {});
      await sendModLog(bot, await bot.store.getConfig(), {
        embeds: [embeds.simpleEmbed('info', title, `**Kanał:** <#${channelId}>\n**Moderator:** <@${ix.user.id}>\n**Powód:** ${reason}`)],
      });
      return ix.edit({ embeds: [embeds.successEmbed(`<#${channelId}> ${locked ? 'zablokowany' : 'odblokowany'}.`)] });
    },
  };
}

// ---------- Logowanie do panelu ----------
// Działa tylko na kanale wybranym w panelu („Dostęp do panelu”); login i hasło widzi tylko ta osoba. O tym, co
// odblokowuje, decydują jej role — dlatego komenda jest otwarta dla wszystkich (permission: null).
function accessSummary(access) {
  if (access.full) return '✅ **Możesz zmieniać:** wszystko (administrator)';
  const locked = Object.keys(PANEL_SECTIONS).filter((key) => !access.sections.includes(key));
  return [
    `✅ **Możesz zmieniać:** ${access.sections.map((key) => PANEL_SECTIONS[key]).join(', ')}`,
    ...(locked.length ? [`🔒 **Tylko podgląd:** ${locked.map((key) => PANEL_SECTIONS[key]).join(', ')}`] : []),
  ].join('\n');
}

const login = {
  permission: null,
  defer: 'ephemeral',
  data: {
    name: 'login',
    description: '🔑 Twój login i hasło do panelu bota (tylko na kanale do logowania)',
    ...GUILD_ONLY,
    options: [{ type: T.BOOLEAN, name: 'nowy', description: '🔄 Wygeneruj nowe hasło — stare i wszystkie zalogowania przestaną działać' }],
  },
  async execute(ix, bot) {
    const config = await bot.store.getConfig();
    const { enabled, channelId } = config.panelAccess;
    if (!enabled) throw new ActionError('Logowanie do panelu jest wyłączone — administrator może je włączyć w panelu (zakładka „Dostęp do panelu”).');
    if (!channelId) throw new ActionError('Administrator nie wybrał jeszcze kanału do logowania (panel → zakładka „Dostęp do panelu”).');
    if (ix.channelId !== channelId) throw new ActionError(`Login do panelu wygenerujesz tylko na kanale <#${channelId}>.`);
    const { login: issued, password, access } = await issueLogin(bot, ix, config, { renew: ix.opt('nowy') === true });
    if (!issued) throw new ActionError('Żadna z Twoich ról nie odblokowuje panelu — poproś administrację o dostęp.');
    const expires = `${discordTimestamp(issued.expiresAt, 'f')} (${discordTimestamp(issued.expiresAt, 'R')})`;
    const description = password
      ? [
          `**Login:** \`${issued.login}\``,
          `**Hasło:** ||\`${password}\`|| — kliknij, żeby odsłonić`,
          `**Ważny do:** ${expires} — potem wpisz \`/login\` jeszcze raz.`,
          '',
          accessSummary(access),
          '',
          '-# Hasło pokazuję tylko teraz. Nie dawaj go nikomu. Gdyby ktoś je zobaczył, wpisz `/login nowy:True` — dostaniesz nowe, a stare od razu przestanie działać. Dostęp zależy od Twoich ról — po odebraniu roli panel sam się zamknie.',
        ]
      : [
          `Masz już aktywny login **\`${issued.login}\`**, ważny do ${expires}.`,
          'Hasło pokazuję tylko raz, przy generowaniu. Nie pamiętasz go albo ktoś mógł je zobaczyć? Wpisz `/login nowy:True` — dostaniesz nowe, a stare i wszystkie zalogowania nim przestaną działać.',
          '',
          accessSummary(access),
        ];
    const fragment = password ? `login=${encodeURIComponent(issued.login)}&haslo=${password}` : `login=${encodeURIComponent(issued.login)}`;
    return ix.edit({
      embeds: [{ color: embeds.COLORS.info, title: '🔑 Twój login do panelu', description: description.join('\n'), footer: { text: embeds.BRAND } }],
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 5, label: password ? 'Zaloguj się do panelu' : 'Otwórz panel', url: `${PANEL_SITE}#${fragment}` }],
        },
      ],
    });
  },
};

// ---------- Pomoc ----------
const pomoc = {
  permission: null,
  defer: 'ephemeral',
  data: { name: 'pomoc', description: '❓ Lista wszystkich komend bota z krótkim opisem', ...GUILD_ONLY },
  async execute(ix, bot) {
    const { warns } = await bot.store.getConfig();
    return ix.edit({
      embeds: [
        {
          color: embeds.COLORS.info,
          title: 'Bot moderacyjny — Entuzjaści Hopkostki',
          description: 'Czas wybierasz z listy: **minuty, godziny, dni, tygodnie, miesiące**. Listy mają strony **◀ 1 2 3 ▶**.',
          fields: [
            {
              name: '🔨 Kary',
              value: [
                '`/ban` — ban na czas lub na zawsze',
                '`/unban` — zdejmij bana (puste = lista zbanowanych)',
                '`/timeout` · `/untimeout` — wyciszenie (maks. 28 dni)',
                '`/kick` — wyrzucenie z serwera',
              ].join('\n'),
            },
            {
              name: '⚠️ Ostrzeżenia',
              value: [
                '`/warn dodaj` — ostrzeżenie z punktami',
                '`/warn status` — ostrzeżenia i punkty osoby',
                '`/warn usun` — wybierz osobę i usuń z listy',
                '`/warn wyczysc` · `/warn ranking`',
                warns.expiryDays > 0 ? `-# Każde ostrzeżenie znika samo po **${warns.expiryDays} dniach**.` : '-# Ostrzeżenia nie wygasają.',
              ].join('\n'),
            },
            {
              name: '🗂️ Moderacja',
              value: [
                '`/info` — karta użytkownika',
                '`/historia` · `/sprawy` · `/sprawa`',
                '`/notatka dodaj` · `/notatka lista`',
                '`/nick` · `/rola dodaj` · `/rola usun`',
                '`/login` — Twój login i hasło do panelu bota (na kanale do logowania)',
              ].join('\n'),
            },
            {
              name: '🛠️ Kanały i inne',
              value: [
                '`/clear` (z filtrami) · `/slowmode` · `/lock` · `/unlock` · `/snipe`',
                '`/ogloszenie` · `/powiedz` · `/ankieta` · `/konkurs`',
                '`/emoji dodaj` — emoji z innego serwera · `/rolainfo`',
              ].join('\n'),
            },
            {
              name: '🎲 Dla wszystkich',
              value: [
                '`/profil` · `/serwer` · `/czlonkowie` · `/avatar`',
                '`/przypomnij` · `/afk` · `/propozycja` · `/losuj`',
                '`/bumpy` — ranking bumpów · `/zaproszenia` — kto kogo zaprosił · `/pomoc`',
              ].join('\n'),
            },
          ],
          footer: { text: embeds.BRAND },
        },
      ],
    });
  },
};

export const COMMANDS = [
  ban,
  unban,
  kick,
  timeout,
  untimeout,
  warn,
  historia,
  sprawy,
  sprawa,
  notatka,
  info,
  serwer,
  avatar,
  nick,
  rola,
  ogloszenie,
  clear,
  slowmode,
  lockCommand('lock', '🔒 Zablokuj pisanie na kanale (np. podczas kłótni)', true),
  lockCommand('unlock', '🔓 Odblokuj pisanie na kanale', false),
  ...COMMUNITY_COMMANDS,
  login,
  pomoc,
];

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.data.name, c]));
export const commandDefinitions = () => COMMANDS.map((c) => c.data);

// Metadane do panelu (zakładka "Uprawnienia") — nazwa, opis i domyślny wymóg uprawnień każdej komendy.
export const COMMAND_META = COMMANDS.map((c) => ({
  name: c.data.name,
  description: c.data.description,
  permission: c.permission ? String(c.permission) : null,
  permissionLabel: permissionLabel(c.permission),
}));

// Domyślne listy ról dla każdej komendy = kto może jej użyć teraz (uprawnienie Discorda albo rola moderatora).
// Administratorzy mają dostęp zawsze, więc nie ma ich na listach; komendy bez wymagań dostają „wszystkich”.
export function commandPermissionDefaults(rawRoles, guildId, config) {
  const roles = rawRoles
    .filter((r) => r.id !== guildId && !r.managed && !has(r.permissions, P.ADMINISTRATOR))
    .sort((a, b) => b.position - a.position);
  const out = {};
  for (const c of COMMANDS) {
    out[c.data.name] = c.permission
      ? roles.filter((r) => has(r.permissions, c.permission) || config.modRoleIds.includes(r.id)).map((r) => r.id)
      : [EVERYONE];
  }
  return out;
}

// Każda komenda ma mieć własną listę ról (zakładka Uprawnienia). Uzupełnia brakujące (reset = wszystkie od nowa).
export async function fillCommandPermissions(bot, { reset = false } = {}) {
  const config = await bot.store.getConfig();
  const current = config.commandPermissions ?? {};
  const missing = COMMANDS.map((c) => c.data.name).filter((name) => reset || !Array.isArray(current[name]));
  if (!missing.length) return { changed: 0, config };
  const gctx = await getGuildContext(bot);
  const defaults = commandPermissionDefaults(gctx.rawRoles, gctx.guild.id, config);
  const next = { ...current };
  for (const name of missing) next[name] = defaults[name];
  return { changed: missing.length, config: await bot.store.updateConfig({ commandPermissions: next }) };
}
