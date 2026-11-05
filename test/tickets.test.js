import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, GUILD } from './support/discord.js';
import { handleInteraction } from '../supabase/functions/hopkostki-bot/lib/interactions.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { ticketPanelMessage } from '../supabase/functions/hopkostki-bot/lib/tickets.js';
import { P } from '../supabase/functions/hopkostki-bot/lib/permissions.js';

const SUPPORT = '100000000000000080';
const CATEGORY = '100000000000000081';
const LOGS = '100000000000000082';
const PANEL_CHANNEL = '100000000000000083';

async function setup(tickets = {}) {
  const { store } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  await store.updateConfig({ tickets: { enabled: true, categoryId: CATEGORY, supportRoleIds: [SUPPORT], logChannelId: LOGS, ...tickets } });
  return { store, discord, bot };
}

function click(customId, { user = 'target', roles = [], permissions = '0', type = 3, values, components, message } = {}) {
  return {
    type,
    id: 'i4',
    application_id: 'app',
    token: `tok-${customId.replace(/\W/g, '-')}`,
    guild_id: GUILD,
    channel_id: 'chan',
    member: { user: { id: user, username: user }, roles, permissions },
    message,
    data: { custom_id: customId, ...(values ? { values } : {}), ...(components ? { components } : {}) },
  };
}

async function run(bot, body) {
  const result = await handleInteraction(body, bot);
  await result.task?.();
  return result;
}

const form = (value) => [{ type: 1, components: [{ type: 4, custom_id: 'value', value }] }];

test('panel ticketów: wysyłka na kanał, ponowna wysyłka aktualizuje tę samą wiadomość', async () => {
  const s = await setup({ types: [{ label: 'Pomoc', style: 'zielony', question: '' }, { label: 'Odwołanie', style: 'czerwony', question: 'Od czego się odwołujesz?' }] });
  const handle = createHandler(s.bot);
  const call = (body) =>
    handle(new Request('https://x.supabase.co/functions/v1/hopkostki-bot/panel/tickets/panel', { method: 'POST', headers: { 'x-panel-password': 'tajne' }, body: JSON.stringify(body) }));

  assert.equal((await call({ channelId: PANEL_CHANNEL })).status, 200);
  const panel = s.discord.state.channels.get(PANEL_CHANNEL)[0];
  assert.deepEqual(panel.components[0].components.map((b) => [b.label, b.style, b.custom_id]), [
    ['Pomoc', 3, 'tk|open|0'],
    ['Odwołanie', 4, 'tk|open|1'],
  ]);
  assert.equal((await call({ channelId: PANEL_CHANNEL })).status, 200);
  assert.equal(s.discord.state.channels.get(PANEL_CHANNEL).length, 1, 'bez duplikatu');
  assert.equal(s.discord.state.editedMessages.at(-1).id, panel.id);
});

test('otwarcie ticketu: okienko z pytaniem, prywatny kanał, powitanie z przyciskami, limit otwartych', async () => {
  const s = await setup();
  const modal = await run(s.bot, click('tk|open|0'));
  assert.equal(modal.response.type, 9);
  assert.equal(modal.response.data.components[0].components[0].label, 'Opisz krótko swoją sprawę');

  await run(s.bot, click('tkm|open|0', { type: 5, components: form('Nie działa mi rola') }));
  const [channel] = s.discord.state.createdChannels;
  assert.equal(channel.name, 'ticket-0001');
  assert.equal(channel.type, 0);
  assert.equal(channel.parent_id, CATEGORY);
  const byId = Object.fromEntries(channel.permission_overwrites.map((o) => [o.id, o]));
  assert.equal(BigInt(byId[GUILD].deny) & P.VIEW_CHANNEL, P.VIEW_CHANNEL, 'inni nie widzą ticketu');
  assert.equal(BigInt(byId.target.allow) & P.SEND_MESSAGES, P.SEND_MESSAGES);
  assert.equal(BigInt(byId[SUPPORT].allow) & P.VIEW_CHANNEL, P.VIEW_CHANNEL);

  const welcome = s.discord.state.channels.get(channel.id)[0];
  assert.equal(welcome.content, '<@target>', 'bez pingowania obsługi — i tak widzi kanał');
  assert.equal(welcome.embeds[0].fields[0].value, 'Nie działa mi rola');
  assert.deepEqual(welcome.components[0].components.map((b) => b.label), ['Zamknij', 'Przejmij', 'Dodaj osobę']);
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, new RegExp(`<#${channel.id}>`));
  assert.equal(s.discord.state.channels.get(LOGS).length, 1, 'log otwarcia');

  await run(s.bot, click('tkm|open|0', { type: 5, components: form('drugi') }));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /Masz już otwarty ticket/);
  assert.equal(s.discord.state.createdChannels.length, 1);
});

