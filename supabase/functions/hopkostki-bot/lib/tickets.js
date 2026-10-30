// Tickety: wiadomość-panel z przyciskami (wysyłana z panelu) → formularz (okienko Discorda) → prywatny
// kanał dla osoby i obsługi. Każdy przycisk to rodzaj ticketu z własnym formularzem (np. Zgłoszenie,
// Partnerstwo: link do serwera, liczba członków, powód).
// W tickecie: Zamknij (z potwierdzeniem, zapis rozmowy do logów i w DM), Przejmij, Dodaj osobę.

import { P, has } from './permissions.js';
import { DiscordError } from './rest.js';
import { ActionError, describeError, getGuildContext } from './moderation.js';
import { BRAND, COLORS, colorInt, errorEmbed, escapeMarkdown, fillTemplate, successEmbed } from './embeds.js';
import { discordTimestamp } from './duration.js';
import { ticketFields } from './configSchema.js';
import { emojiObject } from './messages.js';

const EPHEMERAL = 64;
const STYLES = { niebieski: 1, szary: 2, zielony: 3, czerwony: 4 };
const MEMBER_ALLOW = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ATTACH_FILES | P.EMBED_LINKS;
const HISTORY_PAGES = 10;

const isGone = (error) => error instanceof DiscordError && (error.status === 404 || error.code === 10003);
export const ticketNumber = (id) => String(id).padStart(4, '0');

// ---------- Panel ticketów (wiadomość z przyciskami) ----------

