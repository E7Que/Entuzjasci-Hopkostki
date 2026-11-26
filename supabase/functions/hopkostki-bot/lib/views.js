// Widoki z podziałem na strony: embed + przyciski ◀ 1 2 3 ▶ (+ lista wyboru do usuwania/odbanowania).
// custom_id przycisków: "pg|widok|argument|strona|x", listy wyboru: "sel|widok|argument|strona".

import { P } from './permissions.js';
import { formatDuration, discordTimestamp } from './duration.js';
import { avatarUrl } from './rest.js';
import * as embeds from './embeds.js';
import { getGuildContext, sendModLog, unbanUser, describeError } from './moderation.js';

const BUTTON = { PRIMARY: 1, SECONDARY: 2, DANGER: 4 };
const clip = (text, max) => (String(text ?? '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text ?? ''));

export function paginate(items, page, perPage) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  return { page: current, pages, slice: items.slice((current - 1) * perPage, current * perPage), total: items.length };
}

// ◀ 1 2 3 ▶ - maksymalnie 5 przycisków w rzędzie (okno trzech numerów wokół bieżącej strony).
export function pagerRow(kind, arg, page, pages) {
  if (pages <= 1) return null;
  const first = Math.max(1, Math.min(page - 1, pages - 2));
  const numbers = [];
  for (let n = first; n <= Math.min(pages, first + 2); n += 1) numbers.push(n);
  const button = (label, target, key, { disabled = false, style = BUTTON.SECONDARY } = {}) => ({
    type: 2,
    style,
    label,
    custom_id: `pg|${kind}|${arg}|${target}|${key}`,
    disabled,
  });
  return {
    type: 1,
    components: [
      button('◀', page - 1, 'p', { disabled: page <= 1 }),
      ...numbers.map((n) => button(String(n), n, `n${n}`, n === page ? { disabled: true, style: BUTTON.PRIMARY } : {})),
      button('▶', page + 1, 'x', { disabled: page >= pages }),
    ],
  };
}

function selectRow(kind, arg, page, placeholder, options) {
  if (!options.length) return null;
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `sel|${kind}|${arg}|${page}`,
        placeholder,
        min_values: 1,
        max_values: options.length,
        options: options.slice(0, 25),
      },
    ],
  };
}

const rows = (...list) => list.filter(Boolean);
const footerText = (page, pages, extra) => `Strona ${page}/${pages} • ${extra} • ${embeds.BRAND}`;

async function userInfo(bot, userId) {
  const key = `user:${userId}`;
  const hit = bot.cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const user = await bot.discord.get(`/users/${userId}`).catch(() => ({ id: userId, username: `ID ${userId}` }));
  bot.cache.set(key, { at: Date.now(), value: user });
  return user;
}

// ---------- Ostrzeżenia użytkownika (status / usuwanie) ----------

const ESCALATION_NAMES = { alert: 'alert dla moderacji', timeout: 'timeout', kick: 'kick', ban: 'ban' };
function describeRule(rule) {
  const name = ESCALATION_NAMES[rule.action];
  if (rule.action === 'alert' || rule.action === 'kick') return name;
  return rule.amount > 0 ? `${name} na ${formatDuration(rule.amount, rule.unit)}` : `${name} permanentny`;
}

