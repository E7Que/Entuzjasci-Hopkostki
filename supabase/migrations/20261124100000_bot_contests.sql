-- Eventy (konkursy) na stronie rankingu: zaproszenia, wiadomości albo mieszane. Same eventy są w konfiguracji
-- (contests.list, edytowane w panelu), tu - wyniki, uczestnicy i konta połączone ze stroną.

-- Wiadomości policzone w czasie eventu (tak jak do poziomów: z cooldownem i ochroną przed nabijaniem).
create table if not exists bot.contest_scores (
  contest_id text not null,
  user_id text not null,
  messages int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (contest_id, user_id)
);

-- Uczestnicy: dołączenie do eventu bez progu albo zgłoszenie po osiągnięciu progu (np. 5 zaproszeń).
-- score = wynik w chwili dołączenia/zgłoszenia; nazwa i avatar z chwili połączenia konta (/polacz).
create table if not exists bot.contest_entries (
  contest_id text not null,
  user_id text not null,
  user_tag text,
  display_name text,
  avatar text,
  score int not null default 0,
  created_at timestamptz not null default now(),
  primary key (contest_id, user_id)
);
create index if not exists contest_entries_contest_idx on bot.contest_entries (contest_id, created_at);

-- Konta połączone ze stroną: /polacz daje jednorazowy link (kind = 'link', ważny kilka minut), który strona
-- zamienia na sesję przeglądarki (kind = 'session'). Trzymamy tylko skróty SHA-256 tokenów.
create table if not exists bot.member_links (
  id int generated always as identity primary key,
  kind text not null check (kind in ('link', 'session')),
  token_hash text not null unique,
  user_id text not null,
  user_tag text,
  display_name text,
  avatar text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz
);
create index if not exists member_links_user_idx on bot.member_links (user_id, kind);

-- Wyjście z serwera: zaproszenie osoby, która wyszła, przestaje się liczyć w evencie zaproszeń.
alter table bot.invite_joins add column if not exists left_at timestamptz;

revoke all on bot.contest_scores, bot.contest_entries, bot.member_links from anon, authenticated;
