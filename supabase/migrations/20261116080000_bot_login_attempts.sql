-- Ochrona logowania do panelu: nieudane próby (hasło panelu, login z /login) liczone na adres IP (skrót,
-- nie sam adres). 10 błędów w 15 minut → blokada na 15 minut. Stare wpisy bot usuwa sam.
create table if not exists bot.login_attempts (
  key text primary key,
  fails int not null default 0,
  first_at timestamptz not null default now(),
  locked_until timestamptz
);

revoke all on bot.login_attempts from anon, authenticated;
