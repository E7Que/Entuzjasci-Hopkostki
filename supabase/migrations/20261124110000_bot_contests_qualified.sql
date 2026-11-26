-- Eventy: zapis najpierw, potem warunek (zaprosić X osób i/lub napisać Y wiadomości). qualified_at - kiedy osoba
-- pierwszy raz spełniła warunek (bot ogłasza to wtedy na kanale z panelu); kolejność „kto pierwszy, ten wyżej”.
alter table bot.contest_entries add column if not exists qualified_at timestamptz;
