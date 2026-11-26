-- Logi serwera (jak Carl-bot), przypominajka o bumpie (jak Fibo) i komendy społecznościowe:
-- przypomnienia, konkursy (giveaway) i status AFK.

-- Ostatnie wiadomości z serwera - Discord przy usunięciu/edycji nie podaje starej treści, więc trzymamy ją
-- przez kilka dni (logi usuniętych i edytowanych wiadomości, /snipe). Czyszczone przez crona.
create table bot.message_cache (
  id text primary key,
  channel_id text not null,
  author_id text not null,
  author_tag text,
  author_avatar text,
  content text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index message_cache_channel_deleted_idx on bot.message_cache (channel_id, deleted_at desc);
create index message_cache_created_idx on bot.message_cache (created_at);

-- Udane bumpy (DISBOARD /bump) - do rankingu i przypominajki.
create table bot.bumps (
  id int generated always as identity primary key,
  user_id text not null,
  channel_id text not null,
  message_id text not null unique,
  created_at timestamptz not null default now()
);
create index bumps_user_idx on bot.bumps (user_id);

-- /przypomnij - bot pisze na kanale (albo w DM) o wybranej porze.
create table bot.reminders (
  id int generated always as identity primary key,
  user_id text not null,
  channel_id text not null,
  text text not null,
  due_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index reminders_due_idx on bot.reminders (due_at);

-- /konkurs - wiadomość z przyciskiem „Weź udział”, losowanie zwycięzców po czasie.
create table bot.giveaways (
  id int generated always as identity primary key,
  channel_id text not null,
  message_id text,
  prize text not null,
  winners int not null default 1,
  host_id text not null,
  required_role_id text,
  entrants jsonb not null default '[]'::jsonb,
  winner_ids jsonb not null default '[]'::jsonb,
  ends_at timestamptz not null,
  ended boolean not null default false,
  created_at timestamptz not null default now()
);
create index giveaways_open_idx on bot.giveaways (ended, ends_at);

-- /afk - oznaczenie takiej osoby dostaje odpowiedź, że jej nie ma; pierwsza jej wiadomość zdejmuje status.
create table bot.afk (
  user_id text primary key,
  reason text not null default '',
  since timestamptz not null default now()
);

revoke all on bot.message_cache, bot.bumps, bot.reminders, bot.giveaways, bot.afk from anon, authenticated;
