-- Odwołania od kar: osoba klika „Odwołaj się” pod wiadomością prywatną z karą, wypełnia formularz,
-- a moderacja przyjmuje (bot cofa karę) albo odrzuca odwołanie. Jedno odwołanie na sprawę.
create table if not exists bot.appeals (
  id int generated always as identity primary key,
  case_id int not null references bot.cases (id) on delete cascade,
  user_id text not null,
  user_tag text,
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  channel_id text,
  message_id text,
  decided_by text,
  decided_tag text,
  decision_note text,
  undo_result text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists appeals_case_idx on bot.appeals (case_id);
create index if not exists appeals_status_idx on bot.appeals (status, created_at desc);

revoke all on bot.appeals from anon, authenticated;
