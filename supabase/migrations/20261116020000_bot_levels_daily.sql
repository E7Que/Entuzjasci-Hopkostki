-- Dzienne XP każdej osoby (doba według czasu polskiego): dzienny limit XP (ochrona przed nabijaniem)
-- i historia aktywności na stronie rankingu (wykres w profilu). Wpisy starsze niż ~400 dni bot usuwa sam.
create table if not exists bot.level_daily (
  user_id text not null,
  day date not null,
  xp bigint not null default 0,
  messages int not null default 0,
  voice_minutes int not null default 0,
  reactions int not null default 0,
  primary key (user_id, day)
);
create index if not exists level_daily_day_idx on bot.level_daily (day);

-- Skrót ostatniej wiadomości, za którą było XP - ta sama wiadomość drugi raz nie daje XP.
alter table bot.levels add column if not exists last_text_hash text;

revoke all on bot.level_daily from anon, authenticated;
