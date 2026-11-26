// Wiadomości wysyłane z panelu (zakładka Wiadomości): treść, opcjonalny embed i opcjonalny wybór ról -
// przyciski „kliknij, żeby dodać/zdjąć rolę” albo lista wyboru (jak przy usuwaniu ostrzeżeń).
// Identyfikator roli siedzi w samym przycisku/opcji listy, więc obsługa kliknięcia nie potrzebuje bazy.

import { P, has, highestPosition } from './permissions.js';
import { ActionError, describeError, getGuildContext } from './moderation.js';
import { colorInt, errorEmbed, successEmbed } from './embeds.js';

const EPHEMERAL = 64;
const SNOWFLAKE = /^\d{15,25}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const BUTTON_STYLES = { niebieski: 1, szary: 2, zielony: 3, czerwony: 4 };
export const ROLE_MODES = ['none', 'buttons', 'select'];

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const CUSTOM_EMOJI = /^<(a?):(\w{2,32}):(\d{15,25})>$/;
const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\u20E3]*$/u;

// Emoji przy roli: własne emoji serwera (<:nazwa:id>, <a:nazwa:id>) albo zwykłe (🎮). Coś innego = brak.
export function cleanEmoji(value) {
  const raw = String(value ?? '').trim();
  if (CUSTOM_EMOJI.test(raw)) return raw;
  return raw.length <= 32 && UNICODE_EMOJI.test(raw) ? raw : '';
}

export function emojiObject(value) {
  const custom = CUSTOM_EMOJI.exec(String(value ?? ''));
  if (custom) return { id: custom[3], name: custom[2], animated: Boolean(custom[1]) };
  return value ? { name: value } : null;
}

// Dane z panelu -> uporządkowane dane (to zapisujemy w bazie, żeby dało się wczytać do edycji).
export function cleanMessageData(input = {}) {
  const embed = input.embed ?? {};
  const roles = input.roles ?? {};
  const mode = ROLE_MODES.includes(roles.mode) ? roles.mode : 'none';
  const seen = new Set();
  return {
    channelId: String(input.channelId ?? ''),
    content: text(input.content, 2000),
    embed: {
      enabled: embed.enabled === true,
      title: text(embed.title, 256),
      description: text(embed.description, 4000),
      color: HEX_COLOR.test(String(embed.color)) ? String(embed.color).toUpperCase() : '#5865F2',
      image: text(embed.image, 500),
      footer: text(embed.footer, 200),
    },
    roles: {
      mode,
      placeholder: text(roles.placeholder, 150),
      multiple: roles.multiple !== false,
      items: (Array.isArray(roles.items) ? roles.items : [])
        .slice(0, 25)
        .map((item) => ({
          roleId: String(item?.roleId ?? ''),
          label: text(item?.label, 80),
          description: text(item?.description, 100),
          style: Object.hasOwn(BUTTON_STYLES, item?.style) ? item.style : 'niebieski',
          emoji: cleanEmoji(item?.emoji),
        }))
        .filter((item) => SNOWFLAKE.test(item.roleId) && !seen.has(item.roleId) && seen.add(item.roleId)),
    },
  };
}

// Sprawdza, czy bot może rozdawać te role, i buduje wiadomość w formacie API Discorda.
export function buildMessagePayload(data, gctx) {
  const embed = data.embed;
  const hasEmbed = embed.enabled && (embed.title || embed.description || embed.image);
  if (!data.content && !hasEmbed) throw new ActionError('Wiadomość musi mieć treść albo embed (tytuł, opis lub obrazek).');
  if (embed.enabled && embed.image && !/^https:\/\/\S+$/i.test(embed.image)) throw new ActionError('Link do obrazka musi zaczynać się od https://');

  const payload = { content: data.content, embeds: [], components: [], allowed_mentions: { parse: [] } };
  if (hasEmbed) {
    payload.embeds.push({
      color: colorInt(embed.color),
      ...(embed.title ? { title: embed.title } : {}),
      ...(embed.description ? { description: embed.description } : {}),
      ...(embed.image ? { image: { url: embed.image } } : {}),
      ...(embed.footer ? { footer: { text: embed.footer } } : {}),
    });
  }

  const { mode, items } = data.roles;
  if (mode === 'none') return payload;
  if (!items.length) throw new ActionError('Dodaj przynajmniej jedną rolę do wyboru albo wyłącz wybór ról.');

  const botPosition = highestPosition(gctx.botMember.roles, gctx.roles);
  const roles = items.map((item) => {
    const role = gctx.roles.get(item.roleId);
    if (!role || role.id === gctx.guild.id) throw new ActionError('Jedna z wybranych ról już nie istnieje - wybierz ją ponownie.');
    if (role.managed) throw new ActionError(`Roli „${role.name}” zarządza integracja - nie da się jej rozdawać.`);
    if (has(role.permissions, P.ADMINISTRATOR)) throw new ActionError(`Rola „${role.name}” ma uprawnienia administratora - nie można jej rozdawać każdemu.`);
    if (role.position >= botPosition) throw new ActionError(`Rola „${role.name}” jest wyżej niż rola bota - przesuń rolę bota wyżej w ustawieniach serwera.`);
    const custom = CUSTOM_EMOJI.exec(item.emoji ?? '');
    if (custom && gctx.emojis && !gctx.emojis.some((e) => e.id === custom[3])) {
      throw new ActionError(`Emoji :${custom[2]}: nie jest z tego serwera - wybierz emoji serwera z listy albo zwykłe emoji.`);
    }
    return { ...item, name: role.name, emojiObj: emojiObject(item.emoji) };
  });

  if (mode === 'buttons') {
    for (let i = 0; i < roles.length; i += 5) {
      payload.components.push({
        type: 1,
        components: roles.slice(i, i + 5).map((r) => ({
          type: 2,
          style: BUTTON_STYLES[r.style],
          label: r.label || r.name,
          ...(r.emojiObj ? { emoji: r.emojiObj } : {}),
          custom_id: `rr|b|${r.roleId}`,
        })),
      });
    }
  } else {
    payload.components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: 'rr|s',
          placeholder: data.roles.placeholder || 'Wybierz role',
          min_values: 0,
          max_values: data.roles.multiple ? roles.length : 1,
          options: roles.map((r) => ({
            label: (r.label || r.name).slice(0, 100),
            value: r.roleId,
            ...(r.description ? { description: r.description } : {}),
            ...(r.emojiObj ? { emoji: r.emojiObj } : {}),
          })),
        },
      ],
    });
  }
  return payload;
}

