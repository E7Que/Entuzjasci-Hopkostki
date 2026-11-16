import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot } from './support/discord.js';
import { handlePanel } from '../supabase/functions/hopkostki-bot/lib/panel.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { DEFAULT_CONFIG } from '../supabase/functions/hopkostki-bot/lib/defaults.js';
import { sanitizeConfig } from '../supabase/functions/hopkostki-bot/lib/configSchema.js';
import { DiscordError } from '../supabase/functions/hopkostki-bot/lib/rest.js';
import {
  buildServerInfoPayload,
  fillServerInfoSections,
  itemsText,
  pruneBannerAssets,
  serverInfoContext,
  suggestServerInfoRoles,
} from '../supabase/functions/hopkostki-bot/lib/serverInfo.js';

const CHANNEL = '400000000000000001';
const OTHER = '400000000000000002';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const id = (n) => String(300000000000000000n + BigInt(n));
const section = (extra) => ({ id: 's', kind: 'text', title: 'T', intro: '', banner: '', items: [], ...extra });

test('serwer info: role w cytatach, klikalne komendy, nagłówki, baner jako osobny embed i stopka na końcu', () => {
  const info = {
    color: '#3CC3D6',
    bullet: '🔹',
    footer: 'Entuzjaści Hopkostki',
    sections: [
      section({
        id: 'roles',
        kind: 'roles',
        title: 'Role 📋',
        banner: 'https://cdn.example/banner.webp',
        items: [
          { kind: 'heading', text: 'Administracja' },
          { kind: 'role', roleId: id(1), text: 'Właściciel serwera.' },
          { kind: 'role', roleId: id(2), text: 'Linia 1\n\nSprawdź {/rank} i {/bump}' },
        ],
      }),
      section({
        id: 'commands',
        kind: 'commands',
        title: 'Komendy',
        intro: 'Wpisz {/pomoc}.',
        items: [
          { kind: 'heading', text: 'Poziomy' },
          { kind: 'command', command: 'rank', commandId: '', text: 'Twoja karta' },
          { kind: 'command', command: 'przypomnij dodaj', commandId: '', text: 'przypomnienie' },
          { kind: 'command', command: 'bump', commandId: '947088344167366698', text: 'podbij serwer' },
          { kind: 'command', command: 'nieznana', commandId: '', text: '' },
          { kind: 'heading', text: 'Inne' },
          { kind: 'text', text: 'Zwykły tekst' },
        ],
      }),
      section({ id: 'pusta', title: '' }),
    ],
  };
  const commandIds = { rank: '111111111111111111', przypomnij: '222222222222222222', pomoc: '333333333333333333' };
  const now = Date.UTC(2026, 10, 16, 12);
  const payload = buildServerInfoPayload(info, { commandIds, now });
  assert.deepEqual(payload.allowed_mentions, { parse: [] }, 'wzmianki ról bez pingowania');
  assert.equal(payload.content, '');
  assert.equal(payload.embeds.length, 3, 'baner + 2 sekcje; pusta sekcja pominięta');
  assert.deepEqual(payload.embeds[0], { color: 0x3cc3d6, image: { url: 'https://cdn.example/banner.webp' } });
  assert.equal(payload.embeds[1].title, 'Role 📋');
  assert.equal(
    payload.embeds[1].description,
    `**Administracja**\n🔹 <@&${id(1)}>\n> Właściciel serwera.\n\n🔹 <@&${id(2)}>\n> Linia 1\n> Sprawdź </rank:111111111111111111> i </bump:947088344167366698>`,
  );
  assert.equal(
    payload.embeds[2].description,
    [
      'Wpisz </pomoc:333333333333333333>.',
      '',
      '**Poziomy**',
      '🔹 </rank:111111111111111111> — Twoja karta',
      '🔹 </przypomnij dodaj:222222222222222222> — przypomnienie',
      '🔹 </bump:947088344167366698> — podbij serwer',
      '🔹 `/nieznana`',
      '',
      '**Inne**',
      'Zwykły tekst',
    ].join('\n'),
  );
  assert.deepEqual(payload.embeds[2].footer, { text: 'Entuzjaści Hopkostki' });
  assert.equal(payload.embeds[2].timestamp, new Date(now).toISOString());
  assert.equal(payload.embeds[1].footer, undefined, 'stopka tylko pod ostatnią sekcją');
  assert.equal(itemsText([{ kind: 'role', roleId: id(1), text: '' }], { bullet: '' }), `<@&${id(1)}>`, 'bez znaczka i opisu — sama wzmianka');
});