export function ticketPanelMessage(tickets) {
  const buttons = tickets.types.map((t, i) => {
    const emoji = emojiObject(t.emoji);
    return { type: 2, style: STYLES[t.style] ?? 1, label: t.label, custom_id: `tk|open|${i}`, ...(emoji ? { emoji } : {}) };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return {
    embeds: [
      {
        color: colorInt(tickets.panel.color),
        title: tickets.panel.title || 'Tickety',
        ...(tickets.panel.description ? { description: tickets.panel.description } : {}),
        footer: { text: BRAND },
      },
    ],
    components: rows,
  };
}

// Wysyła panel na kanał albo aktualizuje poprzedni, jeśli to ten sam kanał.
export async function sendTicketPanel(bot, channelId) {
  const { tickets } = await bot.store.getConfig();
  if (!tickets.enabled) throw new ActionError('Najpierw włącz tickety i zapisz ustawienia.');
  if (!/^\d{15,25}$/.test(String(channelId ?? ''))) throw new ActionError('Wybierz kanał.');
  const payload = ticketPanelMessage(tickets);
  const saved = await bot.store.getState('ticket_panel');
  if (saved?.channelId === channelId) {
    try {
      await bot.discord.patch(`/channels/${channelId}/messages/${saved.messageId}`, payload);
      return { ...saved, updated: true };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  const message = await bot.discord.post(`/channels/${channelId}/messages`, payload);
  const state = { channelId, messageId: message.id, at: Date.now() };
  await bot.store.setState('ticket_panel', state);
  return { ...state, updated: false };
}

// ---------- Formularz (okienko Discorda przed otwarciem ticketu) ----------

const INVITE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([\w-]{2,32})/i;
// Liczba z separatorami tysięcy („1 200”, „1.200”) albo bez; „1,5k”, „250-300” czy „5 tys.” są odrzucane.
const NUMBER_PART = /\d{1,3}(?:[ .,']\d{3})+(?!\d)|\d+/g;
const NUMBER_SHORTHAND = /\d\s*(?:k|tys|mln)(?![a-ząćęłńóśźż])/i;
const FIELD_MAX = { short: 200, long: 1000, number: 15, invite: 200 };

// prefill: etykieta pola → wartość — przy poprawianiu formularza wpisane wcześniej odpowiedzi wracają do pól.
function ticketForm(type, index, prefill = new Map()) {
  return {
    custom_id: `tkm|open|${index}`,
    title: `Nowy ticket — ${type.label}`.slice(0, 45),
    components: ticketFields(type).map((field, i) => {
      const required = field.required !== false;
      const max = FIELD_MAX[field.kind] ?? FIELD_MAX.short;
      const value = prefill.get(field.label);
      return {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: `f${i}`,
            style: field.kind === 'long' ? 2 : 1,
            label: field.label.slice(0, 45),
            ...(field.placeholder ? { placeholder: field.placeholder.slice(0, 100) } : {}),
            ...(required ? { min_length: field.kind === 'long' ? 3 : 1 } : {}),
            max_length: max,
            required,
            ...(value ? { value: value.slice(0, max) } : {}),
          },
        ],
      };
    }),
  };
}

// Odpowiedzi z okienka w kolejności pól. Okienka sprzed formularzy miały jedno pole o ID `value`.
function formAnswers(ix, fields) {
  const values = new Map();
  for (const row of ix.raw.data?.components ?? []) {
    for (const input of row.components ?? []) values.set(input.custom_id === 'value' ? 'f0' : input.custom_id, String(input.value ?? '').trim());
  }
  return fields.map((field, i) => ({ label: field.label, kind: field.kind, required: field.required !== false, value: values.get(`f${i}`) ?? '' }));
}

// Sprawdza i ujednolica odpowiedzi (liczba, link zaproszenia). Zwraca opis problemu albo null. Do odpowiedzi
// z linkiem dopisuje dane serwera z Discorda — obsługa od razu widzi nazwę i prawdziwą liczbę członków.
async function checkAnswers(bot, answers, guildId) {
  for (const answer of answers) {
    if (!answer.value) {
      if (answer.required) return `Uzupełnij pole „${answer.label}”.`;
      continue;
    }
    if (answer.kind === 'number') {
      const parts = answer.value.match(NUMBER_PART) ?? [];
      if (parts.length !== 1 || NUMBER_SHORTHAND.test(answer.value) || parts[0].replace(/\D/g, '').length > 9) {
        return `W polu „${answer.label}” wpisz jedną liczbę, np. 250 (albo 1500 zamiast 1,5k).`;
      }
      answer.value = String(Number(parts[0].replace(/\D/g, '')));
    }
    if (answer.kind === 'invite') {
      const code = INVITE.exec(answer.value)?.[1];
      if (!code) return `W polu „${answer.label}” wklej link zaproszenia na serwer Discord, np. https://discord.gg/abc123.`;
      answer.value = `https://discord.gg/${code}`;
      let invite = null;
      try {
        invite = await bot.discord.get(`/invites/${code}`, { query: { with_counts: true } });
      } catch (error) {
        // Nieznane zaproszenie = wygasło albo jest błędne. Inny błąd (np. limit zapytań) nie blokuje ticketu.
        if (isGone(error)) {
          return `Link ${answer.value} nie działa — zaproszenie wygasło albo jest błędne. Wklej aktualny link (najlepiej bez limitu czasu).`;
        }
      }
      if (invite?.guild?.id === guildId) return 'To link do naszego serwera — wklej link do swojego.';
      if (invite?.guild) {
        answer.server = {
          name: invite.guild.name,
          members: invite.approximate_member_count ?? null,
          online: invite.approximate_presence_count ?? null,
          expiresAt: invite.expires_at ?? null,
        };
      }
    }
  }
  return null;
}

function serverSummary(server) {
  const parts = [`**${escapeMarkdown(server.name)}**`];
  if (Number.isFinite(server.members)) parts.push(`${server.members} członków`);
  if (Number.isFinite(server.online)) parts.push(`${server.online} online`);
  const expires = Date.parse(server.expiresAt ?? '');
  return `${parts.join(' • ')}${Number.isFinite(expires) ? `\n⚠️ Zaproszenie wygasa ${discordTimestamp(expires, 'R')}` : ''}`;
}

// Odpowiedzi jako pola embeda (powitanie w tickecie, log otwarcia, wiadomość z błędem do poprawienia).
function answerFields(answers, { withServer = true } = {}) {
  return answers
    .filter((a) => a.value)
    .flatMap((a) => [
      { name: a.label.slice(0, 256), value: a.value.slice(0, 1024) },
      ...(withServer && a.server ? [{ name: 'Serwer z zaproszenia', value: serverSummary(a.server) }] : []),
    ]);
}

// Tekst do bazy (lista ticketów w panelu, nagłówek zapisu rozmowy): jedna odpowiedź = sama treść.
function answersText(answers) {
  const filled = answers.filter((a) => a.value);
  if (filled.length === 1 && !filled[0].server) return filled[0].value;
  return filled
    .flatMap((a) => [
      `${a.label}: ${a.value}`,
      ...(a.server ? [`Serwer z zaproszenia: ${a.server.name}${Number.isFinite(a.server.members) ? ` (${a.server.members} członków)` : ''}`] : []),
    ])
    .join('\n');
}

// ---------- Tworzenie ----------

function ticketButtons(ticket) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 4, label: 'Zamknij', custom_id: `tk|close|${ticket.id}` },
        { type: 2, style: 3, label: ticket.claimedBy ? 'Przejęty' : 'Przejmij', custom_id: `tk|claim|${ticket.id}`, disabled: Boolean(ticket.claimedBy) },
        { type: 2, style: 2, label: 'Dodaj osobę', custom_id: `tk|add|${ticket.id}` },
      ],
    },
  ];
}

