# Entuzjaści Hopkostki — bot moderacyjny

Bot moderacyjny na Discorda dla serwera **Entuzjaści Hopkostki**. Działa 24/7 na **Supabase**, więc nie
musisz trzymać włączonego komputera. Panel konfiguracyjny to strona na GitHub Pages — wystarczy
przeglądarka, nic nie trzeba instalować ani uruchamiać lokalnie.

```
Discord ──(komendy /ban, /warn…)──▶ Supabase Edge Function "hopkostki-bot" ──▶ Postgres (sprawy, ostrzeżenia, ustawienia)
                    ▲            ▲                    ▲                              ▲
                    │            │   pg_cron co 30 s ─┘ (wygasanie banów/ostrzeżeń)   │
        gateway co minutę        │   pg_cron co minutę ─ sesja gateway (status online)│
   (status online, reakcje 🫓)   └── API panelu …/hopkostki-bot/panel/* ◀── strona na GitHub Pages
```

## Szybki start (3 kroki)

Projekt Supabase **„Entuzjaści Hopkostki”** (`ucjmbdogtzztrkorqzjq`) jest już utworzony. Baza, funkcja bota
i harmonogram są wdrożone. Brakuje tylko Twojego tokenu bota:

1. **Zresetuj token bota:** https://discord.com/developers/applications → Twoja aplikacja → **Bot** → **Reset Token**.
   Token, który był w czacie, uznaj za spalony.
2. **Dodaj sekret w Supabase:** https://supabase.com/dashboard/project/ucjmbdogtzztrkorqzjq/functions/secrets
   | Nazwa | Wartość |
   | --- | --- |
   | `DISCORD_TOKEN` | nowy token bota |
   | `PANEL_PASSWORD` *(opcjonalnie)* | własne hasło do panelu — jeśli go nie ustawisz, bot wygeneruje je sam przy pierwszym otwarciu panelu |
   | `GUILD_ID` *(opcjonalnie)* | ID serwera; bez niego bot bierze pierwszy serwer, na którym jest |
3. **Poczekaj około minuty.** Harmonogram sam:
   - zarejestruje komendy slash na serwerze,
   - ustawi w Discordzie **Interactions Endpoint URL**,
   - połączy bota z gatewayem, żeby świecił na zielono i pokazywał status.

   Jeśli ustawienie adresu się nie uda (widać to w panelu), wklej go ręcznie w Developer Portal →
   **General Information** → **Interactions Endpoint URL** → **Save**.

Jeśli bota nie ma jeszcze na serwerze, zaproś go tym linkiem (podmień `TWOJE_CLIENT_ID` na *Application ID*):
```
https://discord.com/oauth2/authorize?client_id=TWOJE_CLIENT_ID&scope=bot+applications.commands&permissions=1374676151382
```
Potem przesuń rolę bota **wyżej** niż role osób, które ma karać (Ustawienia serwera → Role). Do kanałów głosowych
na żądanie rola bota potrzebuje też **Łączenie** i **Przenoszenie członków** — panel pokaże, jeśli ich brakuje.

## Panel konfiguracyjny

Nic nie instalujesz, wystarczy otworzyć w przeglądarce:

```
https://e7que.github.io/Entuzjasci-Hopkostki/
```

Stary adres `…/functions/v1/hopkostki-bot/panel/` przekierowuje tutaj. Supabase nie pozwala funkcjom Edge
wyświetlać stron HTML (zamienia je na zwykły tekst), więc sama strona leży na GitHub Pages (gałąź `gh-pages`,
publikowana automatycznie z `panel/public/` po każdej zmianie na `main`), a dane i hasło obsługuje API bota
na Supabase — strona tylko je woła.

Moderacja loguje się własnym loginem i hasłem z komendy `/login` — patrz „Logowanie moderacji do panelu”
niżej. Właściciel może też użyć **hasła panelu**: przy pierwszym wejściu panel zapyta o **hasło**. Hasło
zmienione w zakładce **Ustawienia → Hasło panelu** ma pierwszeństwo; dopóki go nie zmienisz, działa
`PANEL_PASSWORD` z sekretów Supabase (a bez sekretu — hasło wygenerowane przez bota przy pierwszym użyciu).
Hasło zapamiętuje przeglądarka na czas karty (do „Wyloguj” albo zamknięcia karty).

