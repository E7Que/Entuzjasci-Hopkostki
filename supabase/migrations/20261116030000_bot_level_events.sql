-- XP zdobyte w czasie wydarzeń XP (np. podwójne XP na weekend): ranking wydarzenia na stronie rankingu
-- i podsumowanie z najlepszymi osobami po jego końcu. Wpisy usuniętych wydarzeń bot sprząta sam.
create table if not exists bot.level_event_xp (
  event_id text not null,
  user_id text not null,
  xp bigint not null default 0,
  primary key (event_id, user_id)
);
create index if not exists level_event_xp_rank_idx on bot.level_event_xp (event_id, xp desc);

revoke all on bot.level_event_xp from anon, authenticated;
