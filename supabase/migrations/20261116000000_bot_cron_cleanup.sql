-- pg_cron zapisuje każde uruchomienie zadań bota (co 30 s i co minutę) w cron.job_run_details.
-- Po dwóch miesiącach to ~125 MB z ~140 MB całej bazy. Codziennie o 3:17 UTC usuwamy wpisy starsze niż 3 dni
-- (zostaje ~13 tys. wierszy, kilka MB), więc historia przestaje rosnąć.

select cron.unschedule(jobid) from cron.job where jobname = 'hopkostki-cron-cleanup';

select cron.schedule(
  'hopkostki-cron-cleanup',
  '17 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '3 days' $$
);