test('wybór: Zgłoszenie albo Partnerstwo — formularz partnerstwa z linkiem, liczbą członków i powodem', async () => {
  const s = await setup();
  s.discord.state.publicInvites.fajny = {
    code: 'fajny',
    guild: { id: '200000000000000001', name: 'Fajny *Serwer*' },
    approximate_member_count: 243,
    approximate_presence_count: 57,
    expires_at: null,
  };
  s.discord.state.publicInvites.nasz = { code: 'nasz', guild: { id: GUILD, name: 'Entuzjaści Hopkostki' } };

  const { tickets } = await s.store.getConfig();
  const panel = ticketPanelMessage(tickets);
  assert.deepEqual(panel.components[0].components.map((b) => [b.label, b.emoji?.name, b.custom_id]), [
    ['Zgłoszenie', '📩', 'tk|open|0'],
    ['Partnerstwo', '🤝', 'tk|open|1'],
  ]);

  // Najpierw ekran z regulaminem partnerstw; formularz dopiero po „Akceptuję regulamin”.
  const rules = await run(s.bot, click('tk|open|1'));
  assert.equal(rules.response.type, 4);
  assert.equal(rules.response.data.flags, 64);
  assert.equal(rules.response.data.embeds[0].title, 'Regulamin — Partnerstwo');
  assert.match(rules.response.data.embeds[0].description, /prawdziwa/);
  assert.deepEqual(rules.response.data.components[0].components.map((b) => b.custom_id), ['tk|accept|1', 'tk|decline|1']);
  const declined = await run(s.bot, click('tk|decline|1'));
  assert.equal(declined.response.type, 7);
  assert.match(declined.response.data.embeds[0].description, /Bez akceptacji regulaminu/);
  assert.equal((await run(s.bot, click('tk|open|0'))).response.type, 9, 'Zgłoszenie bez regulaminu od razu pokazuje formularz');
  const modal = await run(s.bot, click('tk|accept|1'));
  assert.equal(modal.response.type, 9);
  assert.equal(modal.response.data.custom_id, 'tkm|open|1');
  const inputs = modal.response.data.components.map((row) => row.components[0]);
  assert.deepEqual(inputs.map((i) => [i.custom_id, i.label, i.style, i.required]), [
    ['f0', 'Link do serwera', 1, true],
    ['f1', 'Liczba członków', 1, true],
    ['f2', 'Powód', 2, true],
  ]);

  const answers = (link, count, why = 'Podobna tematyka, chętnie się wymienimy.') => [
    { type: 1, components: [{ type: 4, custom_id: 'f0', value: link }] },
    { type: 1, components: [{ type: 4, custom_id: 'f1', value: count }] },
    { type: 1, components: [{ type: 4, custom_id: 'f2', value: why }] },
  ];
  // Z panelu (publiczna wiadomość) — błędna liczba: nic nie powstaje, odpowiedzi zostają w wiadomości z błędem.
  const wrong = await run(s.bot, click('tkm|open|1', { type: 5, components: answers('discord.gg/fajny', 'około 1,5k'), message: { id: 'panel', flags: 0 } }));
  assert.equal(wrong.response.type, 5);
  const error = s.discord.state.webhook.at(-1).body;
  assert.match(error.embeds[0].description, /Liczba członków.*jedną liczbę/);
  assert.deepEqual(error.embeds[0].fields.map((f) => [f.name, f.value]), [
    ['Link do serwera', 'https://discord.gg/fajny'],
    ['Liczba członków', 'około 1,5k'],
    ['Powód', 'Podobna tematyka, chętnie się wymienimy.'],
  ]);
  assert.equal(error.components[0].components[0].custom_id, 'tk|retry|1');
  assert.equal(s.discord.state.createdChannels.length, 0);

  // „Popraw formularz” otwiera okienko z wpisanymi wcześniej odpowiedziami.
  const retry = await run(s.bot, click('tk|retry|1', { message: { id: 'err', flags: 64, embeds: error.embeds } }));
  assert.equal(retry.response.type, 9);
  assert.deepEqual(retry.response.data.components.map((row) => row.components[0].value), [
    'https://discord.gg/fajny',
    'około 1,5k',
    'Podobna tematyka, chętnie się wymienimy.',
  ]);

  // Wysłane z wiadomości z błędem — aktualizuje ją (typ 6) zamiast dodawać nową.
  const fromError = { type: 5, message: { id: 'err', flags: 64 } };
  const dead = await run(s.bot, click('tkm|open|1', { ...fromError, components: answers('https://discord.com/invite/martwy', '1500') }));
  assert.equal(dead.response.type, 6);
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /discord\.gg\/martwy nie działa/);
  await run(s.bot, click('tkm|open|1', { ...fromError, components: answers('https://discord.gg/nasz', '1500') }));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /naszego serwera/);
  await run(s.bot, click('tkm|open|1', { ...fromError, components: answers('mój serwer', '1500') }));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /wklej link zaproszenia/);
  assert.equal(s.discord.state.createdChannels.length, 0);

  await run(s.bot, click('tkm|open|1', { ...fromError, components: answers('Zapraszam: https://discord.gg/fajny !', '1 500') }));
  assert.match(s.discord.state.webhook.at(-1).body.embeds[0].description, /Ticket utworzony/);
  const [channel] = s.discord.state.createdChannels;
  const welcome = s.discord.state.channels.get(channel.id)[0];
  assert.equal(welcome.embeds[0].title, 'Ticket #0001 • Partnerstwo');
  assert.match(welcome.embeds[0].description, /Dzięki za chęć nawiązania partnerstwa/, 'własne powitanie rodzaju ticketu');
  const fields = Object.fromEntries(welcome.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields['Link do serwera'], 'https://discord.gg/fajny');
  assert.equal(fields['Liczba członków'], '1500');
  assert.equal(fields['Powód'], 'Podobna tematyka, chętnie się wymienimy.');
  assert.equal(fields['Serwer z zaproszenia'], '**Fajny \\*Serwer\\*** • 243 członków • 57 online', 'prawdziwa liczba członków dla obsługi');
  const log = s.discord.state.channels.get(LOGS).at(-1);
  assert.equal(log.embeds[0].fields.length, 5);
  assert.equal(fields['Regulamin'], '✅ Zaakceptowany przed otwarciem ticketu');

  const ticket = (await s.store.listTickets())[0];
  assert.equal(ticket.type, 'Partnerstwo');
  assert.equal(
    ticket.subject,
    'Link do serwera: https://discord.gg/fajny\nSerwer z zaproszenia: Fajny *Serwer* (243 członków)\nLiczba członków: 1500\nPowód: Podobna tematyka, chętnie się wymienimy.',
  );
});