W panelu są:
- **Pulpit:** status bota, lista kontrolna połączenia z Discordem (w tym sesja gateway), statystyki
  i ostatnie sprawy. Przycisk „Sprawdź i zarejestruj komendy” wymusza konfigurację od razu.
- **Ustawienia:** kanał logów, kanał ogłoszeń, role moderatorów, DM, dopisek o odwołaniach, emoji reakcji,
  status i rotujące opisy bota oraz hasło panelu.
- **Uprawnienia:** dla każdej komendy możesz nadpisać domyślne uprawnienie Discorda i ograniczyć ją do
  wybranych ról — plus tabela pokazująca na żywo, która rola może użyć której komendy, i uprawnienia ról
  w samym Discordzie (np. odebranie wyrzucania).
- **Dostęp do panelu:** logowanie moderacji komendą `/login` (kanał, wygasanie loginów, które role
  odblokowują które części panelu) i lista aktywnych loginów — patrz niżej.
- **Nowe osoby:** automatyczne role po wejściu (osobno dla ludzi i botów), powitanie i pożegnanie.
- **Logi serwera:** logi jak w Carl-bocie — patrz niżej.
- **Bump:** przypominajka o bumpie DISBOARD jak w Fibo, z podziękowaniem i rankingiem — patrz niżej.
- **Społeczność:** propozycje (`/propozycja`), lista konkursów i opis komend na co dzień.
- **Tickety:** panel z przyciskami, prywatne kanały ticketów, zapis rozmów — patrz niżej.
- **Kanały głosowe:** kanały na żądanie — patrz niżej.
- **Wiadomości:** wysyłanie wiadomości (treść + embed) z przyciskami ról albo listą wyboru ról — każda rola
  może mieć emoji (własne emoji serwera wybierane z siatki albo zwykłe); wysłane można potem edytować albo usunąć.
- **Wygląd embedów:** edycja każdej akcji z podglądem na żywo w stylu Discorda (na kanale i w DM).
- **Ostrzeżenia:** czas wygasania (domyślnie 60 dni), domyślne punkty, progi automatycznych kar
  i wszystkie aktywne ostrzeżenia z odliczaniem na żywo oraz przyciskiem „Usuń”.
- **Sprawy:** przeszukiwalna historia wszystkich akcji.
- **Tymczasowe bany:** odliczanie do końca bana i przycisk „Odbanuj teraz”.

Zmiany zapisujesz przyciskiem na dole i działają od razu.

### Kanały głosowe na żądanie

W zakładce **Kanały głosowe** wybierasz „kanał do dołączenia” (np. „Dołącz, aby utworzyć”), kategorię, nazwę
(`{nick}`, `{numer}`), limit osób i czy nowy kanał ma być od razu prywatny. Kto wejdzie na kanał do dołączenia,
dostaje własny kanał i jest na niego przenoszony; pusty kanał znika sam. Na czacie kanału bot wysyła panel
(po polsku) z przyciskami: **Ustaw jako prywatny/publiczny**, **Dodaj osoby**, **Zmień nazwę**, **Zmień
właściciela**, **Zmień limit**, **Zbanuj**, **Wyrzuć** — osoby wybiera się z listy, nazwę i limit wpisuje w
okienku. Z panelu korzysta właściciel kanału (oraz osoby z uprawnieniem „Zarządzanie kanałami”).

### Logi serwera

Zakładka **Logi serwera** ma układ jak w Carl-bocie: kanał domyślny i osobne (opcjonalne) kanały dla
członków, serwera, kanałów głosowych, wiadomości oraz wejść i wyjść, lista pomijanych kanałów i karty ze
zdarzeniami do zaznaczenia. Domyślnie włączone są te same zdarzenia, które były zaznaczone w Carl-bocie:
usunięte i edytowane wiadomości, wejścia i wyjścia, zmiany ról, nazw i zdjęć profilowych, bany, odbanowania
i zmiany ról serwera. Do wyboru są też m.in.: zbiorcze usuwanie wiadomości, timeouty i ich zdjęcie,
wyrzucenia, kanały i wątki (utworzenie, zmiany z wartościami przed/po, usunięcie), role serwera, ustawienia
serwera, emoji, zaproszenia i kanały głosowe (wejście, przejście, wyjście).

