-- Prywatność: osoba może się ukryć na publicznej stronie rankingu komendą /prywatnosc. Zostaje jej miejsce
-- w rankingu (jako „Ukryta osoba”), ale bez pseudonimu, avatara i profilu; na serwerze nic się nie zmienia.
alter table bot.levels add column if not exists hidden boolean not null default false;
