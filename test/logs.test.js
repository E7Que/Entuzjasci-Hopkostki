import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD, snowflake } from './support/discord.js';
import {
  onMessageCreateLog,
  onMessageUpdate,
  onMessageDelete,
  onMessageDeleteBulk,
  onAuditLogEntry,
  permissionDiff,
  onMemberUpdateLog,
  seedMemberProfiles,
  GROUPS,
} from '../supabase/functions/hopkostki-bot/lib/logs.js';
import { DEFAULT_CONFIG } from '../supabase/functions/hopkostki-bot/lib/defaults.js';
import { findUsedInvite, ensureInviteSnapshot } from '../supabase/functions/hopkostki-bot/lib/invites.js';
import { onMemberLeave } from '../supabase/functions/hopkostki-bot/lib/members.js';
import { onVoiceStateUpdate } from '../supabase/functions/hopkostki-bot/lib/voice.js';
import { onMemberJoin } from '../supabase/functions/hopkostki-bot/lib/members.js';
import { sessionIntents } from '../supabase/functions/hopkostki-bot/lib/gateway.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { commandPayload } from './support/discord.js';

const MAIN = '100000000000000050';
const MSG_LOGS = '100000000000000051';
const TALK = '100000000000000052';
const QUIET = '100000000000000053';

async function setup(logs = {}, extra = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ logs: { enabled: true, channelId: MAIN, messagesChannelId: MSG_LOGS, ignoredChannelIds: [QUIET], ...logs }, ...extra });
  return { store, discord, bot };
}

const logged = (s, channel = MAIN) => s.discord.state.channels.get(channel) ?? [];
const message = (content, extra = {}) => ({
  id: snowflake(),
  type: 0,
  guild_id: GUILD,
  channel_id: TALK,
  author: { id: 'target', username: 'hurownik_og' },
  content,
  attachments: [],
  timestamp: new Date().toISOString(),
  ...extra,
});