export async function sendPanelMessage(bot, input) {
  const data = cleanMessageData(input);
  if (!SNOWFLAKE.test(data.channelId)) throw new ActionError('Wybierz kanał.');
  const payload = buildMessagePayload(data, await getGuildContext(bot, { force: true }));
  const message = await bot.discord.post(`/channels/${data.channelId}/messages`, payload);
  return bot.store.addSentMessage({ channelId: data.channelId, messageId: message.id, data });
}

export async function editPanelMessage(bot, id, input) {
  const saved = await bot.store.getSentMessage(id);
  if (!saved) throw new ActionError('Nie ma takiej wiadomości.');
  const data = { ...cleanMessageData(input), channelId: saved.channelId };
  const payload = buildMessagePayload(data, await getGuildContext(bot, { force: true }));
  await bot.discord.patch(`/channels/${saved.channelId}/messages/${saved.messageId}`, payload);
  return bot.store.updateSentMessage(id, data);
}

export async function deletePanelMessage(bot, id) {
  const saved = await bot.store.getSentMessage(id);
  if (!saved) return false;
  await bot.discord.delete(`/channels/${saved.channelId}/messages/${saved.messageId}`).catch(() => {});
  await bot.store.deleteSentMessage(id);
  return true;
}

// ---------- Kliknięcia w przyciski / wybór z listy ----------

export const isRoleCustomId = (customId) => /^rr\|/.test(String(customId ?? ''));

// Role, którymi zarządza lista wyboru = wszystkie jej opcje (bierzemy je z samej wiadomości).
function selectRoleIds(message, customId) {
  for (const row of message?.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.custom_id === customId) return (component.options ?? []).map((o) => o.value);
    }
  }
  return [];
}

export function handleRoleInteraction(ix, bot) {
  const [, kind, roleId] = String(ix.customId).split('|');
  const task = async () => {
    try {
      const memberRoles = new Set(ix.member?.roles ?? []);
      const path = (id) => `/guilds/${ix.guildId}/members/${ix.user.id}/roles/${id}`;
      const reason = 'Wybór roli z wiadomości';
      const added = [];
      const removed = [];
      if (kind === 'b') {
        if (memberRoles.has(roleId)) {
          await bot.discord.delete(path(roleId), { reason });
          removed.push(roleId);
        } else {
          await bot.discord.put(path(roleId), undefined, { reason });
          added.push(roleId);
        }
      } else {
        const managed = selectRoleIds(ix.raw.message, ix.customId);
        const wanted = new Set(ix.values.filter((id) => managed.includes(id)));
        for (const id of managed) {
          if (wanted.has(id) && !memberRoles.has(id)) {
            await bot.discord.put(path(id), undefined, { reason });
            added.push(id);
          } else if (!wanted.has(id) && memberRoles.has(id)) {
            await bot.discord.delete(path(id), { reason });
            removed.push(id);
          }
        }
      }
      const list = (ids) => ids.map((id) => `<@&${id}>`).join(', ');
      const lines = [added.length ? `Dodano: ${list(added)}` : null, removed.length ? `Zdjęto: ${list(removed)}` : null].filter(Boolean);
      await ix.edit({ embeds: [successEmbed(lines.join('\n') || 'Bez zmian - masz już dokładnie te role.')], allowed_mentions: { parse: [] } });
    } catch (error) {
      await ix.edit({ embeds: [errorEmbed(describeError(error))] }).catch(() => {});
    }
  };
  return { response: { type: 5, data: { flags: EPHEMERAL } }, task };
}
