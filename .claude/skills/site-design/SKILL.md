---
name: site-design
description: House rules for the enho.pl website (landing page, ranking, events page, admin panel). Use whenever you build, restyle or write copy for anything in panel/public, so new work keeps the same look and never drifts into generic AI-made design.
---

# enho.pl design rules

The site belongs to the Discord server "Entuzjaści Hopkostki". All pages live in `panel/public`
(`index.html` landing, `ranking.html`, `event.html`, `panel.html` + `app.js` + `style.css`, `404.html`).
Copy is Polish. Read `.claude/skills/frontend-design/SKILL.md` for general craft and
`.claude/skills/humanizer/SKILL.md` before writing copy. These rules win where they disagree.

## Never do this (AI slop tells)

1. Tags and pills (rounded capsules around labels or statuses)
2. Excessive italics
3. Instrument Serif (or any trendy display serif)
4. Negative letter spacing on headings
5. Over-the-top detailed UI (badges on badges, chrome nobody needs)
6. Dividers everywhere (hairlines between every row or stat)
7. Many shades and opacities of one colour (accent at 10%, 20%, 30%...)
8. Containers drawn with borders (use surface colour and shadow instead)
9. Overly detailed diagrams
10. Verbose, redundant text
11. Code-style breadcrumbs (`home / ranking / ...`)
12. Section numbering (01, 02, 03) unless the content really is a sequence
13. Eyebrows (small label above a heading)
14. Dithering
15. ASCII images
16. Squircles (rounded-square icon tiles); avatars and the server icon are circles
17. Mono fonts outside real code (slash commands like `/rank` are code, numbers are not)
18. ALL CAPS subtitles and labels
19. Gradient backgrounds (also glows and colour washes behind sections)
20. Periods at the end of titles and buttons

Also banned here: emoji in the interface (use Phosphor icons from `icons.svg`, see the `icons` skill),
em dashes and en dashes (write a normal hyphen `-`), an arrow glued to link or button text,
meta strings joined with middle dots.

User content is the exception: event descriptions, nicknames and Discord messages are shown as written.

## Laws to design by

Aesthetic-usability effect, law of proximity, Von Restorff effect (one thing stands out per screen),
Zeigarnik effect (show unfinished progress), Tesler's law, law of Prägnanz, serial position effect,
progressive disclosure, law of common region, goal-gradient effect (progress bars that show how close
someone is), law of similarity, recognition over recall, Pareto principle, Occam's razor,
Parkinson's law, uniform connectedness, paradox of the active user, cognitive load,
default effect (sensible defaults), peak-end rule (end pages on a strong call to action).

## Practical tips

1. Left-align long text
2. Button text fills about half the button width (generous horizontal padding)
3. Body text stays regular weight (400)
4. Tint grays blue
5. Keep Delete far from Save
6. Tight line height on headlines (1.1 to 1.2)
7. Layer shadows (two or three stacked shadows, not one big blur)
8. Sentence case everywhere
9. Text on a coloured surface is a dark or light tint of that colour, not pure black or white
10. Align on the baseline
11. Labels above inputs, never placeholder-only fields
12. One hue per colour role
13. More padding on the sides than on top and bottom
14. Buttons say what they do ("Dołącz do serwera", not "Kliknij tutaj")
15. More space above a heading than below it
16. Mute colours in dark mode
17. Right-align numbers in tables and use tabular figures
18. Gap between small text lines equals the small text's height
19. Every empty state has a call to action
20. Landing page CTAs are bigger than normal buttons

## Tokens (keep every page on these)

Colours come from the banner's pixels (owner: "kolory z baneru", not navy, not purple): near-black with a
teal-green cast, the banner's neon cyan and sea green. Source of truth: `:root` in `panel/public/site.css`.

```css
--bg: #050b0b; --surface: #0b1716; --raised: #11221f; --raised-hover: #163029;
--text: #e4f4f2; --muted: #93b3ae; --faint: #7fa19b; --field-border: #56807a;
--accent: #28e9ea; --accent-hover: #6ff1f2; --on-accent: #032a2a; --accent-2: #2ccf98;
--gold / --silver / --bronze (podium), --ok / --warn / --danger (states)
```

Cards and sections are plain: solid `--surface` and the layered `--shadow` (owner rejected tinted gradient
panels as AI slop). Only the events page (`/event`) recolours itself with the selected event's colours
(`Motion.paint`). Type: Manrope (700 sections, 800 main heading) and Inter (400 text, 600 buttons), `latin-ext`.

## Backgrounds (one per page, all from React Bits, ported in `rb.js` + `rb-*.js` / `particles.js`)

- Landing: Particles (owner's "tło 1"), stronger than the file (more points and links, calm cursor, no field
  rotation so it does not drift sideways), with drifting glows.
- Ranking: the landing's Particles ("space", same colours) plus a dimmed LightPillar (owner's pick) beside the
  content. The pillar moves sideways through its `offset` prop, never by moving the element (a shifted canvas left a
  green strip at the edge). It starts under the banner, blends in `screen` mode and drifts up slightly on scroll
  (`data-drift`) without leaving the screen. LightRays, Galaxy and GridScan were rejected.
- Events: Aurora in shades of the selected event's main colour, at half opacity so text stays readable. It fades
  in inside the banner's fading bottom (`--flow-in` mask, no hard top edge) and scrolls with the page. The whole
  page (background, cards, fields, accents) takes the event's hue. Owner may still swap the aurora.