test('serwer info: limity Discorda — opis sekcji, liczba embedów, suma znaków i pusta wiadomość', () => {
  const base = { color: '#3CC3D6', bullet: '', footer: '', sections: [] };
  assert.throws(() => buildServerInfoPayload(base), /pusta/);
  assert.throws(() => buildServerInfoPayload({ ...base, sections: [section({ intro: 'x'.repeat(4097) })] }), /4097 znaków.*4096/);
  assert.equal(buildServerInfoPayload({ ...base, sections: [section({ intro: 'x'.repeat(4096) })] }).embeds[0].description.length, 4096);
  const banners = Array.from({ length: 6 }, (_, i) => section({ id: `s${i}`, banner: 'https://x.example/b.png' }));
  assert.throws(() => buildServerInfoPayload({ ...base, sections: banners }), /12 embedów.*10/);
  const long = Array.from({ length: 2 }, (_, i) => section({ id: `s${i}`, intro: 'x'.repeat(3500) }));
  assert.throws(() => buildServerInfoPayload({ ...base, sections: long }), /6000/);
});

test('serwer info: propozycja ról — grupy i kolejność jak w starym embedzie, role do wzięcia, role za poziomy z nagród', () => {
  const role = (n, name, position, extra = {}) => ({ id: id(n), name, position, permissions: '0', color: 0, ...extra });
  const rawRoles = [
    { id: 'g', name: '@everyone', position: 0, permissions: String(1n << 10n) },
    role(15, 'Techink Serwera', 37, { permissions: '8' }),
    role(14, '| Custom - Kasia', 35),
    role(1, '| Właściciel', 33, { permissions: '8' }),
    role(2, '| Admin', 31),
    role(18, '| Bot', 30),
    role(3, '| Moderator', 29),
    role(5, '| Helper', 28),
    role(4, '| Test Helper', 27),
    role(7, '| Server Booster', 26, { managed: true, tags: { premium_subscriber: null } }),
    role(6, '| Twórca wideo', 25),
    role(19, '| Ex-Moderator', 24),
    role(11, '| Level 10', 19, { permissions: String((1n << 15n) | (1n << 10n)) }),
    role(12, '| Level 5', 18, { permissions: String(1n << 14n) }),
    role(20, '| Level 2', 17),
    role(8, '| Członek', 16),
    role(21, 'Collab', 15),
    role(9, 'Ping TT HdQd', 14),
    role(22, 'Ping YT HdQd', 12),
    role(23, '| Dead Chat', 11),
    role(10, '| Bump Reminder', 9),
    role(24, 'MC Serwer Ping', 4),
    role(13, 'Weteran', 3),
    role(17, 'C', 2),
    role(16, 'MEE6', 1, { managed: true, tags: { bot_id: '1' } }),
  ];
  const emojis = [
    { id: '500000000000000001', name: 'TT', animated: false, available: true },
    { id: '500000000000000002', name: 'YT', animated: false, available: true },
  ];
  const gctx = { guild: { id: 'g' }, roles: new Map(rawRoles.map((r) => [r.id, r])), rawRoles, emojis };
  const config = { levels: { rewards: [{ level: 5, roleId: id(12) }, { level: 10, roleId: id(11) }, { level: 20, roleId: id(13) }] } };
  const ROLES_CHANNEL = '600000000000000003';
  const ctx = { ticketChannelId: '600000000000000001', bumpChannelId: '600000000000000002', selfRoles: new Map([[id(23), ROLES_CHANNEL], [id(10), ROLES_CHANNEL]]) };
  const { main, levels } = suggestServerInfoRoles(gctx, config, ctx);
  const name = (roleId) => rawRoles.find((r) => r.id === roleId).name;
  const outline = (items) => items.map((i) => (i.kind === 'heading' ? `# ${i.text}` : i.kind === 'text' ? `> ${i.text}` : name(i.roleId)));
  assert.deepEqual(outline(main), [
    '# Administracja', '| Właściciel', '| Admin', '| Moderator', '| Helper', '| Test Helper', '| Bot',
    '# Społeczność', '| Twórca wideo', '| Server Booster', '| Ex-Moderator', '| Członek',
    '# Role do wzięcia', `> Weźmiesz je sam na kanale <#${ROLES_CHANNEL}>.`, '| Bump Reminder', '| Dead Chat',
    '# Powiadomienia', 'Ping TT HdQd', 'Ping YT HdQd', 'MC Serwer Ping', 'Collab',
  ]);
  assert.equal(
    main.find((i) => i.roleId === id(6)).text,
    [
      '***Wymagania:*** *więcej niż 1000 obserwujących na TikToku <:TT:500000000000000001> lub więcej niż 500 subskrypcji na YouTube <:YT:500000000000000002>.*',
      '**1.** Aby otrzymać tę rolę, otwórz ticket na <#600000000000000001>.',
      '**2.** Wiadomość powinna zawierać link do konta na TikToku/YouTube.',
      '**3.** Następnie pokaż nam, że masz dostęp do tego konta i że możesz je edytować.',
      `**4.** Wtedy dostaniesz rolę <@&${id(6)}>.`,
    ].join('\n'),
  );
  assert.equal(main.find((i) => i.roleId === id(10)).text, 'Ping na <#600000000000000002>, kiedy znowu można podbić serwer komendą {/bump}.');
  assert.equal(main.find((i) => i.roleId === id(9)).text, 'Powiadomienia o nowych filmach HdQd na TikToku.');
  assert.equal(main.find((i) => i.roleId === id(1)).text, 'Właściciel serwera — nic dodać, nic ująć.');
  assert.deepEqual(levels.map((i) => [name(i.roleId), i.text]), [
    ['| Level 5', 'Za **5 poziom**. Odblokowuje: podglądy linków.'],
    ['| Level 10', 'Za **10 poziom**. Odblokowuje: wysyłanie zdjęć i plików.'],
    ['Weteran', 'Za **20 poziom**.'],
  ], 'nagrody z Poziomów; „Level 2” spoza nagród — pominięta');

  // Bez kontekstu: bez ticketów i emoji, bez grupy „do wzięcia”; bez nagród — role „Level N” z nazwy.
  const plain = suggestServerInfoRoles({ ...gctx, emojis: [] }, { levels: { rewards: [] } });
  assert.match(plain.main.find((i) => i.roleId === id(6)).text, /^\*\*\*Wymagania:\*\*\* \*więcej niż 1000 obserwujących na TikToku lub .*\n\*\*1\.\*\* Aby otrzymać tę rolę, napisz do administracji\./);
  assert.ok(!plain.main.some((i) => i.kind === 'heading' && i.text === 'Role do wzięcia'));
  assert.deepEqual(plain.levels.map((i) => name(i.roleId)), ['| Level 2', '| Level 5', '| Level 10']);

  // Uzupełnianie: pusta sekcja dostaje całą propozycję, wypełniona — tylko brakujące role na końcu.
  const sections = [
    section({ id: 'roles', kind: 'roles', items: [{ kind: 'role', roleId: id(1), text: 'Mój opis' }] }),
    section({ id: 'levels', kind: 'levels' }),
    section({ id: 'commands', kind: 'commands', items: [{ kind: 'text', text: 'x' }] }),
  ];
  const filled = fillServerInfoSections(sections, { main, levels });
  assert.equal(filled.added, 15 + 3);
  assert.deepEqual(filled.sections[0].items[0], { kind: 'role', roleId: id(1), text: 'Mój opis' }, 'własny opis zostaje');
  assert.equal(filled.sections[0].items.length, 16);
  assert.ok(filled.sections[0].items.every((i) => i.kind === 'role'), 'do wypełnionej sekcji tylko role, bez nagłówków');
  assert.deepEqual(filled.sections[1].items.map((i) => i.kind), ['role', 'role', 'role']);
  assert.deepEqual(filled.sections[2], sections[2], 'sekcja komend bez zmian');
  assert.equal(fillServerInfoSections(filled.sections, { main, levels }).added, 0, 'drugi raz nie ma czego dopisać');
  const empty = fillServerInfoSections([section({ id: 'roles', kind: 'roles' })], { main, levels });
  assert.deepEqual(outline(empty.sections[0].items), outline(main), 'pusta sekcja — cała propozycja z nagłówkami');
});

