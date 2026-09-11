# Responsive Design — Production Specification

Source: cross-cutting observations from Admin-Dashboard, Test-Player, Student-Dashboard,
Student-Analysis, Site-Header/Footer.

## General pattern already in place
Nearly every grid in the existing design uses `repeat(auto-fit, minmax(Npx, 1fr))` rather than
fixed breakpoints — this is a genuinely good pattern to keep, since it collapses gracefully at
arbitrary widths without a media-query matrix. Preserve it in the Tailwind rebuild
(`grid-cols-[...]` with `minmax` via arbitrary values, or a shared `auto-fit` utility).

## Per-area behavior to verify/build explicitly (not fully provable from static source)

**Admin tables** — no confirmed mobile/tablet treatment in the design; sidebar is a fixed
264px column with no visible collapse-to-drawer breakpoint captured in what was inspected.
Build: collapse sidebar to an overlay drawer below ~900px; tables need horizontal scroll or a
stacked-card fallback below ~640px. Treat as ⚠️ needs design confirmation, not assume-safe.

**Test Player / question navigation** — palette grid and action bars already use
`flex-wrap`/`auto-fit` and 44px-minimum tap targets, which is mobile-appropriate. Verify during
build that the sticky timer/header never overlaps the palette on short viewports.

**Result / Analysis** — grids are `auto-fit minmax(300px,1fr)`, so they stack single-column
below ~600px automatically; no separate mobile layout needed beyond that.

**Sidebars** (Admin) — see above, needs an explicit collapse breakpoint decision.

**Modals** (Report Question, Submit Confirm) — already constrained to `max-width` with
`max-height:86vh` and internal scroll, which is mobile-safe as designed.

**Buttons** — consistently sized with adequate padding; Test-Player's review action bar
explicitly sets `min-height:44px`, meeting the accessibility minimum tap target.

**Header** — sticky, 68–72px, with hamburger-driven mobile nav referenced in
ARCHITECTURE.md (shadcn `Sheet`) for the public header; confirm the actual collapse breakpoint
during build since it wasn't independently re-derivable from static source review.

**Footer** — 4-column layout per ARCHITECTURE.md's README; standard responsive stacking to
single column expected below tablet width, standard practice, no special design constraint
found.

## Verification checklist for build
Test every major screen at 375 / 768 / 1024 / 1440px (per the design handoff's own stated
verification widths) before calling any screen done.
