---
name: icons
description: How to add, find and use icons on the enho.pl website. Use whenever a page in panel/public needs an icon, or when an emoji or text symbol is standing in for one.
---

# Icons on enho.pl

All interface icons come from Phosphor (https://phosphoricons.com, MIT licence), bold weight, packed
into one sprite: `panel/public/icons.svg`. The list of icons, the weight and extra variants (such as
`fill` for the active menu item, id `name-fill`) live in `scripts/icons.json`.
Never paste emoji or text symbols (✓, ★, →) in place of an icon.

## Add an icon

1. Find the name on https://phosphoricons.com (for example `confetti`).
2. Run `node scripts/icons.mjs add confetti` (several names at once are fine).
   The script downloads `@phosphor-icons/core` from npm, extracts only the listed icons and rewrites
   `panel/public/icons.svg`. It fails with the names that do not exist.
3. `node scripts/icons.mjs remove name` drops icons nobody uses; plain `node scripts/icons.mjs`
   rebuilds from the list. Never edit `icons.svg` by hand.

## Use an icon

```html
<svg class="i" aria-hidden="true"><use href="icons.svg#confetti"></use></svg>
```

Every page styles `.i` the same way, so icons follow the text colour:

```css
.i { width: 1.25em; height: 1.25em; flex: none; fill: currentColor; vertical-align: -0.25em; }
```

In JavaScript use the page's `icon('name')` helper, which returns the same markup.
An icon next to text is decoration (`aria-hidden="true"`). An icon-only button needs an
`aria-label` that says what the button does.

## Brand marks

Phosphor has a `discord-logo`, but the join and login buttons keep the filled Discord mark inline. The Discord mark is kept as an inline `<svg>` in the pages that need it
(join and login buttons). Do not add other brand marks without a reason.

## Choosing icons

- One icon per meaning across the site: `user-plus` invites, `chat-circle` messages,
  `gift` prizes, `dice-five` draws, `trophy` ranking, `calendar-dots` events, `microphone` voice time,
  `users` members, `clock` time left.
- Icon weight follows the text next to it (bold for 500-600 text); the current page in the menu uses `-fill`.
- Pick the literal object, not a metaphor stretched to fit. If nothing fits, use no icon.
- Icons sit at text size next to labels. No icon tiles, no coloured squircles behind icons.
