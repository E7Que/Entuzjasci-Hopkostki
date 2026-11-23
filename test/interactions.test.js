import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, commandPayload } from './support/discord.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';

const hex = (buf) => Buffer.from(buf).toString('hex');

// Klucze jak u Discorda: prywatnym "Discord" podpisuje, publiczny zna bot.
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { pair, publicHex: hex(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

async function setup(env = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const { pair, publicHex } = await keys();
  discord.state.verifyKey = publicHex;
  const bot = makeBot({ store, discord, env });
  const tasks = [];
  const handle = createHandler(bot, { waitUntil: (p) => tasks.push(p) });

  async function send(body, { badSignature = false } = {}) {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hex(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(timestamp + raw)));
    const response = await handle(
      new Request('https://x.supabase.co/functions/v1/hopkostki-bot', {
        method: 'POST',
        headers: { 'x-signature-ed25519': badSignature ? signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) : signature, 'x-signature-timestamp': timestamp },
        body: raw,
      }),
    );
    await Promise.all(tasks.splice(0));
    return response;
  }
  return { bot, store, discord, send, handle };
}

const opt = (name, value, type = 3) => ({ name, type, value });

test('PING z poprawnym podpisem dostaje PONG, zły podpis = 401', async () => {
  const s = await setup();
  const ok = await s.send({ type: 1 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { type: 1 });
  const bad = await s.send({ type: 1 }, { badSignature: true });
  assert.equal(bad.status, 401);
});

test('/ban: odroczona odpowiedź, a w tle ban + embed z oznaczeniem', async () => {
  const s = await setup();
  const response = await s.send(
    commandPayload('ban', [opt('uzytkownik', 'target', 6), opt('powod', 'Wielokrotne łamanie zasad'), opt('czas', 14, 4), opt('jednostka', 'd')]),
  );
  assert.deepEqual(await response.json(), { type: 5, data: {} });
  assert.ok(s.discord.state.bans.has('target'));
  const edit = s.discord.state.webhook.find((w) => w.op === 'edit');
  assert.equal(edit.body.content, '<@target>');
  assert.equal(edit.body.embeds[0].fields.find((f) => f.name === '⏱️ Czas trwania').value, '**14 dni**');
  assert.equal((await s.store.listTempBans()).length, 1);
});

test('brak uprawnień = prywatny błąd bez odraczania', async () => {
  const s = await setup();
  const response = await s.send(commandPayload('ban', [opt('uzytkownik', 'target', 6), opt('powod', 'x')], { roles: [], permissions: '0' }));
  const body = await response.json();
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.embeds[0].description, /Nie masz uprawnień/);
  assert.equal(s.discord.state.bans.size, 0);
});

test('rola moderatora z panelu daje dostęp mimo braku uprawnień Discorda', async () => {
  const s = await setup();
  await s.store.updateConfig({ modRoleIds: ['123456789012345678'] });
  const response = await s.send(
    commandPayload('warn', [{ name: 'status', type: 1, options: [opt('uzytkownik', 'target', 6)] }], { roles: ['123456789012345678'], permissions: '0' }),
  );
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  const edit = s.discord.state.webhook.find((w) => w.op === 'edit');
  assert.equal(edit.body.embeds[0].author.name, 'hurownik_og • Ostrzeżenia');
});

test('błąd hierarchii: publiczne "myśli..." znika, błąd widzi tylko moderator', async () => {
  const s = await setup();
  const payload = commandPayload('kick', [opt('uzytkownik', 'target', 6), opt('powod', 'x')], {
    members: { target: { roles: ['r-admin'] } },
  });
  const response = await s.send(payload);
  assert.equal((await response.json()).type, 5);
  assert.equal(s.discord.state.kicked.length, 0);
  assert.deepEqual(s.discord.state.webhook.map((w) => w.op), ['delete', 'followup']);
  const followup = s.discord.state.webhook[1].body;
  assert.equal(followup.flags, 64);
  assert.match(followup.embeds[0].description, /równą lub wyższą/);
});

