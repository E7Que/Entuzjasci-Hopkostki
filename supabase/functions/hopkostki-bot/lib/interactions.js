// Obsługa interakcji z Discorda (HTTP Interactions). Discord wymaga odpowiedzi w 3 sekundy,
// więc komendy są od razu "odraczane" (type 5), a właściwa praca dzieje się w tle.

import { COMMAND_MAP } from './commands.js';
import { VIEWS, parseCustomId, renderView } from './views.js';
import { hasModAccess, describeError, ActionError, announceElsewhere } from './moderation.js';
import { errorEmbed } from './embeds.js';
import { isVoiceCustomId, handleVoiceInteraction } from './voice.js';
import { isRoleCustomId, handleRoleInteraction } from './messages.js';
import { isTicketCustomId, handleTicketInteraction } from './tickets.js';
import { isGiveawayCustomId, handleGiveawayInteraction } from './community.js';
import { isAppealCustomId, handleAppealInteraction } from './appeals.js';

const TYPE = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 };
const RESPONSE = { PONG: 1, MESSAGE: 4, DEFERRED: 5, DEFERRED_UPDATE: 6, AUTOCOMPLETE: 8 };
export const EPHEMERAL = 64;

function flattenOptions(options = []) {
  const values = new Map();
  let sub = null;
  let focused = null;
  const walk = (list) => {
    for (const option of list ?? []) {
      if (option.type === 1 || option.type === 2) {
        sub = option.type === 1 ? option.name : sub;
        walk(option.options);
      } else {
        values.set(option.name, option.value);
        if (option.focused) focused = option.value;
      }
    }
  };
  walk(options);
  return { values, sub, focused };
}

export function wrapInteraction(body, bot) {
  const data = body.data ?? {};
  const { values, sub, focused } = flattenOptions(data.options);
  const resolved = data.resolved ?? {};
  const hook = `/webhooks/${body.application_id}/${body.token}`;
  const member = body.member
    ? { id: body.member.user.id, roles: body.member.roles ?? [], permissions: body.member.permissions ?? '0' }
    : null;

  return {
    raw: body,
    guildId: body.guild_id,
    channelId: body.channel_id ?? body.channel?.id ?? null,
    name: data.name ?? data.custom_id,
    sub,
    isComponent: body.type === TYPE.COMPONENT,
    customId: data.custom_id ?? null,
    values: data.values ?? [],
    user: body.member?.user ?? body.user,
    member,
    ephemeral: false,
    opt: (name) => values.get(name),
    focused: () => focused,
    getUser(name) {
      const id = values.get(name);
      return id ? resolved.users?.[id] ?? null : null;
    },
    getMember(name) {
      const id = values.get(name);
      const found = id ? resolved.members?.[id] : null;
      return found ? { ...found, id } : null;
    },
    edit: (payload) => bot.discord.patch(`${hook}/messages/@original`, payload),
    delete: () => bot.discord.delete(`${hook}/messages/@original`),
    followUp: (payload) => bot.discord.post(hook, payload),
  };
}

export async function replyError(ix, message) {
  const payload = { content: '', embeds: [errorEmbed(message)] };
  try {
    if (ix.isComponent) return await ix.followUp({ ...payload, flags: EPHEMERAL });
    if (ix.ephemeral) return await ix.edit(payload);
    // Publiczna odpowiedź była odroczona — usuwamy ją, żeby błąd nie wisiał na kanale.
    await ix.delete().catch(() => {});
    return await ix.followUp({ ...payload, flags: EPHEMERAL });
  } catch (error) {
    console.warn(`[interakcja] Nie udało się odpowiedzieć błędem: ${error.message}`);
    return null;
  }
}

const ephemeralMessage = (text) => ({ type: RESPONSE.MESSAGE, data: { flags: EPHEMERAL, embeds: [errorEmbed(text)] } });

/**
 * Zwraca { response } — odpowiedź HTTP dla Discorda — oraz opcjonalnie task() do wykonania w tle.
 */
