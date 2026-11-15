// Kanały głosowe na żądanie: wejście na „kanał do dołączenia” tworzy osobny kanał tej osoby, przenosi ją tam,
// a na czacie kanału pojawia się panel (przyciski + listy wyboru) do zarządzania nim. Pusty kanał znika sam.
// Zdarzenia głosowe przychodzą z gatewaya (gateway.js); przyciski i okna z formularzem — przez interakcje.

import { P, has } from './permissions.js';
import { DiscordError } from './rest.js';
import { isOurGuild, describeError, ActionError } from './moderation.js';
import { colorInt, errorEmbed, successEmbed, COLORS } from './embeds.js';
import { logVoiceChange } from './logs.js';

const EPHEMERAL = 64;
const VOICE_CHANNEL = 2;
const RESPONSE = { MESSAGE: 4, DEFERRED: 5, DEFERRED_UPDATE: 6, MODAL: 9 };
const OWNER_ALLOW = P.VIEW_CHANNEL | P.CONNECT | P.SPEAK;
const MEMBER_ALLOW = P.VIEW_CHANNEL | P.CONNECT;
const BOT_ALLOW = P.VIEW_CHANNEL | P.CONNECT;
const EMPTY_GRACE_MS = 60_000;

const isGone = (error) => error instanceof DiscordError && (error.status === 404 || error.code === 10003);

export function fillChannelName(template, vars) {
  const name = String(template || 'Kanał {nick}')
    .replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
    .trim()
    .slice(0, 100);
  return name || 'Kanał';
}

// ---------- Uprawnienia na kanale ----------

async function putOverwrite(bot, channelId, targetId, type, allow, deny) {
  if (!allow && !deny) {
    await bot.discord.delete(`/channels/${channelId}/permissions/${targetId}`).catch((error) => {
      if (!isGone(error)) throw error;
    });
    return;
  }
  await bot.discord.put(`/channels/${channelId}/permissions/${targetId}`, { type, allow: String(allow), deny: String(deny) });
}

// Nadpisanie jednej osoby wynika z jej roli na kanale: właściciel / zbanowany / z dostępem / nikt.
function memberOverwrite(temp, userId) {
  if (userId === temp.ownerId) return [OWNER_ALLOW, 0n];
  if (temp.banned.includes(userId)) return [0n, P.CONNECT];
  if (temp.allowed.includes(userId)) return [MEMBER_ALLOW, 0n];
  return [0n, 0n];
}

const syncMember = (bot, temp, userId) => putOverwrite(bot, temp.channelId, userId, 1, ...memberOverwrite(temp, userId));

// Prywatny kanał: @everyone nie może dołączyć. Zachowujemy resztę nadpisania odziedziczonego z kategorii.
async function syncPrivacy(bot, temp) {
  const channel = await bot.discord.get(`/channels/${temp.channelId}`);
  const current = channel.permission_overwrites?.find((o) => o.id === temp.guildId) ?? { allow: '0', deny: '0' };
  let allow = BigInt(current.allow);
  let deny = BigInt(current.deny);
  if (temp.private) {
    deny |= P.CONNECT;
    allow &= ~P.CONNECT;
  } else {
    deny &= ~P.CONNECT;
  }
  // Bot też musi móc wejść na prywatny kanał, żeby przenosić na niego ludzi.
  const botId = await botUserId(bot);
  if (botId) await putOverwrite(bot, temp.channelId, botId, 1, BOT_ALLOW, 0n);
  await putOverwrite(bot, temp.channelId, temp.guildId, 0, allow, deny);
}

async function botUserId(bot) {
  const app = bot.cache.get('app')?.value ?? (await bot.discord.get('/applications/@me').catch(() => null));
  return app?.bot?.id ?? app?.id ?? null;
}

const moveMember = (bot, guildId, userId, channelId) =>
  bot.discord.patch(`/guilds/${guildId}/members/${userId}`, { channel_id: channelId }, { reason: 'Kanał głosowy na żądanie' });

// ---------- Zdarzenia z gatewaya ----------

// Wyciszony/ogłuszony (sam albo przez serwer), bot i role — do XP za kanały głosowe.
function voiceFlags(state, member = state.member) {
  return {
    muted: Boolean(state.self_mute || state.mute),
    deafened: Boolean(state.self_deaf || state.deaf),
    bot: Boolean(member?.user?.bot),
    roles: member?.roles ?? [],
  };
}