test('/timeout powyżej 28 dni jest odrzucany', async () => {
  const s = await setup();
  await s.send(commandPayload('timeout', [opt('uzytkownik', 'target', 6), opt('czas', 1, 4), opt('jednostka', 'mo'), opt('powod', 'x')]));
  assert.equal(s.discord.state.timeouts.length, 0);
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /maksymalnie \*\*28 dni\*\*/);
});

test('autouzupełnianie /unban podpowiada zbanowanych', async () => {
  const s = await setup();
  s.discord.state.bans.set('target', { user: { id: '123456789012345678', username: 'hurownik_og' } });
  const response = await s.send({
    ...commandPayload('unban'),
    type: 4,
    data: { name: 'unban', options: [{ name: 'uzytkownik', type: 3, value: 'hur', focused: true }] },
  });
  assert.deepEqual(await response.json(), { type: 8, data: { choices: [{ name: 'hurownik_og (123456789012345678)', value: '123456789012345678' }] } });
});

test('/lock blokuje pisanie dla @everyone', async () => {
  const s = await setup();
  await s.send(commandPayload('lock', [], { roles: ['r-admin'], permissions: String(1n << 3n) }));
  const overwrite = s.discord.state.overwrites.get('chan');
  assert.equal(overwrite.id, 'g1');
  assert.equal(BigInt(overwrite.deny) & (1n << 11n), 1n << 11n);
  await s.send(commandPayload('unlock', [], { roles: ['r-admin'], permissions: String(1n << 3n) }));
  assert.equal(BigInt(s.discord.state.overwrites.get('chan').deny) & (1n << 11n), 0n);
});

test('/health działa bez sekretów i nie ujawnia ich', async () => {
  const s = await setup();
  const response = await s.handle(new Request('https://x.supabase.co/functions/v1/hopkostki-bot/health'));
  assert.deepEqual(await response.json(), { ok: true, tokenConfigured: true, panelPasswordConfigured: true, ed25519: true });
});

// ---------- Widoki ze stronami (◀ 1 2 3 ▶) i listy wyboru ----------

const sub = (name, options = []) => ({ name, type: 1, options });
const ALL_MOD = String((1n << 2n) | (1n << 1n) | (1n << 40n) | (1n << 13n) | (1n << 27n) | (1n << 28n));

// Kliknięcie przycisku lub wybór z listy — tak jak wysyła to Discord.
function componentPayload(customId, { values, permissions = String((1n << 2n) | (1n << 1n) | (1n << 40n)), roles = ['r-mod'], user = { id: 'mod', username: 'dfgbh65' } } = {}) {
  return {
    type: 3,
    id: 'c1',
    application_id: 'app',
    token: 'tok-component',
    guild_id: 'g1',
    channel_id: 'chan',
    member: { user, roles, permissions },
    message: { id: '1', flags: 64 },
    data: values ? { custom_id: customId, component_type: 3, values } : { custom_id: customId, component_type: 2 },
  };
}

const lastEdit = (s) => s.discord.state.webhook.filter((w) => w.op === 'edit').at(-1).body;
const buttons = (body) => body.components.find((row) => row.components[0].type === 2)?.components ?? [];
const select = (body) => body.components.find((row) => row.components[0].type === 3)?.components[0];

async function addWarns(store, n) {
  const warns = [];
  for (let i = 1; i <= n; i += 1) {
    warns.push(
      await store.addWarn(
        { guildId: 'g1', userId: 'target', userTag: 'hurownik_og', moderatorId: 'mod', moderatorTag: 'dfgbh65', reason: `powód ${i}`, points: 1, caseId: null },
        60,
      ),
    );
  }
  return warns;
}

