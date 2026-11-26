-- Strażnik w bazie: co 5 minut sprawdza, czy funkcja bota wykonuje zadania okresowe (bot.state 'cron_last_run').
-- Gdy od X minut (ustawienie „Alerty” w panelu) nic się nie dzieje, wysyła alarm przez webhook Discorda
-- (zakłada go funkcja bota i zapisuje w bot.state 'alert_webhook'), a gdy bot wróci - wiadomość, że działa.
-- Działa nawet wtedy, gdy sama funkcja bota leży, bo wysyła z bazy (pg_net), a nie przez bota.

create or replace function bot.health_watchdog() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook jsonb := (select value from bot.state where key = 'alert_webhook');
  last_run bigint := (select (value->>'at')::bigint from bot.state where key = 'cron_last_run');
  watch jsonb := coalesce((select value from bot.state where key = 'health_watchdog'), '{}'::jsonb);
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  limit_ms bigint;
  stale boolean;
  alerted boolean;
  ping text;
begin
  if hook is null or coalesce((hook->>'enabled')::boolean, false) is false or coalesce(hook->>'url', '') = '' then
    return;
  end if;
  limit_ms := greatest(3, least(120, coalesce((hook->>'minutes')::int, 5))) * 60000;
  stale := last_run is null or now_ms - last_run > limit_ms;
  alerted := coalesce((watch->>'alerted')::boolean, false);
  ping := nullif(hook->>'pingRoleId', '');

  if stale and not alerted then
    perform net.http_post(
      url := hook->>'url',
      body := jsonb_build_object(
        'username', 'Strażnik bota',
        'content', coalesce('<@&' || ping || '> ', '') || '⚠️ **Bot nie działa** - od '
          || greatest(1, (now_ms - coalesce(last_run, now_ms)) / 60000)::text
          || ' min funkcja bota na Supabase nie wykonała żadnych zadań. Komendy, XP, automoderacja i logi mogą nie działać. '
          || 'Sprawdź Supabase → Edge Functions → hopkostki-bot → Logs.',
        'allowed_mentions', jsonb_build_object(
          'parse', '[]'::jsonb,
          'roles', case when ping is null then '[]'::jsonb else jsonb_build_array(ping) end
        )
      ),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
    insert into bot.state (key, value) values ('health_watchdog', jsonb_build_object('alerted', true, 'since', coalesce(last_run, now_ms)))
      on conflict (key) do update set value = excluded.value, updated_at = now();
  elsif not stale and alerted then
    perform net.http_post(
      url := hook->>'url',
      body := jsonb_build_object(
        'username', 'Strażnik bota',
        'content', '✅ **Bot znowu działa** (przerwa: ok. '
          || greatest(1, (now_ms - coalesce((watch->>'since')::bigint, now_ms)) / 60000)::text || ' min).',
        'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb)
      ),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
    insert into bot.state (key, value) values ('health_watchdog', jsonb_build_object('alerted', false))
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end;
$$;

revoke all on function bot.health_watchdog() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'hopkostki-bot-watchdog';

select cron.schedule('hopkostki-bot-watchdog', '*/5 * * * *', $$ select bot.health_watchdog(); $$);
