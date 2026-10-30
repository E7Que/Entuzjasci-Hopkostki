// Domyślna konfiguracja bota. Wszystko poniżej można zmienić w panelu (https://notkairo.github.io/Entuzjasci-Hopkostki/).
// Zapisana konfiguracja jest scalana z tymi wartościami, więc nowe opcje pojawiają się automatycznie.

export const ACTIONS = ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn'];

export const DEFAULT_CONFIG = {
  // Kanał z logami moderacji (pełne szczegóły, punkty ostrzeżeń, status DM). Puste = brak logów.
  modLogChannelId: '',
  // Kanał, na który trafiają ogłoszenia o karach. Puste = odpowiedź na kanale, na którym użyto komendy.
  announceChannelId: '',
  // Role, które mogą używać komend moderacyjnych (oprócz osób z odpowiednimi uprawnieniami Discorda).
  modRoleIds: [],
  // Nadpisania dostępu dla POJEDYNCZYCH komend (panel → Uprawnienia): { nazwaKomendy: ['idRoli', ...] }.
  // Gdy komenda ma tu wpis, liczy się TYLKO ta lista ról (plus administratorzy) — niezależnie od
  // uprawnień Discorda i modRoleIds powyżej. Brak wpisu = zasady domyślne. null = obiekt dynamiczny,
  // scalany/sanitizowany specjalnie (patrz configSchema.js), nie strukturą jak zwykłe pola.
  commandPermissions: null,

  // Oznaczanie ukaranego użytkownika w wiadomości na kanale.
  mentionTarget: true,
  // Wysyłanie prywatnej wiadomości (DM) do ukaranego użytkownika.
  dmUsers: true,
  // Czy w DM pokazywać, który moderator nałożył karę.
  dmShowModerator: true,
  // Tekst dopisywany do DM (np. informacja o odwołaniach). Puste = brak.
  appealText: 'Jeśli uważasz, że kara była niesłuszna, skontaktuj się z administracją serwera.',

  // Reakcja na odpowiedzi do wiadomości o karach (domyślnie :flatbread:).
  replyReaction: {
    enabled: true,
    emoji: '🫓',
  },

  warns: {
    // Domyślna liczba punktów za ostrzeżenie.
    defaultPoints: 1,
    // Po ilu dniach ostrzeżenie jest automatycznie usuwane (0 = nigdy nie wygasa).
    // Każde ostrzeżenie ma własne odliczanie liczone od chwili nadania.
    expiryDays: 60,
    // Czy pokazywać punkty użytkownikowi (kanał + DM). Domyślnie punkty widzi tylko moderacja.
    showPointsToUser: false,
  },

  // Status bota na liście członków. Teksty rotują co rotateSeconds sekund.
  // type: custom (własny status) | playing (Gra w) | listening (Słucha) | watching (Ogląda) | competing (Rywalizuje w)
  // Zmienne: {czlonkowie} {online} {serwer} {ostrzezenia} {sprawy}
  presence: {
    enabled: true,
    status: 'online',
    rotateSeconds: 30,
    activities: [
      { type: 'custom', text: 'Pilnuję porządku na Hopkostkach' },
      { type: 'watching', text: '{czlonkowie} Entuzjastów Hopkostki' },
      { type: 'custom', text: '🟢 {online} osób online • wpisz /pomoc' },
      { type: 'playing', text: '/pomoc • moderacja 24/7' },
    ],
  },

  // Kanały głosowe na żądanie: wejście na „kanał do dołączenia” (hubId) tworzy osobny kanał tej osoby
  // i przenosi ją tam; pusty kanał znika sam. Zmienne w nazwie: {nick} {numer}.
  // generators: [{ hubId, categoryId ('' = ta sama kategoria co hub), name, limit (0 = bez limitu), private }]
  tempVoice: {
    enabled: false,
    generators: [],
    // Panel z przyciskami wysyłany na czat nowego kanału.
    dashboard: {
      enabled: true,
      title: 'Panel kanału',
      description: 'Zarządzaj swoim kanałem głosowym przyciskami poniżej.',
      color: '#57F287',
    },
  },

  // Tickety: przycisk w wiadomości-panelu tworzy prywatny kanał dla tej osoby i obsługi.
  // Zmienne: {uzytkownik} {nick} {numer} {typ}. types: przyciski w panelu — każdy z własnym formularzem
  // (fields: maks. 5 pól w okienku Discorda; brak pól = ticket otwiera się od razu) i opcjonalnym powitaniem.
  tickets: {
    enabled: false,
    categoryId: '',
    // Dokąd trafia kanał po zamknięciu ticketu (puste = zostaje w tej samej kategorii). Kanał nie jest
    // usuwany — znika tylko z widoku osoby, która go otworzyła, i każdego poza obsługą.
    archiveCategoryId: '',
    supportRoleIds: [],
    logChannelId: '',
    maxOpen: 1,
    nameTemplate: 'ticket-{numer}',
    dmTranscript: true,
    welcome: 'Cześć {uzytkownik}! Opisz dokładnie swoją sprawę — ktoś z obsługi zaraz odpowie.',
    panel: {
      title: 'Pomoc i zgłoszenia',
      description:
        'Masz problem albo pytanie do administracji? Wybierz **Zgłoszenie**.\nChcesz nawiązać z nami partnerstwo? Wybierz **Partnerstwo** — poprosimy o link do serwera, liczbę członków i powód.\n\nUtworzymy prywatny kanał, na którym ktoś Ci odpowie.',
      color: '#5865F2',
    },
    types: [
      {
        label: 'Zgłoszenie',
        style: 'niebieski',
        emoji: '📩',
        welcome: '',
        fields: [{ label: 'Opisz krótko swoją sprawę', placeholder: '', kind: 'long', required: true }],
      },
      {
        label: 'Partnerstwo',
        style: 'zielony',
        emoji: '🤝',
        welcome: 'Cześć {uzytkownik}! Dzięki za chęć nawiązania partnerstwa — administracja sprawdzi Twój serwer i odpowie tutaj.',
        fields: [
          { label: 'Link do serwera', placeholder: 'https://discord.gg/…', kind: 'invite', required: true },
          { label: 'Liczba członków', placeholder: 'np. 250', kind: 'number', required: true },
          { label: 'Powód', placeholder: 'Dlaczego chcesz nawiązać z nami partnerstwo?', kind: 'long', required: true },
        ],
      },
    ],
  },

  // Nowe osoby na serwerze. Wymaga intencji „Server Members” — bot włącza ją sam, gdy coś tu jest włączone.
  // Zmienne w wiadomościach: {uzytkownik} {nick} {serwer} {liczba}
  members: {
    autoRole: { enabled: false, roleIds: [], botRoleIds: [] },
    welcome: {
      enabled: false,
      channelId: '',
      title: 'Witaj na serwerze!',
      message: 'Cześć {uzytkownik}! Witamy na **{serwer}** — jesteś naszym **{liczba}.** członkiem.',
      color: '#57F287',
    },
    goodbye: { enabled: false, channelId: '', message: '**{nick}** opuścił(a) serwer. Zostało nas {liczba}.' },
  },

  // Logi serwera jak w Carl-bocie. Każda grupa może mieć własny kanał ('' = kanał domyślny channelId).
  // Zmiany ról, pseudonimów, kanałów, wątków, ról serwera, bany i timeouty pochodzą z dziennika zdarzeń
  // Discorda (bot potrzebuje uprawnienia „Wyświetlanie dziennika zdarzeń”), więc widać też, KTO coś zrobił.
  // Domyślnie włączone są te same zdarzenia, które były zaznaczone w Carl-bocie.
  logs: {
    enabled: false,
    channelId: '',
    membersChannelId: '',
    serverChannelId: '',
    voiceChannelId: '',
    messagesChannelId: '',
    joinLeaveChannelId: '',
    ignoreBots: true,
    ignoredChannelIds: [],
    // Nowe konta (np. multikonta): przy wejściu osoby z kontem młodszym niż `days` dni log jest żółty,
    // a gdy ping jest włączony — oznacza @here, @everyone albo wybrane role (mention: here | everyone | roles).
    newAccount: {
      ping: true,
      days: 1,
      mention: 'here',
      roleIds: [],
    },
    events: {
      // Wiadomości
      messageDelete: true,
      messageEdit: true,
      messageBulk: false,
      // Wejścia i wyjścia
      memberJoin: true,
      memberLeave: true,
      memberInvite: true,
      // Członkowie
      memberRoles: true,
      memberNick: true,
      memberAvatar: true,
      memberBan: true,
      memberUnban: true,
      memberTimeout: false,
      memberTimeoutRemove: false,
      memberKick: false,
      // Serwer
      channelCreate: false,
      channelUpdate: false,
      channelDelete: false,
      threadCreate: false,
      threadUpdate: false,
      threadDelete: false,
      roleCreate: false,
      roleUpdate: true,
      roleDelete: false,
      serverUpdate: false,
      emojiUpdate: false,
      inviteCreate: false,
      // Kanały głosowe
      voiceJoin: false,
      voiceMove: false,
      voiceLeave: false,
    },
  },

  // Przypominajka o bumpie na DISBOARD (jak Fibo): po udanym /bump bot odpowiada podziękowaniem,
  // a po intervalMinutes przypomina (odpowiedzią na ostatni bump) i oznacza wybrane role.
  // Zmienne: {uzytkownik} {nick} {liczba} (który to bump tej osoby) {nastepny} (kiedy kolejny)
  bump: {
    enabled: false,
    channelId: '',
    roleIds: [],
    intervalMinutes: 120,
    thanks: {
      enabled: true,
      reply: true,
      title: 'Dzięki za Bumpnięcie serwera!',
      message: '{uzytkownik} — to już Twój **{liczba}.** bump. Kolejny możliwy {nastepny}.',
      color: '#5865F2',
    },
    reminder: {
      reply: true,
      title: 'Czas na Bump!',
      message: 'Bumpnij serwer używając komendy </bump:947088344167366698>!',
      color: '#5865F2',
    },
  },

  // Propozycje (/propozycja): embed na wybranym kanale z reakcjami do głosowania i opcjonalnym wątkiem.
  suggestions: {
    enabled: false,
    channelId: '',
    thread: true,
  },

  // Automatyczne kary po przekroczeniu progu aktywnych punktów ostrzeżeń.
  // action: alert (tylko powiadomienie w logach) | timeout | kick | ban
  escalation: {
    enabled: false,
    rules: [
      { points: 5, action: 'alert', amount: 0, unit: 'm' },
      { points: 10, action: 'timeout', amount: 1, unit: 'd' },
      { points: 20, action: 'ban', amount: 7, unit: 'd' },
    ],
  },

  // Wygląd embedów dla każdej akcji. Dostępne zmienne w tekstach:
  // {uzytkownik} {nick} {moderator} {moderatorNick} {powod} {czas} {serwer} {sprawa} {typ}
  actions: {
    ban: {
      color: '#ED4245',
      emoji: '⛔',
      title: 'Pomyślnie zbanowano użytkownika',
      description: 'Pomyślnie {typ} zbanowałeś **{nick}** z serwera!',
      dmTitle: 'Zostałeś zbanowany',
      dmDescription: 'Zostałeś {typ} zbanowany na serwerze **{serwer}**.',
    },
    unban: {
      color: '#57F287',
      emoji: '✅',
      title: 'Pomyślnie odbanowano użytkownika',
      description: 'Użytkownik **{nick}** został odbanowany i może wrócić na serwer.',
      dmTitle: 'Zostałeś odbanowany',
      dmDescription: 'Twój ban na serwerze **{serwer}** został zdjęty. Możesz wrócić!',
    },
    kick: {
      color: '#F0883E',
      emoji: '👢',
      title: 'Pomyślnie wyrzucono użytkownika',
      description: 'Pomyślnie wyrzuciłeś **{nick}** z serwera!',
      dmTitle: 'Zostałeś wyrzucony',
      dmDescription: 'Zostałeś wyrzucony z serwera **{serwer}**. Możesz dołączyć ponownie z nowym zaproszeniem.',
    },
    timeout: {
      color: '#9B59B6',
      emoji: '🔇',
      title: 'Pomyślnie wyciszono użytkownika',
      description: 'Pomyślnie nałożyłeś timeout na **{nick}** na **{czas}**!',
      dmTitle: 'Otrzymałeś timeout',
      dmDescription: 'Zostałeś wyciszony na serwerze **{serwer}** na **{czas}**.',
    },
    untimeout: {
      color: '#57F287',
      emoji: '🔊',
      title: 'Pomyślnie zdjęto timeout',
      description: 'Timeout użytkownika **{nick}** został zdjęty.',
      dmTitle: 'Twój timeout został zdjęty',
      dmDescription: 'Możesz znowu pisać na serwerze **{serwer}**.',
    },
    warn: {
      color: '#FEE75C',
      emoji: '⚠️',
      title: 'Użytkownik otrzymał ostrzeżenie',
      description: '**{nick}** otrzymał ostrzeżenie od moderacji.',
      dmTitle: 'Otrzymałeś ostrzeżenie',
      dmDescription: 'Otrzymałeś ostrzeżenie na serwerze **{serwer}**. Kolejne mogą skutkować karą.',
    },
  },
};