test('logi wiadomości: edycja z treścią przed/po, usunięcie z treścią, zbiorcze z plikiem; boty i wyciszone kanały pomijane', async () => {
  const s = await setup({ events: { messageBulk: true } });
  const first = message('Cześć wszystkim');
  const second = message('druga', { attachments: [{ filename: 'kot.png', url: 'https://cdn/kot.png' }] });
  const third = message('trzecia');
  for (const m of [first, second, third]) await onMessageCreateLog(s.bot, m);
  await onMessageCreateLog(s.bot, message('bot', { author: { id: 'bot', bot: true } }));
  await onMessageCreateLog(s.bot, message('cicho', { channel_id: QUIET }));

  await onMessageUpdate(s.bot, { ...first, content: 'Cześć wszystkim!', edited_timestamp: new Date().toISOString() });
  await onMessageUpdate(s.bot, { ...first, content: 'Cześć wszystkim!', edited_timestamp: new Date().toISOString() });
  const [edit] = logged(s, MSG_LOGS);
  assert.match(edit.embeds[0].description, /edytowana na <#\d+>\*\* \[Przejdź do wiadomości\]/);
  assert.deepEqual(edit.embeds[0].fields.map((f) => f.value), ['Cześć wszystkim', 'Cześć wszystkim!']);
  assert.equal(logged(s, MSG_LOGS).length, 1, 'bez zmiany treści (np. podgląd linku) nie ma logu');

  await onMessageDelete(s.bot, { id: second.id, channel_id: TALK, guild_id: GUILD });
  const del = logged(s, MSG_LOGS)[1].embeds[0];
  assert.match(del.description, /Wiadomość od <@target> usunięta na <#\d+>\*\*\ndruga\n\n\*\*Załączniki:\*\*\n\[kot\.png\]/);
  assert.equal(del.author.name, 'hurownik_og');

  await onMessageDelete(s.bot, { id: '999999999999999999', channel_id: TALK, guild_id: GUILD });
  assert.equal(logged(s, MSG_LOGS).length, 2, 'nieznanej wiadomości nie logujemy');

  await onMessageDeleteBulk(s.bot, { ids: [first.id, third.id, '1'], channel_id: TALK, guild_id: GUILD });
  const bulkCall = s.discord.state.calls.findLast((c) => c.method === 'POST' && c.path === `/channels/${MSG_LOGS}/messages`);
  assert.match(bulkCall.body.embeds[0].description, /Usunięto zbiorczo 3 wiadomości/);
  assert.match(bulkCall.files[0].content, /hurownik_og \(target\): Cześć wszystkim!\n.*trzecia/);

  // /snipe pokazuje ostatnio usuniętą wiadomość z kanału.
  const snipe = await handleInteraction({ ...commandPayload('snipe', [], { permissions: String(1n << 13n) }), channel_id: TALK }, s.bot);
  await snipe.task();
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /Cześć wszystkim!|trzecia/);
});

test('logi z dziennika zdarzeń: role z autorem zmiany, pseudonim, ban; kary bota pomijane, gdy są logi moderacji', async () => {
  const s = await setup({}, { modLogChannelId: '100000000000000054' });
  await onAuditLogEntry(s.bot, {
    guild_id: GUILD,
    action_type: 25,
    user_id: 'mod',
    target_id: 'target',
    changes: [{ key: '$add', new_value: [{ id: 'r-fan', name: 'Fan' }] }, { key: '$remove', new_value: [{ id: 'r-member', name: 'Entuzjasta' }] }],
  });
  const roles = logged(s)[0].embeds[0];
  assert.match(roles.description, /Zmiana ról <@target>\*\*\n\*\*Dodano rolę:\*\* <@&r-fan>\n\*\*Zabrano rolę:\*\* <@&r-member>\n\*\*Przez:\*\* <@mod>/);
  assert.equal(roles.author.name, 'hurownik_og');

  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 24, user_id: 'target', target_id: 'target', changes: [{ key: 'nick', old_value: 'stary', new_value: 'nowy' }] });
  const nick = logged(s)[1].embeds[0];
  assert.deepEqual(nick.fields.map((f) => f.value), ['stary', 'nowy']);
  assert.doesNotMatch(nick.description, /Przez/, 'sam sobie zmienił');

  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 22, user_id: 'mod', target_id: 'target', reason: 'spam' });
  assert.match(logged(s)[2].embeds[0].description, /<@target> został\(a\) zbanowany\/a\*\*\n\*\*Przez:\*\* <@mod>\n\*\*Powód:\*\* spam/);
  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 22, user_id: 'bot', target_id: 'target', reason: 'x' });
  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 10, user_id: 'bot', target_id: '5', changes: [{ key: 'name', new_value: 'Kanał kogoś' }] });
  assert.equal(logged(s).length, 3, 'ban komendą bota i kanał na żądanie bota nie trafiają do logów serwera');

  await onAuditLogEntry(s.bot, {
    guild_id: GUILD,
    action_type: 31,
    user_id: 'mod',
    target_id: 'r-fan',
    changes: [
      { key: 'name', old_value: 'Fan', new_value: 'Superfan' },
      { key: 'permissions', old_value: '0', new_value: String((1n << 13n) | (1n << 3n)) },
      { key: 'position', old_value: 2, new_value: 3 },
    ],
  });
  const role = logged(s)[3].embeds[0].description;
  assert.match(role, /Zmieniono rolę <@&r-fan>\*\*\n\*\*Nazwa:\*\* `Fan` → `Superfan`\n\*\*Dodane uprawnienia:\*\* Administrator, Zarządzanie wiadomościami/);
  assert.doesNotMatch(role, /3/, 'pozycja to szum');
});

test('permissionDiff: nazwy dodanych i zabranych uprawnień', () => {
  assert.deepEqual(permissionDiff(String(1n << 11n), String((1n << 2n) | (1n << 40n))), {
    added: ['Banowanie członków', 'Wyciszanie (timeout)'],
    removed: ['Wysyłanie wiadomości'],
  });
});

test('logi głosowe: wejście, przejście i wyjście', async () => {
  const s = await setup({ voiceChannelId: '100000000000000055', events: { voiceJoin: true, voiceMove: true, voiceLeave: true } });
  const member = { user: { id: 'target', username: 'hurownik_og' } };
  await onVoiceStateUpdate(s.bot, { guild_id: GUILD, user_id: 'target', channel_id: 'v1', member });
  await onVoiceStateUpdate(s.bot, { guild_id: GUILD, user_id: 'target', channel_id: 'v1', member, self_mute: true });
  await onVoiceStateUpdate(s.bot, { guild_id: GUILD, user_id: 'target', channel_id: 'v2', member });
  await onVoiceStateUpdate(s.bot, { guild_id: GUILD, user_id: 'target', channel_id: null, member });
  assert.deepEqual(
    logged(s, '100000000000000055').map((m) => m.embeds[0].description),
    [
      '**<@target> dołączył(a) do kanału głosowego <#v1>**',
      '**<@target> przeszedł/przeszła z <#v1> na <#v2>**',
      '**<@target> opuścił(a) kanał głosowy <#v2>**',
    ],
  );
});

