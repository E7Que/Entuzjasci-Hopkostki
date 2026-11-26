-- Ostatnio znane zdjęcie profilowe i nazwa każdej osoby - Discord przy zmianie podaje tylko nową wersję,
-- a log ma pokazać „przed” i „po” (logi serwera: zmiany zdjęć profilowych i nazw użytkowników).
create table bot.member_profiles (
  user_id text primary key,
  avatar text,
  guild_avatar text,
  username text,
  global_name text,
  updated_at timestamptz not null default now()
);

revoke all on bot.member_profiles from anon, authenticated;