export async function handleInteraction(body, bot) {
  if (body.type === TYPE.PING) return { response: { type: RESPONSE.PONG } };
  // Odwołania od kar: przycisk i formularz w wiadomości prywatnej (bez serwera), decyzje — na serwerze.
  if ((body.type === TYPE.COMPONENT || body.type === TYPE.MODAL_SUBMIT) && isAppealCustomId(body.data?.custom_id)) {
    return handleAppealInteraction(body, bot);
  }
  if (!body.guild_id) return { response: ephemeralMessage('Komendy działają tylko na serwerze.') };
  if (bot.env.guildId && body.guild_id !== bot.env.guildId) {
    return { response: ephemeralMessage('Ten bot działa tylko na serwerze Entuzjaści Hopkostki.') };
  }

  if (body.type === TYPE.COMPONENT || body.type === TYPE.MODAL_SUBMIT) {
    const customId = body.data?.custom_id;
    // Panel kanału głosowego i wybór ról — własne przyciski, poza widokami ze stronami.
    if (isVoiceCustomId(customId)) return handleVoiceInteraction(wrapInteraction(body, bot), bot);
    if (isRoleCustomId(customId)) return handleRoleInteraction(wrapInteraction(body, bot), bot);
    if (isTicketCustomId(customId)) return handleTicketInteraction(wrapInteraction(body, bot), bot);
    if (isGiveawayCustomId(customId)) return handleGiveawayInteraction(wrapInteraction(body, bot), bot);
    if (body.type === TYPE.COMPONENT) return handleComponent(body, bot);
    return { response: ephemeralMessage('Ten formularz jest już nieaktualny.') };
  }

  const command = COMMAND_MAP.get(body.data?.name);
  if (!command) return { response: ephemeralMessage('Nieznana komenda — spróbuj ponownie za chwilę.') };

  const ix = wrapInteraction(body, bot);
  const config = await bot.store.getConfig();

  if (body.type === TYPE.AUTOCOMPLETE) {
    let choices = [];
    if (command.autocomplete && hasModAccess(ix.member, command.permission, config, command.data.name)) {
      choices = await command.autocomplete(ix, bot).catch(() => []);
    }
    return { response: { type: RESPONSE.AUTOCOMPLETE, data: { choices } } };
  }
  if (body.type !== TYPE.COMMAND) return { response: ephemeralMessage('Nieobsługiwany typ interakcji.') };

  if (!hasModAccess(ix.member, command.permission, config, command.data.name)) {
    return { response: ephemeralMessage('Nie masz uprawnień do tej komendy.') };
  }

  const mode = typeof command.defer === 'function' ? command.defer(ix) : command.defer;
  // 'action' = kara ogłaszana publicznie (chyba że jest osobny kanał ogłoszeń), 'public', 'ephemeral'.
  ix.ephemeral = mode === 'ephemeral' || (mode === 'action' && announceElsewhere(config, ix.channelId));

  const task = async () => {
    try {
      await command.execute(ix, bot);
    } catch (error) {
      if (!(error instanceof ActionError)) console.error(`[/${ix.name}]`, error);
      await replyError(ix, describeError(error));
    }
  };
  return { response: { type: RESPONSE.DEFERRED, data: ix.ephemeral ? { flags: EPHEMERAL } : {} }, task, ix };
}

// Przyciski stron (◀ 1 2 3 ▶) i listy wyboru. Odpowiadamy od razu "aktualizuję wiadomość" (type 6),
// a nową stronę wysyłamy w tle, edytując wiadomość z przyciskami.
async function handleComponent(body, bot) {
  const parsed = parseCustomId(body.data?.custom_id);
  if (!parsed) return { response: ephemeralMessage('Ten przycisk jest już nieaktualny.') };
  const ix = wrapInteraction(body, bot);
  const config = await bot.store.getConfig();
  const view = VIEWS[parsed.kind];
  if (!hasModAccess(ix.member, view.permission, config, view.command)) {
    return { response: ephemeralMessage('Nie masz uprawnień do tej listy.') };
  }

  const task = async () => {
    try {
      let note = null;
      if (parsed.action === 'sel' && VIEWS[parsed.kind].onSelect) {
        note = await VIEWS[parsed.kind].onSelect(bot, ix, parsed.arg, ix.values);
      }
      await ix.edit(await renderView(bot, parsed.kind, parsed.arg, parsed.page, { note }));
    } catch (error) {
      if (!(error instanceof ActionError)) console.error(`[komponent ${parsed.kind}]`, error);
      await replyError(ix, describeError(error));
    }
  };
  return { response: { type: RESPONSE.DEFERRED_UPDATE }, task, ix };
}
