# Biblioteki na stronie (bez CDN)

| Plik | Wersja | Licencja |
| --- | --- | --- |
| gsap.min.js, ScrollTrigger.min.js | GSAP 3.15.1 (https://github.com/greensock/GSAP) | Standard "no charge" license, https://gsap.com/standard-license |
| lenis.min.js, lenis.css | Lenis 1.3.29 (https://github.com/darkroomengineering/lenis) | MIT, Copyright (c) darkroom.engineering |

Pliki są skopiowane bez zmian z paczek npm `gsap@3.15.1` i `lenis@1.3.29`.
GSAP i Lenis: ruch na wszystkich stronach publicznych (`motion.js`: płynne przewijanie, baner zwijany przy przewijaniu,
tytuły i sekcje wjeżdżające przy przewijaniu).

## React Bits (przeniesione do zwykłego JS)

Komponenty z https://reactbits.dev (David Haz, https://github.com/DavidHDev/react-bits), licencja MIT + Commons Clause:
wolno ich używać jako części strony, nie wolno sprzedawać ani rozpowszechniać samych komponentów.
Przeniesione z Reacta, shadery i logika bez zmian:

| Plik | Komponent | Gdzie |
| --- | --- | --- |
| `particles.js` | Particles („tło 1” od właściciela) | tło strony głównej, rankingu i eventów |
| `rb-scanner.js` | Scanner („tło 4” od właściciela) | dół strony głównej, od nad kartą z zaproszeniem do końca |
| `rb-gridscan.js` | GridScan | tło rankingu (neonowa siatka 3D ze skanem; kamera wyłączona) |
| `rb-aurora.js` | Aurora | tło eventów w kolorach wybranego eventu |
| `rb-terminal.js` | FaultyTerminal | tło strony 404 |
| `motion.js` | wzorce MaskedHeading, AnimatedContent, CountUp, SpotlightCard, Magnet, TiltedCard, ClickSpark, GlareHover, StarBorder, ScrollReveal | wszystkie strony publiczne |

Pliki `rb-*.js` to oryginalny kod komponentów z JSX zamienionym na `RB.dom`; `rb.js` daje im potrzebne funkcje
Reacta (useRef, useEffect, useState) i podpina je do elementów z `data-rb="Nazwa"` (ustawienia w `data-props`).
