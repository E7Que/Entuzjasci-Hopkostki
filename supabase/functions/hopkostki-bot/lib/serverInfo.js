// Serwer info (zakładka panelu): wiadomość z informacjami o rolach, rolach za poziomy i komendach dla społeczności.
// Każda sekcja to embed (tytuł, wstęp, lista), a nad nim opcjonalny baner - osobny embed z samym obrazkiem.
// Wiadomość wysyła się i aktualizuje z panelu; bot pamięta, gdzie ją wysłał (bot.state 'server_info_message').
// Banery wgrane w panelu leżą w bot.assets i są serwowane publicznie przez funkcję (/panel/public/asset/…).

import { ActionError, cached, getApp, getGuildContext } from './moderation.js';
import { colorInt } from './embeds.js';
import { DiscordError } from './rest.js';
import { P } from './permissions.js';

export const SERVER_INFO_KINDS = ['roles', 'levels', 'commands', 'text'];
export const SERVER_INFO_ITEM_KINDS = ['heading', 'role', 'command', 'text'];
const SNOWFLAKE = /^\d{15,25}$/;
const LIMITS = { embeds: 10, total: 6000, description: 4096 };
const DEFAULT_COLOR = 0x3cc3d6;

// ---------- Treść wiadomości ----------

// Puste linie pomijamy - sama „> ” na Discordzie nie jest cytatem i przerwałaby blok.
const quote = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => `> ${line}`)
    .join('\n');

// Komendy innych botów, które znamy z ID (DISBOARD /bump) - klikalne także jako {/bump}.
export const KNOWN_COMMANDS = { bump: '947088344167366698' };

// {/rank} w tekście → klikalna komenda (albo `/rank`, gdy bot nie zna jej ID).
function commandMention(command, { commandIds = {}, commandId = '' } = {}) {
  const base = command.split(' ')[0];
  const id = commandId || commandIds[base] || KNOWN_COMMANDS[base];
  return id ? `</${command}:${id}>` : `\`/${command}\``;
}
const withCommands = (text, opts) => String(text ?? '').replace(/\{\/([\p{Ll}\p{N}_-]{1,32}(?: [\p{Ll}\p{N}_-]{1,32}){0,2})\}/gu, (_, c) => commandMention(c, opts));

// Rola: znaczek + wzmianka, opis w cytacie pod spodem (jak w dotychczasowym embedzie „Role Info”).
// Komenda: jedna linia „znaczek /komenda - opis”. Nagłówek: pogrubiona linia.
export function itemText(item, { bullet = '', commandIds = {} } = {}) {
  const b = bullet ? `${bullet} ` : '';
  const opts = { commandIds };
  switch (item.kind) {
    case 'heading':
      return `**${item.text}**`;
    case 'role':
      return `${b}<@&${item.roleId}>${item.text ? `\n${quote(withCommands(item.text, opts))}` : ''}`;
    case 'command':
      return `${b}${commandMention(item.command, { commandIds, commandId: item.commandId })}${item.text ? ` - ${withCommands(item.text, opts)}` : ''}`;
    default:
      return withCommands(item.text, opts);
  }
}

// Odstępy: między rolami pusta linia, między komendami nie; przed nagłówkiem pusta linia.
export function itemsText(items, opts) {
  let out = '';
  items.forEach((item, i) => {
    const text = itemText(item, opts);
    if (i === 0) {
      out = text;
      return;
    }
    const prev = items[i - 1];
    const gap = item.kind === 'heading' || (prev.kind !== 'heading' && (item.kind !== 'command' || prev.kind !== 'command')) ? '\n\n' : '\n';
    out += gap + text;
  });
  return out;
}

export function sectionDescription(section, opts) {
  return [withCommands(section.intro, opts), itemsText(section.items, opts)].filter(Boolean).join('\n\n');
}

const bannersOf = (info) => info.sections.map((s) => s.banner).filter(Boolean);