test('/warn dodaj: kilka osób naraz — każda dostaje własne ostrzeżenie i ogłoszenie; powtórki i boty pominięte', async () => {
  const s = await setup();
  const second = { id: 'target2', username: 'drugi_gracz', avatar: null };
  s.discord.state.users.set('target2', second);
  s.discord.state.members.set('target2', { user: second, roles: ['r-member'] });
  await s.send(
    commandPayload(
      'warn',
      [sub('dodaj', [opt('uzytkownik', 'target', 6), opt('powod', 'spam na ogólnym'), opt('punkty', 2, 4), opt('osoba2', 'target2', 6), opt('osoba3', 'target', 6), opt('osoba4', 'bot', 6)])],
      { resolvedIds: ['target', 'target2', 'bot'] },
    ),
  );
  const [first] = await s.store.getWarns('target');
  const [other] = await s.store.getWarns('target2');
  assert.equal((await s.store.getWarns('target')).length, 1, 'ta sama osoba dwa razy = jedno ostrzeżenie');
  assert.deepEqual([first.points, first.reason, other.points, other.reason], [2, 'spam na ogólnym', 2, 'spam na ogólnym']);
  assert.notEqual(first.caseId, other.caseId, 'osobne sprawy');

  // Pierwsza osoba w odpowiedzi na komendę, druga — osobnym ogłoszeniem na tym samym kanale.
  const edit = s.discord.state.webhook.find((w) => w.op === 'edit');
  assert.match(JSON.stringify(edit.body), /<@target>/);
  assert.doesNotMatch(JSON.stringify(edit.body), /target2/);
  assert.ok((s.discord.state.channels.get('chan') ?? []).some((m) => JSON.stringify(m).includes('<@target2>')), 'ogłoszenie dla drugiej osoby');
  assert.deepEqual(s.discord.state.dms.map((d) => d.channel_id).sort(), ['dm-target', 'dm-target2'], 'każda osoba dostaje wiadomość prywatną');

  // Bot pominięty — moderator dostaje prywatnie wyjaśnienie.
  const note = s.discord.state.webhook.find((w) => w.op === 'followup');
  assert.equal(note.body.flags, 64);
  assert.match(note.body.embeds[0].description, /<@bot> — Botów nie można ostrzegać/);
  assert.match(note.body.embeds[0].description, /Ostrzeżono: <@target>, <@target2>/);
});

test('/warn dodaj: gdy nikogo nie można ostrzec — błąd z powodem dla każdej osoby', async () => {
  const s = await setup();
  await s.send(commandPayload('warn', [sub('dodaj', [opt('uzytkownik', 'bot', 6), opt('powod', 'test'), opt('osoba2', 'owner', 6)])], { resolvedIds: ['bot', 'owner'] }));
  assert.equal((await s.store.getWarns('owner')).length, 0);
  const reply = s.discord.state.webhook.find((w) => w.op === 'followup');
  assert.match(reply.body.embeds[0].description, /<@bot>: Botów nie można ostrzegać\.\n<@owner>: /);
});

test('/warn usun: przewinienia na stronach, przyciski ◀ 1 2 ▶ i usuwanie z listy', async () => {
  const s = await setup();
  const warns = await addWarns(s.store, 7);
  const response = await s.send(commandPayload('warn', [sub('usun', [opt('uzytkownik', 'target', 6)])]));
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });

  let body = lastEdit(s);
  assert.equal(body.embeds[0].fields.length, 5);
  assert.match(body.embeds[0].footer.text, /^Strona 1\/2/);
  assert.deepEqual(buttons(body).map((b) => [b.label, b.disabled]), [['◀', true], ['1', true], ['2', false], ['▶', false]]);
  assert.equal(select(body).options.length, 5);

  // Strona 2: Discord dostaje od razu "aktualizuję wiadomość", a nowa strona przychodzi edycją.
  const page = await s.send(componentPayload(buttons(body)[2].custom_id));
  assert.deepEqual(await page.json(), { type: 6 });
  body = lastEdit(s);
  assert.equal(body.embeds[0].fields.length, 2);
  assert.match(body.embeds[0].footer.text, /^Strona 2\/2/);
  assert.deepEqual(buttons(body).map((b) => b.disabled), [false, false, true, true]);

  // Wybór z listy usuwa zaznaczone ostrzeżenia i odświeża widok.
  const toDelete = select(body).options.map((o) => o.value);
  await s.send(componentPayload(select(body).custom_id, { values: toDelete }));
  body = lastEdit(s);
  assert.match(body.embeds[0].description, new RegExp(`✅ Usunięto: ${toDelete.map((id) => `\\*\\*#${id}\\*\\*`).join(', ')}`));
  assert.equal((await s.store.getWarns('target')).length, 5);
  assert.deepEqual(buttons(body), [], 'po usunięciu mieści się na jednej stronie');
  assert.equal(warns.length, 7);
});

