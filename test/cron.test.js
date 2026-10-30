import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestStore } from './support/db.js';
import { fakeDiscord, makeBot, snowflake } from './support/discord.js';
import { createHandler } from '../supabase/functions/hopkostki-bot/lib/app.js';
import { runCron, pollReplies } from '../supabase/functions/hopkostki-bot/lib/cron.js';

async function setup() {
  const { store, db } = await createTestStore();
  const discord = fakeDiscord();
  const bot = makeBot({ store, discord });
  return { store, db, discord, bot };
}

test('pierwszy przebieg: rejestruje komendy i ustawia Interactions Endpoint URL', async () => {
  const s = await setup();
  const report = await runCron(s.bot);
  assert.equal(report.setup.ok, true);
  assert.equal(s.discord.state.commands.length, 36);
  assert.equal(s.discord.state.endpoint, s.bot.env.selfUrl);
  assert.equal((await s.store.getState('app')).id, 'app');

  // Kolejny przebieg korzysta z zapamiętanej konfiguracji i nie rejestruje komend ponownie.
  s.discord.state.commands = null;
  const second = await runCron(s.bot);
  assert.equal(second.setup.cached, true);
  assert.equal(s.discord.state.commands, null);
});

test('reakcja 🫓 tylko pod odpowiedziami na wiadomości o karach, bez duplikatów', async () => {
  const s = await setup();
  const mod = { id: snowflake(Date.now() - 5000), channel_id: 'chan', author: { id: 'bot', bot: true } };
  const other = { id: snowflake(Date.now() - 4000), channel_id: 'chan', author: { id: 'x' } };
  const reply = { id: snowflake(Date.now() - 3000), channel_id: 'chan', author: { id: 'u1' }, message_reference: { message_id: mod.id } };
  const replyOther = { id: snowflake(Date.now() - 2000), channel_id: 'chan', author: { id: 'u2' }, message_reference: { message_id: other.id } };
  const botReply = { id: snowflake(Date.now() - 1000), channel_id: 'chan', author: { id: 'b', bot: true }, message_reference: { message_id: mod.id } };
  s.discord.state.channels.set('chan', [mod, other, reply, replyOther, botReply]);
  await s.store.addModMessage(mod.id, 'chan', 1);

  assert.equal(await pollReplies(s.bot), 1);
  assert.deepEqual(s.discord.state.reactions, [{ channel: 'chan', id: reply.id, emoji: '🫓' }]);
  assert.equal(await pollReplies(s.bot), 0, 'kursor pamięta, co już sprawdzono');

  const later = { id: snowflake(), channel_id: 'chan', author: { id: 'u3' }, message_reference: { message_id: mod.id } };
  s.discord.state.channels.get('chan').push(later);
  assert.equal(await pollReplies(s.bot), 1);
});

test('cron usuwa wygasłe ostrzeżenia i zdejmuje wygasłe bany', async () => {
  const s = await setup();
  await s.store.updateConfig({ modLogChannelId: '100000000000000001' });
  const warn = await s.store.addWarn({ guildId: 'g1', userId: 'target', userTag: 'hurownik_og', moderatorId: 'mod', moderatorTag: 'dfgbh65', reason: 'spam', points: 2, caseId: null }, 60);
  await s.db.query(`update bot.warns set expires_at = now() - interval '1 second' where id = $1`, [warn.id]);
  s.discord.state.bans.set('target', { user: s.discord.state.users.get('target') });
  await s.store.setTempBan({ guildId: 'g1', userId: 'target', userTag: 'hurownik_og', expiresAt: Date.now() - 1, caseId: 3 });

  const report = await runCron(s.bot);
  assert.equal(report.warns, 1);
  assert.equal(report.tempBans, 1);
  assert.equal(s.discord.state.bans.size, 0);
  const log = s.discord.state.channels.get('100000000000000001').map((m) => m.embeds[0].title ?? m.embeds[0].author?.name);
  assert.ok(log.some((t) => /Ostrzeżenie #1 wygasło/.test(t)));
  assert.ok(log.some((t) => /Unban/.test(t)));
});

test('endpoint /cron wymaga sekretu z bazy', async () => {
  const s = await setup();
  const handle = createHandler(s.bot);
  const url = 'https://x.supabase.co/functions/v1/hopkostki-bot/cron';
  assert.equal((await handle(new Request(url, { method: 'POST' }))).status, 401);
  const secret = await s.store.getState('cron_secret');
  const ok = await handle(new Request(url, { method: 'POST', headers: { 'x-cron-secret': secret } }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).setup.ok, true);
});