test('rodzaje ticketów z panelu: stare pytanie zamienia się w formularz, pola są przycinane do limitów Discorda', async () => {
  const s = await setup();
  const saved = await s.store.updateConfig({
    tickets: {
      types: [
        { label: 'Stary', style: 'czerwony', question: 'Od czego się odwołujesz?' },
        {
          label: 'Nowy',
          style: 'fioletowy',
          emoji: 'nie emoji',
          fields: [
            ...Array.from({ length: 6 }, (_, i) => ({ label: `Pole ${i} ${'x'.repeat(60)}`, kind: i === 0 ? 'invite' : 'coś', required: i !== 1 })),
            { label: '   ', kind: 'long' },
          ],
        },
        { label: '', fields: [] },
      ],
    },
  });
  const [old, fresh] = saved.tickets.types;
  assert.equal(saved.tickets.types.length, 2, 'bez napisu na przycisku — pomijany');
  assert.deepEqual(old, { label: 'Stary', style: 'czerwony', emoji: '', welcome: '', rules: '', categoryId: '', archiveCategoryId: '', logChannelId: '', supportRoleIds: [], authorCanClose: true, authorCanAdd: true, authorCanAttach: true, fields: [{ label: 'Od czego się odwołujesz?', placeholder: '', kind: 'long', required: true }] });
  assert.equal(fresh.style, 'niebieski');
  assert.equal(fresh.emoji, '');
  assert.equal(fresh.fields.length, 5, 'okienko Discorda mieści maks. 5 pól');
  assert.ok(fresh.fields.every((f) => f.label.length <= 45));
  assert.deepEqual(fresh.fields.map((f) => [f.kind, f.required]), [['invite', true], ['short', false], ['short', true], ['short', true], ['short', true]]);
});

