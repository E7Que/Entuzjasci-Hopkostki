// Domyślna konfiguracja bota. Wszystko poniżej można zmienić w panelu (https://enho.pl/panel).
// Zapisana konfiguracja jest scalana z tymi wartościami, więc nowe opcje pojawiają się automatycznie.

export const ACTIONS = ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn'];

export const DEFAULT_CONFIG = {
  // Kanał z logami moderacji (pełne szczegóły, punkty ostrzeżeń, status DM). Puste = brak logów.
  modLogChannelId: '',
  // Alerty, gdy bot przestaje działać (brak połączenia z Discordem, komendy nie docierają, funkcja bota nie odpowiada).
  // channelId puste = kanał logów moderacji; minutes - po ilu minutach problemu wysłać alert (3-120).
  alerts: { enabled: true, channelId: '', pingRoleId: '', minutes: 5 },
  // Kanał, na który trafiają ogłoszenia o karach. Puste = odpowiedź na kanale, na którym użyto komendy.
  announceChannelId: '',
  // Role, które mogą używać komend moderacyjnych (oprócz osób z odpowiednimi uprawnieniami Discorda).
  modRoleIds: [],
  // Nadpisania dostępu dla POJEDYNCZYCH komend (panel → Uprawnienia): { nazwaKomendy: ['idRoli', ...] }.
  // Gdy komenda ma tu wpis, liczy się TYLKO ta lista ról - także dla ról z Administratorem, niezależnie od
  // uprawnień Discorda i modRoleIds powyżej. Jedyny wyjątek: właściciel serwera ma dostęp zawsze (bezpiecznik,
  // patrz moderation.js/hasModAccess). Brak wpisu = zasady domyślne. null = obiekt dynamiczny,
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
  // Odwołania od kar: przycisk „Odwołaj się” pod DM z karą (ban, wyrzucenie, timeout, ostrzeżenie) → formularz →
  // kanał channelId (puste = kanał logów moderacji) z przyciskami Przyjmij/Odrzuć; pingRoleId - ping przy nowym
  // odwołaniu. Przyjęcie cofa karę. Jedno odwołanie na sprawę, najwyżej `days` dni po karze.
  appeals: { enabled: false, channelId: '', pingRoleId: '', days: 14 },

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
  // Zmienne: {uzytkownik} {nick} {numer} {typ}. types: przyciski w panelu - każdy z własnym formularzem
  // (fields: maks. 5 pól w okienku Discorda; brak pól = ticket otwiera się od razu) i opcjonalnym powitaniem.
  tickets: {
    enabled: false,
    categoryId: '',
    // Dokąd trafia kanał po zamknięciu ticketu (puste = zostaje w tej samej kategorii). Kanał nie jest
    // usuwany - znika tylko z widoku osoby, która go otworzyła, i każdego poza obsługą.
    archiveCategoryId: '',
    supportRoleIds: [],
    logChannelId: '',
    maxOpen: 1,
    nameTemplate: 'ticket-{numer}',
    dmTranscript: true,
    // Pierwsza wiadomość kogoś z obsługi w nieprzejętym tickecie przejmuje go (jak przycisk „Przejmij”).
    autoClaim: true,
    welcome: 'Cześć {uzytkownik}! Opisz dokładnie swoją sprawę - ktoś z obsługi zaraz odpowie.',
    panel: {
      title: 'Pomoc i zgłoszenia',
      description:
        'Masz problem albo pytanie do administracji? Wybierz **Zgłoszenie**.\nChcesz nawiązać z nami partnerstwo? Wybierz **Partnerstwo** - poprosimy o link do serwera, liczbę członków i powód.\n\nUtworzymy prywatny kanał, na którym ktoś Ci odpowie.',
      color: '#5865F2',
    },
    types: [
      {
        label: 'Zgłoszenie',
        style: 'niebieski',
        emoji: '📩',
        welcome: '',
        rules: '',
        categoryId: '',
        archiveCategoryId: '',
        logChannelId: '',
        supportRoleIds: [],
        authorCanClose: true,
        authorCanAdd: true,
        authorCanAttach: true,
        fields: [{ label: 'Opisz krótko swoją sprawę', placeholder: '', kind: 'long', required: true }],
      },
      {
        label: 'Partnerstwo',
        style: 'zielony',
        emoji: '🤝',
        welcome: 'Cześć {uzytkownik}! Dzięki za chęć nawiązania partnerstwa - administracja sprawdzi Twój serwer i odpowie tutaj.',
        // Regulamin partnerstw - pokazywany przed formularzem; edytujesz go w panelu (Tickety → Partnerstwo).
        rules: '**1.** Serwer partnera musi być aktywny i przestrzegać regulaminu Discorda (bez treści NSFW, nienawiści i oszustw).\n**2.** Podany link do serwera musi być stałym zaproszeniem (bez limitu czasu i użyć).\n**3.** Podana liczba członków musi być prawdziwa - sprawdzamy ją w Discordzie. Boty i fałszowanie liczby = odmowa.\n**4.** Partnerstwo opiera się na wzajemnej reklamie: obie strony publikują reklamę drugiej na ustalonym kanale i nie usuwają jej bez uzgodnienia.\n**5.** Linki w reklamie nie mogą być ukryte - żadnych linków schowanych pod tekstem (np. [kliknij](link)), w spoilerach, za skracaczami ani przekierowaniami. Zaproszenie musi być widoczne w całości.\n**6.** Zakaz promowania się pieniędzmi, konkursami, giveawayami i innymi nagrodami za dołączenie (np. Nitro, płatne zaproszenia, „dołącz i wygraj”) - dotyczy serwera partnera i treści reklamy.\n**7.** Zastrzegamy sobie prawo do zerwania partnerstwa, gdy serwer partnera złamie regulamin lub przestanie spełniać wymagania.\n**8.** Decyzję o partnerstwie podejmuje administracja - odpowiedź może zająć kilka dni.',
        categoryId: '',
        archiveCategoryId: '',
        logChannelId: '',
        supportRoleIds: [],
        authorCanClose: true,
        authorCanAdd: false,
        authorCanAttach: true,
        fields: [
          { label: 'Link do serwera', placeholder: 'https://discord.gg/…', kind: 'invite', required: true },
          { label: 'Liczba członków', placeholder: 'np. 250', kind: 'number', required: true },
          { label: 'Powód', placeholder: 'Dlaczego chcesz nawiązać z nami partnerstwo?', kind: 'long', required: true },
        ],
      },
    ],
  },

  // Nowe osoby na serwerze. Wymaga intencji „Server Members” - bot włącza ją sam, gdy coś tu jest włączone.
  // Zmienne w wiadomościach: {uzytkownik} {nick} {serwer} {liczba}
  members: {
    autoRole: { enabled: false, roleIds: [], botRoleIds: [] },
    welcome: {
      enabled: false,
      channelId: '',
      title: 'Witaj na serwerze!',
      message: 'Cześć {uzytkownik}! Witamy na **{serwer}** - jesteś naszym **{liczba}.** członkiem.',
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
    // a gdy ping jest włączony - oznacza @here, @everyone albo wybrane role (mention: here | everyone | roles).
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
      message: '{uzytkownik} - to już Twój **{liczba}.** bump. Kolejny możliwy {nastepny}.',
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

  // Poziomy (jak Arcane). Formuła: linear = 100·poziom + 75 XP na następny poziom (jak „Linear” w Arcane),
  // standard = jak MEE6, flat = zawsze 100; × mnożnik; maxLevel 0 = bez limitu.
  // levelUp.target: current (kanał, na którym ktoś napisał) | channel (channelId) | dm.
  // Tagi wiadomości: {user.mention} {user.name} {user.level} {user.xp} {earned:… {name} / {mention} …}.
  levels: {
    enabled: false,
    formula: { curve: 'linear', multiplier: 1, maxLevel: 0 },
    message: { enabled: true, mode: 'random', min: 15, max: 40, cooldown: 60 },
    voice: { enabled: false, min: 15, max: 40, cooldown: 180, minMembers: 2, antiAfk: true },
    reaction: { enabled: false, awards: 'both', min: 25, max: 25, cooldown: 300 },
    // Ochrona przed nabijaniem: dailyCap - najwyżej tyle XP na dobę (czas polski; 0 = bez limitu, w wydarzeniu XP
    // limit rośnie razem z mnożnikiem); ignoreRepeats - ta sama wiadomość co ostatnio nagrodzona nie daje XP;
    // minChars - krótsze wiadomości (bez załączników) nie dają XP.
    antiFarm: { dailyCap: 0, ignoreRepeats: true, minChars: 0 },
    // Wydarzenia XP: od startsAt do endsAt XP (wybranych rodzajów: message/voice/reaction) mnożone przez multiplier
    // (dowolny od 1,1 do 10); gdy kilka się nakłada - liczy się największy mnożnik. theme - efekt na stronie rankingu
    // (XP_EVENT_THEMES w configSchema.js), intensity - none/low/medium/high, accent - własny kolor #rrggbb albo null,
    // floor - efekt przy dole ekranu (płomienie przy „Ogniu”), false wyłącza.
    // Ogłoszenie początku i końca (z najlepszymi osobami) na eventsAnnounce.channelId (puste = kanał awansów),
    // rola roleId dostaje ping przy starcie.
    events: [],
    eventsAnnounce: { enabled: true, channelId: '', roleId: '' },
    levelUp: {
      enabled: true,
      target: 'current',
      channelId: '',
      message: '{user.mention} właśnie awansował(a) na poziom **{user.level}**!{earned: Zdobywasz rolę **{name}**!}',
      card: false,
    },
    rewards: [],
    stackRewards: true,
    firstPlaceRoleId: '',
    boosters: {
      stack: true,
      effort: { enabled: false, words: 50, images: 5, percent: 10 },
      roles: [],
      channels: [],
    },
    // Raz w tygodniu (niedziela 00:00 UTC) i raz w miesiącu ranking osób, które w tym czasie zdobyły najwięcej XP;
    // roleId - rola pingowana przy każdym nowym rankingu.
    highlights: { weekly: { enabled: false, channelId: '' }, monthly: { enabled: false, channelId: '' }, roleId: '' },
    // autoColor - kolor embedów z roli za poziom (albo progu poziomu); userBanner - baner osoby z Discorda jako obrazek.
    card: { color: '#3CC3D6', image: '', autoColor: true, userBanner: true },
    management: { lockXpCommand: false, lockReset: false },
    autoReset: true,
    restrictions: { channelMode: 'deny', channelIds: [], roleIds: [], threads: true, forums: true, voiceText: true, slashCommands: false },
    publicLeaderboard: true,
  },

  // Eventy (konkursy) na stronie rankingu - zakładka „Eventy” pokazuje się tylko, gdy jakiś event jest zaplanowany,
  // trwa albo skończył się w ostatnich 3 dniach. Udział wymaga połączenia konta: /polacz na Discordzie daje link,
  // który loguje na stronie. list: eventy (contests.js), logChannelId: kanał, na który trafiają zgłoszenia osób,
  // które osiągnęły próg (puste = bez powiadomień), pingRoleId: rola oznaczana przy zgłoszeniu.
  // Wygląd stron WWW (Ustawienia → Wygląd strony): ikona i osobne banery strony głównej, rankingu i eventów,
  // wgrane w panelu (obrazki bota /panel/public/asset/…). Puste = domyślne pliki strony (img/icon.webp, img/banner.webp).
  site: {
    icon: '',
    bannerHome: '',
    bannerRanking: '',
    bannerEvents: '',
  },

  contests: {
    enabled: true,
    logChannelId: '',
    pingRoleId: '',
    list: [],
  },

  // Logowanie moderacji do panelu: /login na wybranym kanale daje osobie jej login i hasło, ważne loginDays
  // dni (7, 14 albo 30 - potem /login daje nowe; /login nowy:True wymusza nowe wcześniej).
  // roles: które role odblokowują którą część panelu (bot sprawdza aktualne role na bieżąco).
  // Administratorzy serwera i logowanie hasłem panelu mają zawsze dostęp do wszystkiego.
  // Automoderacja (domyślnie wyłączona). action: delete = tylko usunięcie wiadomości, warn = usunięcie + ostrzeżenie
  // (warnPoints punktów → progi z „Ostrzeżeń”), timeout = usunięcie + timeout na timeoutMinutes minut.
  // Moderatorzy (role moderatorów, uprawnienia zarządzania wiadomościami/serwerem/timeoutem) są pomijani.
  automod: {
    enabled: false,
    logChannelId: '',
    exemptRoleIds: [],
    exemptChannelIds: [],
    // Pomijanie administracji i moderacji (role moderatorów, właściciel, uprawnienia do usuwania wiadomości / timeoutów).
    exemptStaff: true,
    // Pomijanie ticketów (wszystkich rodzajów, otwartych i zamkniętych) - rozmowy z obsługą, linki przy partnerstwach.
    exemptTickets: true,
    notify: true,
    timeoutMinutes: 10,
    warnPoints: 1,
    invites: { enabled: true, action: 'delete', allowOwn: true },
    mentions: { enabled: true, limit: 6, action: 'timeout' },
    caps: { enabled: false, percent: 75, minLength: 15, action: 'delete' },
    words: { enabled: false, list: [], action: 'delete' },
    spam: { enabled: true, messages: 7, seconds: 8, duplicates: 4, action: 'timeout' },
    // Rajd: tyle wejść w tyle sekund → alert i tryb anty-rajdu na `minutes` minut; kick = wyrzucanie nowych kont
    // (młodszych niż accountAgeDays dni; 0 = wszystkich) w tym czasie.
    raid: { enabled: false, joins: 10, seconds: 30, minutes: 10, action: 'alert', accountAgeDays: 7 },
  },

  // Serwer info (zakładka panelu): wiadomość z informacjami o rolach, rolach za poziomy i komendach dla społeczności.
  // Sekcja = embed (tytuł, wstęp, lista) z opcjonalnym banerem nad nim. Elementy listy: heading (nagłówek),
  // role (rola + opis w cytacie), command (komenda + opis; commandId dla komend innych botów), text.
  // W tekstach {/komenda} zamienia się w klikalną komendę. Role uzupełnia przycisk „Uzupełnij role z serwera”.
  serverInfo: {
    channelId: '',
    color: '#3CC3D6',
    bullet: '🔹',
    footer: 'Entuzjaści Hopkostki',
    sections: [
      { id: 'roles', kind: 'roles', title: 'Entuzjaści Hopkostki | Informacje o rolach 📋 *(Główne)*', intro: '', banner: '', items: [] },
      {
        id: 'levels',
        kind: 'levels',
        title: 'Role za poziomy 📈',
        intro: 'Za aktywność na serwerze zdobywasz XP - za wiadomości i czas na kanałach głosowych. Kolejne poziomy dają nowe role. Swój poziom sprawdzisz komendą {/rank}.',
        banner: '',
        items: [],
      },
      {
        id: 'commands',
        kind: 'commands',
        title: 'Komendy dla wszystkich ⌨️',
        intro: 'Wpisz / na czacie albo kliknij komendę poniżej.',
        banner: '',
        items: [
          { kind: 'heading', text: 'Poziomy' },
          { kind: 'command', command: 'rank', commandId: '', text: 'Twoja karta poziomu (albo innej osoby)' },
          { kind: 'command', command: 'ranking', commandId: '', text: 'najaktywniejsi łącznie, w tym tygodniu i miesiącu' },
          { kind: 'command', command: 'prywatnosc', commandId: '', text: 'ukryj się albo pokaż na stronie rankingu' },
          { kind: 'heading', text: 'Ty i serwer' },
          { kind: 'command', command: 'profil', commandId: '', text: 'profil: konto, dołączenie, role' },
          { kind: 'command', command: 'avatar', commandId: '', text: 'awatar w dużym rozmiarze' },
          { kind: 'command', command: 'serwer', commandId: '', text: 'informacje o serwerze' },
          { kind: 'command', command: 'czlonkowie', commandId: '', text: 'ile osób jest na serwerze i online' },
          { kind: 'command', command: 'rolainfo', commandId: '', text: 'informacje o wybranej roli' },
          { kind: 'command', command: 'zaproszenia', commandId: '', text: 'kto kogo zaprosił' },
          { kind: 'heading', text: 'Przydatne' },
          { kind: 'command', command: 'afk', commandId: '', text: 'status AFK (bot odpowie za Ciebie, gdy ktoś Cię oznaczy)' },
          { kind: 'command', command: 'przypomnij dodaj', commandId: '', text: 'przypomnienie o wybranej porze' },
          { kind: 'command', command: 'propozycja', commandId: '', text: 'zgłoś pomysł na serwer' },
          { kind: 'command', command: 'pomoc', commandId: '', text: 'lista wszystkich komend bota' },
          { kind: 'heading', text: 'Bump' },
          { kind: 'command', command: 'bump', commandId: '947088344167366698', text: 'podbij serwer na DISBOARD (co 2 godziny)' },
          { kind: 'command', command: 'bumpy status', commandId: '', text: 'kiedy można znowu podbić serwer' },
          { kind: 'command', command: 'bumpy ranking', commandId: '', text: 'kto najczęściej bumpuje' },
        ],
      },
    ],
  },

  panelAccess: {
    enabled: false,
    channelId: '',
    loginDays: 7,
    roles: {
      ustawienia: [],
      uprawnienia: [],
      czlonkowie: [],
      logi: [],
      bump: [],
      spolecznosc: [],
      tickety: [],
      glosowe: [],
      wiadomosci: [],
      embedy: [],
      ostrzezenia: [],
      sprawy: [],
      bany: [],
      poziomy: [],
      eventy: [],
      automod: [],
      serwerinfo: [],
    },
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