async function warnsView(bot, userId, page, { manage, note }) {
  const config = await bot.store.getConfig();
  const user = await userInfo(bot, userId);
  const summary = await bot.store.warnSummary(userId);
  const { escalation, warns: warnConfig, actions } = config;
  const scale = escalation.rules.at(-1)?.points ?? 10;
  const nextRule = escalation.enabled ? escalation.rules.find((r) => r.points > summary.points) : null;
  const view = paginate(summary.warns, page, 5);

  const lines = [];
  if (note) lines.push(note, '');
  lines.push(
    `👤 <@${userId}> • \`${userId}\``,
    `⚠️ **${summary.count}** aktywnych ostrzeżeń • 🔢 **${summary.points} pkt**`,
    `${embeds.severityBar(summary.points, scale)} \`${summary.points}/${scale}\``,
  );
  if (nextRule) lines.push(`🚨 Następny próg: **${nextRule.points} pkt** → ${describeRule(nextRule)}`);
  if (summary.nextExpiry) lines.push(`⏳ Najbliższe wygaśnięcie: ${discordTimestamp(summary.nextExpiry, 'R')}`);
  if (warnConfig.expiryDays > 0) lines.push(`-# Każde ostrzeżenie znika samo po ${warnConfig.expiryDays} dniach.`);
  if (manage && summary.count) lines.push('', '🗑️ **Wybierz z listy poniżej, które ostrzeżenia usunąć.**');

  const fields = view.slice.map((w) => ({
    name: `#${w.id} • ${w.points} pkt`,
    value: [
      `> ${clip(w.reason, 180)}`,
      `🛡️ <@${w.moderatorId}> • 🗓️ ${discordTimestamp(w.createdAt, 'd')}`,
      w.expiresAt ? `⏳ wygasa ${discordTimestamp(w.expiresAt, 'R')}` : '♾️ nie wygasa',
    ].join('\n'),
  }));
  if (!summary.count) fields.push({ name: '✨ Brak aktywnych ostrzeżeń', value: 'Ten użytkownik jest czysty.' });

  const kind = manage ? 'wd' : 'ws';
  const options = manage
    ? view.slice.map((w) => ({
        label: clip(`#${w.id} • ${w.points} pkt • ${w.reason}`, 100),
        description: clip(`od ${w.moderatorTag ?? 'moderatora'} • ${new Date(w.createdAt).toISOString().slice(0, 10)}`, 100),
        value: String(w.id),
        emoji: { name: '⚠️' },
      }))
    : [];

  return {
    embeds: [
      {
        color: embeds.colorInt(actions.warn.color),
        author: { name: `${user.username} • ${manage ? 'Usuwanie ostrzeżeń' : 'Ostrzeżenia'}`, icon_url: avatarUrl(user, 64) },
        description: lines.join('\n'),
        fields,
        footer: { text: footerText(view.page, view.pages, 'widoczne tylko dla moderacji') },
      },
    ],
    components: rows(
      selectRow(kind, userId, view.page, '🗑️ Wybierz ostrzeżenia do usunięcia…', options),
      pagerRow(kind, userId, view.page, view.pages),
    ),
  };
}

async function deleteWarns(bot, ix, userId, ids) {
  const config = await bot.store.getConfig();
  const removed = [];
  for (const id of ids) {
    const warn = await bot.store.removeWarn(Number(id));
    if (!warn) continue;
    removed.push(warn);
    if (warn.caseId) await bot.store.updateCase(warn.caseId, { note: `Ostrzeżenie usunięte przez ${ix.user.username}` });
  }
  if (!removed.length) return '⚠️ Te ostrzeżenia były już usunięte.';
  const left = await bot.store.warnSummary(userId);
  await sendModLog(bot, config, {
    embeds: [
      embeds.simpleEmbed(
        'success',
        `🗑️ Usunięto ostrzeżenia (${removed.length})`,
        [
          `**Użytkownik:** <@${userId}>`,
          `**Usunął:** <@${ix.user.id}>`,
          ...removed.map((w) => `• **#${w.id}** (${w.points} pkt) - ${clip(w.reason, 120)}`),
          `**Pozostało:** ${left.count} ostrzeżeń (${left.points} pkt)`,
        ].join('\n'),
      ),
    ],
  });
  return `✅ Usunięto: ${removed.map((w) => `**#${w.id}**`).join(', ')} (-${removed.reduce((s, w) => s + w.points, 0)} pkt)`;
}

// ---------- Historia kar użytkownika ----------

function caseLabel(entry) {
  return entry.type === 'ban' && entry.duration ? 'Tymczasowy ban' : embeds.ACTION_LABELS[entry.type] ?? entry.type;
}
const CASE_EMOJI = { ban: '⛔', unban: '✅', kick: '👢', timeout: '🔇', untimeout: '🔊', warn: '⚠️' };

function caseField(c, { withUser = false } = {}) {
  const duration = c.duration ? ` • ${formatDuration(c.duration.amount, c.duration.unit)}` : '';
  const lines = [`> ${clip(c.reason, 160)}`];
  lines.push(`${withUser ? `👤 <@${c.userId}> • ` : ''}🛡️ <@${c.moderatorId}>${c.auto ? ' 🤖' : ''} • 🗓️ ${discordTimestamp(c.createdAt, 'd')}`);
  if (c.note) lines.push(`-# 📝 ${clip(c.note, 120)}`);
  return { name: `${CASE_EMOJI[c.type] ?? '🗂️'} #${c.id} • ${caseLabel(c)}${duration}`, value: lines.join('\n') };
}

