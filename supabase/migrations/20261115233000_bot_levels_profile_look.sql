-- Personalizacja profilu z Discorda do publicznej strony rankingu: czcionka i efekt nazwy, kolory nazwy,
-- tabliczka z nazwą (nameplate), tag serwera, dekoracja avatara (look) oraz avatar ustawiony tylko na tym serwerze.
alter table bot.levels
  add column if not exists look jsonb,
  add column if not exists guild_avatar text;
