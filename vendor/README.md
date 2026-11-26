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
| `chrome.js` | LiquidChrome („tło 2” od właściciela) | pas z zaproszeniem na końcu strony głównej, tło strony 404 |
| `motion.js` | wzorce MaskedHeading, AnimatedContent, CountUp, SpotlightCard, Magnet | wszystkie strony publiczne |
