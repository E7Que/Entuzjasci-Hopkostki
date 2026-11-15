-- Kolor akcentu (kolor banera z profilu Discorda) i Nitro osób z rankingu — do publicznej strony rankingu.
-- Odświeżane przez crona po kilka osób naraz, najwyżej co 12 godzin dla każdej osoby.
alter table bot.levels
  add column if not exists accent_color text,
  add column if not exists nitro boolean not null default false,
  add column if not exists look_checked_at timestamptz;