export async function syncGuildVoiceStates(bot, guild) {
  if (!(await isOurGuild(bot, guild?.id))) return;
  // GUILD_CREATE dosyła członków z kanałów głosowych — z nich role i to, czy to bot (do XP za głosowe).
  const members = new Map((guild.members ?? []).map((m) => [m.user?.id, m]));
  const states = (guild.voice_states ?? [])
    .filter((s) => s.channel_id)
    .map((s) => ({ userId: s.user_id, channelId: s.channel_id, ...voiceFlags(s, members.get(s.user_id)) }));
  await bot.store.replaceVoiceStates(states);
}

export async function onVoiceStateUpdate(bot, state) {
  if (!(await isOurGuild(bot, state?.guild_id))) return;
  const userId = state.user_id;
  const channelId = state.channel_id ?? null;
  const previous = await bot.store.getVoiceChannel(userId);
  await bot.store.setVoiceState(userId, channelId, voiceFlags(state));
  await logVoiceChange(bot, state, previous).catch((error) => console.warn(`[logi:głosowe] ${error.message}`));
  if (previous && previous !== channelId) await deleteIfEmpty(bot, previous);
  if (!channelId || previous === channelId || state.member?.user?.bot) return;

  const { tempVoice } = await bot.store.getConfig();
  if (!tempVoice.enabled) return;
  const generator = tempVoice.generators.find((g) => g.hubId === channelId);
  if (generator) await openTempChannel(bot, tempVoice, generator, state);
}

export async function deleteIfEmpty(bot, channelId, { minAgeMs = 0 } = {}) {
  const temp = await bot.store.getTempVoice(channelId);
  if (!temp || Date.now() - temp.createdAt < minAgeMs) return false;
  if ((await bot.store.voiceMembers(channelId)).length) return false;
  await bot.discord.delete(`/channels/${channelId}`, { reason: 'Pusty kanał tymczasowy' }).catch((error) => {
    if (!isGone(error)) throw error;
  });
  await bot.store.deleteTempVoice(channelId);
  return true;
}

async function hubParent(bot, hubId) {
  const key = `hubParent:${hubId}`;
  const hit = bot.cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const hub = await bot.discord.get(`/channels/${hubId}`).catch(() => null);
  bot.cache.set(key, { at: Date.now(), value: hub?.parent_id ?? null });
  return hub?.parent_id ?? null;
}

async function openTempChannel(bot, tempVoice, generator, state) {
  const guildId = state.guild_id;
  const userId = state.user_id;

  const existing = await bot.store.getTempVoiceByOwner(userId);
  if (existing) {
    try {
      await moveMember(bot, guildId, userId, existing.channelId);
      return existing;
    } catch (error) {
      if (!isGone(error)) throw error;
      await bot.store.deleteTempVoice(existing.channelId);
    }
  }

  const member = state.member ?? {};
  const nick = member.nick ?? member.user?.global_name ?? member.user?.username ?? 'kanał';
  const name = fillChannelName(generator.name, { nick, numer: (await bot.store.listTempVoice()).length + 1 });
  const parent = generator.categoryId || (await hubParent(bot, generator.hubId));
  const channel = await bot.discord.post(
    `/guilds/${guildId}/channels`,
    { name, type: VOICE_CHANNEL, user_limit: generator.limit, ...(parent ? { parent_id: parent } : {}) },
    { reason: `Kanał na żądanie dla ${nick}` },
  );

  let temp;
  try {
    temp = await bot.store.addTempVoice({
      channelId: channel.id,
      guildId,
      ownerId: userId,
      hubId: generator.hubId,
      name,
      limit: generator.limit,
      private: generator.private,
    });
  } catch (error) {
    await bot.discord.delete(`/channels/${channel.id}`).catch(() => {});
    throw error;
  }

  try {
    await moveMember(bot, guildId, userId, channel.id);
  } catch (error) {
    // Zdążył wyjść z kanału do dołączenia — sprzątamy od razu.
    console.warn(`[voice] Nie udało się przenieść ${userId}: ${error.message}`);
    await bot.discord.delete(`/channels/${channel.id}`).catch(() => {});
    await bot.store.deleteTempVoice(channel.id);
    return null;
  }

  await syncMember(bot, temp, userId).catch((error) => console.warn(`[voice] Uprawnienia właściciela: ${error.message}`));
  if (temp.private) await syncPrivacy(bot, temp).catch((error) => console.warn(`[voice] Prywatność: ${error.message}`));

  if (tempVoice.dashboard.enabled) {
    const message = await bot.discord
      .post(`/channels/${channel.id}/messages`, dashboardMessage(temp, tempVoice.dashboard))
      .catch((error) => console.warn(`[voice] Panel kanału: ${error.message}`));
    if (message) temp = await bot.store.updateTempVoice(channel.id, { dashboardMessageId: message.id });
  }
  return temp;
}

