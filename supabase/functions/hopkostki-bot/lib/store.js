// Dostęp do bazy (schemat "bot" w Postgresie Supabase).
// query(text, params) => Promise<wiersze> — w funkcji Edge to postgres.js, w testach PGlite.

import { DEFAULT_CONFIG } from './defaults.js';
import { mergeWithDefaults, sanitizeConfig } from './configSchema.js';

const ms = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

// Bez skrótu tokenu — ten zostaje w bazie.
const mapPanelSession = (r) => ({
  id: r.id,
  kind: r.kind,
  login: r.login,
  loginId: r.login_id,
  userId: r.user_id,
  userTag: r.user_tag,
  roles: r.roles ?? [],
  admin: r.admin,
  createdAt: ms(r.created_at),
  expiresAt: ms(r.expires_at),
  checkedAt: ms(r.checked_at),
  lastSeenAt: ms(r.last_seen_at),
});

function mapCase(r) {
  return {
    id: r.id,
    type: r.type,
    guildId: r.guild_id,
    userId: r.user_id,
    userTag: r.user_tag,
    moderatorId: r.moderator_id,
    moderatorTag: r.moderator_tag,
    reason: r.reason,
    duration: r.duration ?? null,
    expiresAt: ms(r.expires_at),
    auto: r.auto,
    note: r.note,
    dmStatus: r.dm_status,
    messageUrl: r.message_url,
    createdAt: ms(r.created_at),
  };
}

function mapWarn(r) {
  return {
    id: r.id,
    guildId: r.guild_id,
    userId: r.user_id,
    userTag: r.user_tag,
    moderatorId: r.moderator_id,
    moderatorTag: r.moderator_tag,
    reason: r.reason,
    points: r.points,
    caseId: r.case_id,
    createdAt: ms(r.created_at),
    expiresAt: ms(r.expires_at),
  };
}

function mapTempBan(r) {
  return { guildId: r.guild_id, userId: r.user_id, userTag: r.user_tag, expiresAt: ms(r.expires_at), caseId: r.case_id };
}

const CASE_COLUMNS = { reason: 'reason', note: 'note', dmStatus: 'dm_status', messageUrl: 'message_url' };
const ACTIVE_WARN = '(expires_at is null or expires_at > now())';

function mapNote(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userTag: r.user_tag,
    authorId: r.author_id,
    authorTag: r.author_tag,
    text: r.text,
    createdAt: ms(r.created_at),
  };
}

function mapTempVoice(r) {
  return {
    channelId: r.channel_id,
    guildId: r.guild_id,
    ownerId: r.owner_id,
    hubId: r.hub_id,
    name: r.name,
    limit: r.user_limit,
    private: r.private,
    allowed: r.allowed ?? [],
    banned: r.banned ?? [],
    dashboardMessageId: r.dashboard_message_id,
    createdAt: ms(r.created_at),
  };
}

const TEMP_VOICE_COLUMNS = {
  ownerId: ['owner_id', 'text'],
  name: ['name', 'text'],
  limit: ['user_limit', 'int'],
  private: ['private', 'boolean'],
  allowed: ['allowed', 'jsonb'],
  banned: ['banned', 'jsonb'],
  dashboardMessageId: ['dashboard_message_id', 'text'],
};

function mapTicket(r) {
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    userId: r.user_id,
    userTag: r.user_tag,
    type: r.type,
    subject: r.subject,
    status: r.status,
    claimedBy: r.claimed_by,
    closedBy: r.closed_by,
    createdAt: ms(r.created_at),
    closedAt: ms(r.closed_at),
  };
}

const TICKET_COLUMNS = { channelId: 'channel_id', status: 'status', claimedBy: 'claimed_by', closedBy: 'closed_by' };

function mapSentMessage(r) {
  return { id: r.id, channelId: r.channel_id, messageId: r.message_id, data: r.data, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) };
}

function mapCachedMessage(r) {
  return {
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    authorTag: r.author_tag,
    authorAvatar: r.author_avatar,
    content: r.content ?? '',
    attachments: r.attachments ?? [],
    createdAt: ms(r.created_at),
    editedAt: ms(r.edited_at),
    deletedAt: ms(r.deleted_at),
  };
}

function mapReminder(r) {
  return { id: r.id, userId: r.user_id, channelId: r.channel_id, text: r.text, dueAt: ms(r.due_at), createdAt: ms(r.created_at) };
}

function mapGiveaway(r) {
  return {
    id: r.id,
    channelId: r.channel_id,
    messageId: r.message_id,
    prize: r.prize,
    winners: r.winners,
    hostId: r.host_id,
    requiredRoleId: r.required_role_id,
    entrants: r.entrants ?? [],
    winnerIds: r.winner_ids ?? [],
    endsAt: ms(r.ends_at),
    ended: r.ended,
    createdAt: ms(r.created_at),
  };
}