test('/warn usun z numerem usuwa od razu to jedno ostrzeżenie', async () => {
  const s = await setup();
  const [first] = await addWarns(s.store, 2);
  await s.send(commandPayload('warn', [sub('usun', [opt('uzytkownik', 'target', 6), opt('numer', first.id, 4)])]));
  assert.match(lastEdit(s).embeds[0].description, new RegExp(`Usunięto: \\*\\*#${first.id}\\*\\*`));
  assert.equal((await s.store.getWarns('target')).length, 1);
});

test('przyciski widoków wymagają uprawnień moderatora', async () => {
  const s = await setup();
  const response = await s.send(componentPayload('pg|wd|target|2|n2', { roles: [], permissions: '0' }));
  const body = await response.json();
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.embeds[0].description, /Nie masz uprawnień/);
});

test('/unban bez użytkownika: lista banów ze stronami i odbanowanie z listy', async () => {
  const s = await setup();
  for (let i = 0; i < 12; i += 1) {
    s.discord.state.users.set(`u${i}`, { id: `u${i}`, username: `zbanowany${i}` });
    s.discord.state.bans.set(`u${i}`, { user: s.discord.state.users.get(`u${i}`) });
  }
  const response = await s.send(commandPayload('unban', []));
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  let body = lastEdit(s);
  assert.match(body.embeds[0].title, /Zbanowani użytkownicy \(12\)/);
  assert.equal(select(body).options.length, 10);
  assert.deepEqual(buttons(body).map((b) => b.label), ['◀', '1', '2', '▶']);

  await s.send(componentPayload(select(body).custom_id, { values: ['u0', 'u1'] }));
  body = lastEdit(s);
  assert.match(body.embeds[0].description, /Odbanowano: \*\*zbanowany0, zbanowany1\*\*/);
  assert.equal(s.discord.state.bans.size, 10);
  assert.equal((await s.store.listCases({ type: 'unban' })).total, 2);
});

test('/historia i /sprawy mają strony', async () => {
  const s = await setup();
  for (let i = 0; i < 9; i += 1) {
    await s.store.addCase({ guildId: 'g1', type: 'kick', userId: 'target', userTag: 'hurownik_og', moderatorId: 'mod', moderatorTag: 'dfgbh65', reason: `r${i}` });
  }
  await s.send(commandPayload('historia', [opt('uzytkownik', 'target', 6)]));
  let body = lastEdit(s);
  assert.equal(body.embeds[0].fields.length, 6);
  assert.match(body.embeds[0].footer.text, /^Strona 1\/2 • 9 spraw/);

  await s.send(commandPayload('sprawy', []));
  body = lastEdit(s);
  assert.equal(body.embeds[0].fields.length, 8);
  await s.send(componentPayload(buttons(body).at(-1).custom_id));
  assert.equal(lastEdit(s).embeds[0].fields.length, 1);
});