async function historyView(bot, userId, page) {
  const user = await userInfo(bot, userId);
  const counts = await bot.store.caseCounts(userId);
  const perPage = 6;
  const { total } = await bot.store.listCases({ userId, limit: 1 });
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const { items } = await bot.store.listCases({ userId, limit: perPage, offset: (current - 1) * perPage });
  const summary = Object.entries(CASE_EMOJI)
    .filter(([type]) => counts[type])
    .map(([type, emoji]) => `${emoji} ${counts[type]}`)
    .join('  ');
  return {
    embeds: [
      {
        color: embeds.COLORS.info,
        author: { name: `${user.username} • Historia kar`, icon_url: avatarUrl(user, 64) },
        description: `👤 <@${userId}> • \`${userId}\`\n${summary || 'Brak kar. Wzorowy użytkownik! ✨'}`,
        fields: items.map((c) => caseField(c)),
        footer: { text: footerText(current, pages, `${total} spraw`) },
      },
    ],
    components: rows(pagerRow('h', userId, current, pages)),
  };
}

// ---------- Wszystkie sprawy ----------

async function casesView(bot, type, page) {
  const perPage = 8;
  const filter = type && type !== 'all' ? type : undefined;
  const { total } = await bot.store.listCases({ type: filter, limit: 1 });
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const { items } = await bot.store.listCases({ type: filter, limit: perPage, offset: (current - 1) * perPage });
  return {
    embeds: [
      {
        color: embeds.COLORS.info,
        title: `🗂️ Sprawy moderacyjne${filter ? ` - ${embeds.ACTION_LABELS[filter]}` : ''}`,
        ...(items.length ? {} : { description: 'Brak spraw. Spokojnie jak na Hopkostkach.' }),
        fields: items.map((c) => caseField(c, { withUser: true })),
        footer: { text: footerText(current, pages, `${total} spraw`) },
      },
    ],
    components: rows(pagerRow('c', type || 'all', current, pages)),
  };
}

// ---------- Ranking ostrzeżeń ----------

async function rankingView(bot, page) {
  const ranking = await bot.store.warnRanking();
  const view = paginate(ranking, page, 10);
  const medals = ['🥇', '🥈', '🥉'];
  const description = view.slice.length
    ? view.slice
        .map((row, i) => {
          const place = (view.page - 1) * 10 + i + 1;
          const next = row.warns.map((w) => w.expiresAt).filter(Boolean).sort((a, b) => a - b)[0];
          return `${medals[place - 1] ?? `**${place}.**`} <@${row.userId}> - **${row.points} pkt** • ${row.count} ostrz.${
            next ? ` • ⏳ ${discordTimestamp(next, 'R')}` : ''
          }`;
        })
        .join('\n')
    : 'Nikt nie ma aktywnych ostrzeżeń. 🎉';
  return {
    embeds: [
      {
        color: embeds.COLORS.warning,
        title: '📊 Ranking ostrzeżeń',
        description,
        footer: { text: footerText(view.page, view.pages, 'widoczne tylko dla moderacji') },
      },
    ],
    components: rows(pagerRow('r', '-', view.page, view.pages)),
  };
}

// ---------- Lista banów (odbanowywanie z listy) ----------

async function bansView(bot, page, { note } = {}) {
  const { guild } = await getGuildContext(bot);
  const bans = await bot.discord.get(`/guilds/${guild.id}/bans`, { query: { limit: 1000 } });
  const temp = new Map((await bot.store.listTempBans()).map((b) => [b.userId, b]));
  const view = paginate(bans, page, 10);
  const lines = view.slice.map((b) => {
    const t = temp.get(b.user.id);
    const until = t ? `⏳ do ${discordTimestamp(t.expiresAt, 'R')}` : '♾️ permanentny';
    return `⛔ **${embeds.escapeMarkdown(b.user.username)}** \`${b.user.id}\` • ${until}\n> ${clip(b.reason ?? 'brak powodu', 90)}`;
  });
  return {
    embeds: [
      {
        color: embeds.COLORS.error,
        title: `⛔ Zbanowani użytkownicy (${bans.length})`,
        description: [note, lines.join('\n') || 'Nikt nie jest zbanowany. 🎉'].filter(Boolean).join('\n\n'),
        footer: { text: footerText(view.page, view.pages, 'wybierz z listy, żeby odbanować') },
      },
    ],
    components: rows(
      selectRow(
        'b',
        '-',
        view.page,
        '✅ Wybierz, kogo odbanować…',
        view.slice.map((b) => ({
          label: clip(b.user.username, 100),
          description: clip(b.reason ?? 'brak powodu', 100),
          value: b.user.id,
          emoji: { name: '✅' },
        })),
      ),
      pagerRow('b', '-', view.page, view.pages),
    ),
  };
}

