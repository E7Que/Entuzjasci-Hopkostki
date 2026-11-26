-- Zamknięte tickety nie są już usuwane - kanał zostaje (przenosi się do kategorii archiwum i znika dla
-- wszystkich poza obsługą), a zapis rozmowy trafia na niego chwilę po zamknięciu (patrz cron.js).
-- transcript: zapisana treść .txt do wysłania; transcript_posted_at: kiedy już wysłano (null = czeka);
-- transcript_count: liczba wiadomości w zapisie (do pokazania w embedzie bez przeliczania pliku).
alter table bot.tickets add column transcript text;
alter table bot.tickets add column transcript_count int;
alter table bot.tickets add column transcript_posted_at timestamptz;
