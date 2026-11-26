-- Kanały głosowe na żądanie (wejście na wybrany kanał tworzy własny kanał) + wiadomości wysyłane z panelu
-- (z przyciskami albo listą do wybierania ról).

-- Kto jest teraz na jakim kanale głosowym (z gatewaya) - potrzebne, żeby wiedzieć, kiedy kanał jest pusty.
create table bot.voice_states (
  user_id text primary key,
  channel_id text not null,
  updated_at timestamptz not null default now()
);
create index voice_states_channel_idx on bot.voice_states (channel_id);

-- Kanały utworzone przez bota. Jedna osoba ma naraz najwyżej jeden własny kanał.
create table bot.temp_voice (
  channel_id text primary key,
  guild_id text not null,
  owner_id text not null unique,
  hub_id text,
  name text,
  user_limit int not null default 0,
  private boolean not null default false,
  allowed jsonb not null default '[]'::jsonb,
  banned jsonb not null default '[]'::jsonb,
  dashboard_message_id text,
  created_at timestamptz not null default now()
);

-- Wiadomości wysłane z panelu (zakładka Wiadomości) - żeby można je było potem edytować albo usunąć.
create table bot.sent_messages (
  id int generated always as identity primary key,
  channel_id text not null,
  message_id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on bot.voice_states, bot.temp_voice, bot.sent_messages from anon, authenticated;