// Wiadomość w formacie API Discorda (sprawdza limity Discorda, zanim cokolwiek wyślemy).
export function buildServerInfoPayload(info, { commandIds = {}, now = Date.now() } = {}) {
  const color = colorInt(info.color, DEFAULT_COLOR);
  const opts = { bullet: info.bullet, commandIds };
  const embeds = [];
  for (const section of info.sections) {
    const description = sectionDescription(section, opts);
    if (!section.title && !description && !section.banner) continue;
    if (description.length > LIMITS.description) {
      throw new ActionError(`Sekcja „${section.title || 'bez tytułu'}” ma ${description.length} znaków, a embed mieści 4096 - skróć opisy albo podziel ją na dwie.`);
    }
    if (section.banner) embeds.push({ color, image: { url: section.banner } });
    if (section.title || description) embeds.push({ color, ...(section.title ? { title: section.title } : {}), ...(description ? { description } : {}) });
  }
  if (!embeds.length) throw new ActionError('Wiadomość jest pusta - dodaj sekcję z treścią.');
  if (info.footer) Object.assign(embeds.at(-1), { footer: { text: info.footer }, timestamp: new Date(now).toISOString() });
  if (embeds.length > LIMITS.embeds) throw new ActionError(`Wiadomość ma ${embeds.length} embedów, a Discord pozwala na 10 - usuń któryś baner albo sekcję.`);
  const total = embeds.reduce((sum, e) => sum + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0), 0);
  if (total > LIMITS.total) throw new ActionError(`Wiadomość ma ${total} znaków, a Discord pozwala na 6000 we wszystkich embedach razem - skróć opisy.`);
  return { content: '', embeds, allowed_mentions: { parse: [] } };
}

// ID komend bota (klikalne komendy w wiadomości) - z pamięcią na 10 minut.
export function commandIdMap(bot) {
  return cached(bot, 'commandIds', 10 * 60_000, async () => {
    const app = await getApp(bot);
    const { guild } = await getGuildContext(bot);
    const list = await bot.discord.get(`/applications/${app.id}/guilds/${guild.id}/commands`);
    return Object.fromEntries((list ?? []).map((c) => [c.name, c.id]));
  });
}

// Wysyła wiadomość albo aktualizuje już wysłaną (asNew - zawsze nowa). Zwraca { action, channelId, messageId }.
export async function sendServerInfo(bot, { channelId = '', asNew = false } = {}) {
  const info = (await bot.store.getConfig()).serverInfo;
  const posted = await bot.store.getState('server_info_message');
  const payload = buildServerInfoPayload(info, { commandIds: await commandIdMap(bot).catch(() => ({})) });
  const target = channelId || info.channelId;
  if (posted?.messageId && !asNew && (!target || target === posted.channelId)) {
    try {
      await bot.discord.patch(`/channels/${posted.channelId}/messages/${posted.messageId}`, payload);
      const next = { ...posted, updatedAt: Date.now(), banners: bannersOf(info) };
      await bot.store.setState('server_info_message', next);
      return { action: 'updated', ...next };
    } catch (error) {
      // Wiadomość usunięta na Discordzie - wysyłamy nową.
      if (!(error instanceof DiscordError && error.status === 404)) throw error;
    }
  }
  if (!SNOWFLAKE.test(target ?? '')) throw new ActionError('Wybierz kanał, na który wysłać wiadomość (i zapisz zmiany).');
  const message = await bot.discord.post(`/channels/${target}/messages`, payload);
  const next = { channelId: target, messageId: message.id, sentAt: Date.now(), updatedAt: Date.now(), banners: bannersOf(info) };
  await bot.store.setState('server_info_message', next);
  return { action: 'sent', ...next };
}

// ---------- Podpowiedź treści z ról serwera ----------