async function ticketLog(bot, tickets, payload, files) {
  if (!tickets.logChannelId) return;
  await bot.discord
    .post(`/channels/${tickets.logChannelId}/messages`, { allowed_mentions: { parse: [] }, ...payload }, files ? { files } : undefined)
    .catch((error) => console.warn(`[tickety] Log: ${error.message}`));
}

// answers: odpowiedzi z formularza [{ label, value, server? }] (sprawdzone przez checkAnswers).
export async function createTicket(bot, { guildId, user, type, answers = [] }) {
  const { tickets } = await bot.store.getConfig();

  // Ticket, którego kanał ktoś usunął ręcznie, nie powinien blokować nowego.
  const open = [];
  for (const ticket of await bot.store.openTicketsForUser(user.id)) {
    const channel = ticket.channelId ? await bot.discord.get(`/channels/${ticket.channelId}`).catch((e) => (isGone(e) ? null : ticket)) : null;
    if (channel) open.push(ticket);
    else await bot.store.updateTicket(ticket.id, { status: 'closed' });
  }
  if (open.length >= tickets.maxOpen) throw new ActionError(`Masz już otwarty ticket: <#${open[0].channelId}>`);

  const subject = answersText(answers);
  let ticket = await bot.store.addTicket({ guildId, userId: user.id, userTag: user.username, type: type.label, subject });
  const number = ticketNumber(ticket.id);
  const vars = { numer: number, nick: user.username, uzytkownik: `<@${user.id}>`, typ: type.label };
  const fields = answerFields(answers);
  const { botUser } = await getGuildContext(bot);
  const overwrites = [
    { id: guildId, type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) },
    { id: user.id, type: 1, allow: String(MEMBER_ALLOW), deny: '0' },
    { id: botUser.id, type: 1, allow: String(MEMBER_ALLOW), deny: '0' },
    ...tickets.supportRoleIds.map((id) => ({ id, type: 0, allow: String(MEMBER_ALLOW | P.MANAGE_MESSAGES), deny: '0' })),
  ];

  let channel;
  try {
    channel = await bot.discord.post(
      `/guilds/${guildId}/channels`,
      {
        name: fillTemplate(tickets.nameTemplate || 'ticket-{numer}', vars).slice(0, 100),
        type: 0,
        topic: `Ticket #${number} • ${user.username} • ${type.label}`.slice(0, 1024),
        permission_overwrites: overwrites,
        ...(tickets.categoryId ? { parent_id: tickets.categoryId } : {}),
      },
      { reason: `Ticket #${number} (${user.username})` },
    );
  } catch (error) {
    await bot.store.deleteTicket(ticket.id);
    throw error;
  }
  ticket = await bot.store.updateTicket(ticket.id, { channelId: channel.id });

  // Tylko oznaczenie autora — obsługa i tak widzi kanał (ma do niego dostęp od razu po utworzeniu),
  // więc pingowanie całej roli przy każdym nowym tickecie byłoby tylko spamem powiadomień.
  await bot.discord.post(`/channels/${channel.id}/messages`, {
    content: `<@${user.id}>`,
    allowed_mentions: { users: [user.id] },
    embeds: [
      {
        color: colorInt(tickets.panel.color),
        title: `Ticket #${number} • ${type.label}`,
        description: fillTemplate(type.welcome || tickets.welcome, vars),
        ...(fields.length ? { fields } : {}),
        footer: { text: BRAND },
      },
    ],
    components: ticketButtons(ticket),
  });
  await ticketLog(bot, tickets, {
    embeds: [
      {
        color: COLORS.info,
        title: `Otwarto ticket #${number}`,
        description: `**Autor:** <@${user.id}> \`${user.username}\`\n**Typ:** ${type.label}\n**Kanał:** <#${channel.id}>`,
        ...(fields.length ? { fields } : {}),
      },
    ],
  });
  return { ticket, channel };
}

// ---------- Zamykanie ----------

