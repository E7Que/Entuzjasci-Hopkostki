// Uprawnienia Discorda jako bity (BigInt) + liczenie pozycji ról i uprawnień członka.

export const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_GUILD_INSIGHTS: 1n << 19n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
  SEND_POLLS: 1n << 49n,
};

// Na liście ról komendy: „wszyscy” (także osoby bez żadnej roli).
export const EVERYONE = 'everyone';

// Nazwy uprawnień do wyświetlenia w panelu (zakładka "Uprawnienia").
export const PERMISSION_LABELS = {
  [String(P.BAN_MEMBERS)]: 'Banowanie członków',
  [String(P.KICK_MEMBERS)]: 'Wyrzucanie członków',
  [String(P.MODERATE_MEMBERS)]: 'Wyciszanie członków (timeout)',
  [String(P.MANAGE_MESSAGES)]: 'Zarządzanie wiadomościami',
  [String(P.MANAGE_CHANNELS)]: 'Zarządzanie kanałami',
  [String(P.MANAGE_ROLES)]: 'Zarządzanie rolami',
  [String(P.MANAGE_NICKNAMES)]: 'Zarządzanie pseudonimami',
  [String(P.CONNECT)]: 'Łączenie (kanały głosowe)',
  [String(P.MOVE_MEMBERS)]: 'Przenoszenie członków',
  [String(P.MANAGE_GUILD)]: 'Zarządzanie serwerem',
  [String(P.VIEW_AUDIT_LOG)]: 'Wyświetlanie dziennika zdarzeń',
  [String(P.MANAGE_GUILD_EXPRESSIONS)]: 'Zarządzanie emoji i naklejkami',
  [String(P.ADD_REACTIONS)]: 'Dodawanie reakcji',
  [String(P.CREATE_PUBLIC_THREADS)]: 'Tworzenie wątków',
  [String(P.SEND_POLLS)]: 'Tworzenie ankiet',
  [String(P.SEND_MESSAGES)]: 'Wysyłanie wiadomości',
  [String(P.VIEW_CHANNEL)]: 'Wyświetlanie kanałów',
  [String(P.MENTION_EVERYONE)]: 'Oznaczanie @everyone, @here i wszystkich ról',
  [String(P.EMBED_LINKS)]: 'Osadzanie linków',
  [String(P.ATTACH_FILES)]: 'Załączanie plików',
  [String(P.READ_MESSAGE_HISTORY)]: 'Czytanie historii wiadomości',
  [String(P.MUTE_MEMBERS)]: 'Wyciszanie członków na głosowych',
  [String(P.DEAFEN_MEMBERS)]: 'Ogłuszanie członków na głosowych',
  [String(P.VIEW_GUILD_INSIGHTS)]: 'Podgląd statystyk serwera',
  [String(P.MANAGE_THREADS)]: 'Zarządzanie wątkami',
  [String(P.MANAGE_EVENTS)]: 'Zarządzanie wydarzeniami',
  [String(P.MANAGE_WEBHOOKS)]: 'Zarządzanie webhookami',
  [String(P.CREATE_INSTANT_INVITE)]: 'Tworzenie zaproszeń',
  [String(P.CHANGE_NICKNAME)]: 'Zmiana własnego pseudonimu',
  [String(P.USE_EXTERNAL_EMOJIS)]: 'Zewnętrzne emoji',
};

export function permissionLabel(bits) {
  if (!bits) return 'Każdy (bez wymaganych uprawnień)';
  return PERMISSION_LABELS[String(bits)] ?? 'Uprawnienie Discorda';
}

export function has(bitfield, permission) {
  const bits = BigInt(bitfield ?? 0);
  if ((bits & P.ADMINISTRATOR) === P.ADMINISTRATOR) return true;
  return (bits & permission) === permission;
}

export function rolesById(roles) {
  return new Map(roles.map((role) => [role.id, role]));
}

// Najwyższa pozycja spośród ról członka (0 = tylko @everyone).
export function highestPosition(roleIds = [], byId) {
  return roleIds.reduce((max, id) => Math.max(max, byId.get(id)?.position ?? 0), 0);
}

// Uprawnienia członka na poziomie serwera: @everyone + wszystkie jego role.
export function memberPermissions(roleIds = [], byId, guildId) {
  let bits = BigInt(byId.get(guildId)?.permissions ?? 0);
  for (const id of roleIds) bits |= BigInt(byId.get(id)?.permissions ?? 0);
  return bits;
}