test('ticket: przejęcie tylko przez obsługę, dodanie osoby, zamknięcie z zapisem do logów i DM', async () => {
  const s = await setup({ types: [{ label: 'Pomoc', style: 'niebieski', question: '' }] });
  await run(s.bot, click('tk|open|0'));
  const channel = s.discord.state.createdChannels[0];
  const ticket = (await s.store.listTickets())[0];
  s.discord.state.channels.get(channel.id).push({ id: '1300000000000000000', content: 'Pomocy!', author: { username: 'target' }, timestamp: new Date().toISOString() });

  const denied = await run(s.bot, click(`tk|claim|${ticket.id}`));
  assert.match(denied.response.data.embeds[0].description, /tylko obsługa/);
  await run(s.bot, click(`tk|claim|${ticket.id}`, { user: 'mod', roles: [SUPPORT], message: { id: s.discord.state.channels.get(channel.id)[0].id } }));
  assert.equal((await s.store.getTicket(ticket.id)).claimedBy, 'mod');

  await run(s.bot, click(`tks|add|${ticket.id}`, { values: ['owner'] }));
  const added = s.discord.state.calls.find((c) => c.method === 'PUT' && c.path === `/channels/${channel.id}/permissions/owner`);
  assert.equal(BigInt(added.body.allow) & P.VIEW_CHANNEL, P.VIEW_CHANNEL);

  const confirm = await run(s.bot, click(`tk|close|${ticket.id}`));
  assert.equal(confirm.response.data.components[0].components[0].custom_id, `tk|confirm|${ticket.id}`);
  await run(s.bot, click(`tk|confirm|${ticket.id}`));

  // Kanał NIE jest usuwany — zostaje jako archiwum, ukryty dla autora i dodanej osoby.
  assert.deepEqual(s.discord.state.deletedChannels, []);
  const closed = await s.store.getTicket(ticket.id);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closedAt);
  const removed = s.discord.state.removedOverwrites.filter((o) => o.id === channel.id).map((o) => o.target);
  assert.deepEqual(removed.sort(), ['owner', 'target'], 'autor i dodana osoba tracą dostęp, obsługa zostaje');
  const liveChannel = await s.bot.discord.get(`/channels/${channel.id}`);
  const byIdAfter = Object.fromEntries(liveChannel.permission_overwrites.map((o) => [o.id, o]));
  assert.ok(byIdAfter[SUPPORT], 'obsługa nadal widzi ticket');
  assert.equal(byIdAfter.target, undefined);
  assert.equal(byIdAfter.owner, undefined);

  const logCall = s.discord.state.calls.findLast((c) => c.method === 'POST' && c.path === `/channels/${LOGS}/messages`);
  assert.equal(logCall.files[0].name, 'ticket-0001.txt');
  assert.match(logCall.files[0].content, /target: Pomocy!/);
  assert.equal(s.discord.state.dms.at(-1).embeds[0].title, 'Twój ticket #0001 został zamknięty');
  // Zapis rozmowy trafia na sam kanał od razu przy zamknięciu, z przyciskiem do usunięcia go z archiwum.
  const posted = s.discord.state.channels.get(channel.id).at(-1);
  assert.equal(posted.embeds[0].title, 'Ticket #0001 zamknięty');
  assert.equal(posted.embeds[0].fields.find((f) => f.name === 'Wiadomości').value, '4');
  assert.deepEqual(posted.components[0].components.map((b) => [b.label, b.custom_id]), [['Usuń kanał z archiwum', `tk|delete|${ticket.id}`]]);
  const postedCall = s.discord.state.calls.findLast((c) => c.method === 'POST' && c.path === `/channels/${channel.id}/messages`);
  assert.equal(postedCall.files[0].name, 'ticket-0001.txt');
  assert.match(postedCall.files[0].content, /target: Pomocy!/);

  const again = await run(s.bot, click(`tk|close|${ticket.id}`));
  assert.match(again.response.data.embeds[0].description, /już zamknięty/);
});

