# Admin Appearance — Production Specification

Source: `frontend-appearance.js`, `theme-modes.js`.

## Scope — explicitly limited by design
`frontend-appearance.js`'s own header states the boundary precisely: "Controls colors, fonts
and buttons for public/student-facing pages only. The Admin Panel has its own independent
styling and never reads these values." Preserve this boundary exactly:
- Appearance settings may change: color tokens (primary/accent/success/error/background/
  surface/text/border families, plus an "inverse" set for dark-ground panels like the
  announcement bar and final CTA), font families (heading/body/mono + weight/line-height/base
  size, from a curated Google Fonts list), and button styles (radius, per-variant bg/text/border).
- Appearance settings must **never** touch: admin panel structure/colors, container widths,
  page layout, database schema, or application architecture. The admin panel's own colors come
  from a completely separate `--admin-*` namespace that Appearance does not write to.
- New frontend components must read these CSS custom properties (`--frontend-*`,
  `--frontend-btn-*`) rather than hardcoding colors, so they automatically inherit whatever the
  admin has configured — this is already the pattern used throughout the existing .dc.html
  files and should continue in the real component library (Tailwind config mapping these into
  `theme.extend.colors`, per ARCHITECTURE.md).

## Persistence
Prototype: `localStorage`. Production (per the file's own comment): an `AppearanceSetting`
table, rendered **server-side into a `<style>:root{...}</style>` block** so it survives refresh/
logout/restart without depending on the browser — implement it exactly this way, not as a
client-only theme.

## Day / Night / Eye-Protection mode
`theme-modes.js` implements a 3-mode cycle (day → night → eye → day), persisted in
localStorage, applied as a `data-mts-mode` attribute plus a full set of CSS variable overrides:
- **Day**: the admin's saved Appearance colors, verbatim.
- **Night**: a fixed dark palette derived from the day colors (not admin-configurable
  per-color, just a fixed alternate scheme).
- **Eye Protection**: pure black background, pure white text/borders, semantic colors
  (success/error/warning) distinguished only by border brightness since hue is suppressed.
- A round toggle button (`.mts-theme-btn`) auto-mounts itself into the right-hand cluster of
  every `<header>` on the page via a MutationObserver-like polling mount — this must remain
  available **consistently on every public/student page** per the user's requirement (it
  currently self-injects rather than being manually added per page, which is a reasonable
  pattern to keep: implement it as a persistent header slot in the shared `SiteHeader`
  component rather than a bolt-on script, but preserve "available everywhere without per-page
  wiring").
- Admin panel also follows the mode (its own `--admin-*` values swap per mode) but independent
  of the frontend's admin-configured colors — i.e. mode is global, but Appearance's *custom*
  colors are frontend-only.

## What Appearance is not
Not a page builder, not a layout editor, not a database console. Keep the admin UI narrowly
scoped to colors/fonts/buttons/mode exactly as designed — this matches the explicit "do NOT
allow it to unintentionally change admin structure/container widths/database/architecture"
instruction.
