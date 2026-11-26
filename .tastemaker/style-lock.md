# Style lock: enho.pl

Projekt ma ustalony styl. Kolejne ekrany biorą te wartości, a nie wymyślają nowych.
Źródło tokenów: `panel/public/site.css` (strony publiczne). Zasady słowne: `.claude/skills/site-design/SKILL.md`.

## Kierunek
- Teza: serwer na Discordzie z rankingiem XP i eventami. Strona pokazuje prawdziwe dane (osoby, eventy, ranking), a nie opisy.
- Nastrój: technical, ciemny. Akcent to cyjan z banera serwera.
- Tło: jedno, grafit #171b23 i drobne punkty tsParticles (particles.js), wybór właściciela po próbach z szumem grafitu i termowizją.
- Baner na całą szerokość ekranu, bez dużej ikony serwera.
- Nie wolno: pigułki, etykiety nad nagłówkami, WERSALIKI, ramki na kontenerach, gradientowe tła i teksty, squircle, emoji, pauzy, kropki-separatory, strzałki doklejone do przycisków.

## Kolory (kontrakt, sprawdzony `taste-tastemaker/scripts/check_contrast.py --matrix`)
| Rola | Hex |
| --- | --- |
| bg | #171b23 (grafit) |
| surface | #1e232d |
| raised | #262c38 |
| text | #e5eaf1 |
| muted | #9aa6b7 |
| faint | #8d99ab (4.85:1 na raised) |
| field-border | #69768a (3.42:1 na surface) |
| accent | #4cc3c8 |
| on-accent | #06282a |
| ok / warn / danger | #5bbf8a / #d9a64e / #e06c70 |

Tekst (>= 4.5:1): text/bg 15.29, text/surface 14.18, muted/bg 7.32, muted/raised 6.12, faint/bg 5.63, faint/surface 5.22, faint/raised 4.71, accent/bg 8.75, on-accent/accent 7.40, ok/surface 7.56, danger/surface 5.35, warn/surface 7.77.
UI (>= 3:1): field-border/bg 3.42, field-border/surface 3.17.
Tylko ozdobnie: bg/surface 1.08 (różnica powierzchni nigdy nie jest jedynym sygnałem stanu).

## Typografia
- Manrope 700/800: nagłówki i duże liczby. Inter 400/500/600/700: tekst i przyciski (wybór właściciela, wygrywa z zakazem Intera w elaya-landing-page-design).
- Skala (rem): 12, 14, 16, 18, 20, 24, 30, 36, 48, 60. Interlinia: nagłówki 1.1-1.2, tekst 1.5.
- `text-wrap: balance` w nagłówkach, `pretty` w akapitach, `tabular-nums` w liczbach. Pola tekstowe 16 px.
- Bez ujemnego odstępu liter (wymaganie właściciela, wygrywa z `jakub-better-typography`).

## Odstępy, kształty, cienie
- Odstępy: 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96 px. Sekcje strony głównej: 96 px (telefon 64 px).
- Promienie: 4 / 6 / 10 px (`--r-xs`, `--r-sm`, `--r`), awatary i ikona serwera okrągłe.
- Cienie warstwowe `--shadow-sm`, `--shadow`; ramki tylko na polach formularzy i w trybie wymuszonych kolorów.
- Obrazy z treścią: obwódka 1 px `oklch(1 0 0 / 0.1)` do środka.

## Ikony
- Phosphor 2.1.1, grubość bold (pasuje do tekstu 500-600), jeden plik `panel/public/icons.svg` (`node scripts/icons.mjs`).
- Aktywna pozycja menu: odmiana fill. Logo Discorda tylko w przyciskach logowania i zaproszenia.

## Ruch
- Krzywa `cubic-bezier(0.22, 1, 0.36, 1)`, zmiany koloru 200 ms.
- Jeden efekt przewijania: strona główna, GSAP 3.15.1 ScrollTrigger (`scrub: 1`) + Lenis 1.3.29 (`lerp` 0.08, kotwice natywne), baner zjeżdża do kolumny treści.
- Uzasadnione dłuższe animacje: pasek postępu eventu (700 ms, transform), hasło na stronie głównej (słowo po słowie, 600 ms na słowo), szkielety ładowania.
- Efekty wydarzeń XP w rankingu to osobna warstwa artystyczna i zostają.
- Zawsze `prefers-reduced-motion`: hasło od razu w pełnym kolorze, bez pulsowania.

## Struktura strony głównej
hero (baner, nazwa, jedno zdanie, Dołącz do serwera) -> hasło -> teraz na serwerze (prawdziwe eventy) -> najaktywniejsi (prawdziwy ranking) -> jak dołączyć (3 kroki) -> pytania (stawki XP i role z API) -> zaproszenie.