// Zapas dla crona: usuwa puste kanały, gdyby gateway coś przegapił. Tylko gdy gateway działa (inaczej lista
// osób na kanałach mogłaby być nieaktualna i bot skasowałby kanał, na którym ktoś siedzi).
export async function cleanupTempVoice(bot) {
  const gateway = await bot.store.getState('gateway_status');
  const fresh = gateway?.startedAt && !gateway.error && Date.now() - (gateway.endedAt ?? gateway.startedAt) < 3 * 60_000;
  if (!fresh) return 0;
  let removed = 0;
  for (const temp of await bot.store.listTempVoice()) {
    if (await deleteIfEmpty(bot, temp.channelId, { minAgeMs: EMPTY_GRACE_MS }).catch(() => false)) removed += 1;
  }
  return removed;
}

// ---------- Panel na czacie kanału ----------

const button = (label, action, channelId, style = 2) => ({ type: 2, style, label, custom_id: `tv|${action}|${channelId}` });
const mentions = (ids) => (ids.length ? ids.map((id) => `<@${id}>`).join(' ') : 'brak');

export function dashboardMessage(temp, dashboard) {
  const id = temp.channelId;
  return {
    embeds: [
      {
        color: colorInt(dashboard.color, COLORS.success),
        title: dashboard.title || 'Panel kanału',
        ...(dashboard.description ? { description: dashboard.description } : {}),
        fields: [
          { name: 'Status', value: temp.private ? 'Prywatny' : 'Publiczny', inline: true },
          { name: 'Właściciel', value: `<@${temp.ownerId}>`, inline: true },
          { name: 'Limit osób', value: temp.limit ? String(temp.limit) : 'bez limitu', inline: true },
          { name: 'Osoby z dostępem', value: mentions(temp.allowed) },
          { name: 'Zbanowani', value: mentions(temp.banned) },
        ],
      },
    ],
    components: [
      { type: 1, components: [button(temp.private ? 'Ustaw jako publiczny' : 'Ustaw jako prywatny', 'privacy', id), button('Dodaj osoby', 'members', id)] },
      { type: 1, components: [button('Zmień nazwę', 'name', id), button('Zmień właściciela', 'owner', id), button('Zmień limit', 'limit', id)] },
      { type: 1, components: [button('Zbanuj', 'ban', id, 4), button('Wyrzuć', 'kick', id, 4)] },
    ],
    allowed_mentions: { parse: [] },
  };
}

async function refreshDashboard(bot, temp) {
  if (!temp.dashboardMessageId) return;
  const { tempVoice } = await bot.store.getConfig();
  await bot.discord
    .patch(`/channels/${temp.channelId}/messages/${temp.dashboardMessageId}`, dashboardMessage(temp, tempVoice.dashboard))
    .catch((error) => console.warn(`[voice] Odświeżenie panelu: ${error.message}`));
}

// ---------- Interakcje (przyciski, listy, okna) ----------

export const isVoiceCustomId = (customId) => /^tv[sm]?\|/.test(String(customId ?? ''));

const ephemeral = (content, components) => ({ type: RESPONSE.MESSAGE, data: { flags: EPHEMERAL, content, components: components ?? [] } });
const failure = (text) => ({ response: { type: RESPONSE.MESSAGE, data: { flags: EPHEMERAL, embeds: [errorEmbed(text)] } } });

function userSelect(action, channelId, placeholder, { min = 0, max = 10, selected = [] } = {}) {
  return [
    {
      type: 1,
      components: [
        {
          type: 5,
          custom_id: `tvs|${action}|${channelId}`,
          placeholder,
          min_values: min,
          max_values: max,
          default_values: selected.slice(0, max).map((id) => ({ id, type: 'user' })),
        },
      ],
    },
  ];
}