test('zamknięty ticket: przeniesienie do archiwum i przycisk „Usuń kanał z archiwum” (tylko obsługa, z potwierdzeniem)', async () => {
  const ARCHIVE = '100000000000000084';
  const s = await setup({ types: [{ label: 'Pomoc', style: 'niebieski', question: '' }], archiveCategoryId: ARCHIVE });
  await run(s.bot, click('tk|open|0'));
  const channel = s.discord.state.createdChannels[0];
  const ticket = (await s.store.listTickets())[0];

  await run(s.bot, click(`tk|close|${ticket.id}`));
  await run(s.bot, click(`tk|confirm|${ticket.id}`));

  const liveChannel = await s.bot.discord.get(`/channels/${channel.id}`);
  assert.equal(liveChannel.parent_id, ARCHIVE, 'kanał przenosi się do kategorii archiwum');

  const deniedOwner = await run(s.bot, click(`tk|delete|${ticket.id}`, { user: 'target' }));
  assert.match(deniedOwner.response.data.embeds[0].description, /tylko obsługa/);
  assert.deepEqual(s.discord.state.deletedChannels, []);

  const prompt = await run(s.bot, click(`tk|delete|${ticket.id}`, { user: 'mod', roles: [SUPPORT] }));
  assert.match(prompt.response.data.content, /Na pewno usunąć/);
  assert.equal(prompt.response.data.components[0].components[0].custom_id, `tk|deleteconfirm|${ticket.id}`);
  assert.deepEqual(s.discord.state.deletedChannels, [], 'samo kliknięcie jeszcze nic nie usuwa');

  await run(s.bot, click(`tk|deleteconfirm|${ticket.id}`, { user: 'mod', roles: [SUPPORT] }));
  assert.deepEqual(s.discord.state.deletedChannels, [channel.id]);
});

test('ticket, którego kanał usunięto ręcznie, nie blokuje nowego; wyłączone tickety nic nie tworzą', async () => {
  const s = await setup({ types: [{ label: 'Pomoc', style: 'niebieski', question: '' }] });
  await run(s.bot, click('tk|open|0'));
  s.discord.state.deletedChannels.push(s.discord.state.createdChannels[0].id);
  await run(s.bot, click('tk|open|0'));
  assert.equal(s.discord.state.createdChannels.length, 2);

  await s.store.updateConfig({ tickets: { enabled: false } });
  const off = await run(s.bot, click('tk|open|0', { user: 'owner' }));
  assert.match(off.response.data.embeds[0].description, /wyłączone/);
});

test('osobne ustawienia rodzajów ticketów: własna kategoria, role obsługi, logi i uprawnienia autora', async () => {
  const PARTNER_CAT = '100000000000000091';
  const PARTNER_ROLE = '100000000000000092';
  const PARTNER_LOG = '100000000000000093';
  const s = await setup({
    types: [
      { label: 'Zgłoszenie', style: 'niebieski', fields: [] },
      { label: 'Partnerstwo', style: 'zielony', fields: [], categoryId: PARTNER_CAT, logChannelId: PARTNER_LOG, supportRoleIds: [PARTNER_ROLE], authorCanClose: false, authorCanAdd: false, authorCanAttach: false },
    ],
  });
  await run(s.bot, click('tk|open|0', { user: 'target' }));
  await run(s.bot, click('tk|open|1', { user: 'owner' }));
  const [report, partner] = s.discord.state.createdChannels;
  assert.equal(report.parent_id, CATEGORY);
  assert.equal(partner.parent_id, PARTNER_CAT, 'partnerstwa w osobnej kategorii');
  const roles = (ch) => ch.permission_overwrites.filter((o) => o.type === 0 && o.id !== GUILD).map((o) => o.id);
  assert.deepEqual(roles(report), [SUPPORT]);
  assert.deepEqual(roles(partner), [PARTNER_ROLE], 'partnerstwa widzi tylko własna obsługa');
  const authorAllow = BigInt(partner.permission_overwrites.find((o) => o.id === 'owner').allow);
  assert.equal(authorAllow & P.ATTACH_FILES, 0n, 'autor partnerstwa bez załączników');
  assert.equal(s.discord.state.channels.get(PARTNER_LOG).length, 1, 'log otwarcia w osobnym kanale');
  assert.equal(s.discord.state.channels.get(LOGS).length, 1);

  const [t1, t2] = await s.store.listTickets();
  const tPartner = t1.type === 'Partnerstwo' ? t1 : t2;
  assert.match((await run(s.bot, click(`tk|close|${tPartner.id}`, { user: 'owner' }))).response.data.embeds[0].description, /tylko obsługa/);
  assert.match((await run(s.bot, click(`tk|add|${tPartner.id}`, { user: 'owner' }))).response.data.embeds[0].description, /tylko obsługa/);
  assert.match((await run(s.bot, click(`tk|claim|${tPartner.id}`, { user: 'mod', roles: [SUPPORT] }))).response.data.embeds[0].description, /tylko obsługa/, 'obsługa zgłoszeń nie rusza partnerstw');
  const ok = await run(s.bot, click(`tk|close|${tPartner.id}`, { user: 'mod', roles: [PARTNER_ROLE] }));
  assert.equal(ok.response.data.components[0].components[0].custom_id, `tk|confirm|${tPartner.id}`);
});