const EXTERNAL_STICKERS = 1n << 37n;
const MEMBER_PERMS = [
  [P.ATTACH_FILES, 'wysyłanie zdjęć i plików'],
  [P.EMBED_LINKS, 'podglądy linków'],
  [P.CREATE_PUBLIC_THREADS, 'tworzenie wątków'],
  [P.CHANGE_NICKNAME, 'zmianę pseudonimu'],
  [P.USE_EXTERNAL_EMOJIS, 'emoji z innych serwerów'],
  [EXTERNAL_STICKERS, 'naklejki z innych serwerów'],
  [1n << 9n, 'udostępnianie ekranu'],
  [1n << 46n, 'wiadomości głosowe'],
  [1n << 42n, 'soundboard'],
];

const TIKTOK = /^ping\s+(?:tt|tiktok)\s+(.+)$/i;
const YOUTUBE = /^ping\s+(?:yt|youtube)\s+(.+)$/i;

// Twórca wideo: wymagania i kroki jak w dotychczasowym embedzie „Role Info” (ticket zamiast usuniętego bota).
function creatorText(m, ctx) {
  const tt = ctx.emoji(/^(tt|tiktok)$/i);
  const yt = ctx.emoji(/^(yt|youtube)$/i);
  return [
    `***Wymagania:*** *więcej niż 1000 obserwujących na TikToku${tt ? ` ${tt}` : ''} lub więcej niż 500 subskrypcji na YouTube${yt ? ` ${yt}` : ''}.*`,
    `**1.** Aby otrzymać tę rolę, ${ctx.ticketChannelId ? `otwórz ticket na <#${ctx.ticketChannelId}>` : 'napisz do administracji'}.`,
    '**2.** Wiadomość powinna zawierać link do konta na TikToku/YouTube.',
    '**3.** Następnie pokaż nam, że masz dostęp do tego konta i że możesz je edytować.',
    `**4.** Wtedy dostaniesz rolę <@&${ctx.role.id}>.`,
  ].join('\n');
}