test('/notatka: dodawanie, lista i usuwanie z listy', async () => {
  const s = await setup();
  await s.send(commandPayload('notatka', [sub('dodaj', [opt('uzytkownik', 'target', 6), opt('tresc', 'podejrzany o multikonto')])]));
  let body = lastEdit(s);
  assert.match(body.embeds[0].description, /Dodano notatkę \*\*#1\*\*/);
  assert.match(body.embeds[0].fields[0].value, /podejrzany o multikonto/);
  await s.send(componentPayload(select(body).custom_id, { values: ['1'] }));
  body = lastEdit(s);
  assert.match(body.embeds[0].description, /Usunięto notatki: \*\*#1\*\*/);
  assert.equal((await s.store.listNotes('target')).length, 0);
});

// ---------- Nowe komendy ----------

test('/rola dodaj i usun sprawdzają hierarchię ról', async () => {
  const s = await setup();
  const perms = { permissions: ALL_MOD };
  await s.send(commandPayload('rola', [sub('dodaj', [opt('uzytkownik', 'target', 6), opt('rola', 'r-fan', 8)])], perms));
  assert.deepEqual(s.discord.state.members.get('target').roles, ['r-member', 'r-fan']);

  await s.send(commandPayload('rola', [sub('dodaj', [opt('uzytkownik', 'target', 6), opt('rola', 'r-mod', 8)])], perms));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /równa lub wyższa od Twojej/);

  await s.send(
    commandPayload('rola', [sub('usun', [opt('uzytkownik', 'target', 6), opt('rola', 'r-fan', 8)])], {
      ...perms,
      members: { target: { roles: ['r-member', 'r-fan'] } },
    }),
  );
  assert.deepEqual(s.discord.state.members.get('target').roles, ['r-member']);
});

test('/nick zmienia pseudonim, /ogloszenie nie pozwala na @everyone bez uprawnień', async () => {
  const s = await setup();
  await s.send(commandPayload('nick', [opt('uzytkownik', 'target', 6), opt('nowy_nick', 'Hopek')], { permissions: ALL_MOD }));
  const patch = s.discord.state.calls.find((c) => c.method === 'PATCH' && c.path === '/guilds/g1/members/target');
  assert.deepEqual(patch.body, { nick: 'Hopek' });

  await s.send(commandPayload('ogloszenie', [opt('tytul', 'Turniej'), opt('tresc', 'Linia 1\\nLinia 2'), opt('oznacz', 'everyone')], { permissions: ALL_MOD }));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /oznaczania @everyone/);

  await s.send(commandPayload('ogloszenie', [opt('tytul', 'Turniej'), opt('tresc', 'Linia 1\\nLinia 2'), opt('kolor', '#57F287')], { permissions: ALL_MOD }));
  const post = s.discord.state.calls.filter((c) => c.method === 'POST' && c.path === '/channels/chan/messages').at(-1).body;
  assert.equal(post.embeds[0].title, 'Turniej');
  assert.equal(post.embeds[0].description, 'Linia 1\nLinia 2');
  assert.equal(post.embeds[0].color, 0x57f287);
  assert.deepEqual(post.allowed_mentions, { parse: [] });
});

test('/serwer pokazuje statystyki moderacji tylko moderatorom, /info ma przyciski widoków', async () => {
  const s = await setup();
  await s.send(commandPayload('serwer', [], { roles: [], permissions: '0' }));
  let fields = lastEdit(s).embeds[0].fields.map((f) => f.name);
  assert.ok(fields.includes('👥 Członkowie'));
  assert.ok(!fields.includes('⚠️ Aktywne ostrzeżenia'));
  await s.send(commandPayload('serwer', []));
  fields = lastEdit(s).embeds[0].fields.map((f) => f.name);
  assert.ok(fields.includes('⚠️ Aktywne ostrzeżenia'));

  await s.send(commandPayload('info', [opt('uzytkownik', 'target', 6)]));
  const body = lastEdit(s);
  assert.deepEqual(buttons(body).map((b) => b.custom_id), ['pg|ws|target|1|i', 'pg|h|target|1|i', 'pg|n|target|1|i']);
  await s.send(componentPayload('pg|ws|target|1|i'));
  assert.equal(lastEdit(s).embeds[0].author.name, 'hurownik_og • Ostrzeżenia');
});

test('nadpisanie uprawnień z panelu ogranicza komendę do wybranych ról (i widoki, które z niej korzystają)', async () => {
  const s = await setup();
  const VIP = '100000000000000020'; // ID jak prawdziwy snowflake — wymaga tego sanitizer konfiguracji
  // Moderator ma uprawnienie Discorda MODERATE_MEMBERS, ale komenda /notatka jest nadpisana na rolę VIP.
  // (Celowo komenda bez sprawdzania hierarchii ról jak /kick — nadpisanie testujemy niezależnie od niej.)
  await s.store.updateConfig({ commandPermissions: { notatka: [VIP] } });

  const deniedForMod = await s.send(commandPayload('notatka', [sub('dodaj', [opt('uzytkownik', 'target', 6), opt('tresc', 'test')])]));
  const deniedBody = await deniedForMod.json();
  assert.equal(deniedBody.type, 4);
  assert.match(deniedBody.data.embeds[0].description, /Nie masz uprawnień/);
  assert.equal((await s.store.listNotes('target')).length, 0);

  const allowed = await s.send(
    commandPayload('notatka', [sub('dodaj', [opt('uzytkownik', 'target', 6), opt('tresc', 'test')])], { roles: [VIP], permissions: '0' }),
  );
  assert.deepEqual(await allowed.json(), { type: 5, data: { flags: 64 } });
  assert.equal((await s.store.listNotes('target')).length, 1);

  // Widok "Notatki" (np. przycisk z /info) dziedziczy to samo nadpisanie komendy "notatka".
  const viewDenied = await s.send(componentPayload('pg|n|target|1|i', { roles: ['r-mod'], permissions: String((1n << 2n) | (1n << 1n) | (1n << 40n)) }));
  const viewBody = await viewDenied.json();
  assert.equal(viewBody.type, 4);
  assert.match(viewBody.data.embeds[0].description, /Nie masz uprawnień/);
  const viewAllowed = await s.send(componentPayload('pg|n|target|1|i', { roles: [VIP], permissions: '0' }));
  assert.deepEqual(await viewAllowed.json(), { type: 6 });
});