test('intencje sesji: dziennik zdarzeń przy logach, treść wiadomości i członkowie tylko z flagami aplikacji', async () => {
  const s = await setup();
  const base = (1 << 0) | (1 << 7) | (1 << 9);
  assert.equal(await sessionIntents(s.bot), base | (1 << 2), 'bez flag aplikacji - bez uprzywilejowanych');
  s.discord.state.appFlags = (1 << 15) | (1 << 19);
  s.bot.cache.delete('app');
  assert.equal(await sessionIntents(s.bot), base | (1 << 2) | (1 << 1) | (1 << 15));
  await s.store.updateConfig({ logs: { enabled: false } });
  assert.equal(await sessionIntents(s.bot), base);
});

test('nowe konto: ping @here poniżej progu, wybrane role zamiast @here, starsze konto bez pingu', async () => {
  const s = await setup({ joinLeaveChannelId: '100000000000000056', newAccount: { ping: true, days: 7, mention: 'here' } });
  const idAged = (days) => String(BigInt(Date.now() - days * 86_400_000 - 1420070400000) << 22n);
  const join = (id, extra = {}) => onMemberJoin(s.bot, { guild_id: GUILD, user: { id, username: `u${id.slice(-4)}`, ...extra }, roles: [], joined_at: new Date().toISOString() });
  const log = () => logged(s, '100000000000000056').at(-1);

  await join(idAged(3));
  assert.equal(log().content, '@here');
  assert.match(log().embeds[0].description, /ma mniej niż 7 dni/);
  assert.equal(log().embeds[0].color, 0xfee75c);

  await join(idAged(30));
  assert.equal(log().content, undefined, 'stare konto bez pingu');
  assert.doesNotMatch(log().embeds[0].description, /nowe konto/);

  await join(idAged(2), { bot: true });
  assert.equal(log().content, undefined, 'boty bez pingu');

  await s.store.updateConfig({ logs: { newAccount: { mention: 'roles', roleIds: ['100000000000000057'], days: 1 } } });
  await join(idAged(0.5));
  assert.equal(log().content, '<@&100000000000000057>');
  assert.deepEqual(log().allowed_mentions, { roles: ['100000000000000057'] });
  await join(idAged(3));
  assert.equal(log().content, undefined, 'próg 1 dzień');

  const cfg = await s.store.updateConfig({ logs: { newAccount: { days: 999, mention: 'wszyscy' } } });
  assert.equal(cfg.logs.newAccount.days, 60);
  assert.equal(cfg.logs.newAccount.mention, 'roles');
});

