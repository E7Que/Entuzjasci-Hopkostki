-- Logowanie moderacji do panelu: /login na wybranym kanale daje osobie jej login i hasło (ważne kilka dni,
-- potem trzeba wygenerować nowe), a logowanie nimi na stronie panelu tworzy sesję przeglądarki.
-- Trzymamy tylko skróty SHA-256 haseł i tokenów — same wartości zna wyłącznie ta osoba. Sesja należy do
-- loginu (login_id): nowy albo unieważniony login kończy też wszystkie jego zalogowania.
-- roles/admin to ostatnio sprawdzone role z Discorda (bot odświeża je co kilka minut), a które części panelu
-- odblokowują, liczy się z bieżącej konfiguracji przy każdym zapytaniu.
create table bot.panel_sessions (
  id int generated always as identity primary key,
  kind text not null check (kind in ('login', 'session')),
  login text,
  login_id int references bot.panel_sessions (id) on delete cascade,
  token_hash text not null unique,
  user_id text not null,
  user_tag text,
  roles jsonb not null default '[]'::jsonb,
  admin boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  checked_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create unique index panel_sessions_login_idx on bot.panel_sessions (login) where kind = 'login';
create index panel_sessions_user_idx on bot.panel_sessions (user_id, kind);
create index panel_sessions_parent_idx on bot.panel_sessions (login_id);

revoke all on bot.panel_sessions from anon, authenticated;