test('lista ról obowiązuje też administratora, a właściciel serwera ma dostęp zawsze (komenda, podpowiedzi, widoki)', async () => {
  const s = await setup();
  const VIP = '100000000000000020';
  const ADMIN = String(1n << 3n);
  // /unban (i jego lista banów) tylko dla VIP-a, /historia z pustą listą — czyli tylko dla właściciela.
  await s.store.updateConfig({ commandPermissions: { unban: [VIP], historia: [] } });
  s.discord.state.bans.set('target', { user: { id: '123456789012345678', username: 'hurownik_og' } });
  const suggestions = async (who) => {
    const focused = { name: 'unban', options: [{ name: 'uzytkownik', type: 3, value: 'hur', focused: true }] };
    return (await (await s.send({ ...commandPayload('unban', [], who), type: 4, data: focused })).json()).data.choices.length;
  };
  const historia = async (who) => (await s.send(commandPayload('historia', [opt('uzytkownik', 'target', 6)], who))).json();
  const bansView = async (member) => (await s.send(componentPayload('pg|b|-|1', member))).json();

  // Rola z uprawnieniem Administrator spoza listy: bez komendy, podpowiedzi i listy ze stronami.
  const admin = { roles: ['r-admin'], permissions: ADMIN };
  assert.match((await historia(admin)).data.embeds[0].description, /Nie masz uprawnień/);
  assert.equal(await suggestions(admin), 0);
  assert.match((await bansView(admin)).data.embeds[0].description, /Nie masz uprawnień/);

  // Rola z listy — dostęp bez żadnych uprawnień Discorda.
  const vip = { roles: [VIP], permissions: '0' };
  assert.equal(await suggestions(vip), 1);
  assert.deepEqual(await bansView(vip), { type: 6 });

  // Właściciel serwera nie ma żadnej roli z list, a mimo to może wszystko — także przy pustej liście.
  const owner = { invoker: 'owner', roles: [], permissions: ADMIN };
  assert.deepEqual(await historia(owner), { type: 5, data: { flags: 64 } });
  assert.equal(lastEdit(s).embeds[0].author.name, 'hurownik_og • Historia kar');
  assert.equal(await suggestions(owner), 1);
  assert.deepEqual(await bansView({ ...owner, user: { id: 'owner', username: 'wlasciciel' } }), { type: 6 });
});

test('/serwer: statystyki moderacji widzą role z listy /sprawy i właściciel serwera', async () => {
  const s = await setup();
  const VIP = '100000000000000020';
  await s.store.updateConfig({ commandPermissions: { sprawy: [VIP] } });
  const seesStats = async (who) => {
    await s.send(commandPayload('serwer', [], who));
    return lastEdit(s).embeds[0].fields.some((f) => f.name === '⚠️ Aktywne ostrzeżenia');
  };
  assert.equal(await seesStats({}), false, 'moderator z uprawnieniem Discorda, ale spoza listy /sprawy');
  assert.equal(await seesStats({ roles: ['r-admin'], permissions: String(1n << 3n) }), false, 'administrator spoza listy');
  assert.equal(await seesStats({ roles: [VIP], permissions: '0' }), true);
  assert.equal(await seesStats({ invoker: 'owner', roles: [], permissions: String(1n << 3n) }), true);
});
