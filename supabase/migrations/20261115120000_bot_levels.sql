-- Poziomy (leveling jak w Arcane): XP za wiadomości, kanały głosowe i reakcje.
-- xp to suma od początku (z niej liczy się poziom), week_xp/month_xp — XP zdobyte w bieżącym tygodniu
-- (od niedzieli, UTC) i miesiącu; po zmianie okresu licznik zaczyna się od nowa przy następnym XP, a ranking
-- tygodniowy/miesięczny bierze osoby z kluczem właśnie zakończonego okresu.
-- last_*_at to cooldowny osobno dla wiadomości, głosowych i reakcji.
create table bot.levels (
  user_id text primary key,
  user_tag text,
  avatar text,
  xp bigint not null default 0,
  level int not null default 0,
  messages int not null default 0,
  voice_minutes int not null default 0,
  reactions int not null default 0,
  week_key text,
  week_xp bigint not null default 0,
  month_key text,
  month_xp bigint not null default 0,
  last_message_at timestamptz,
  last_voice_at timestamptz,
  last_reaction_at timestamptz,
  updated_at timestamptz not null default now()
);
create index levels_xp_idx on bot.levels (xp desc);
create index levels_week_idx on bot.levels (week_key, week_xp desc);
create index levels_month_idx on bot.levels (month_key, month_xp desc);

-- XP za kanały głosowe: anty-AFK pomija wyciszonych i ogłuszonych, a role (bez XP, boostery) bierzemy
-- z ostatniej aktualizacji stanu głosowego.
alter table bot.voice_states
  add column muted boolean not null default false,
  add column deafened boolean not null default false,
  add column bot boolean not null default false,
  add column roles jsonb not null default '[]'::jsonb;

revoke all on bot.levels from anon, authenticated;
