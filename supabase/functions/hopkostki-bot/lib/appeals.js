// Odwołania od kar. Przycisk „Odwołaj się” pod wiadomością prywatną z karą (ban, wyrzucenie, timeout,
// ostrzeżenie) otwiera formularz; odwołanie trafia na kanał moderacji z przyciskami Przyjmij / Odrzuć (każdy
// z okienkiem na odpowiedź dla osoby). Przyjęcie cofa karę: zdejmuje bana albo timeout, usuwa ostrzeżenie.
// Jedno odwołanie na sprawę, najwyżej `appeals.days` dni po karze.

import { P } from './permissions.js';
import { ActionError, describeError, getGuildContext, hasModAccess, isOurGuild, sendDm, sendModLog, unbanUser, untimeoutUser } from './moderation.js';
import { COLORS, errorEmbed, successEmbed } from './embeds.js';
import { formatDuration } from './duration.js';

const EPHEMERAL = 64;
const DAY = 24 * 60 * 60_000;
export const APPEAL_ACTIONS = ['ban', 'kick', 'timeout', 'warn'];
const ACTION_NAMES = { ban: 'Ban', kick: 'Wyrzucenie', timeout: 'Wyciszenie (timeout)', warn: 'Ostrzeżenie' };
// Kto rozpatruje: lista ról komendy, która tę karę cofa (zakładka Uprawnienia) — przyjęcie odwołania od bana to
// /unban, od timeoutu /untimeout, od ostrzeżenia jego usunięcie (/warn usun). Wyrzucenia nie da się cofnąć, więc
// o odwołaniu od niego decydują ci, którzy mogą wyrzucać (/kick). Uprawnienie Discorda (pierwszy element)
// liczy się tylko wtedy, gdy komenda nie ma własnej listy ról.
const DECIDE = { ban: [P.BAN_MEMBERS, 'unban'], kick: [P.KICK_MEMBERS, 'kick'], timeout: [P.MODERATE_MEMBERS, 'untimeout'], warn: [P.MODERATE_MEMBERS, 'warn'] };

export const isAppealCustomId = (customId) => /^apl[md]?\|/.test(String(customId ?? ''));
export const appealChannel = (config) => config.appeals.channelId || config.modLogChannelId || '';
export const appealDeadline = (config, createdAt) => createdAt + config.appeals.days * DAY;

const reply = (embed) => ({ response: { type: 4, data: { flags: EPHEMERAL, embeds: [embed] } } });
const fail = (text) => reply(errorEmbed(text));

function modalValue(body, id) {
  for (const row of body.data?.components ?? []) {
    for (const input of row.components ?? []) if (input.custom_id === id) return String(input.value ?? '').trim();
  }
  return '';
}

// Czy od tej sprawy można się teraz odwołać (zwraca { entry } albo { error }).
async function appealableCase(bot, config, caseId, userId) {
  if (!config.appeals.enabled || !appealChannel(config)) return { error: 'Odwołania są teraz wyłączone. Skontaktuj się z administracją serwera.' };
  const entry = await bot.store.getCase(caseId);
  if (!entry || entry.userId !== userId) return { error: 'Nie znaleziono tej sprawy.' };
  if (!APPEAL_ACTIONS.includes(entry.type)) return { error: 'Od tej sprawy nie można się odwołać.' };
  if (Date.now() > appealDeadline(config, entry.createdAt)) return { error: `Czas na odwołanie minął (${config.appeals.days} dni od kary).` };
  const existing = await bot.store.getAppealByCase(caseId);
  if (existing) return { error: existing.status === 'pending' ? 'Twoje odwołanie od tej kary już czeka na decyzję moderacji.' : 'Od tej kary już się odwołano.' };
  return { entry };
}

function punishmentText(entry) {
  const duration = entry.duration?.amount ? ` na ${formatDuration(entry.duration.amount, entry.duration.unit)}` : '';
  return `${ACTION_NAMES[entry.type] ?? entry.type}${duration}`;
}