- **Zmiana zdjęcia profilowego:** log pokazuje stare i nowe zdjęcie obok siebie — bot pobiera oba obrazki od
  razu i dołącza je do wiadomości, więc stare zdjęcie nie zniknie z logów.
- **Zmiana nazwy:** pseudonim na serwerze (z dziennika zdarzeń) i nazwa użytkownika — przed/po.
- **Kto kogo zaprosił:** log wejścia pokazuje, z czyjego zaproszenia ktoś wszedł (kod, liczba użyć i ile osób
  ta osoba już zaprosiła), a log wyjścia — kto tę osobę zaprosił. Bot porównuje liczniki użyć zaproszeń (jak
  boty typu Invite Tracker), więc potrzebuje uprawnienia „Zarządzanie serwerem”. `/zaproszenia` pokazuje
  ranking albo osoby zaproszone przez wybraną osobę.
- **Nowe konta:** przy wejściu osoby z kontem młodszym niż wybrany próg (1 dzień – 30 dni) log jest żółty i
  bot oznacza **@here**, @everyone albo wybrane role.

Zmiany z dziennika zdarzeń Discorda pokazują, **kto** je zrobił (bot potrzebuje uprawnienia „Wyświetlanie
dziennika zdarzeń”). Treść wiadomości bot pamięta 7 dni (tabela `bot.message_cache`, czyszczona przez crona),
a ostatnie zdjęcia i nazwy osób — w `bot.member_profiles`; z pamięci wiadomości korzysta też `/snipe`.

### Bump (DISBOARD)

Jak Fibo: po udanym `/bump` bota DISBOARD bot **odpowiada na tę wiadomość** podziękowaniem (np. „Dzięki za
Bumpnięcie serwera! @osoba — to już Twój 7. bump. Kolejny możliwy za 2 godziny”), a po 120 minutach wysyła
**„Czas na Bump!”** jako odpowiedź na ostatni bump, oznaczając wybrane role. Podziękowanie można wyłączyć,
teksty, kolory i czas zmienić (zmienne: `{uzytkownik}`, `{nick}`, `{liczba}`, `{nastepny}`, `{godzina}`),
a zakładka pokazuje podgląd i ranking. Komenda `/bumpy` pokazuje ranking i kiedy następny bump.

### Tickety

W zakładce **Tickety** włączasz tickety, wybierasz kategorię, kanał logów i role obsługi, a potem wysyłasz
**panel ticketów** (wiadomość z przyciskami — każdy przycisk to rodzaj ticketu, domyślnie **Zgłoszenie** i
**Partnerstwo**). Każdy rodzaj ma własny **formularz** (do 5 pól w okienku Discorda: krótka odpowiedź, długi
tekst, liczba albo link do serwera Discord), emoji na przycisku i opcjonalnie własne powitanie:
- **Partnerstwo** pyta o link do serwera, liczbę członków i powód. Link musi być działającym zaproszeniem
  (bot sprawdza go w Discordzie i odrzuca link do naszego serwera), a w tickecie obsługa widzi nazwę serwera
  i jego **prawdziwą** liczbę członków i osób online obok liczby podanej w formularzu;
- pole „Liczba” przyjmuje tylko liczbę („1 500” tak, „1,5k” czy „250–300” nie);
- przy błędzie nic nie przepada — przycisk **„Popraw formularz”** otwiera okienko z wpisanymi odpowiedziami.

Każdy rodzaj ticketu można też skonfigurować osobno (zakładka Tickety → rodzaj → „Osobne ustawienia”):
- **Regulamin przed formularzem** — tekst edytowany w panelu; osoba widzi go z przyciskami „Akceptuję
  regulamin” / „Nie akceptuję” i dopiero po akceptacji dostaje formularz (domyślnie ma go Partnerstwo,
  a obsługa widzi w tickecie „Regulamin: zaakceptowany”);
- **własna kategoria, archiwum, kanał logów i role obsługi** — np. partnerstwa trafiają do innej kategorii
  i widzi je tylko inna obsługa niż zgłoszenia (puste = ustawienia ogólne);
