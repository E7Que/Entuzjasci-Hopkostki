-- Obrazki wgrane w panelu (np. banery sekcji w „Serwer info”), serwowane publicznie przez funkcję bota
-- pod /panel/public/asset/<id>. Treść jako base64; nieużywane obrazki bot usuwa po dniu.
create table if not exists bot.assets (
  id text primary key,
  content_type text not null,
  data text not null,
  size int not null,
  created_at timestamptz not null default now()
);

revoke all on bot.assets from anon, authenticated;