test('serwer info: kontekst opisów — kanał ticketów, kanał bumpów i role do wzięcia z wiadomości bota', async () => {
  const { store } = await createTestStore();
  const bot = makeBot({ store, discord: fakeDiscord() });
  await store.setState('ticket_panel', { channelId: '700000000000000001', messageId: '700000000000000009' });
  await store.addSentMessage({ channelId: '700000000000000002', messageId: '1', data: { roles: { mode: 'buttons', items: [{ roleId: id(1) }, { roleId: id(2) }] } } });
  await store.addSentMessage({ channelId: '700000000000000003', messageId: '2', data: { roles: { mode: 'select', items: [{ roleId: id(2) }, { roleId: id(3) }] } } });
  await store.addSentMessage({ channelId: '700000000000000004', messageId: '3', data: { roles: { mode: 'none', items: [{ roleId: id(4) }] } } });
  const config = sanitizeConfig({ tickets: { enabled: true }, bump: { channelId: '700000000000000005' } }, structuredClone(DEFAULT_CONFIG));
  const ctx = await serverInfoContext(bot, config);
  assert.equal(ctx.ticketChannelId, '700000000000000001');
  assert.equal(ctx.bumpChannelId, '700000000000000005');
  assert.deepEqual([...ctx.selfRoles], [[id(1), '700000000000000002'], [id(2), '700000000000000002'], [id(3), '700000000000000003']], 'rola z kilku wiadomości — pierwsza wysłana; „bez wyboru” się nie liczy');
  const off = await serverInfoContext(bot, structuredClone(DEFAULT_CONFIG));
  assert.equal(off.ticketChannelId, '', 'tickety wyłączone — bez linku do ticketów');
});