// configTtlMs: jak długo trzymać konfigurację w pamięci (mniej zapytań = szybsza odpowiedź dla Discorda).
export function createStore(query, { configTtlMs = 10_000 } = {}) {
  const one = async (text, params) => (await query(text, params))[0] ?? null;
  let configCache = null;

  const store = {
    query,

    // ---------- Konfiguracja ----------
    async getConfig() {
      if (configCache && Date.now() - configCache.at < configTtlMs) return configCache.value;
      const row = await one('select data from bot.config where id = 1');
      const value = mergeWithDefaults(DEFAULT_CONFIG, row?.data);
      configCache = { at: Date.now(), value };
      return value;
    },

    async updateConfig(input) {
      configCache = null;
      const next = sanitizeConfig(input, await store.getConfig());
      await query(
        `insert into bot.config (id, data, updated_at) values (1, $1::text::jsonb, now())
         on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [JSON.stringify(next)],
      );
      configCache = { at: Date.now(), value: next };
      return next;
    },

    // ---------- Sprawy ----------
    async addCase(c) {
      const row = await one(
        `insert into bot.cases (type, guild_id, user_id, user_tag, moderator_id, moderator_tag, reason, duration, expires_at, auto)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text::jsonb,
                 case when $9::float8 is null then null else to_timestamp($9::float8 / 1000) end, $10::boolean)
         returning *`,
        [
          c.type,
          c.guildId,
          c.userId,
          c.userTag ?? null,
          c.moderatorId ?? null,
          c.moderatorTag ?? null,
          c.reason,
          c.duration ? JSON.stringify(c.duration) : null,
          c.expiresAt ?? null,
          Boolean(c.auto),
        ],
      );
      return mapCase(row);
    },

    async getCase(id) {
      const row = await one('select * from bot.cases where id = $1::int', [id]);
      return row ? mapCase(row) : null;
    },

    async updateCase(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => CASE_COLUMNS[key]);
      if (!entries.length) return store.getCase(id);
      const sets = entries.map(([key], i) => `${CASE_COLUMNS[key]} = $${i + 2}::text`).join(', ');
      const row = await one(`update bot.cases set ${sets} where id = $1::int returning *`, [id, ...entries.map(([, v]) => v)]);
      return row ? mapCase(row) : null;
    },

    async deleteCase(id) {
      await query('delete from bot.cases where id = $1::int', [id]);
    },

    async listCases({ userId, type, search, limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = [];
      if (userId) {
        params.push(userId);
        where.push(`user_id = $${params.length}::text`);
      }
      if (type) {
        params.push(type);
        where.push(`type = $${params.length}::text`);
      }
      if (search) {
        params.push(`%${search}%`);
        where.push(`(user_tag ilike $${params.length}::text or moderator_tag ilike $${params.length}::text)`);
      }
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = await one(`select count(*)::int as n from bot.cases ${clause}`, params);
      const rows = await query(
        `select * from bot.cases ${clause} order by id desc limit $${params.length + 1}::int offset $${params.length + 2}::int`,
        [...params, limit, offset],
      );
      return { total: total.n, items: rows.map(mapCase) };
    },

    async caseCounts(userId) {
      const rows = await query('select type, count(*)::int as n from bot.cases where user_id = $1::text group by type', [userId]);
      return Object.fromEntries(rows.map((r) => [r.type, r.n]));
    },

    // ---------- Ostrzeżenia ----------
    async addWarn(w, expiryDays) {
      const row = await one(
        `insert into bot.warns (guild_id, user_id, user_tag, moderator_id, moderator_tag, reason, points, case_id, expires_at)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::int, $8::int,
                 case when $9::int > 0 then now() + make_interval(days => $9::int) end)
         returning *`,
        [w.guildId, w.userId, w.userTag, w.moderatorId, w.moderatorTag, w.reason, w.points, w.caseId, expiryDays],
      );
      return mapWarn(row);
    },

    async getWarn(id) {
      const row = await one(`select * from bot.warns where id = $1::int and ${ACTIVE_WARN}`, [id]);
      return row ? mapWarn(row) : null;
    },

    async getWarns(userId) {
      const rows = await query(`select * from bot.warns where user_id = $1::text and ${ACTIVE_WARN} order by created_at desc, id desc`, [userId]);
      return rows.map(mapWarn);
    },

    async warnSummary(userId) {
      const warns = await store.getWarns(userId);
      const points = warns.reduce((sum, w) => sum + w.points, 0);
      const nextExpiry = warns.map((w) => w.expiresAt).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
      return { count: warns.length, points, warns, nextExpiry };
    },

    async removeWarn(id) {
      const row = await one('delete from bot.warns where id = $1::int returning *', [id]);
      return row ? mapWarn(row) : null;
    },

    async clearWarns(userId) {
      const rows = await query('delete from bot.warns where user_id = $1::text returning *', [userId]);
      return rows.map(mapWarn);
    },

    async updateWarnByCase(caseId, { reason }) {
      await query('update bot.warns set reason = $2::text where case_id = $1::int', [caseId, reason]);
    },

    // Usuwa ostrzeżenia, którym skończyło się odliczanie, i dopisuje notatkę w sprawie.
    async expireWarns() {
      const rows = await query('delete from bot.warns where expires_at is not null and expires_at <= now() returning *');
      const ids = rows.map((r) => r.case_id).filter(Boolean);
      if (ids.length) {
        await query(
          `update bot.cases set note = 'Ostrzeżenie wygasło' where id in (select (jsonb_array_elements_text($1::text::jsonb))::int)`,
          [JSON.stringify(ids)],
        );
      }
      return rows.map(mapWarn);
    },

    async warnRanking() {
      const rows = await query(`select * from bot.warns where ${ACTIVE_WARN} order by created_at desc, id desc`);
      const byUser = new Map();
      for (const w of rows.map(mapWarn)) {
        const row = byUser.get(w.userId) ?? { userId: w.userId, userTag: w.userTag, count: 0, points: 0, warns: [] };
        row.count += 1;
        row.points += w.points;
        row.warns.push(w);
        byUser.set(w.userId, row);
      }
      return [...byUser.values()].sort((a, b) => b.points - a.points || b.count - a.count);
    },

    // ---------- Tymczasowe bany ----------
    async setTempBan({ guildId, userId, userTag, expiresAt, caseId }) {
      await query(
        `insert into bot.temp_bans (guild_id, user_id, user_tag, expires_at, case_id)
         values ($1::text, $2::text, $3::text, to_timestamp($4::float8 / 1000), $5::int)
         on conflict (guild_id, user_id) do update
           set user_tag = excluded.user_tag, expires_at = excluded.expires_at, case_id = excluded.case_id`,
        [guildId, userId, userTag, expiresAt, caseId],
      );
    },

    async removeTempBan(guildId, userId) {
      const rows = await query('delete from bot.temp_bans where guild_id = $1::text and user_id = $2::text returning user_id', [guildId, userId]);
      return rows.length > 0;
    },

    async listTempBans() {
      return (await query('select * from bot.temp_bans order by expires_at')).map(mapTempBan);
    },

    async dueTempBans() {
      return (await query('select * from bot.temp_bans where expires_at <= now() order by expires_at')).map(mapTempBan);
    },

    // ---------- Wiadomości o karach (reakcje na odpowiedzi) ----------
    async addModMessage(messageId, channelId, caseId) {
      await query(
        `insert into bot.mod_messages (message_id, channel_id, case_id) values ($1::text, $2::text, $3::int)
         on conflict (message_id) do nothing`,
        [messageId, channelId, caseId ?? null],
      );
    },

    async filterModMessages(ids) {
      if (!ids.length) return new Set();
      const rows = await query(
        'select message_id from bot.mod_messages where message_id in (select jsonb_array_elements_text($1::text::jsonb))',
        [JSON.stringify(ids)],
      );
      return new Set(rows.map((r) => r.message_id));
    },

    // Kanały z wiadomościami o karach z ostatnich dni + najstarsza z nich (punkt startowy przeglądania).
    async recentModChannels(days = 7) {
      const rows = await query(
        `select m.channel_id, min(m.message_id::numeric)::text as first_message_id, c.last_message_id
         from bot.mod_messages m left join bot.channel_cursors c on c.channel_id = m.channel_id
         where m.created_at > now() - make_interval(days => $1::int)
         group by m.channel_id, c.last_message_id`,
        [days],
      );
      return rows.map((r) => ({ channelId: r.channel_id, firstMessageId: r.first_message_id, cursor: r.last_message_id }));
    },

    async setCursor(channelId, messageId) {
      await query(
        `insert into bot.channel_cursors (channel_id, last_message_id, updated_at) values ($1::text, $2::text, now())
         on conflict (channel_id) do update set last_message_id = excluded.last_message_id, updated_at = now()`,
        [channelId, messageId],
      );
    },

    async pruneModMessages(days = 30) {
      await query('delete from bot.mod_messages where created_at < now() - make_interval(days => $1::int)', [days]);
    },

    // ---------- Stan techniczny ----------
    async getState(key) {
      const row = await one('select value from bot.state where key = $1::text', [key]);
      return row?.value ?? null;
    },

    async setState(key, value) {
      await query(
        `insert into bot.state (key, value, updated_at) values ($1::text, $2::text::jsonb, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    },

    // Blokada (dzierżawa) na czas działania zadania — wygasa sama, gdyby zadanie padło.
    async acquireLease(key, seconds) {
      await query(
        `insert into bot.state (key, value) values ($1::text, to_jsonb('1970-01-01T00:00:00Z'::text))
         on conflict (key) do nothing`,
        [key],
      );
      const rows = await query(
        `update bot.state set value = to_jsonb(now()::text), updated_at = now()
         where key = $1::text and (value #>> '{}')::timestamptz < now() - make_interval(secs => $2::int)
         returning key`,
        [key, seconds],
      );
      return rows.length > 0;
    },

    async releaseLease(key) {
      await query(`update bot.state set value = to_jsonb('1970-01-01T00:00:00Z'::text) where key = $1::text`, [key]);
    },

    acquireCronLock: () => store.acquireLease('cron_lock', 60),
    releaseCronLock: () => store.releaseLease('cron_lock'),

    // ---------- Notatki moderatorów ----------
    async addNote({ guildId, userId, userTag, authorId, authorTag, text }) {
      const row = await one(
        `insert into bot.notes (guild_id, user_id, user_tag, author_id, author_tag, text)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text) returning *`,
        [guildId, userId, userTag, authorId, authorTag, text],
      );
      return mapNote(row);
    },

    async listNotes(userId) {
      const rows = await query('select * from bot.notes where user_id = $1::text order by id desc', [userId]);
      return rows.map(mapNote);
    },

    async removeNote(id) {
      const row = await one('delete from bot.notes where id = $1::int returning *', [id]);
      return row ? mapNote(row) : null;
    },

    // ---------- Stany głosowe (kto jest na jakim kanale) ----------
    async getVoiceChannel(userId) {
      return (await one('select channel_id from bot.voice_states where user_id = $1::text', [userId]))?.channel_id ?? null;
    },

    async setVoiceState(userId, channelId) {
      if (!channelId) {
        await query('delete from bot.voice_states where user_id = $1::text', [userId]);
        return;
      }
      await query(
        `insert into bot.voice_states (user_id, channel_id, updated_at) values ($1::text, $2::text, now())
         on conflict (user_id) do update set channel_id = excluded.channel_id, updated_at = now()`,
        [userId, channelId],
      );
    },

    // Pełna lista z GUILD_CREATE — zastępuje wszystko, co było (po ponownym zalogowaniu do gatewaya).
    async replaceVoiceStates(states) {
      await query('delete from bot.voice_states');
      if (!states.length) return;
      await query(
        `insert into bot.voice_states (user_id, channel_id)
         select s->>'userId', s->>'channelId' from jsonb_array_elements($1::text::jsonb) s
         on conflict (user_id) do update set channel_id = excluded.channel_id, updated_at = now()`,
        [JSON.stringify(states)],
      );
    },

    async voiceMembers(channelId) {
      return (await query('select user_id from bot.voice_states where channel_id = $1::text order by updated_at', [channelId])).map((r) => r.user_id);
    },

    // ---------- Kanały głosowe na żądanie ----------
    async addTempVoice({ channelId, guildId, ownerId, hubId, name, limit = 0, private: isPrivate = false }) {
      const row = await one(
        `insert into bot.temp_voice (channel_id, guild_id, owner_id, hub_id, name, user_limit, private)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::int, $7::boolean) returning *`,
        [channelId, guildId, ownerId, hubId ?? null, name ?? null, limit, isPrivate],
      );
      return mapTempVoice(row);
    },

    async getTempVoice(channelId) {
      const row = await one('select * from bot.temp_voice where channel_id = $1::text', [channelId]);
      return row ? mapTempVoice(row) : null;
    },

    async getTempVoiceByOwner(ownerId) {
      const row = await one('select * from bot.temp_voice where owner_id = $1::text', [ownerId]);
      return row ? mapTempVoice(row) : null;
    },

    async listTempVoice() {
      return (await query('select * from bot.temp_voice order by created_at')).map(mapTempVoice);
    },

    async updateTempVoice(channelId, patch) {
      const entries = Object.entries(patch).filter(([key]) => TEMP_VOICE_COLUMNS[key]);
      if (!entries.length) return store.getTempVoice(channelId);
      const sets = entries.map(([key], i) => {
        const [column, type] = TEMP_VOICE_COLUMNS[key];
        return `${column} = $${i + 2}::${type === 'jsonb' ? 'text::jsonb' : type}`;
      });
      const values = entries.map(([key, value]) => (TEMP_VOICE_COLUMNS[key][1] === 'jsonb' ? JSON.stringify(value) : value));
      const row = await one(`update bot.temp_voice set ${sets.join(', ')} where channel_id = $1::text returning *`, [channelId, ...values]);
      return row ? mapTempVoice(row) : null;
    },

    async deleteTempVoice(channelId) {
      await query('delete from bot.temp_voice where channel_id = $1::text', [channelId]);
    },

    // ---------- Tickety ----------
    async addTicket({ guildId, userId, userTag, type, subject }) {
      const row = await one(
        `insert into bot.tickets (guild_id, user_id, user_tag, type, subject)
         values ($1::text, $2::text, $3::text, $4::text, $5::text) returning *`,
        [guildId, userId, userTag ?? null, type ?? null, subject || null],
      );
      return mapTicket(row);
    },

    async getTicket(id) {
      const row = await one('select * from bot.tickets where id = $1::int', [id]);
      return row ? mapTicket(row) : null;
    },

    async openTicketsForUser(userId) {
      return (await query(`select * from bot.tickets where user_id = $1::text and status = 'open' order by id`, [userId])).map(mapTicket);
    },

    async listTickets({ limit = 50 } = {}) {
      return (await query('select * from bot.tickets order by id desc limit $1::int', [limit])).map(mapTicket);
    },

    // closed_at ustawia się samo przy zmianie statusu na "closed".
    async updateTicket(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => TICKET_COLUMNS[key]);
      if (!entries.length) return store.getTicket(id);
      const sets = entries.map(([key], i) => `${TICKET_COLUMNS[key]} = $${i + 2}::text`);
      if (patch.status === 'closed') sets.push('closed_at = now()');
      const row = await one(`update bot.tickets set ${sets.join(', ')} where id = $1::int returning *`, [id, ...entries.map(([, v]) => v)]);
      return row ? mapTicket(row) : null;
    },

    async deleteTicket(id) {
      await query('delete from bot.tickets where id = $1::int', [id]);
    },

    // ---------- Wiadomości wysłane z panelu ----------
    async addSentMessage({ channelId, messageId, data }) {
      const row = await one(
        'insert into bot.sent_messages (channel_id, message_id, data) values ($1::text, $2::text, $3::text::jsonb) returning *',
        [channelId, messageId, JSON.stringify(data)],
      );
      return mapSentMessage(row);
    },

    async listSentMessages() {
      return (await query('select * from bot.sent_messages order by id desc limit 100')).map(mapSentMessage);
    },

    async getSentMessage(id) {
      const row = await one('select * from bot.sent_messages where id = $1::int', [id]);
      return row ? mapSentMessage(row) : null;
    },

    async updateSentMessage(id, data) {
      const row = await one(
        'update bot.sent_messages set data = $2::text::jsonb, updated_at = now() where id = $1::int returning *',
        [id, JSON.stringify(data)],
      );
      return row ? mapSentMessage(row) : null;
    },

    async deleteSentMessage(id) {
      await query('delete from bot.sent_messages where id = $1::int', [id]);
    },

    // ---------- Pamięć wiadomości (logi usunięć/edycji, /snipe) ----------
    async cacheMessage({ id, channelId, authorId, authorTag, authorAvatar, content, attachments, createdAt }) {
      await query(
        `insert into bot.message_cache (id, channel_id, author_id, author_tag, author_avatar, content, attachments, created_at)
         values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text::jsonb, coalesce($8::timestamptz, now()))
         on conflict (id) do nothing`,
        [id, channelId, authorId, authorTag ?? null, authorAvatar ?? null, content ?? '', JSON.stringify(attachments ?? []), createdAt ? new Date(createdAt).toISOString() : null],
      );
    },

    // Zapisuje nową treść i zwraca wiadomość sprzed edycji (null, jeśli jej nie znamy).
    async editCachedMessage(id, content) {
      const row = await one(
        `with prev as (select * from bot.message_cache where id = $1::text)
         update bot.message_cache m set content = $2::text, edited_at = now() from prev where m.id = prev.id
         returning prev.*`,
        [id, content ?? ''],
      );
      return row ? mapCachedMessage(row) : null;
    },

    async deleteCachedMessages(ids) {
      if (!ids.length) return [];
      const rows = await query(
        `update bot.message_cache set deleted_at = now()
         where id in (select jsonb_array_elements_text($1::text::jsonb)) and deleted_at is null returning *`,
        [JSON.stringify(ids)],
      );
      return rows.map(mapCachedMessage).sort((a, b) => a.createdAt - b.createdAt);
    },

    async lastDeletedMessages(channelId, { limit = 10, withinMinutes = 120 } = {}) {
      const rows = await query(
        `select * from bot.message_cache where channel_id = $1::text and deleted_at > now() - make_interval(mins => $3::int)
         order by deleted_at desc limit $2::int`,
        [channelId, limit, withinMinutes],
      );
      return rows.map(mapCachedMessage);
    },

    async lastEditedMessages(channelId, { limit = 10, withinMinutes = 120 } = {}) {
      const rows = await query(
        `select * from bot.message_cache where channel_id = $1::text and edited_at > now() - make_interval(mins => $3::int)
         order by edited_at desc limit $2::int`,
        [channelId, limit, withinMinutes],
      );
      return rows.map(mapCachedMessage);
    },

    async pruneMessageCache(days = 7) {
      await query('delete from bot.message_cache where created_at < now() - make_interval(days => $1::int)', [days]);
    },

    // ---------- Profile (zdjęcie i nazwa) do logów zmian ----------
    // Zapisuje nową wersję i zwraca poprzednią (null, jeśli tej osoby jeszcze nie znaliśmy).
    async swapMemberProfile(userId, next) {
      const prev = await one('select * from bot.member_profiles where user_id = $1::text', [userId]);
      const mapped = prev ? { avatar: prev.avatar, guildAvatar: prev.guild_avatar, username: prev.username, globalName: prev.global_name } : null;
      const same = mapped && ['avatar', 'guildAvatar', 'username', 'globalName'].every((k) => (mapped[k] ?? null) === (next[k] ?? null));
      if (!same) {
        await query(
          `insert into bot.member_profiles (user_id, avatar, guild_avatar, username, global_name, updated_at)
           values ($1::text, $2::text, $3::text, $4::text, $5::text, now())
           on conflict (user_id) do update set avatar = excluded.avatar, guild_avatar = excluded.guild_avatar,
             username = excluded.username, global_name = excluded.global_name, updated_at = now()`,
          [userId, next.avatar ?? null, next.guildAvatar ?? null, next.username ?? null, next.globalName ?? null],
        );
      }
      return mapped;
    },

    // Tylko osoby, których jeszcze nie znamy — istniejących nie nadpisujemy (zmianę wykryje GUILD_MEMBER_UPDATE).
    async seedMemberProfiles(list) {
      if (!list.length) return 0;
      const rows = await query(
        `insert into bot.member_profiles (user_id, avatar, guild_avatar, username, global_name)
         select p->>'userId', p->>'avatar', p->>'guildAvatar', p->>'username', p->>'globalName' from jsonb_array_elements($1::text::jsonb) p
         on conflict (user_id) do nothing returning user_id`,
        [JSON.stringify(list)],
      );
      return rows.length;
    },

    // ---------- Zaproszenia (kto kogo zaprosił) ----------
    async addInviteJoin({ userId, inviterId, code }) {
      await query('insert into bot.invite_joins (user_id, inviter_id, code) values ($1::text, $2::text, $3::text)', [userId, inviterId ?? null, code ?? null]);
    },

    async inviteJoinFor(userId) {
      const row = await one('select * from bot.invite_joins where user_id = $1::text order by joined_at desc limit 1', [userId]);
      return row ? { userId: row.user_id, inviterId: row.inviter_id, code: row.code, joinedAt: ms(row.joined_at) } : null;
    },

    // Ile różnych osób weszło z zaproszeń tej osoby.
    async inviteCount(inviterId) {
      return (await one('select count(distinct user_id)::int as n from bot.invite_joins where inviter_id = $1::text', [inviterId]))?.n ?? 0;
    },

    async invitedBy(inviterId, limit = 10) {
      const rows = await query(
        `select distinct on (user_id) user_id, code, joined_at from bot.invite_joins where inviter_id = $1::text
         order by user_id, joined_at desc`,
        [inviterId],
      );
      return rows
        .map((r) => ({ userId: r.user_id, code: r.code, joinedAt: ms(r.joined_at) }))
        .sort((a, b) => b.joinedAt - a.joinedAt)
        .slice(0, limit);
    },

    async inviteRanking(limit = 10) {
      const rows = await query(
        `select inviter_id, count(distinct user_id)::int as n from bot.invite_joins where inviter_id is not null
         group by inviter_id order by n desc, max(joined_at) desc limit $1::int`,
        [limit],
      );
      return rows.map((r) => ({ inviterId: r.inviter_id, count: r.n }));
    },

    // ---------- Bumpy ----------
    async addBump({ userId, channelId, messageId }) {
      const row = await one(
        `insert into bot.bumps (user_id, channel_id, message_id) values ($1::text, $2::text, $3::text)
         on conflict (message_id) do nothing returning *`,
        [userId, channelId, messageId],
      );
      return row ? { id: row.id, userId: row.user_id, createdAt: ms(row.created_at) } : null;
    },

    async bumpRanking({ limit = 10, days = null } = {}) {
      const rows = await query(
        `select user_id, count(*)::int as n, max(created_at) as last_at from bot.bumps
         where $2::int is null or created_at > now() - make_interval(days => $2::int)
         group by user_id order by n desc, last_at desc limit $1::int`,
        [limit, days],
      );
      return rows.map((r) => ({ userId: r.user_id, count: r.n, lastAt: ms(r.last_at) }));
    },

    async bumpCount(userId) {
      return (await one('select count(*)::int as n from bot.bumps where user_id = $1::text', [userId]))?.n ?? 0;
    },

    // ---------- Przypomnienia ----------
    async addReminder({ userId, channelId, text, dueAt }) {
      const row = await one(
        `insert into bot.reminders (user_id, channel_id, text, due_at) values ($1::text, $2::text, $3::text, $4::timestamptz) returning *`,
        [userId, channelId, text, new Date(dueAt).toISOString()],
      );
      return mapReminder(row);
    },

    async listReminders(userId) {
      return (await query('select * from bot.reminders where user_id = $1::text order by due_at', [userId])).map(mapReminder);
    },

    async removeReminder(id, userId) {
      const row = await one('delete from bot.reminders where id = $1::int and user_id = $2::text returning *', [id, userId]);
      return row ? mapReminder(row) : null;
    },

    // Zabiera (usuwa) przypomnienia, których czas minął — każde wysyłamy tylko raz.
    async takeDueReminders(limit = 20) {
      const rows = await query(
        `delete from bot.reminders where id in (select id from bot.reminders where due_at <= now() order by due_at limit $1::int) returning *`,
        [limit],
      );
      return rows.map(mapReminder);
    },

    // ---------- Konkursy ----------
    async addGiveaway({ channelId, prize, winners, hostId, requiredRoleId, endsAt }) {
      const row = await one(
        `insert into bot.giveaways (channel_id, prize, winners, host_id, required_role_id, ends_at)
         values ($1::text, $2::text, $3::int, $4::text, $5::text, $6::timestamptz) returning *`,
        [channelId, prize, winners, hostId, requiredRoleId || null, new Date(endsAt).toISOString()],
      );
      return mapGiveaway(row);
    },

    async setGiveawayMessage(id, messageId) {
      await query('update bot.giveaways set message_id = $2::text where id = $1::int', [id, messageId]);
    },

    async getGiveaway(id) {
      const row = await one('select * from bot.giveaways where id = $1::int', [id]);
      return row ? mapGiveaway(row) : null;
    },

    async getGiveawayByMessage(messageId) {
      const row = await one('select * from bot.giveaways where message_id = $1::text', [messageId]);
      return row ? mapGiveaway(row) : null;
    },

    async listGiveaways({ limit = 25 } = {}) {
      return (await query('select * from bot.giveaways order by id desc limit $1::int', [limit])).map(mapGiveaway);
    },

    // Dopisuje albo wypisuje osobę (jednym zapytaniem, więc równoczesne kliknięcia się nie gubią).
    async toggleGiveawayEntry(id, userId) {
      const row = await one(
        `update bot.giveaways set entrants = case
           when entrants @> jsonb_build_array($2::text) then entrants - $2::text
           else entrants || jsonb_build_array($2::text) end
         where id = $1::int and not ended returning *`,
        [id, userId],
      );
      return row ? mapGiveaway(row) : null;
    },

    async dueGiveaways() {
      return (await query('select * from bot.giveaways where not ended and ends_at <= now() order by ends_at')).map(mapGiveaway);
    },

    async finishGiveaway(id, winnerIds) {
      const row = await one(
        'update bot.giveaways set ended = true, winner_ids = $2::text::jsonb, ends_at = least(ends_at, now()) where id = $1::int returning *',
        [id, JSON.stringify(winnerIds)],
      );
      return row ? mapGiveaway(row) : null;
    },

    async deleteGiveaway(id) {
      await query('delete from bot.giveaways where id = $1::int', [id]);
    },

    // ---------- AFK ----------
    async setAfk(userId, reason) {
      await query(
        `insert into bot.afk (user_id, reason, since) values ($1::text, $2::text, now())
         on conflict (user_id) do update set reason = excluded.reason, since = now()`,
        [userId, reason ?? ''],
      );
    },

    async removeAfk(userId) {
      const row = await one('delete from bot.afk where user_id = $1::text returning *', [userId]);
      return row ? { userId: row.user_id, reason: row.reason, since: ms(row.since) } : null;
    },

    async listAfk() {
      return (await query('select * from bot.afk')).map((r) => ({ userId: r.user_id, reason: r.reason, since: ms(r.since) }));
    },

    // ---------- Logowanie do panelu (loginy z /login i sesje przeglądarki) ----------
    // ttlMs — ważność od teraz, expiresAt — konkretna chwila (sesja kończy się razem ze swoim loginem).
    async addPanelLogin({ kind, login = null, loginId = null, tokenHash, userId, userTag, roles = [], admin = false, ttlMs, expiresAt }) {
      const row = await one(
        `insert into bot.panel_sessions (kind, login, login_id, token_hash, user_id, user_tag, roles, admin, expires_at)
         values ($1::text, $2::text, $3::int, $4::text, $5::text, $6::text, $7::text::jsonb, $8::boolean,
                 coalesce($9::timestamptz, now() + make_interval(secs => $10::double precision)))
         returning *`,
        [kind, login, loginId, tokenHash, userId, userTag ?? null, JSON.stringify(roles), admin, expiresAt ? new Date(expiresAt).toISOString() : null, (ttlMs ?? 0) / 1000],
      );
      return mapPanelSession(row);
    },

    // Aktywny login o tej nazwie — razem ze skrótem hasła (do sprawdzenia przy logowaniu).
    async findPanelLogin(login) {
      const row = await one(`select * from bot.panel_sessions where kind = 'login' and login = $1::text and expires_at > now()`, [login]);
      return row ? { ...mapPanelSession(row), tokenHash: row.token_hash } : null;
    },

    async getPanelLoginForUser(userId) {
      const row = await one(
        `select * from bot.panel_sessions where kind = 'login' and user_id = $1::text and expires_at > now() order by id desc limit 1`,
        [userId],
      );
      return row ? mapPanelSession(row) : null;
    },

    // Wygasły login o tej nazwie (jeszcze nie sprzątnięty przez crona) nie blokuje nowego.
    async freePanelLoginName(login) {
      await query(`delete from bot.panel_sessions where kind = 'login' and login = $1::text and expires_at <= now()`, [login]);
    },

    async getPanelSession(tokenHash) {
      const row = await one(`select * from bot.panel_sessions where kind = 'session' and token_hash = $1::text and expires_at > now()`, [tokenHash]);
      return row ? mapPanelSession(row) : null;
    },

    // Odświeżone role (checked = sprawdzone teraz w Discordzie) i/lub ostatnia aktywność.
    async touchPanelSession(id, { roles, admin, checked = false } = {}) {
      const row = await one(
        `update bot.panel_sessions set last_seen_at = now(),
           roles = coalesce($2::text::jsonb, roles),
           admin = coalesce($3::boolean, admin),
           checked_at = case when $4::boolean then now() else checked_at end
         where id = $1::int returning *`,
        [id, roles ? JSON.stringify(roles) : null, admin ?? null, checked],
      );
      return row ? mapPanelSession(row) : null;
    },

    // Aktywne loginy z liczbą zalogowanych przeglądarek i ostatnią aktywnością.
    async listPanelLogins() {
      const rows = await query(
        `select l.*,
           (select count(*)::int from bot.panel_sessions s where s.login_id = l.id and s.expires_at > now()) as sessions,
           (select max(s.last_seen_at) from bot.panel_sessions s where s.login_id = l.id) as session_seen_at
         from bot.panel_sessions l
         where l.kind = 'login' and l.expires_at > now()
         order by l.created_at desc limit 100`,
      );
      return rows.map((r) => ({ ...mapPanelSession(r), sessions: r.sessions, lastSeenAt: ms(r.session_seen_at) }));
    },

    // { id } — jeden wpis, { userId, kind } — np. login tej osoby, {} — wszystko. Usunięcie loginu kończy też
    // jego sesje (kaskada w bazie).
    async deletePanelLogins({ id, userId, kind } = {}) {
      const rows = await query(
        `delete from bot.panel_sessions
         where ($1::int is null or id = $1::int) and ($2::text is null or user_id = $2::text) and ($3::text is null or kind = $3::text)
         returning id`,
        [id ?? null, userId ?? null, kind ?? null],
      );
      return rows.length;
    },

    async prunePanelSessions() {
      await query('delete from bot.panel_sessions where expires_at < now()');
    },

    async stats() {
      const row = await one(
        `select (select count(*)::int from bot.cases) as cases,
                (select count(*)::int from bot.warns where ${ACTIVE_WARN}) as active_warns,
                (select count(*)::int from bot.temp_bans) as temp_bans`,
      );
      const byType = await query('select type, count(*)::int as n from bot.cases group by type');
      return {
        cases: row.cases,
        activeWarns: row.active_warns,
        tempBans: row.temp_bans,
        byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      };
    },
  };
  return store;
}
