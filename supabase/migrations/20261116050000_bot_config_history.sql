-- Dziennik zmian ustawień z panelu: kto i kiedy zapisał, które sekcje zmienił (wartości przed i po -
-- tylko zmienione sekcje). Panel pozwala cofnąć wybraną zmianę. Bot trzyma ostatnie 100 wpisów.
create table if not exists bot.config_history (
  id int generated always as identity primary key,
  changed_by text,
  keys jsonb not null default '[]'::jsonb,
  changes jsonb not null,
  created_at timestamptz not null default now()
);

revoke all on bot.config_history from anon, authenticated;
