-- Pseudonim na serwerze (albo nazwa wyświetlana Discorda) do publicznego rankingu poziomów.
-- Uzupełnia go XP za wiadomości/reakcje i co 30 min synchronizacja z listą członków.
alter table bot.levels add column if not exists display_name text;