- **uprawnienia autora** — czy może zamknąć ticket, dodawać osoby i wysyłać pliki/linki.

Wysłanie formularza tworzy prywatny kanał widoczny tylko dla tej osoby i obsługi (oznaczona w powitaniu
jest tylko ta osoba — obsługa i tak ma dostęp do kanału, więc pingowanie całej roli przy każdym nowym
tickecie byłoby tylko spamem powiadomień), z przyciskami **Zamknij** (z potwierdzeniem), **Przejmij** i
**Dodaj osobę**.

Zamknięty ticket **nie jest usuwany** — zostaje jako archiwum:
- kanał przenosi się do **kategorii dla zamkniętych ticketów** (osobne pole w ustawieniach, puste = zostaje
  w tej samej kategorii);
- znika dla wszystkich poza obsługą — **także dla autora** i każdego, kogo dodano do ticketu — zapis
  rozmowy widzi więc tylko obsługa;
- zapis rozmowy (.txt) i podsumowanie zamknięcia trafiają **od razu** do logów ticketów, w DM do autora i
  na sam kanał archiwum, razem z przyciskiem **„Usuń kanał z archiwum”** (z potwierdzeniem, tylko dla
  obsługi) — do ręcznego sprzątania spraw, które nie są już potrzebne.

### Intencje Discorda

Powitania, autorole i log wejść/wyjść potrzebują intencji **Server Members**, a zapis rozmów w ticketach, logi
wiadomości i rozpoznawanie udanego bumpa — **Message Content**. Bot włącza je sam (wersje „limited” dla botów na mniej niż 100 serwerach) po zapisaniu ustawień; jeśli
się nie uda, panel pokaże, gdzie włączyć je ręcznie (Developer Portal → Bot → Privileged Gateway Intents).

### Uprawnienia — kto może użyć jakiej komendy

Każda komenda ma **własną listę ról** (zakładka **Uprawnienia**): role dodajesz przez „+ Dodaj rolę”, usuwasz
krzyżykiem, a „Szybkie zmiany” dodają lub usuwają jedną rolę naraz ze wszystkich komend. Listy zostały
ustawione według tego, kto miał dostęp wcześniej (uprawnienia Discorda + role moderatorów); nowe komendy
dostają listę automatycznie. Administratorzy mogą zawsze wszystko, pusta lista = tylko administratorzy,
„Wszyscy (@everyone)” = każdy. Tabela na dole pokazuje na żywo, która rola może użyć której komendy.

Komendy nie mają własnego wymogu uprawnień Discorda (`default_member_permissions`) — gdyby go ustawić,
Discord ukrywałby komendę przed rolami dodanymi tylko przez panel (np. Helperem bez prawdziwego
uprawnienia „Wyciszanie członków”), mimo że miałyby do niej dostęp. Dlatego każda komenda jest widoczna
dla wszystkich w liście komend, a o tym, kto faktycznie może jej użyć, decyduje wyłącznie lista ról z tej
zakładki (osoba bez dostępu i tak dostanie „Nie masz uprawnień do tej komendy” po próbie użycia). Jeśli
zależy Ci na ukryciu komendy przed kimś na poziomie samego Discorda, możesz dodatkowo ograniczyć ją w
*Ustawienia serwera → Integracje → bot*.

Zakładka **Uprawnienia** ma też kartę **Uprawnienia ról w Discordzie** (tylko pełny dostęp): najważniejsze
uprawnienia samego Discorda (wyrzucanie, banowanie, wyciszanie, usuwanie wiadomości, pseudonimy, role,
kanały, wątki, webhooki, głosowe, emoji, wydarzenia, zaproszenia, dziennik zdarzeń i inne — ponad 25 w grupach)
dla każdej roli, którą rozwiniesz na liście. Te
działają bez bota — np. Test Helper z „Wyrzucaniem” mógłby wyrzucać prawym przyciskiem myszy mimo braku
`/kick` — więc tu można je odebrać jednym kliknięciem (bot zmienia rolę od razu, z wpisem w dzienniku
zdarzeń). Role wyżej niż rola bota i role z Administratorem zmienisz tylko w ustawieniach serwera.

### Logowanie moderacji do panelu (`/login`)

