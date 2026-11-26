-- Notatki moderatorów o użytkownikach (/notatka) + połączenie gateway (status "online" bota).

create table bot.notes (
  id int generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  user_tag text,
  author_id text,
  author_tag text,
  text text not null,
  created_at timestamptz not null default now()
);
create index notes_user_idx on bot.notes (user_id);
revoke all on bot.notes from anon, authenticated;

-- Funkcja działa w regionie bazy (Frankfurt) - krótsze zapytania do Postgresa.
select cron.schedule(
  'hopkostki-bot-cron',
  '30 seconds',
  $$
  select net.http_post(
    url := 'https://ucjmbdogtzztrkorqzjq.supabase.co/functions/v1/hopkostki-bot/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-central-1',
      'x-cron-secret', (select value #>> '{}' from bot.state where key = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);

-- Co minutę: sesja gateway (~55 s), dzięki której bot ma status "online" i własne opisy.
select cron.schedule(
  'hopkostki-bot-gateway',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://ucjmbdogtzztrkorqzjq.supabase.co/functions/v1/hopkostki-bot/gateway',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-central-1',
      'x-cron-secret', (select value #>> '{}' from bot.state where key = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);
