-- Eventy: losowanie nagród wśród osób, które spełniły warunek (ręcznie z panelu albo automatycznie po końcu
-- eventu). won_at — kiedy osoba została wylosowana (ponowne losowanie czyści poprzednich zwycięzców).
alter table bot.contest_entries add column if not exists won_at timestamptz;
