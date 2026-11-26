-- Dane bota moderacyjnego Entuzjaści Hopkostki.
-- Osobny schemat "bot" nie jest wystawiony przez API (PostgREST), więc dostęp ma tylko funkcja Edge (rola postgres).

create schema if not exists bot;
revoke all on schema bot from anon, authenticated;

-- Konfiguracja (jeden wiersz, JSON scalany z domyślną konfiguracją w kodzie).
create table bot.config (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into bot.config (id) values (1);

-- Sprawy = historia wszystkich akcji moderacyjnych.
create table bot.cases (
  id int generated always as identity primary key,
  type text not null,
  guild_id text not null,
  user_id text not null,
  user_tag text,
  moderator_id text,
  moderator_tag text,
  reason text not null,
  duration jsonb,
  expires_at timestamptz,
  auto boolean not null default false,
  note text,
  dm_status text,
  message_url text,
  created_at timestamptz not null default now()
);
create index cases_user_idx on bot.cases (user_id);
create index cases_type_idx on bot.cases (type);

-- Ostrzeżenia. Każde ma własny termin wygaśnięcia (domyślnie 60 dni od nadania).
create table bot.warns (
  id int generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  user_tag text,
  moderator_id text,
  moderator_tag text,
  reason text not null,
  points int not null check (points > 0),
  case_id int references bot.cases (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index warns_user_idx on bot.warns (user_id);
create index warns_expires_idx on bot.warns (expires_at);

-- Tymczasowe bany do automatycznego zdjęcia.
create table bot.temp_bans (
  guild_id text not null,
  user_id text not null,
  user_tag text,
  expires_at timestamptz not null,
  case_id int,
  primary key (guild_id, user_id)
);

-- Wiadomości bota o karach - odpowiedzi na nie dostają reakcję 🫓.
create table bot.mod_messages (
  message_id text primary key,
  channel_id text not null,
  case_id int,
  created_at timestamptz not null default now()
);
create index mod_messages_created_idx on bot.mod_messages (created_at);

-- Do którego miejsca bot przejrzał kanał w poszukiwaniu odpowiedzi.
create table bot.channel_cursors (
  channel_id text primary key,
  last_message_id text not null,
  updated_at timestamptz not null default now()
);

-- Różne wartości techniczne (sekret crona, blokada crona, zarejestrowane komendy itd.).
create table bot.state (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);
insert into bot.state (key, value) values
  ('cron_secret', to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))),
  ('cron_lock', to_jsonb('1970-01-01T00:00:00Z'::text));

revoke all on all tables in schema bot from anon, authenticated;
