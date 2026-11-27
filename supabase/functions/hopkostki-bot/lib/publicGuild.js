// Strona główna: liczba osób i osób online (strona pyta co pół minuty, więc liczby zmieniają się na żywo) oraz
// awatary kilku osób, które ostatnio dołączyły. Same awatary: bez nazw, bez botów, bez osób, które jeszcze nie
// przeszły weryfikacji, i bez osób ukrytych na stronie rankingu. Lista pochodzi z listy członków serwera
// (intencja „Server Members”) i leży kilka minut w stanie bota; wejście albo wyjście kogoś ją unieważnia (gateway.js).
import { cached, getApp, resolveGuildId } from './moderation.js';
import { membersIntentOn } from './members.js';
import { avatarUrl } from './rest.js';

const COUNTS_TTL_MS = 20_000;
const NEWCOMERS_TTL_MS = 5 * 60_000;
const SHOWN = 5;
const MAX_PAGES = 10;
const STATE_KEY = 'public_newcomers';

// Awatar ustawiony na tym serwerze ma pierwszeństwo przed zwykłym.
function memberAvatar(guildId, member) {
  const user = member.user;
  if (member.avatar) return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=96`;
  return avatarUrl(user, 96);
}

async function loadNewcomers(bot) {
  if (!membersIntentOn(await getApp(bot))) return [];
  const guildId = await resolveGuildId(bot);
  const all = [];
  let after = '0';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const list = await bot.discord.get(`/guilds/${guildId}/members`, { query: { limit: 1000, after } });
    if (!list?.length) break;
    all.push(...list);
    after = list.at(-1).user.id;
    if (list.length < 1000) break;
  }
  const fresh = all
    .filter((m) => m.user && !m.user.bot && !m.pending && m.joined_at)
    .sort((a, b) => Date.parse(b.joined_at) - Date.parse(a.joined_at))
    .slice(0, SHOWN * 4);
  const hidden = new Set(await bot.store.hiddenLevelUsers(fresh.map((m) => m.user.id)));
  return fresh
    .filter((m) => !hidden.has(m.user.id))
    .slice(0, SHOWN)
    .map((m) => ({ avatar: memberAvatar(guildId, m) }));
}

async function newcomers(bot) {
  const saved = await bot.store.getState(STATE_KEY);
  if (saved?.at && Date.now() - saved.at < NEWCOMERS_TTL_MS) return saved.list ?? [];
  const list = await loadNewcomers(bot);
  await bot.store.setState(STATE_KEY, { at: Date.now(), list });
  return list;
}

// Ktoś wszedł albo wyszedł: następne zapytanie strony pobierze listę od nowa.
export async function forgetNewcomers(bot) {
  await bot.store.setState(STATE_KEY, null);
}

// GET /panel/public/guild
export async function publicGuild(bot) {
  if (!bot.discord) return { memberCount: null, onlineCount: null, newcomers: [] };
  const [counts, list] = await Promise.all([
    cached(bot, 'guildCounts', COUNTS_TTL_MS, async () => {
      const guild = await bot.discord.get(`/guilds/${await resolveGuildId(bot)}`, { query: { with_counts: true } });
      return { memberCount: guild.approximate_member_count ?? null, onlineCount: guild.approximate_presence_count ?? null };
    }).catch(() => ({ memberCount: null, onlineCount: null })),
    cached(bot, 'newcomers', 30_000, () => newcomers(bot)).catch(() => []),
  ]);
  return { ...counts, newcomers: list };
}