// Embed odwołania na kanale moderacji (z decyzją, gdy już zapadła).
export function appealEmbed(appeal, entry) {
  const decided = appeal.status !== 'pending';
  const fields = [
    { name: '👤 Osoba', value: `<@${entry.userId}>\n\`${entry.userTag ?? entry.userId}\``, inline: true },
    { name: '⚖️ Kara', value: `${punishmentText(entry)}\n<t:${Math.floor(entry.createdAt / 1000)}:R>`, inline: true },
    { name: '🛡️ Ukarał(a)', value: entry.auto ? '🤖 automatycznie' : entry.moderatorId ? `<@${entry.moderatorId}>` : '—', inline: true },
    { name: '📝 Powód kary', value: String(entry.reason ?? '—').slice(0, 1000) },
    { name: '💬 Odwołanie', value: appeal.text.slice(0, 1024) },
  ];
  if (decided) {
    const lines = [`Rozpatrzył(a): <@${appeal.decidedBy}>`];
    if (appeal.undoResult) lines.push(`Kara: ${appeal.undoResult}`);
    if (appeal.decisionNote) lines.push(`Odpowiedź: ${appeal.decisionNote}`);
    fields.push({ name: appeal.status === 'accepted' ? '✅ Przyjęte' : '❌ Odrzucone', value: lines.join('\n').slice(0, 1024) });
  }
  return {
    color: appeal.status === 'accepted' ? COLORS.success : appeal.status === 'rejected' ? COLORS.error : 0x5865f2,
    title: `📨 Odwołanie od kary #${entry.id}`,
    fields,
    footer: { text: `Odwołanie #${appeal.id} • ID osoby: ${entry.userId}` },
    timestamp: new Date(appeal.decidedAt ?? appeal.createdAt).toISOString(),
  };
}

const decisionButtons = (appeal) => [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Przyjmij', emoji: { name: '✅' }, custom_id: `apl|ok|${appeal.id}` },
      { type: 2, style: 4, label: 'Odrzuć', emoji: { name: '✖️' }, custom_id: `apl|no|${appeal.id}` },
    ],
  },
];

// Wyłączony przycisk pod DM z karą po wysłaniu odwołania.
const sentButton = [{ type: 1, components: [{ type: 2, style: 2, label: 'Odwołanie wysłane', emoji: { name: '📨' }, custom_id: 'apl|sent|0', disabled: true }] }];

async function submitAppeal(bot, config, entry, user, text, body) {
  const appeal = await bot.store.addAppeal({ caseId: entry.id, userId: user.id, userTag: user.username ?? null, text });
  if (!appeal) throw new ActionError('Odwołanie od tej kary już zostało wysłane.');
  const channelId = appealChannel(config);
  const ping = config.appeals.pingRoleId;
  try {
    const message = await bot.discord.post(`/channels/${channelId}/messages`, {
      ...(ping ? { content: `<@&${ping}>` } : {}),
      embeds: [appealEmbed(appeal, entry)],
      components: decisionButtons(appeal),
      allowed_mentions: { parse: [], roles: ping ? [ping] : [] },
    });
    await bot.store.setAppealMessage(appeal.id, { channelId, messageId: message.id });
  } catch (error) {
    // Moderacja nie zobaczy odwołania — cofamy je, żeby osoba mogła spróbować później.
    await bot.store.deleteAppeal(appeal.id);
    throw new ActionError(`Nie udało się przekazać odwołania moderacji (${describeError(error)}). Spróbuj później.`);
  }
  if (body.message?.id && body.channel_id) {
    await bot.discord.patch(`/channels/${body.channel_id}/messages/${body.message.id}`, { components: sentButton }).catch(() => {});
  }
  return appeal;
}

// Cofnięcie kary po przyjęciu odwołania — zwraca opis, co się stało (do embedów i DM).
async function undoPunishment(bot, entry, moderator) {
  const target = { id: entry.userId, username: entry.userTag ?? entry.userId };
  const reason = `Przyjęte odwołanie od kary #${entry.id}`;
  try {
    switch (entry.type) {
      case 'ban':
        await unbanUser(bot, { target, moderator, reason, announce: false });
        return 'ban zdjęty';
      case 'timeout':
        await untimeoutUser(bot, { target, moderator, reason, announce: false });
        return 'timeout zdjęty';
      case 'warn': {
        const removed = await bot.store.removeWarnsByCase(entry.id);
        return removed ? 'ostrzeżenie usunięte' : 'ostrzeżenie już wygasło albo zostało usunięte';
      }
      default:
        return 'wyrzucenia nie da się cofnąć — osoba może wrócić na serwer';
    }
  } catch (error) {
    return `nie udało się cofnąć automatycznie (${describeError(error)})`;
  }
}