Każda osoba z moderacji może mieć **własny login do panelu** — bez znajomości hasła panelu — i widzi w nim,
co może zmieniać, a co nie, zależnie od swojego stopnia:
1. W zakładce **Dostęp do panelu** włączasz logowanie, wybierasz **kanał**, na którym działa `/login`
   (najlepiej widoczny tylko dla moderacji), ustawiasz, jak często login **wygasa** (co tydzień, co 2 tygodnie
   albo co miesiąc), i przypisujesz **role** do części panelu (Tickety, Ostrzeżenia, Sprawy, …).
2. Moderator wpisuje `/login` na tym kanale. Bot czyta jego **aktualne role** i odpowiada (widzi to tylko on)
   **loginem** (jego nazwa na Discordzie) i **hasłem**, datą wygaśnięcia, listą tego, co może zmieniać, oraz
   przyciskiem **„Zaloguj się do panelu”**. Na innym kanale albo bez odpowiedniej roli komenda odmawia.
3. Hasło bot pokazuje tylko raz (w bazie jest tylko jego skrót SHA-256). Kolejny `/login` przypomina login,
   a `/login nowy:True` **wymusza nowe hasło** — stare i wszystkie zalogowania nim od razu przestają działać.
   Po wygaśnięciu `/login` daje nowy login sam.
4. W panelu odblokowane części działają normalnie, a pozostałe są widoczne z **kłódką**, tylko do podglądu
   (z informacją, które role je odblokowują; dane spraw, banów i wiadomości są ukryte). Na pulpicie karta
   **„Twój dostęp do panelu”** pokazuje wszystko naraz. Bot i tak odrzuca zapytania i zapisy spoza
   odblokowanych części.

Bot sprawdza role zalogowanych co kilka minut: odebrana rola albo wyjście z serwera kończy sesję samo, a
zmiany ról w zakładce działają od razu. Administratorzy serwera (i logowanie hasłem panelu) mają zawsze
dostęp do wszystkiego; w zakładce widać aktywne loginy (kto, do kiedy, ile przeglądarek) i można wymusić nowy
login jednej osobie albo wszystkim.

### Uruchomienie panelu lokalnie (opcjonalnie)