// [grupa, test nazwy (bez „| ” na początku), opis albo (dopasowanie, kontekst) => opis].
// Kolejność reguł = kolejność ról w grupie (jak w dotychczasowym embedzie), przy remisie - pozycja roli.
const ROLE_RULES = [
  ['staff', /właściciel|wlasciciel|owner/i, 'Właściciel serwera - nic dodać, nic ująć.'],
  ['staff', /^admin/i, 'Administrator serwera. Najsilniejsza rola, jaką możesz dostać.'],
  ['staff', /^moderator/i, 'Moderator, taki admin, ale może mniej.'],
  ['staff', /^helper/i, 'Pomocnik moderatorów i adminów.'],
  ['staff', /^test\s*helper/i, 'Helper na okresie próbnym - uczy się moderacji pod okiem ekipy.'],
  ['staff', /^bot$/i, '„Bep Bop” - dźwięki robota.'],
  ['community', /twórca|tworca|creator/i, creatorText],
  ['community', /booster/i, 'Osoba, która zboostowała serwer.'],
  ['community', /^ex-?\s*moderator/i, 'Były moderator - dziękujemy za pomoc przy serwerze.'],
  ['community', /członek|czlonek|^member$/i, 'Członek serwera - podstawowa rola każdej osoby na serwerze.'],
  ['notify', TIKTOK, (m) => `Powiadomienia o nowych filmach ${m[1]} na TikToku.`],
  ['notify', YOUTUBE, (m) => `Powiadomienia o nowych filmach ${m[1]} na YouTube.`],
  ['notify', /(mc|minecraft).*ping|ping.*(mc|minecraft)/i, 'Powiadomienia o serwerze Minecraft.'],
  ['notify', /bump/i, (m, ctx) => `Ping${ctx.bumpChannelId ? ` na <#${ctx.bumpChannelId}>` : ''}, kiedy znowu można podbić serwer komendą {/bump}.`],
  ['notify', /highlight/i, 'Ping przy podsumowaniu najaktywniejszych osób tygodnia i miesiąca.'],
  ['notify', /dead\s*chat/i, 'Ping, gdy na czacie robi się pusto - wpadnij pogadać.'],
  ['notify', /collab/i, 'Powiadomienia o collabach i ogłoszeniach Serwer Collab.'],
  ['notify', /ping/i, 'Rola z powiadomieniami.'],
];
const GROUP_HEADINGS = { staff: 'Administracja', community: 'Społeczność', self: 'Role do wzięcia', notify: 'Powiadomienia' };
const cleanName = (name) => String(name ?? '').replace(/^[\s|]+/, '').trim();

// Kontekst opisów ról: kanał ticketów i bumpów oraz role do wzięcia z wiadomości bota (zakładka Wiadomości).
export async function serverInfoContext(bot, config) {
  const [ticketPanel, sent] = await Promise.all([
    bot.store.getState('ticket_panel').catch(() => null),
    bot.store.listSentMessages().catch(() => []),
  ]);
  const selfRoles = new Map();
  for (const message of [...sent].reverse()) {
    const roles = message.data?.roles;
    if (!roles || roles.mode === 'none') continue;
    for (const item of roles.items ?? []) if (item.roleId && !selfRoles.has(item.roleId)) selfRoles.set(item.roleId, message.channelId);
  }
  return {
    ticketChannelId: config.tickets?.enabled && ticketPanel?.channelId ? ticketPanel.channelId : '',
    bumpChannelId: config.bump?.channelId ?? '',
    selfRoles,
  };
}

// Role serwera → proponowane elementy sekcji „Role” i „Role za poziomy” (z opisami). Role za poziomy: nagrody
// z ustawień Poziomów (gdy są) albo role „Level N”; role do wzięcia: te z wiadomości bota z wyborem ról.
export function suggestServerInfoRoles(gctx, config, { ticketChannelId = '', bumpChannelId = '', selfRoles = new Map() } = {}) {
  const everyone = BigInt(gctx.roles.get(gctx.guild.id)?.permissions ?? 0);
  const rewards = config.levels?.rewards ?? [];
  const rewardLevel = new Map(rewards.map((r) => [r.roleId, r.level]));
  const emoji = (test) => {
    const found = (gctx.emojis ?? []).find((e) => e.available !== false && test.test(e.name ?? ''));
    return found ? `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>` : '';
  };
  const groups = { staff: [], community: [], self: [], notify: [] };
  const levels = [];
  for (const role of gctx.rawRoles ?? []) {
    if (role.id === gctx.guild.id) continue;
    const name = cleanName(role.name);
    if (name.length < 2 || /^custom\b/i.test(name) || /techni|techink/i.test(name)) continue;
    if (role.tags?.bot_id || role.tags?.integration_id) continue;
    const levelMatch = /^(?:level|poziom|lvl)\s*(\d+)$/i.exec(name);
    if (rewardLevel.has(role.id) || levelMatch) {
      // Rola „Level N” spoza nagród - bot jej nie daje, więc jej nie opisujemy.
      if (rewards.length && !rewardLevel.has(role.id)) continue;
      const level = rewardLevel.get(role.id) ?? Number(levelMatch[1]);
      const extra = BigInt(role.permissions ?? 0) & ~everyone;
      const unlocks = MEMBER_PERMS.filter(([bit]) => (extra & bit) === bit).map(([, label]) => label);
      levels.push({ level, item: { kind: 'role', roleId: role.id, text: `Za **${level} poziom**.${unlocks.length ? ` Odblokowuje: ${unlocks.join(', ')}.` : ''}` } });
      continue;
    }
    const premium = role.tags && 'premium_subscriber' in role.tags;
    const index = premium ? ROLE_RULES.findIndex((r) => r[1].source === 'booster') : ROLE_RULES.findIndex(([, test]) => test.test(name));
    if (index < 0) continue;
    const [group, test, describe] = ROLE_RULES[index];
    const text = typeof describe === 'function' ? describe(test.exec(name), { ticketChannelId, bumpChannelId, emoji, role }) : describe;
    const target = group === 'notify' && selfRoles.has(role.id) ? 'self' : group;
    groups[target].push({ index, position: role.position, item: { kind: 'role', roleId: role.id, text } });
  }
  const main = [];
  for (const [group, list] of Object.entries(groups)) {
    if (!list.length) continue;
    main.push({ kind: 'heading', text: GROUP_HEADINGS[group] });
    if (group === 'self') {
      const channels = [...new Set(list.map((r) => selfRoles.get(r.item.roleId)).filter(Boolean))].map((id) => `<#${id}>`);
      if (channels.length) main.push({ kind: 'text', text: `Weźmiesz je sam na ${channels.length > 1 ? 'kanałach' : 'kanale'} ${channels.join(', ')}.` });
    }
    main.push(...list.sort((a, b) => a.index - b.index || b.position - a.position).map((r) => r.item));
  }
  return { main, levels: levels.sort((a, b) => a.level - b.level).map((l) => l.item) };
}

// Uzupełnia sekcje „Role” i „Role za poziomy”: pusta sekcja dostaje całą propozycję (z nagłówkami),
// a w wypełnionej dopisujemy na końcu tylko role, których jeszcze nie ma. Zwraca nowe sekcje i liczbę ról.
export function fillServerInfoSections(sections, suggestion) {
  let added = 0;
  const next = sections.map((section) => {
    const pool = section.kind === 'roles' ? suggestion.main : section.kind === 'levels' ? suggestion.levels : null;
    if (!pool) return section;
    if (!section.items.length) {
      added += pool.filter((i) => i.kind === 'role').length;
      return { ...section, items: pool.map((i) => ({ ...i })) };
    }
    const have = new Set(sections.flatMap((s) => s.items).filter((i) => i.kind === 'role').map((i) => i.roleId));
    const missing = pool.filter((i) => i.kind === 'role' && !have.has(i.roleId));
    added += missing.length;
    return { ...section, items: [...section.items, ...missing.map((i) => ({ ...i }))] };
  });
  return { sections: next, added };
}

// ---------- Banery (obrazki wgrane w panelu) ----------

const ASSET_TYPES = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
export const ASSET_MAX_BYTES = 3 * 1024 * 1024;
export const ASSET_ID = /^[a-f0-9]{24}\.(webp|png|jpg|gif)$/;

// Publiczny adres obrazka: adres funkcji bez parametrów (selfUrl ma ?forceFunctionRegion=…) + /panel/public/asset/<id>.
export function assetUrl(selfUrl, id) {
  if (!selfUrl) throw new ActionError('Bot nie zna swojego adresu (brak SUPABASE_URL) - nie da się udostępnić obrazka.');
  const url = new URL(selfUrl);
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/panel/public/asset/${id}`;
  return url.toString();
}

// data:image/…;base64,… → zapis w bot.assets, zwraca publiczny adres obrazka.
export async function saveBannerAsset(bot, dataUrl) {
  const match = /^data:(image\/(?:webp|png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!match) throw new ActionError('To nie jest obrazek PNG, JPG, WebP ani GIF.');
  const size = Math.floor((match[2].length * 3) / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
  if (size > ASSET_MAX_BYTES) throw new ActionError('Obrazek jest za duży (maks. 3 MB).');
  const id = `${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}.${ASSET_TYPES[match[1]]}`;
  const url = assetUrl(bot.env.selfUrl, id);
  await bot.store.addAsset({ id, contentType: match[1], data: match[2], size });
  return { id, url };
}

// Sprząta obrazki, których nie używa ani ustawienie (Serwer info, banery eventów), ani wysłana wiadomość (starsze niż dzień).
export async function pruneBannerAssets(bot) {
  const [config, posted] = await Promise.all([bot.store.getConfig(), bot.store.getState('server_info_message')]);
  const keep = [...bannersOf(config.serverInfo), ...(posted?.banners ?? []), ...(config.contests?.list ?? []).map((c) => c.banner).filter(Boolean), ...Object.values(config.site ?? {}).filter(Boolean)]
    .map((url) => /\/asset\/([a-f0-9]{24}\.\w+)$/.exec(url)?.[1])
    .filter(Boolean);
  await bot.store.pruneAssets(keep, 24);
}