test('zdjęcie profilowe: log ze starym i nowym zdjęciem (dołączone pliki, galeria), zmiana nazwy przed/po', async () => {
  const s = await setup({ membersChannelId: '100000000000000058' });
  const fetched = [];
  s.bot.fetch = async (url) => {
    fetched.push(url);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': url.includes('.gif') ? 'image/gif' : 'image/png' } });
  };
  const update = (user, extra = {}) => onMemberUpdateLog(s.bot, { guild_id: GUILD, user: { id: 'target', username: 'hurownik_og', ...user }, roles: [], ...extra });

  await update({ avatar: 'aaa' });
  assert.equal(logged(s, '100000000000000058').length, 0, 'pierwszy raz tylko zapamiętujemy');
  await update({ avatar: 'aaa' });
  assert.equal(logged(s, '100000000000000058').length, 0, 'bez zmian (np. zmiana ról) nic nie logujemy');

  await update({ avatar: 'a_bbb' });
  assert.deepEqual(fetched, ['https://cdn.discordapp.com/avatars/target/aaa.png?size=512', 'https://cdn.discordapp.com/avatars/target/a_bbb.gif?size=512']);
  const call = s.discord.state.calls.findLast((c) => c.method === 'POST' && c.path === '/channels/100000000000000058/messages');
  assert.deepEqual(call.files.map((f) => f.name), ['przed.png', 'po.gif']);
  const [first, second] = call.body.embeds;
  assert.match(first.description, /<@target> zmienił\(a\) zdjęcie profilowe/);
  assert.equal(first.image.url, 'attachment://przed.png');
  assert.equal(second.image.url, 'attachment://po.gif');
  assert.equal(first.url, second.url, 'ten sam link = jedna galeria');

  // Serwerowe zdjęcie ma pierwszeństwo przed zwykłym.
  await update({ avatar: 'a_bbb' }, { avatar: 'ccc' });
  assert.equal(fetched.at(-1), 'https://cdn.discordapp.com/guilds/g1/users/target/avatars/ccc.png?size=512');

  // Gdy obrazka nie da się pobrać - zostają linki.
  s.bot.fetch = async () => new Response('nie ma', { status: 404 });
  await update({ avatar: 'a_bbb' }, { avatar: null });
  const fallback = s.discord.state.calls.findLast((c) => c.method === 'POST' && c.path === '/channels/100000000000000058/messages');
  assert.equal(fallback.files, undefined);
  assert.match(fallback.body.embeds[0].image.url, /^https:\/\/cdn\.discordapp\.com\/guilds\/g1\/users\/target\/avatars\/ccc\.png/);

  await update({ avatar: 'a_bbb', username: 'nowy_nick', global_name: 'Nowy' });
  const name = logged(s, '100000000000000058').at(-1).embeds[0];
  assert.match(name.description, /zmienił\(a\) nazwę użytkownika/);
  assert.deepEqual(name.fields.map((f) => f.value), ['(`hurownik_og`)', 'Nowy (`nowy_nick`)']);

  // Wyłączone zdjęcia profilowe - nic nie trafia do logów.
  await s.store.updateConfig({ logs: { events: { memberAvatar: false } } });
  const before = logged(s, '100000000000000058').length;
  await update({ avatar: 'zzz', username: 'nowy_nick', global_name: 'Nowy' });
  assert.equal(logged(s, '100000000000000058').length, before);
});

test('cron zapamiętuje zdjęcia wszystkich osób (bez nadpisywania znanych), gdy są logi profili i intencja członków', async () => {
  const s = await setup();
  assert.equal(await seedMemberProfiles(s.bot), 0, 'bez intencji „Server Members” nic');
  await s.store.setState('profiles_seed', null);
  s.discord.state.appFlags = 1 << 15;
  s.bot.cache.delete('app');
  assert.equal(await seedMemberProfiles(s.bot), 4);
  assert.equal(await seedMemberProfiles(s.bot), 0, 'co 6 godzin');
});

test('wątki, zdjęcie timeoutu jako osobne zdarzenie, kanał wejść/wyjść osobno od członków', async () => {
  const s = await setup({
    joinLeaveChannelId: '100000000000000059',
    events: { threadCreate: true, threadDelete: true, memberTimeout: true, memberTimeoutRemove: false },
  });
  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 110, user_id: 'mod', target_id: '777', changes: [{ key: 'name', new_value: 'pomysły' }, { key: 'type', new_value: 11 }] });
  assert.match(logged(s)[0].embeds[0].description, /Utworzono wątek \(wątek publiczny\): <#777>\*\* `pomysły`\n\*\*Przez:\*\* <@mod>/);
  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 110, user_id: 'bot', target_id: '778', changes: [{ key: 'name', new_value: 'Propozycja #1' }] });
  assert.equal(logged(s).length, 1, 'wątki bota (np. pod propozycjami) pomijane');

  const until = new Date(Date.now() + 3600_000).toISOString();
  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 24, user_id: 'mod', target_id: 'target', changes: [{ key: 'communication_disabled_until', new_value: until }] });
  await onAuditLogEntry(s.bot, { guild_id: GUILD, action_type: 24, user_id: 'mod', target_id: 'target', changes: [{ key: 'communication_disabled_until', old_value: until }] });
  assert.equal(logged(s).length, 2, 'nałożenie timeoutu tak, zdjęcie (wyłączone) nie');
  assert.match(logged(s)[1].embeds[0].description, /dostał\(a\) timeout/);
});