test('serwer info w panelu: podpowiedzi komend, wysyłka, aktualizacja, nowa wiadomość i ponowne wysłanie po usunięciu', async () => {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  discord.state.commands = [{ name: 'rank' }, { name: 'ranking' }];
  const bot = makeBot({ store, discord });
  const call = (method, path, body) => handlePanel(bot, { method, path, body });

  const info = await call('GET', '/serverinfo');
  assert.equal(info.status, 200);
  assert.equal(info.body.posted, null);
  assert.deepEqual(info.body.commandIds, { rank: '200000000000000000', ranking: '200000000000000001' });
  assert.equal(info.body.guildId, 'g1');
  const names = info.body.commands.map((c) => c.name);
  for (const command of ['rank', 'przypomnij dodaj', 'bumpy status', 'prywatnosc']) assert.ok(names.includes(command), command);
  for (const command of ['ban', 'warn dodaj', 'xp dodaj']) assert.ok(!names.includes(command), `${command} — tylko dla moderacji`);

  const noChannel = await call('POST', '/serverinfo/send', {});
  assert.equal(noChannel.status, 400);
  assert.match(noChannel.body.error, /Wybierz kanał/);

  await store.updateConfig({ serverInfo: { channelId: CHANNEL } });
  const sent = await call('POST', '/serverinfo/send', {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.result.action, 'sent');
  const message = discord.state.channels.get(CHANNEL).at(-1);
  assert.equal(message.embeds.length, 3, 'domyślnie: role, role za poziomy, komendy');
  assert.equal(message.embeds[0].title, 'Entuzjaści Hopkostki | Informacje o rolach 📋 *(Główne)*');
  assert.match(message.embeds[1].description, /Swój poziom sprawdzisz komendą <\/rank:200000000000000000>\./);
  assert.match(message.embeds[2].description, /🔹 <\/rank:200000000000000000> — Twoja karta poziomu/);
  assert.match(message.embeds[2].description, /🔹 <\/bump:947088344167366698> — podbij serwer na DISBOARD/);
  assert.match(message.embeds[2].description, /🔹 `\/prywatnosc`/, 'komenda bez znanego ID — jako kod');
  assert.doesNotMatch(message.embeds[2].description, /losuj|login/, 'bez gier i logowania do panelu');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.deepEqual(message.embeds[2].footer, { text: 'Entuzjaści Hopkostki' });
  assert.equal((await store.getState('server_info_message')).messageId, message.id);

  const updated = await call('POST', '/serverinfo/send', {});
  assert.equal(updated.body.result.action, 'updated');
  assert.equal(discord.state.editedMessages.at(-1).id, message.id);
  assert.equal(discord.state.channels.get(CHANNEL).length, 1, 'aktualizacja zamiast nowej wiadomości');

  // Wiadomość usunięta na Discordzie — bot wysyła nową.
  const patch = discord.patch;
  discord.patch = async () => {
    throw new DiscordError(404, { code: 10008, message: 'Unknown Message' });
  };
  const resent = await call('POST', '/serverinfo/send', {});
  discord.patch = patch;
  assert.equal(resent.body.result.action, 'sent');
  assert.equal(discord.state.channels.get(CHANNEL).length, 2);

  // „Wyślij jako nową” i inny kanał — zawsze nowa wiadomość.
  assert.equal((await call('POST', '/serverinfo/send', { asNew: true })).body.result.action, 'sent');
  assert.equal(discord.state.channels.get(CHANNEL).length, 3);
  const moved = await call('POST', '/serverinfo/send', { channelId: OTHER });
  assert.equal(moved.body.result.action, 'sent');
  assert.equal(discord.state.channels.get(OTHER).length, 1);
  const posted = (await call('GET', '/serverinfo')).body.posted;
  assert.equal(posted.channelId, OTHER);
  assert.deepEqual(posted.banners, []);
});

test('serwer info: „Uzupełnij role z serwera” — do szkicu z panelu albo od razu do ustawień (save)', async () => {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const extra = [
    { id: id(1), name: '| Właściciel', position: 20, permissions: '0', color: 0x1abc9c },
    { id: id(2), name: '| Ping Dead Chat', position: 3, permissions: '0', color: 0 },
    { id: id(3), name: 'Level 5', position: 2, permissions: '0', color: 0 },
  ];
  const get = discord.get;
  discord.get = async (path, opts) => {
    const result = await get(path, opts);
    return path === '/guilds/g1' ? { ...result, roles: [...result.roles, ...extra] } : result;
  };
  const bot = makeBot({ store, discord });
  const call = (method, path, body) => handlePanel(bot, { method, path, body });

  // Szkic z panelu: przysłane sekcje + brakujące role serwera, bez zapisu.
  const draft = structuredClone((await store.getConfig()).serverInfo.sections);
  draft[0].items = [{ kind: 'role', roleId: id(1), text: 'Szef' }];
  const preview = await call('POST', '/serverinfo/fill', { sections: draft });
  assert.equal(preview.status, 200);
  const roles = preview.body.sections[0].items;
  assert.deepEqual(roles[0], { kind: 'role', roleId: id(1), text: 'Szef' });
  assert.ok(roles.some((i) => i.roleId === id(2) && /pusto/.test(i.text)));
  assert.deepEqual(preview.body.sections[1].items.map((i) => i.roleId), [id(3)]);
  assert.ok(preview.body.added >= 2);
  assert.deepEqual((await store.getConfig()).serverInfo.sections[0].items, [], 'bez save nic się nie zapisuje');

  // save: true — od razu w ustawieniach (+ wpis w dzienniku zmian). Testowe role bez ID Discorda odpadają przy zapisie.
  const saved = await call('POST', '/serverinfo/fill', { save: true });
  assert.equal(saved.status, 200);
  const sections = (await store.getConfig()).serverInfo.sections;
  assert.deepEqual(sections[0].items.map((i) => (i.kind === 'heading' ? i.text : i.roleId)), ['Administracja', id(1), 'Powiadomienia', id(2)]);
  assert.deepEqual(sections[1].items.map((i) => i.roleId), [id(3)]);
  assert.equal(sections[2].items.length, DEFAULT_CONFIG.serverInfo.sections[2].items.length, 'komendy bez zmian');
  assert.deepEqual((await store.listConfigHistory(5))[0].keys, ['serverInfo']);
});

test('serwer info: baner z panelu — publiczny adres, typ obrazka, odrzucanie złych plików i sprzątanie nieużywanych', async () => {
  const { store } = await createTestStore();
  const selfUrl = 'https://example.supabase.co/functions/v1/hopkostki-bot?forceFunctionRegion=eu-central-1';
  const bot = makeBot({ store, discord: fakeDiscord(), env: { selfUrl } });
  const handle = createHandler(bot);
  const upload = (data) =>
    handle(
      new Request('https://example.supabase.co/functions/v1/hopkostki-bot/panel/serverinfo/banner', {
        method: 'POST',
        headers: { 'x-panel-password': 'tajne', 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      }),
    );

  const res = await upload(PNG);
  assert.equal(res.status, 200);
  const first = await res.json();
  assert.match(first.id, /^[a-f0-9]{24}\.png$/);
  assert.equal(first.url, `https://example.supabase.co/functions/v1/hopkostki-bot/panel/public/asset/${first.id}`, 'bez ?forceFunctionRegion');

  // Bez hasła — Discord pobiera obrazek do embeda.
  const image = await handle(new Request(first.url));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control'), /immutable/);
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(1, 4)), 'PNG');
  assert.equal(Number(image.headers.get('content-length')), bytes.length);
  const head = await handle(new Request(first.url, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/png');
  assert.equal((await handle(new Request(first.url.replace(/[a-f0-9]{24}/, '0'.repeat(24))))).status, 404);

  for (const data of ['data:text/html;base64,PGgxPg==', 'nie obrazek', `data:image/png;base64,${'A'.repeat(4_300_000)}`]) {
    const bad = await upload(data);
    assert.equal(bad.status, 400, data.slice(0, 30));
    assert.match((await bad.json()).error, /obrazek|za duży/i);
  }

  // Sprzątanie: obrazek z ustawień zostaje, nieużywany starszy niż dzień znika, świeży zostaje (może czekać na zapis).
  const unused = await (await upload(PNG)).json();
  const fresh = await (await upload(PNG)).json();
  const sections = structuredClone((await store.getConfig()).serverInfo.sections);
  sections[0].banner = first.url;
  await store.updateConfig({ serverInfo: { sections } });
  await store.query("update bot.assets set created_at = now() - interval '2 days' where id <> $1", [fresh.id]);
  await pruneBannerAssets(bot);
  const left = (await store.query('select id from bot.assets')).map((r) => r.id).sort();
  assert.deepEqual(left, [first.id, fresh.id].sort());
  assert.ok(!left.includes(unused.id));
});

test('serwer info: zapis ustawień czyści sekcje i elementy', () => {
  const current = structuredClone(DEFAULT_CONFIG);
  const out = sanitizeConfig(
    {
      serverInfo: {
        bullet: 'nie emoji',
        footer: `  ${'x'.repeat(250)} `,
        sections: [
          {
            id: 'roles',
            kind: 'roles',
            title: ' Role ',
            intro: 'a\r\nb',
            banner: 'http://niebezpieczny.example/a.png',
            items: [
              { kind: 'role', roleId: '123', text: 'za krótkie ID' },
              { kind: 'role', roleId: id(1), text: ' Opis ' },
              { kind: 'heading', text: '   ' },
              { kind: 'command', command: '/Rank', text: 'x' },
              { kind: 'command', command: 'przypomnij  dodaj', commandId: 'abc', text: 'y' },
              { kind: 'command', command: 'zła komenda!', text: 'z' },
              { kind: 'nieznany', text: 'q' },
            ],
          },
          { id: 'roles', kind: 'cos', title: 'Druga', banner: 'https://ok.example/b.webp', items: 'nie lista' },
          ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, kind: 'text', title: `S${i}`, items: [] })),
        ],
      },
    },
    current,
  );
  const info = out.serverInfo;
  assert.equal(info.bullet, DEFAULT_CONFIG.serverInfo.bullet, 'zły znaczek — zostaje poprzedni');
  assert.equal(info.footer.length, 200);
  assert.equal(info.sections.length, 6, 'najwyżej 6 sekcji');
  assert.deepEqual(info.sections[0], {
    id: 'roles',
    kind: 'roles',
    title: 'Role',
    intro: 'a\nb',
    banner: '',
    items: [
      { kind: 'role', roleId: id(1), text: 'Opis' },
      { kind: 'command', command: 'rank', commandId: '', text: 'x' },
      { kind: 'command', command: 'przypomnij dodaj', commandId: '', text: 'y' },
    ],
  });
  assert.deepEqual([info.sections[1].id, info.sections[1].kind, info.sections[1].banner, info.sections[1].items], ['roles-2', 'text', 'https://ok.example/b.webp', []]);
  assert.equal(sanitizeConfig({ serverInfo: { bullet: '' } }, current).serverInfo.bullet, '', 'bez znaczka');
  assert.equal(sanitizeConfig({ serverInfo: { bullet: '<:hopka:100000000000000070>' } }, current).serverInfo.bullet, '<:hopka:100000000000000070>');
  assert.equal(sanitizeConfig({ serverInfo: { sections: 'x' } }, current).serverInfo.sections, current.serverInfo.sections);
});

test('serwer info: dostęp — osobna część panelu', async () => {
  const { store } = await createTestStore();
  const bot = makeBot({ store, discord: fakeDiscord() });
  const limited = { kind: 'session', full: false, sections: ['serwerinfo'], user: { id: '1', tag: 'kasia' } };
  const other = { kind: 'session', full: false, sections: ['bump'], user: { id: '2', tag: 'janek' } };
  const call = (auth, method, path, body) => handlePanel(bot, { method, path, body, auth });
  assert.equal((await call(limited, 'GET', '/serverinfo')).status, 200);
  assert.equal((await call(other, 'GET', '/serverinfo')).status, 403);
  assert.equal((await call(other, 'POST', '/serverinfo/send', {})).status, 403);
  assert.equal((await call(other, 'POST', '/serverinfo/banner', { data: PNG })).status, 403);
  await call(limited, 'PUT', '/config', { serverInfo: { footer: 'Nowa stopka' }, bump: { enabled: true } });
  const config = await store.getConfig();
  assert.equal(config.serverInfo.footer, 'Nowa stopka');
  assert.equal(config.bump.enabled, false, 'bez dostępu do Bumpa — pominięte');
});