async function fetchHistory(bot, channelId) {
  const all = [];
  let before;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const batch = await bot.discord.get(`/channels/${channelId}/messages`, { query: { limit: 100, ...(before ? { before } : {}) } });
    if (!batch?.length) break;
    all.push(...batch);
    before = batch.at(-1).id;
    if (batch.length < 100) break;
  }
  return all.reverse();
}

const snowflakeMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);
const plTime = (ms) => new Date(ms).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });

export function buildTranscript(ticket, messages, closer) {
  const header = [
    `Zapis ticketu #${ticketNumber(ticket.id)} — ${BRAND}`,
    `Autor: ${ticket.userTag ?? ticket.userId} (${ticket.userId})`,
    `Typ: ${ticket.type ?? '—'}`,
    // Kilka odpowiedzi z formularza („Pole: odpowiedź” w liniach) albo jedna — sama treść sprawy.
    ticket.subject ? (ticket.subject.includes('\n') ? `Formularz:\n${ticket.subject.replace(/^/gm, '  ')}` : `Sprawa: ${ticket.subject}`) : null,
    `Otwarty: ${plTime(ticket.createdAt)}`,
    `Zamknął: ${closer.username} (${closer.id}), ${plTime(Date.now())}`,
    '',
  ].filter((line) => line !== null);
  const lines = messages.map((m) => {
    const when = m.timestamp ? new Date(m.timestamp).getTime() : snowflakeMs(m.id);
    const author = m.author?.global_name ?? m.author?.username ?? 'nieznany';
    const extras = [
      ...(m.embeds ?? []).map((e) => `[embed: ${e.title ?? e.description ?? ''}]`.slice(0, 200)),
      ...(m.attachments ?? []).map((a) => `[załącznik: ${a.url}]`),
    ];
    return `[${plTime(when)}] ${author}: ${m.content ?? ''}${extras.length ? ` ${extras.join(' ')}` : ''}`;
  });
  return [...header, ...lines].join('\n');
}

function closedSummary(ticket, closer, messageCount) {
  const number = ticketNumber(ticket.id);
  return {
    color: COLORS.muted,
    title: `Ticket #${number} zamknięty`,
    fields: [
      { name: 'Autor', value: `<@${ticket.userId}>`, inline: true },
      { name: 'Zamknął', value: closer ? `<@${closer.id}>` : '—', inline: true },
      { name: 'Typ', value: ticket.type ?? '—', inline: true },
      ...(ticket.claimedBy ? [{ name: 'Przejął', value: `<@${ticket.claimedBy}>`, inline: true }] : []),
      { name: 'Otwarty', value: discordTimestamp(ticket.createdAt, 'f'), inline: true },
      { name: 'Wiadomości', value: String(messageCount), inline: true },
    ],
    footer: { text: BRAND },
  };
}

export async function closeTicket(bot, ticket, closer) {
  const { tickets } = await bot.store.getConfig();
  const number = ticketNumber(ticket.id);
  const messages = await fetchHistory(bot, ticket.channelId).catch(() => []);
  const transcript = buildTranscript(ticket, messages, closer);
  const file = { name: `ticket-${number}.txt`, content: transcript };
  const summary = closedSummary(ticket, closer, messages.length);
  await ticketLog(bot, tickets, { embeds: [summary] }, [file]);
  if (tickets.dmTranscript) {
    try {
      const dm = await bot.discord.post('/users/@me/channels', { recipient_id: ticket.userId });
      await bot.discord.post(`/channels/${dm.id}/messages`, { embeds: [{ ...summary, title: `Twój ticket #${number} został zamknięty` }] }, { files: [file] });
    } catch {
      // Zamknięte DM — trudno.
    }
  }
  await bot.store.updateTicket(ticket.id, { status: 'closed', closedBy: closer.id });
  const channel = await archiveTicketChannel(bot, ticket, tickets).catch((error) => {
    console.warn(`[tickety] Archiwizacja #${number}: ${error.message}`);
    return null;
  });
  // Zapis rozmowy i informacja o zamknięciu — od razu, na kanał, który już widzi tylko obsługa.
  // Przycisk pozwala usunąć kanał z archiwum, gdy sprawa przestanie być potrzebna.
  if (channel) {
    await bot.discord
      .post(
        `/channels/${ticket.channelId}/messages`,
        {
          embeds: [summary],
          allowed_mentions: { parse: [] },
          components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Usuń kanał z archiwum', custom_id: `tk|delete|${ticket.id}` }] }],
        },
        { files: [file] },
      )
      .catch((error) => {
        if (!isGone(error)) console.warn(`[tickety] Zapis na kanał #${number}: ${error.message}`);
      });
  }
}