Panel działa w pełni bez tego — to tylko wygodny skrót, jeśli wolisz `localhost` zamiast GitHub Pages.
Potrzebujesz Node.js 18.17+ (https://nodejs.org), zero zależności do zainstalowania:

```bash
npm run panel
```

Otwiera `http://localhost:3000` — te same pliki co na GitHub Pages, serwer tylko przekazuje resztę żądań
do bota na Supabase (adres z `BOT_URL` w `.env`, domyślnie projekt „Entuzjaści Hopkostki”). Hasło i tak
wpisujesz w przeglądarce.

## Komendy

| Komenda | Co robi |
| --- | --- |
| `/ban uzytkownik powod [czas] [jednostka] [usun_wiadomosci]` | Ban na czas albo permanentny (bez podania czasu). Bot sam zdejmuje tymczasowego bana. |
| `/unban [uzytkownik] [powod]` | Zdejmuje bana; bez podania osoby pokazuje listę zbanowanych ze stronami i wyborem do odbanowania. |
| `/timeout uzytkownik czas jednostka powod` | Wyciszenie na czas (maksymalnie 28 dni, bo tyle pozwala Discord). |
| `/untimeout uzytkownik [powod]` | Zdejmuje wyciszenie. |
| `/kick uzytkownik powod` | Wyrzuca z serwera. |
| `/warn dodaj uzytkownik powod [punkty]` | Ostrzeżenie z punktami. |
| `/warn status uzytkownik` | Ostrzeżenia, punkty, pasek poziomu i odliczanie do wygaśnięcia (strony ◀ 1 2 3 ▶, widzi tylko moderacja). |
| `/warn usun uzytkownik [numer]` | Lista ostrzeżeń tej osoby do usunięcia (albo od razu jedno, jeśli podasz numer). |
| `/warn wyczysc uzytkownik` · `/warn ranking` | Czyszczenie wszystkich ostrzeżeń / ranking punktów. |
| `/historia uzytkownik` | Wszystkie kary danej osoby (strony). |
| `/sprawy [typ]` · `/sprawa pokaz numer` · `/sprawa powod numer nowy_powod` | Lista, podgląd i edycja spraw. |
| `/notatka dodaj uzytkownik tresc` · `/notatka lista uzytkownik` | Prywatne notatki moderacji o osobie. |
| `/info uzytkownik` | Karta użytkownika: konto, role, kary, ostrzeżenia, notatki. |
| `/serwer` · `/avatar [uzytkownik]` | Informacje o serwerze / awatar w dużym rozmiarze. |
| `/nick uzytkownik [nowy_nick]` | Zmiana albo reset pseudonimu. |
| `/rola dodaj/usun uzytkownik rola` | Nadanie/odebranie roli (z kontrolą hierarchii). |
| `/ogloszenie tytul tresc [kolor] [kanal] [oznacz] [obrazek]` | Ogłoszenie w ładnym embedzie. |
| `/clear ilosc [uzytkownik] [filtr] [tekst]` · `/slowmode sekundy [kanal]` | Czyszczenie wiadomości (filtry: boty, ludzie, linki, załączniki, tekst) / tryb powolny. |
| `/lock` · `/unlock` | Blokada i odblokowanie pisania na kanale. |
| `/snipe [ktora]` | Ostatnio usunięta wiadomość z kanału (wymaga logów wiadomości). |
| `/powiedz tresc [kanal] [odpowiedz_na]` | Wiadomość jako bot — także jako odpowiedź na czyjąś wiadomość (link albo ID). |
| `/ankieta pytanie odpowiedzi [godziny] [wielokrotny] [kanal]` | Ankieta Discorda, odpowiedzi rozdzielone `;` (mogą mieć emoji). |
| `/konkurs start/zakoncz/losuj/lista` | Konkursy z przyciskiem „Weź udział”, wymaganą rolą i losowaniem ponownym. |
| `/emoji dodaj emoji [nazwa]` · `/emoji info emoji` | Dodanie emoji z innego serwera albo linku / duży podgląd. |
| `/przypomnij dodaj/lista/usun` | Przypomnienia na kanale albo w DM. |
| `/afk [powod]` | Status AFK — kto Cię oznaczy, dostanie odpowiedź; Twoja wiadomość zdejmuje status. |
| `/propozycja tresc` | Propozycja na kanale propozycji z głosowaniem i wątkiem. |
| `/profil` · `/rolainfo` · `/czlonkowie` | Profil użytkownika / informacje o roli / liczba członków i online. |
| `/losuj kostka/moneta/liczba/wybor` · `/bumpy ranking/status` | Losowanie / ranking bumpów i kiedy następny. |
| `/zaproszenia [uzytkownik]` | Ranking zaproszeń albo kogo zaprosiła dana osoba. |
| `/login [nowy]` | Login i hasło do panelu bota (tylko na kanale do logowania, widoczne tylko dla Ciebie); `nowy:True` wymusza nowe hasło. |
| `/pomoc` | Lista komend. |

**Jednostki czasu** wybierasz z listy: minuty, godziny, dni, tygodnie albo miesiące (30 dni). W wiadomości
czas jest odmieniony po polsku („1 dzień”, „2 tygodnie”), a obok widać datę wygaśnięcia i odliczanie Discorda.

**Listy z wieloma wynikami** (`/warn status`, `/warn usun`, `/unban`, `/historia`, `/sprawy`, `/notatka lista`,
`/warn ranking`) mają strony z przyciskami **◀ 1 2 3 ▶**, a tam gdzie trzeba coś usunąć/odbanować — listę
wyboru pod spodem.

**Każda kara:**
- ma własny, konfigurowalny embed z polami (na kanale i w DM);
- **oznacza ukaranego** i trafia do niego w **DM** (przy banie i kicku DM idzie przed wyrzuceniem);
- pokazuje powód, czas, datę wygaśnięcia i numer sprawy;
- ląduje w logach moderacji.

Pod każdą odpowiedzią na wiadomość o karze bot dodaje reakcję 🫓 (`:flatbread:`) — natychmiast przez
gateway, a dodatkowo sprawdzane co 30 s przez pg_cron jako zapas.

**Ostrzeżenia:**
- mają punkty, które widzi tylko moderacja;
- **każde wygasa samo po 60 dniach** (konfigurowalne), z własnym odliczaniem;
- opcjonalnie działają automatyczne kary za przekroczenie progu punktów, np. 10 pkt → timeout na 1 dzień.

**Status bota:** dzięki krótkim sesjom gateway (co minutę) bot świeci na zielono i pokazuje rotujące opisy
(„Gra w…”, „Ogląda…”, własny status…) — konfigurowalne w panelu, z podstawianymi zmiennymi
(`{czlonkowie}`, `{online}`, `{ostrzezenia}`, `{sprawy}`, `{serwer}`).

**Zabezpieczenia:**
- nie da się ukarać siebie, bota, właściciela serwera ani osoby z rolą równą lub wyższą;
- gdy Discord odrzuci karę, bot wycofuje sprawę i wysłany DM;
- każde żądanie od Discorda jest weryfikowane podpisem Ed25519;
- panel wymaga hasła (nagłówek sprawdzany w stałym czasie), dostęp do komend można dodatkowo ograniczyć
  per komenda w zakładce Uprawnienia.

## Co działa inaczej niż w zwykłym bocie

Supabase uruchamia kod na żądanie i nie trzyma stałego połączenia z Discordem, więc bot łączy się z
gatewayem w krótkich sesjach (~55 s co minutę) zamiast trzymać je stale:
- Między sesjami (ułamki minuty) bot bywa chwilowo „w trakcie łączenia” zamiast pełnego online — to
  normalne, komendy HTTP działają cały czas niezależnie od tego.
- **Darmowy plan Supabase wstrzymuje projekt po tygodniu bez aktywności.** Wtedy wejdź na dashboard i kliknij
  „Restore”. Regularne używanie komend i gateway liczą się jako aktywność.

## Dla deweloperów

```bash
npm install        # tylko do testów (PGlite = Postgres w pamięci)
npm test           # testy kar, ostrzeżeń, wygasania, podpisów, crona, gateway, panelu i SQL na prawdziwym Postgresie
```

Struktura:
```
supabase/
  migrations/                     schemat "bot" + zadania pg_cron (30 s: wygasanie/reakcje zapasowe; co minutę: gateway)
  functions/hopkostki-bot/
    index.ts                      wejście funkcji Edge (Deno): postgres.js + sekrety
    lib/app.js                    router: / (Discord), /cron, /gateway, /panel/* (API + CORS), /health
    lib/interactions.js           obsługa interakcji (odroczone odpowiedzi + praca w tle)
    lib/commands.js               definicje i obsługa komend slash
    lib/moderation.js             wspólny przebieg każdej kary, uprawnienia (hasModAccess/roleHasAccess)
    lib/views.js                  widoki ze stronami (◀ 1 2 3 ▶) i listami wyboru
    lib/gateway.js                krótkie sesje gateway: status online, opisy, reakcje 🫓 na żywo, zdarzenia
    lib/cron.js                   rejestracja komend, wygasanie, reakcje 🫓 (zapas), bump, przypomnienia, konkursy
    lib/logs.js                   logi serwera (wiadomości, członkowie, dziennik zdarzeń, kanały głosowe)
    lib/bump.js                   przypominajka o bumpie DISBOARD
    lib/community.js              AFK, przypomnienia, konkursy, propozycje
    lib/invites.js                kto kogo zaprosił (porównanie liczników użyć zaproszeń)
    lib/communityCommands.js      komendy na co dzień (/ankieta, /konkurs, /snipe, /emoji, /losuj…)
    lib/panel.js                  API panelu
    lib/store.js                  zapytania SQL
    lib/configSchema.js           walidacja konfiguracji z panelu (w tym uprawnienia per komenda)
    lib/embeds.js, defaults.js    wygląd i domyślne ustawienia
panel/
  server.js                       opcjonalny lokalny wrapper (statyka + przezroczysty proxy do Supabase)
  public/                         frontend panelu — publikowany na GitHub Pages (.github/workflows/panel-pages.yml)
```

Wdrożenie zmian w bocie: `supabase functions deploy hopkostki-bot --no-verify-jwt` (Supabase CLI) albo przez
MCP. Zmiany w `panel/public/` trafiają na GitHub Pages same po wypchnięciu na `main`.