- 404: LiquidChrome (owner's pick, "tło 2") in the banner's cyan, darker on the left behind the text. No Scanner
  band at the bottom (owner removed it there).
- Bottom of the landing, ranking and events pages: Scanner waves (owner's "tło 4") in `var(--accent)` /
  `var(--accent-2)`, from above the last section down to the end of the page (`.page-scan`, `data-from`).
Do not stack a second full-page background on a page.
Backgrounds pinned to the screen (`.page-bg`, `.particles-bg`, `.glow`) use `top: 0; height: 100lvh`, never
`inset: 0`: on phones the hiding address bar otherwise uncovers a black strip at the bottom and the background
jumps when it resizes. Scroll-linked drift ignores height-only resizes for the same reason.

## Page frame

- Same top bar on every page (brand, Ranking, Eventy, "Dołącz" button): floats 12 px from the top over the banner as
  dark blurred glass, no coloured fills or lines; the current page is brighter text with a filled accent icon.
  It moves with the scroll (motion.js, transform only): scrolling down hides it slower than the page (40% of the
  scrolled distance), a small scroll down does not hide it, 12 px of scrolling up glides it fully back (0.3 s), and
  a half-hidden bar finishes to the nearer end when scrolling stops. Only the top bar moves on every page
  (`data-nav-hidden-top` can still make a sticky part follow it, nothing uses it now). Keyboard focus inside it
  keeps it shown. The owner rejected the earlier narrowing capsule (layout transition, not smooth).
- Ranking person panel (profile): a plain site card. Top: the person's Discord banner, or their blurred avatar,
  fading into the card like page banners. Avatar without the Discord cut-out border; the Discord avatar frame is
  120% of the image, centred (same as in the list). No Nitro tag. Section headings with Phosphor icons like the side
  cards, numbers in the display font. On open: the card rises, sections come in one by one, numbers count up, the
  level ring fills and chart bars grow; the full profile load only adds new sections and continues a running count.
  Screen-reader tables go inside a `.sr-only` wrapper (a table with `.sr-only` keeps its height and stretches cards).
- Ranking filter bar: part of the page (scrolls with it, never sticky or floating; the owner disliked two floating
  bars). One layer: controls sit straight on the page, no panel behind them; all 44 px high, `--surface` with a
  1 px inner edge, 14 px radius; the selected period has a raised highlight that slides between tabs.
- Full-width banner (`img/banner.webp` 3840×2160 from the owner, `srcset` 960/1600/2400/3840). The owner can set
  the icon and a separate banner for the landing, ranking and events pages in the panel (Ustawienia → Wygląd
  strony, best 3840×2160 / icon 512×512); pages read them from `/public/site` in `motion.js`. On scroll the image
  moves slower than the page (parallax), zooms out slightly and darkens, on every page with a banner. It never shrinks into a box.
  Every banner fades into the page at the bottom (mask), without getting taller. Ranking and events banners are a
  flat strip (best 3840 × 1200) with the same scroll motion as the landing (owner asked for it back). Every banner then
  "breathes" (slow zoom, `.breathe`), added only after the banner is revealed: a CSS animation that starts under a
  GSAP curtain stays on Chrome's main thread and stutters (`Motion.recomposite` restarts such animations).
- The landing ends with a big centred invite (no banner behind it): avatars of the people who joined most recently
  (`/public/guild`; no names, no bots, no one hidden from the ranking; top members only as a fallback), a big
  title, the member and online count, the main button and "Zobacz ranking", over the bottom waves. The counts
  (under the hero button and in the invite) refresh every 30 s and count from the old number to the new one; a new
  face pops in at the front.
- FAQ answers open and close with a height animation (`Motion.accordion`), native behaviour under reduced motion.
- `motion.js` gives every public page the same motion: title words rise on load, section headings rise and
  sections slide up once, numbers count up (whole numbers, fixed width), the card under the cursor gets a light
  and tilts slightly, main buttons have a moving star border, a glare and a slight magnet pull, clicks spark.
  Call `Motion.init({...})` on a new page. Everything is visible without JS and static under reduced motion.
- Footer: "© <year> Entuzjaści Hopkostki" (year filled in by motion.js) and links.

## Copy

- Plain Polish, short sentences, sentence case, no full stop in titles or buttons.
- Polish quotes „…”, hyphen `-` for dashes, numbers with a space as thousands separator.
- Say what happens: "Zaloguj się przez Discord", "Zapisz się na event", "Dołącz do serwera".
- Empty states tell people what to do next and give them the button to do it.

## Skills to run on UI work

`meng-no-ai-design-slop` (quality gate), `jakub-better-ui`, `jakub-better-typography`,
`vercel-web-design-guidelines`, `elaya-landing-page-design` (public pages), `taste-tastemaker`
(style lock in `.tastemaker/style-lock.md`, scanners in its `scripts/`), `humanizer` for copy.
The owner's rules above win wherever a skill disagrees (no negative tracking, no gradient text,
no em or en dashes).

## Before you finish

Grep your diff for `—`, `–`, emoji, `text-transform: uppercase`, `letter-spacing: -`,
`linear-gradient` / `radial-gradient` on backgrounds and `border:` on containers.
Check the page at 390 px and 1280 px wide.