// Kanał NIE jest usuwany — zostaje jako archiwum. Przenosi się do kategorii zamkniętych ticketów (jeśli
// ustawiona) i znika dla wszystkich poza obsługą (nawet dla autora) — usuwamy nadpisania uprawnień
// każdego poza @everyone (już ma zakaz VIEW_CHANNEL z chwili utworzenia), botem i rolami obsługi.
// Zwraca pobrany kanał (albo null, gdy ktoś go już ręcznie usunął).
async function archiveTicketChannel(bot, ticket, tickets) {
  let channel;
  try {
    channel = await bot.discord.get(`/channels/${ticket.channelId}`);
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
  const { botUser } = await getGuildContext(bot);
  const keep = new Set([ticket.guildId, botUser.id, ...tickets.supportRoleIds]);
  const number = ticketNumber(ticket.id);
  for (const overwrite of channel.permission_overwrites ?? []) {
    if (keep.has(overwrite.id)) continue;
    await bot.discord.delete(`/channels/${ticket.channelId}/permissions/${overwrite.id}`, { reason: `Archiwizacja ticketu #${number}` }).catch(() => {});
  }
  if (tickets.archiveCategoryId && tickets.archiveCategoryId !== channel.parent_id) {
    await bot.discord.patch(`/channels/${ticket.channelId}`, { parent_id: tickets.archiveCategoryId }, { reason: `Archiwizacja ticketu #${number}` });
  }
  return channel;
}

// ---------- Przyciski, listy i okna ----------

export const isTicketCustomId = (customId) => /^tk[ms]?\|/.test(String(customId ?? ''));

function isSupport(member, tickets) {
  if (!member) return false;
  if (has(member.permissions, P.ADMINISTRATOR) || has(member.permissions, P.MANAGE_CHANNELS)) return true;
  return tickets.supportRoleIds.some((id) => member.roles?.includes(id));
}

const fail = (text) => ({ response: { type: 4, data: { flags: EPHEMERAL, embeds: [errorEmbed(text)] } } });

export async function handleTicketInteraction(ix, bot) {
  const [kind, action, arg] = String(ix.customId).split('|');
  const { tickets } = await bot.store.getConfig();

  const work = (deferType, fn) => ({
    response: deferType === 5 ? { type: 5, data: { flags: EPHEMERAL } } : { type: 6 },
    task: async () => {
      try {
        const text = await fn();
        if (text) await ix.edit({ content: '', embeds: [successEmbed(text)], components: [] });
      } catch (error) {
        await ix.edit({ content: '', embeds: [errorEmbed(describeError(error))], components: [] }).catch(() => {});
      }
    },
  });

  // open: przycisk w panelu ticketów (i wysłany formularz), retry: „Popraw formularz” pod błędem w odpowiedziach.
  if (action === 'open' || action === 'retry') {
    if (!tickets.enabled) return fail('Tickety są teraz wyłączone.');
    const type = tickets.types[Number(arg)];
    if (!type) return fail('Ten przycisk jest już nieaktualny.');
    const fields = ticketFields(type);
    if (kind === 'tk' && fields.length) {
      // Odpowiedzi do poprawienia wracają z wiadomości z błędem (jej pola to „etykieta: odpowiedź”).
      const prefill = new Map(action === 'retry' ? (ix.raw.message?.embeds?.[0]?.fields ?? []).map((f) => [f.name, String(f.value ?? '')]) : []);
      return { response: { type: 9, data: ticketForm(type, arg, prefill) } };
    }
    const answers = kind === 'tkm' ? formAnswers(ix, fields) : [];
    // Formularz otwarty z wiadomości z błędem (widocznej tylko dla tej osoby) aktualizuje ją zamiast dodawać nową.
    const fromRetry = kind === 'tkm' && (Number(ix.raw.message?.flags ?? 0) & EPHEMERAL) !== 0;
    return work(fromRetry ? 6 : 5, async () => {
      const problem = await checkAnswers(bot, answers, ix.guildId);
      if (problem) {
        await ix.edit({
          content: '',
          embeds: [{ ...errorEmbed(`${problem}\nKliknij **Popraw formularz** — wpisane odpowiedzi wrócą do pól.`), fields: answerFields(answers, { withServer: false }) }],
          components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Popraw formularz', custom_id: `tk|retry|${arg}` }] }],
        });
        return null;
      }
      const { channel } = await createTicket(bot, { guildId: ix.guildId, user: ix.user, type, answers });
      return `Ticket utworzony: <#${channel.id}>`;
    });
  }

  const ticket = await bot.store.getTicket(Number(arg));
  if (!ticket) return fail('Ten ticket już nie istnieje.');

  // Przycisk pod zapisem rozmowy w archiwum — działa tylko na już zamkniętym tickecie, więc sprawdzany
  // jest przed ogólnym „musi być otwarty” niżej.
  if (kind === 'tk' && (action === 'delete' || action === 'deleteconfirm')) {
    if (ticket.status !== 'closed') return fail('Ten ticket nie jest jeszcze zamknięty.');
    if (!isSupport(ix.member, tickets)) return fail('Usunąć kanał z archiwum może tylko obsługa.');
    if (action === 'delete') {
      return {
        response: {
          type: 4,
          data: {
            flags: EPHEMERAL,
            content: 'Na pewno usunąć ten kanał z archiwum? Tej operacji nie można cofnąć.',
            components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Tak, usuń', custom_id: `tk|deleteconfirm|${ticket.id}` }] }],
          },
        },
      };
    }
    return work(6, async () => {
      await bot.discord.delete(`/channels/${ticket.channelId}`, { reason: `Usunięcie archiwum ticketu #${ticketNumber(ticket.id)}` }).catch((error) => {
        if (!isGone(error)) throw error;
      });
      return 'Kanał usunięty z archiwum.';
    });
  }

  if (ticket.status !== 'open') return fail('Ten ticket jest już zamknięty.');
  const support = isSupport(ix.member, tickets);
  const owner = ix.user.id === ticket.userId;

  if (kind === 'tks' && action === 'add') {
    return work(6, async () => {
      const added = ix.values.filter((id) => id !== ticket.userId);
      for (const id of added) {
        await bot.discord.put(`/channels/${ticket.channelId}/permissions/${id}`, { type: 1, allow: String(MEMBER_ALLOW), deny: '0' });
      }
      if (added.length) {
        await bot.discord.post(`/channels/${ticket.channelId}/messages`, {
          content: `${added.map((id) => `<@${id}>`).join(' ')} — <@${ix.user.id}> dodał(a) Cię do tego ticketu.`,
          allowed_mentions: { users: added },
        });
      }
      return added.length ? `Dodano: ${added.map((id) => `<@${id}>`).join(', ')}` : 'Nikogo nie dodano.';
    });
  }

  switch (action) {
    case 'close':
      if (!support && !owner) return fail('Ticket może zamknąć jego autor albo obsługa.');
      return {
        response: {
          type: 4,
          data: {
            flags: EPHEMERAL,
            content: 'Na pewno zamknąć ticket? Kanał trafi do archiwum i zniknie dla autora oraz każdego poza obsługą; zapis rozmowy trafi do logów, w DM do autora i na ten kanał.',
            components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Tak, zamknij', custom_id: `tk|confirm|${ticket.id}` }] }],
          },
        },
      };
    case 'confirm':
      if (!support && !owner) return fail('Ticket może zamknąć jego autor albo obsługa.');
      return work(6, async () => {
        await ix.edit({ content: 'Zamykam i archiwizuję ticket…', components: [] }).catch(() => {});
        await closeTicket(bot, ticket, ix.user);
        return null;
      });
    case 'claim':
      if (!support) return fail('Przejąć ticket może tylko obsługa.');
      return work(5, async () => {
        const claimed = await bot.store.updateTicket(ticket.id, { claimedBy: ix.user.id });
        if (ix.raw.message?.id) {
          await bot.discord.patch(`/channels/${ticket.channelId}/messages/${ix.raw.message.id}`, { components: ticketButtons(claimed) }).catch(() => {});
        }
        await bot.discord.post(`/channels/${ticket.channelId}/messages`, {
          embeds: [{ color: COLORS.success, description: `Ticket przejęty przez <@${ix.user.id}>.` }],
          allowed_mentions: { parse: [] },
        });
        return 'Przejęto ticket.';
      });
    case 'add':
      if (!support && !owner) return fail('Osoby do ticketu może dodać jego autor albo obsługa.');
      return {
        response: {
          type: 4,
          data: {
            flags: EPHEMERAL,
            content: 'Kogo dodać do ticketu?',
            components: [{ type: 1, components: [{ type: 5, custom_id: `tks|add|${ticket.id}`, placeholder: 'Wybierz osoby', min_values: 1, max_values: 10 }] }],
          },
        },
      };
    default:
      return fail('Nieznana akcja.');
  }
}
