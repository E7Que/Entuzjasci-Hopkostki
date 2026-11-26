// Kto kogo zaprosił. Discord nie podaje zaproszenia przy wejściu, więc (jak boty typu Invite Tracker)
// bot pamięta liczniki użyć wszystkich zaproszeń i po wejściu nowej osoby sprawdza, któremu licznik
// wzrósł. Zaproszenie z limitem użyć znika po ostatnim użyciu - wtedy wskazuje je brak na liście.
// Wymaga uprawnienia „Zarządzanie serwerem” (lista zaproszeń z licznikami).

import { resolveGuildId } from './moderation.js';
import { plural } from './duration.js';
import { inviteContestStart } from './contests.js';

const SNAPSHOT = 'invites_snapshot';

export async function fetchInvites(bot, guildId) {
  const list = await bot.discord.get(`/guilds/${guildId}/invites`);
  const vanity = await bot.discord.get(`/guilds/${guildId}/vanity-url`).catch(() => null);
  return {
    at: Date.now(),
    invites: Object.fromEntries(
      (list ?? []).map((i) => [
        i.code,
        {
          uses: i.uses ?? 0,
          inviterId: i.inviter?.id ?? null,
          maxUses: i.max_uses ?? 0,
          expiresAt: i.expires_at ? Date.parse(i.expires_at) : null,
          channelId: i.channel?.id ?? null,
        },
      ]),
    ),
    vanity: vanity?.code ? { code: vanity.code, uses: vanity.uses ?? 0 } : null,
  };
}

// Porównanie stanu sprzed wejścia i po nim → { type: 'invite' | 'vanity' | 'ambiguous', ... } albo null.
export function findUsedInvite(before, after, now = Date.now()) {
  const grown = Object.entries(after.invites).filter(([code, inv]) => inv.uses > (before.invites[code]?.uses ?? 0));
  if (grown.length === 1) return { type: 'invite', code: grown[0][0], ...grown[0][1] };
  if (grown.length > 1) return { type: 'ambiguous', codes: grown.map(([code]) => code) };
  if (after.vanity && before.vanity && after.vanity.uses > before.vanity.uses) return { type: 'vanity', code: after.vanity.code };
  const gone = Object.entries(before.invites).filter(([code, inv]) => !after.invites[code] && (!inv.expiresAt || inv.expiresAt > now));
  const exhausted = gone.filter(([, inv]) => inv.maxUses && inv.uses + 1 >= inv.maxUses);
  const pick = exhausted.length === 1 ? exhausted[0] : gone.length === 1 ? gone[0] : null;
  if (pick) return { type: 'invite', code: pick[0], ...pick[1], uses: pick[1].uses + 1, deleted: true };
  return null;
}

// Wejścia sprawdzamy po kolei - dwa naraz porównywałyby ten sam stan „przed”.
let chain = Promise.resolve();
export function detectInvite(bot, member) {
  const run = chain.then(() => detect(bot, member));
  chain = run.catch(() => {});
  return run;
}

async function detect(bot, member) {
  if (member.user?.bot) return { type: 'bot' };
  const guildId = member.guild_id ?? (await resolveGuildId(bot));
  const before = await bot.store.getState(SNAPSHOT);
  let after;
  try {
    after = await fetchInvites(bot, guildId);
  } catch (error) {
    return { type: 'error', error: error.message };
  }
  await bot.store.setState(SNAPSHOT, after);
  if (!before?.invites) return null;
  const used = findUsedInvite(before, after);
  if (used?.type === 'invite' && used.inviterId) {
    await bot.store.addInviteJoin({ userId: member.user.id, inviterId: used.inviterId, code: used.code });
    used.invitedCount = await bot.store.inviteCount(used.inviterId);
  } else if (used?.type === 'vanity') {
    await bot.store.addInviteJoin({ userId: member.user.id, inviterId: null, code: used.code });
  }
  return used;
}

// Cron: pierwszy stan zaproszeń (potem aktualizuje go każde wejście), żeby już pierwsze wejście miało porównanie.
// Event zaproszeń (contests.js) włącza śledzenie także bez logu wejść - wtedy stan sprzed startu eventu mógł się
// zestarzeć (wejścia nie były sprawdzane), więc na start eventu pobieramy go od nowa.
export async function ensureInviteSnapshot(bot, config) {
  const logs = inviteTrackingOn(config);
  const contestStart = inviteContestStart(config);
  if (!logs && contestStart === null) return 0;
  const snapshot = await bot.store.getState(SNAPSHOT);
  const stale = !logs && contestStart !== null && (snapshot?.at ?? 0) < contestStart;
  if (snapshot?.invites && !stale) return 0;
  await bot.store.setState(SNAPSHOT, await fetchInvites(bot, await resolveGuildId(bot)));
  return 1;
}

export const inviteTrackingOn = (config) => Boolean(config.logs.enabled && config.logs.events.memberInvite);

// Linia do logu wejścia.
export function inviteLine(used) {
  if (!used) return '**Zaproszenie:** nie udało się ustalić';
  if (used.type === 'bot') return '**Dodany przez:** integrację (bot)';
  if (used.type === 'error') return '**Zaproszenie:** brak dostępu do listy zaproszeń (bot potrzebuje uprawnienia „Zarządzanie serwerem”)';
  if (used.type === 'vanity') return `**Zaproszenie:** własny link serwera \`discord.gg/${used.code}\``;
  if (used.type === 'ambiguous') return `**Zaproszenie:** jedno z: ${used.codes.map((c) => `\`${c}\``).join(', ')} (kilka osób weszło naraz)`;
  const who = used.inviterId ? `<@${used.inviterId}>` : 'nieznanej osoby';
  const count = used.invitedCount ? ` - zaprosił(a) już **${used.invitedCount}** ${plural(used.invitedCount, ['osobę', 'osoby', 'osób'])}` : '';
  return `**Zaprosił(a):** ${who} (zaproszenie \`${used.code}\`, użyte ${used.uses}×${used.deleted ? ', wyczerpane' : ''})${count}`;
}