async function unbanSelected(bot, ix, ids) {
  bot.cache.delete('bans');
  const done = [];
  const failed = [];
  for (const id of ids) {
    const target = await bot.discord.get(`/users/${id}`).catch(() => null);
    if (!target) continue;
    try {
      await unbanUser(bot, { target, moderator: ix.user, reason: 'Odbanowano z listy /unban', channelId: ix.channelId });
      done.push(target.username);
    } catch (error) {
      failed.push(`${target.username}: ${describeError(error)}`);
    }
  }
  return [done.length ? `✅ Odbanowano: **${done.join(', ')}**` : null, ...failed.map((f) => `❌ ${f}`)].filter(Boolean).join('\n');
}

// ---------- Notatki moderatorów ----------

async function notesView(bot, userId, page, { note } = {}) {
  const user = await userInfo(bot, userId);
  const notes = await bot.store.listNotes(userId);
  const view = paginate(notes, page, 5);
  return {
    embeds: [
      {
        color: 0x3498db,
        author: { name: `${user.username} • Notatki moderacji`, icon_url: avatarUrl(user, 64) },
        description: [note, `👤 <@${userId}> • \`${userId}\``].filter(Boolean).join('\n\n'),
        fields: view.slice.length
          ? view.slice.map((n) => ({
              name: `📌 #${n.id}`,
              value: `> ${clip(n.text, 300)}\n✍️ <@${n.authorId}> • 🗓️ ${discordTimestamp(n.createdAt, 'd')}`,
            }))
          : [{ name: 'Brak notatek', value: 'Dodaj pierwszą: `/notatka dodaj`.' }],
        footer: { text: footerText(view.page, view.pages, 'widoczne tylko dla moderacji') },
      },
    ],
    components: rows(
      selectRow(
        'n',
        userId,
        view.page,
        '🗑️ Wybierz notatki do usunięcia…',
        view.slice.map((n) => ({ label: clip(`#${n.id} • ${n.text}`, 100), value: String(n.id), emoji: { name: '📌' } })),
      ),
      pagerRow('n', userId, view.page, view.pages),
    ),
  };
}

async function deleteNotes(bot, ids) {
  const removed = [];
  for (const id of ids) {
    const n = await bot.store.removeNote(Number(id));
    if (n) removed.push(n.id);
  }
  return removed.length ? `✅ Usunięto notatki: ${removed.map((id) => `**#${id}**`).join(', ')}` : '⚠️ Te notatki były już usunięte.';
}

// ---------- Rejestr widoków ----------

// `command` wiąże widok z komendą, która go otwiera - panel ("Uprawnienia") nadpisuje dostęp per komenda,
// więc przyciski/listy tej komendy muszą sprawdzać dokładnie to samo nadpisanie.
export const VIEWS = {
  ws: { permission: P.MODERATE_MEMBERS, command: 'warn', render: (bot, arg, page, opts) => warnsView(bot, arg, page, { ...opts, manage: false }) },
  wd: {
    permission: P.MODERATE_MEMBERS,
    command: 'warn',
    render: (bot, arg, page, opts) => warnsView(bot, arg, page, { ...opts, manage: true }),
    onSelect: (bot, ix, arg, values) => deleteWarns(bot, ix, arg, values),
  },
  h: { permission: P.MODERATE_MEMBERS, command: 'historia', render: (bot, arg, page) => historyView(bot, arg, page) },
  c: { permission: P.MODERATE_MEMBERS, command: 'sprawy', render: (bot, arg, page) => casesView(bot, arg, page) },
  r: { permission: P.MODERATE_MEMBERS, command: 'warn', render: (bot, arg, page) => rankingView(bot, page) },
  b: {
    permission: P.BAN_MEMBERS,
    command: 'unban',
    render: (bot, arg, page, opts) => bansView(bot, page, opts),
    onSelect: (bot, ix, arg, values) => unbanSelected(bot, ix, values),
  },
  n: {
    permission: P.MODERATE_MEMBERS,
    command: 'notatka',
    render: (bot, arg, page, opts) => notesView(bot, arg, page, opts),
    onSelect: (bot, ix, arg, values) => deleteNotes(bot, values),
  },
};

export function renderView(bot, kind, arg, page = 1, opts = {}) {
  return VIEWS[kind].render(bot, arg, Number(page) || 1, opts);
}

export function parseCustomId(customId) {
  const [action, kind, arg, page] = String(customId).split('|');
  if (!['pg', 'sel'].includes(action) || !VIEWS[kind]) return null;
  return { action, kind, arg, page: Number(page) || 1 };
}