test('domyślne zdarzenia jak zaznaczone w Carl-bocie', () => {
  const on = Object.entries(DEFAULT_CONFIG.logs.events).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(on, ['messageDelete', 'messageEdit', 'memberJoin', 'memberLeave', 'memberInvite', 'memberRoles', 'memberNick', 'memberAvatar', 'memberBan', 'memberUnban', 'roleUpdate']);
  assert.deepEqual(Object.values(GROUPS).flat().sort(), Object.keys(DEFAULT_CONFIG.logs.events).sort(), 'każde zdarzenie ma grupę i ustawienie');
});

test('zaproszenia: kto kogo zaprosił w logu wejścia i wyjścia, /zaproszenia pokazuje ranking i osoby', async () => {
  const s = await setup({ joinLeaveChannelId: '100000000000000060', newAccount: { ping: false } });
  const inv = (code, inviter, uses, extra = {}) => ({ code, uses, max_uses: 0, inviter: { id: inviter }, channel: { id: 'chan' }, expires_at: null, ...extra });
  s.discord.state.invites = [inv('abc', 'mod', 3), inv('xyz', 'owner', 0), inv('raz', 'owner', 0, { max_uses: 1 })];
  s.discord.state.vanity = { code: 'hopkostki', uses: 10 };
  assert.equal(await ensureInviteSnapshot(s.bot, await s.store.getConfig()), 1, 'stan początkowy z crona');
  assert.equal(await ensureInviteSnapshot(s.bot, await s.store.getConfig()), 0, 'tylko raz');

  const join = (id) => onMemberJoin(s.bot, { guild_id: GUILD, user: { id, username: `u${id.slice(-3)}` }, roles: [], joined_at: new Date().toISOString() });
  const log = () => logged(s, '100000000000000060').at(-1).embeds[0].description;
  const base = Date.now() - 400 * 86_400_000 - 1420070400000;
  const aged = (n) => String(BigInt(base + n) << 22n);

  s.discord.state.invites[0].uses = 4;
  await join(aged(1));
  assert.match(log(), /\*\*Zaprosił\(a\):\*\* <@mod> \(zaproszenie `abc`, użyte 4×\) - zaprosił\(a\) już \*\*1\*\* osobę/);

  // Jednorazowe zaproszenie znika po użyciu.
  s.discord.state.invites = s.discord.state.invites.filter((i) => i.code !== 'raz');
  await join(aged(2));
  assert.match(log(), /<@owner> \(zaproszenie `raz`, użyte 1×, wyczerpane\)/);

  s.discord.state.vanity.uses = 11;
  await join(aged(3));
  assert.match(log(), /własny link serwera `discord\.gg\/hopkostki`/);

  s.discord.state.invites[0].uses = 5;
  s.discord.state.invites.push(inv('nowe', 'target', 1));
  await join(aged(4));
  assert.match(log(), /jedno z: `abc`, `nowe`/);

  await onMemberLeave(s.bot, { guild_id: GUILD, user: { id: aged(1), username: 'ktos' } });
  assert.match(logged(s, '100000000000000060').at(-1).embeds[0].description, /Zaproszony\/a przez:\*\* <@mod> \(`abc`\)/);

  const ranking = await handleInteraction(commandPayload('zaproszenia', []), s.bot);
  await ranking.task();
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /1\. <@mod> - \*\*1\*\*\n2\. <@owner> - \*\*1\*\*|1\. <@owner> - \*\*1\*\*\n2\. <@mod> - \*\*1\*\*/);
  const person = await handleInteraction(commandPayload('zaproszenia', [{ name: 'uzytkownik', type: 6, value: 'mod' }], { resolvedIds: ['mod'] }), s.bot);
  await person.task();
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /\*\*Zaprosił\(a\):\*\* 1 osobę/);
});

test('findUsedInvite: nowe zaproszenie spoza zapamiętanego stanu i wygasłe nie są mylone', () => {
  const before = { invites: { a: { uses: 1, inviterId: 'x', maxUses: 0, expiresAt: Date.now() - 1000 } }, vanity: null };
  assert.equal(findUsedInvite(before, { invites: {}, vanity: null }), null, 'wygasłe zaproszenie zniknęło samo');
  assert.equal(findUsedInvite(before, { invites: { b: { uses: 1, inviterId: 'y' } }, vanity: null }).inviterId, 'y');
});