function textModal(action, channelId, title, label, { value = '', min = 1, max = 100, placeholder = '' } = {}) {
  return {
    type: RESPONSE.MODAL,
    data: {
      custom_id: `tvm|${action}|${channelId}`,
      title,
      components: [
        {
          type: 1,
          components: [
            { type: 4, custom_id: 'value', style: 1, label, min_length: min, max_length: max, required: true, value: String(value ?? ''), placeholder },
          ],
        },
      ],
    },
  };
}

function modalValue(ix) {
  for (const row of ix.raw.data?.components ?? []) {
    for (const input of row.components ?? []) if (input.custom_id === 'value') return String(input.value ?? '').trim();
  }
  return '';
}

async function userLabel(bot, userId) {
  const key = `user:${userId}`;
  const hit = bot.cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value.global_name ?? hit.value.username;
  const user = await bot.discord.get(`/users/${userId}`).catch(() => null);
  if (user) bot.cache.set(key, { at: Date.now(), value: user });
  return user?.global_name ?? user?.username ?? `ID ${userId}`;
}

export async function handleVoiceInteraction(ix, bot) {
  const [kind, action, channelId] = String(ix.customId).split('|');
  const temp = await bot.store.getTempVoice(channelId);
  if (!temp) return failure('Ten kanał już nie istnieje.');
  const isOwner = ix.user.id === temp.ownerId;
  if (!isOwner && !has(ix.member?.permissions, P.MANAGE_CHANNELS)) return failure('Tylko właściciel kanału może nim zarządzać.');

  // Każda zmiana: najpierw odpowiedź dla Discorda (limit 3 s), potem właściwa praca w tle.
  const work = (deferType, fn) => ({
    response: { type: deferType, ...(deferType === RESPONSE.DEFERRED ? { data: { flags: EPHEMERAL } } : {}) },
    task: async () => {
      try {
        const text = await fn();
        await ix.edit({ content: '', embeds: [successEmbed(text)], components: [] });
      } catch (error) {
        const message = error instanceof DiscordError && error.status === 429
          ? 'Discord pozwala zmieniać nazwę kanału tylko 2 razy na 10 minut — spróbuj za chwilę.'
          : describeError(error);
        await ix.edit({ content: '', embeds: [errorEmbed(message)], components: [] }).catch(() => {});
      }
    },
  });

  if (kind === 'tv') {
    switch (action) {
      case 'privacy':
        return work(RESPONSE.DEFERRED, async () => {
          const next = await bot.store.updateTempVoice(channelId, { private: !temp.private });
          await syncPrivacy(bot, next);
          await refreshDashboard(bot, next);
          return next.private ? 'Kanał jest teraz prywatny — dołączą tylko osoby z dostępem.' : 'Kanał jest teraz publiczny.';
        });
      case 'members':
        return { response: ephemeral('Wybierz osoby, które mogą dołączyć (także gdy kanał jest prywatny). Odznacz, żeby odebrać dostęp.', userSelect('members', channelId, 'Wybierz osoby', { max: 25, selected: temp.allowed })) };
      case 'owner':
        return { response: ephemeral('Komu przekazać kanał?', userSelect('owner', channelId, 'Wybierz nowego właściciela', { min: 1, max: 1 })) };
      case 'ban':
        return { response: ephemeral('Zbanowane osoby nie mogą dołączyć do kanału. Odznacz, żeby odbanować.', userSelect('ban', channelId, 'Wybierz osoby do zbanowania', { max: 25, selected: temp.banned })) };
      case 'name':
        return { response: textModal('name', channelId, 'Zmień nazwę kanału', 'Nowa nazwa', { value: ix.raw.channel?.name ?? temp.name ?? '', max: 100 }) };
      case 'limit':
        return { response: textModal('limit', channelId, 'Zmień limit osób', 'Limit (0 = bez limitu, maks. 99)', { value: String(temp.limit ?? 0), max: 2 }) };
      case 'kick':
        return {
          response: { type: RESPONSE.DEFERRED, data: { flags: EPHEMERAL } },
          task: async () => {
            const present = (await bot.store.voiceMembers(channelId)).filter((id) => id !== temp.ownerId);
            if (!present.length) return ix.edit({ content: 'Na kanale nie ma nikogo poza Tobą.', components: [] });
            const options = await Promise.all(present.slice(0, 25).map(async (id) => ({ label: (await userLabel(bot, id)).slice(0, 100), value: id })));
            return ix.edit({
              content: 'Kogo wyrzucić z kanału? (może wrócić, chyba że go zbanujesz)',
              components: [{ type: 1, components: [{ type: 3, custom_id: `tvs|kick|${channelId}`, placeholder: 'Wybierz osoby', min_values: 1, max_values: options.length, options }] }],
            });
          },
        };
      default:
        return failure('Nieznana akcja.');
    }
  }

  if (kind === 'tvs') {
    const botId = await botUserId(bot);
    const picked = [...new Set(ix.values)].filter((id) => id !== botId);
    switch (action) {
      case 'members':
        return work(RESPONSE.DEFERRED_UPDATE, async () => {
          const allowed = picked.filter((id) => id !== temp.ownerId && !temp.banned.includes(id));
          const next = await bot.store.updateTempVoice(channelId, { allowed });
          for (const id of new Set([...temp.allowed, ...allowed])) await syncMember(bot, next, id);
          await refreshDashboard(bot, next);
          return allowed.length ? `Dostęp mają teraz: ${mentions(allowed)}.` : 'Nikt poza właścicielem nie ma już specjalnego dostępu.';
        });
      case 'ban':
        return work(RESPONSE.DEFERRED_UPDATE, async () => {
          const banned = picked.filter((id) => id !== temp.ownerId);
          const next = await bot.store.updateTempVoice(channelId, { banned, allowed: temp.allowed.filter((id) => !banned.includes(id)) });
          for (const id of new Set([...temp.banned, ...banned])) await syncMember(bot, next, id);
          const present = new Set(await bot.store.voiceMembers(channelId));
          for (const id of banned) if (present.has(id)) await moveMember(bot, temp.guildId, id, null).catch(() => {});
          await refreshDashboard(bot, next);
          return banned.length ? `Zbanowani: ${mentions(banned)}.` : 'Nikt nie jest już zbanowany.';
        });
      case 'owner':
        return work(RESPONSE.DEFERRED_UPDATE, async () => {
          const newOwner = picked[0];
          if (!newOwner || newOwner === temp.ownerId) return 'Właściciel bez zmian.';
          if (await bot.store.getTempVoiceByOwner(newOwner)) throw new ActionError('Ta osoba ma już własny kanał.');
          const next = await bot.store.updateTempVoice(channelId, {
            ownerId: newOwner,
            allowed: [...new Set([...temp.allowed.filter((id) => id !== newOwner), temp.ownerId])],
            banned: temp.banned.filter((id) => id !== newOwner),
          });
          await syncMember(bot, next, newOwner);
          await syncMember(bot, next, temp.ownerId);
          await refreshDashboard(bot, next);
          return `Nowy właściciel: <@${newOwner}>.`;
        });
      case 'kick':
        return work(RESPONSE.DEFERRED_UPDATE, async () => {
          const present = new Set(await bot.store.voiceMembers(channelId));
          const kicked = picked.filter((id) => id !== temp.ownerId && present.has(id));
          for (const id of kicked) await moveMember(bot, temp.guildId, id, null);
          return kicked.length ? `Wyrzucono: ${mentions(kicked)}.` : 'Tych osób już nie ma na kanale.';
        });
      default:
        return failure('Nieznana akcja.');
    }
  }

  // Okna z formularzem (tvm).
  const value = modalValue(ix);
  if (action === 'name') {
    return work(RESPONSE.DEFERRED, async () => {
      const name = value.slice(0, 100);
      if (!name) throw new ActionError('Nazwa nie może być pusta.');
      await bot.discord.patch(`/channels/${channelId}`, { name }, { reason: `Zmiana nazwy przez ${ix.user.username}` });
      await refreshDashboard(bot, await bot.store.updateTempVoice(channelId, { name }));
      return `Nowa nazwa: **${name}**.`;
    });
  }
  if (action === 'limit') {
    return work(RESPONSE.DEFERRED, async () => {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 0 || limit > 99) throw new ActionError('Limit musi być liczbą od 0 do 99.');
      await bot.discord.patch(`/channels/${channelId}`, { user_limit: limit });
      await refreshDashboard(bot, await bot.store.updateTempVoice(channelId, { limit }));
      return limit ? `Limit osób: **${limit}**.` : 'Kanał nie ma już limitu osób.';
    });
  }
  return failure('Nieznana akcja.');
}
