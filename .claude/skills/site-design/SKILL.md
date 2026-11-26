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

```css
:root {
  --bg: #171b23;        /* page, graphite */
  --surface: #1e232d;   /* sections, cards */
  --raised: #262c38;    /* inputs, secondary buttons, hovered rows */
  --text: #e5eaf1;
  --muted: #9aa6b7;
  --faint: #8d99ab;    /* 4.85:1 or better on every surface */
  --accent: #4cc3c8;    /* cyan from the server banner, muted for dark mode */
  --accent-hover: #63d0d4;
  --on-accent: #06282a; /* text on accent */
  --gold: #d8b35c; --silver: #a9b4c2; --bronze: #c38a5e;
  --ok: #5bbf8a; --warn: #d9a64e; --danger: #e06c70;
  --shadow-sm: 0 1px 1px rgb(3 7 12 / .4), 0 2px 4px rgb(3 7 12 / .3);
  --shadow: 0 1px 2px rgb(3 7 12 / .45), 0 4px 10px rgb(3 7 12 / .35), 0 14px 30px rgb(3 7 12 / .3);
  --r-sm: 6px; --r: 10px;
}
```

Type (owner's choice): Manrope (700 section headings, 800 main heading) and Inter (400 text, 600 buttons),
both from Google Fonts with `latin-ext` for Polish letters. Headline line height 1.15, body 1.55.

Background: one only (owner's pick after trying graphite noise and thermal gradients): graphite
`#171b23` with tsParticles (`vendor/tsparticles.basic.bundle.min.js`, config in `particles.js`):
about 110 tiny dots in the site's blue-gray with a little cyan, drifting slowly and twinkling, 30 fps
cap, paused off-screen, frozen under reduced motion. Behind them, for colour (owner's request): three soft radial glows in the
banner's colours (cyan, blue, magenta) drifting slowly (`.glow`, 38-54 s loops, no blur filter).
The primary button carries a cyan glow shadow. Do not add a third background treatment.

Layout: content column max 1120 px, 16 px side gutter on phones, nothing scrolls sideways.
Elevation comes from `--surface`/`--raised` plus layered shadows, never from borders.
Focus is always visible (`outline: 2px solid var(--accent); outline-offset: 2px`).
Respect `prefers-reduced-motion`.

## Page frame

- Top banner runs the full width of the viewport (`.bleed`); no big server icon over it (the small
  logo in the top bar is enough).
- One scroll animation per site, on the landing page only: GSAP ScrollTrigger + Lenis
  (`panel/public/vendor`). The full-width banner scrubs into the content column, the hero title
  rises word by word on load, the tagline lights up word by word while scrolling. Everything is
  visible without JavaScript and static under `prefers-reduced-motion`.

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
