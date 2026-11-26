-- Zapis rozmowy po zamknięciu ticketu wysyła się teraz od razu (na kanał, kategoria + uprawnienia
-- zmieniają się w tej samej chwili), a nie z opóźnieniem przez crona - te kolumny są już niepotrzebne.
alter table bot.tickets drop column if exists transcript;
alter table bot.tickets drop column if exists transcript_count;
alter table bot.tickets drop column if exists transcript_posted_at;
