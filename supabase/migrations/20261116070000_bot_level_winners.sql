-- Archiwum zwycięzców: 10 najlepszych osób każdego zakończonego tygodnia i miesiąca (zapisywane przy końcu
-- okresu), pokazywane na stronie rankingu. Nazwy i avatary bierzemy aktualne z bot.levels.
create table if not exists bot.level_winners (
  period text not null check (period in ('week', 'month')),
  key text not null,
  rank int not null,
  user_id text not null,
  xp bigint not null,
  created_at timestamptz not null default now(),
  primary key (period, key, rank)
);

revoke all on bot.level_winners from anon, authenticated;