function decisionDm(entry, appeal, guildName) {
  const accepted = appeal.status === 'accepted';
  const lines = [
    accepted
      ? `Twoje odwołanie od kary **#${entry.id}** (${punishmentText(entry).toLowerCase()}) zostało **przyjęte**.`
      : `Twoje odwołanie od kary **#${entry.id}** (${punishmentText(entry).toLowerCase()}) zostało **odrzucone** — kara zostaje.`,
  ];
  if (accepted && appeal.undoResult) lines.push(`Kara: ${appeal.undoResult}.`);
  if (appeal.decisionNote) lines.push(`\n**Odpowiedź moderacji:**\n${appeal.decisionNote}`);
  return {
    color: accepted ? COLORS.success : COLORS.error,
    title: accepted ? '✅ Odwołanie przyjęte' : '❌ Odwołanie odrzucone',
    description: lines.join('\n'),
    footer: { text: guildName ?? 'Entuzjaści Hopkostki' },
    timestamp: new Date().toISOString(),
  };
}

export async function decideAppeal(bot, config, { appeal, entry, moderator, accept, note = '' }) {
  // Najpierw zapis decyzji (tylko z „oczekuje”) — dwa kliknięcia naraz nie cofną kary dwa razy.
  let decided = await bot.store.decideAppeal(appeal.id, { status: accept ? 'accepted' : 'rejected', decidedBy: moderator.id, decidedTag: moderator.username ?? null, note: note || null });
  if (!decided) throw new ActionError('To odwołanie zostało już rozpatrzone.');
  if (accept) {
    const undo = await undoPunishment(bot, entry, moderator);
    decided = (await bot.store.setAppealUndo(appeal.id, undo)) ?? { ...decided, undoResult: undo };
    await bot.store.updateCase(entry.id, { note: `Cofnięte po odwołaniu (${moderator.username ?? moderator.id})` });
  }
  if (decided.channelId && decided.messageId) {
    await bot.discord.patch(`/channels/${decided.channelId}/messages/${decided.messageId}`, { embeds: [appealEmbed(decided, entry)], components: [] }).catch(() => {});
  }
  let dmStatus = '✅ dostarczono';
  await sendDm(bot, entry.userId, { embeds: [decisionDm(entry, decided, null)] }).catch(() => {
    dmStatus = '❌ nie udało się (zamknięte DM)';
  });
  if (decided.channelId !== config.modLogChannelId) {
    await sendModLog(bot, config, {
      embeds: [
        {
          color: accept ? COLORS.success : COLORS.error,
          title: `📨 Odwołanie od kary #${entry.id} ${accept ? 'przyjęte' : 'odrzucone'}`,
          description: [
            `**Osoba:** <@${entry.userId}> \`${entry.userTag ?? entry.userId}\``,
            `**Rozpatrzył(a):** <@${moderator.id}>`,
            decided.undoResult ? `**Kara:** ${decided.undoResult}` : null,
            note ? `**Odpowiedź:** ${note}` : null,
            `**DM:** ${dmStatus}`,
          ].filter(Boolean).join('\n'),
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
  return accept ? `Odwołanie przyjęte — ${decided.undoResult}. Osoba dostała odpowiedź (${dmStatus}).` : `Odwołanie odrzucone. Osoba dostała odpowiedź (${dmStatus}).`;
}

// Właściciel serwera rozpatruje zawsze (jak przy komendach). Sprawdzamy go po ID, bo ten handler sam składa dane
// członka z interakcji (trafia tu przed wrapInteraction), a uprawnienia właściciela wyglądają jak administratora.
async function canDecide(bot, member, entry, config) {
  const [permission, command] = DECIDE[entry.type] ?? [P.MODERATE_MEMBERS, 'warn'];
  if (await hasModAccess(member, permission, config, command)) return true;
  const ownerId = await getGuildContext(bot).then((gctx) => gctx.guild.ownerId, () => null);
  return Boolean(ownerId) && member.id === ownerId;
}

/**
 * Przyciski i formularze odwołań. Działa też w wiadomościach prywatnych (bez serwera w interakcji),
 * dlatego interactions.js kieruje tu przed sprawdzeniem serwera. Zwraca { response, task? }.
 */
export async function handleAppealInteraction(body, bot) {
  const [kind, action, arg] = String(body.data?.custom_id ?? '').split('|');
  const user = body.member?.user ?? body.user;
  const id = Math.floor(Number(arg));
  if (!user?.id || !(id > 0)) return fail('Ten przycisk jest już nieaktualny.');
  const config = await bot.store.getConfig();
  const hook = `/webhooks/${body.application_id}/${body.token}`;
  const edit = (payload) => bot.discord.patch(`${hook}/messages/@original`, payload);
  const deferred = (work) => ({
    response: { type: 5, data: { flags: EPHEMERAL } },
    task: async () => {
      try {
        await edit({ embeds: [successEmbed(await work())] });
      } catch (error) {
        if (!(error instanceof ActionError)) console.error('[odwołania]', error);
        await edit({ embeds: [errorEmbed(describeError(error))] }).catch(() => {});
      }
    },
  });

  // Ukarana osoba: przycisk pod DM → formularz; wysłany formularz → odwołanie na kanał moderacji.
  if ((kind === 'apl' && action === 'open') || (kind === 'aplm' && action === 'send')) {
    const { entry, error } = await appealableCase(bot, config, id, user.id);
    if (error) return fail(error);
    if (kind === 'apl') {
      return {
        response: {
          type: 9,
          data: {
            custom_id: `aplm|send|${entry.id}`,
            title: `Odwołanie od kary #${entry.id}`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'text',
                    style: 2,
                    label: 'Dlaczego kara powinna zostać cofnięta?',
                    placeholder: 'Opisz spokojnie, co się stało i dlaczego uważasz, że kara jest niesłuszna.',
                    min_length: 20,
                    max_length: 1500,
                    required: true,
                  },
                ],
              },
            ],
          },
        },
      };
    }
    const text = modalValue(body, 'text');
    if (text.length < 20) return fail('Napisz co najmniej 20 znaków.');
    return deferred(async () => {
      await submitAppeal(bot, config, entry, user, text.slice(0, 1500), body);
      return 'Wysłano odwołanie do moderacji. Odpowiedź dostaniesz w wiadomości prywatnej.';
    });
  }

  // Moderacja: Przyjmij / Odrzuć → okienko z odpowiedzią dla osoby → decyzja.
  if ((kind === 'apl' || kind === 'apld') && (action === 'ok' || action === 'no')) {
    if (!body.guild_id || !(await isOurGuild(bot, body.guild_id))) return fail('Ten przycisk działa tylko na serwerze.');
    const appeal = await bot.store.getAppeal(id);
    if (!appeal) return fail('Nie znaleziono tego odwołania.');
    if (appeal.status !== 'pending') return fail('To odwołanie zostało już rozpatrzone.');
    const entry = await bot.store.getCase(appeal.caseId);
    if (!entry) return fail('Sprawa tego odwołania została usunięta.');
    const member = { id: user.id, roles: body.member?.roles ?? [], permissions: body.member?.permissions ?? '0' };
    if (entry.userId === user.id) return fail('Nie możesz rozpatrzyć własnego odwołania.');
    if (!(await canDecide(bot, member, entry, config))) return fail('Nie masz uprawnień do rozpatrzenia tego odwołania.');
    const accept = action === 'ok';
    if (kind === 'apl') {
      return {
        response: {
          type: 9,
          data: {
            custom_id: `apld|${action}|${appeal.id}`,
            title: accept ? `Przyjęcie odwołania #${entry.id}` : `Odrzucenie odwołania #${entry.id}`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: 'note',
                    style: 2,
                    label: 'Odpowiedź dla osoby (opcjonalnie)',
                    placeholder: accept ? 'Np. kara cofnięta, prosimy o przestrzeganie regulaminu.' : 'Np. dlaczego kara zostaje.',
                    max_length: 500,
                    required: false,
                  },
                ],
              },
            ],
          },
        },
      };
    }
    const note = modalValue(body, 'note').slice(0, 500);
    return deferred(() => decideAppeal(bot, config, { appeal, entry, moderator: { id: user.id, username: user.username }, accept, note }));
  }
  return fail('Ten przycisk jest już nieaktualny.');
}
