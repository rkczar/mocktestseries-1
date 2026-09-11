# Global Navigation — Production Specification

Source: `GlobalBackButton.dc.html`, `Site-Header.dc.html`, `Site-Footer.dc.html`.

## Header / Footer consistency
`Site-Header` and `Site-Footer` are shared components imported across public + student pages
(the Test Player is the one documented exception — it hides the normal footer during an active
attempt, per the Website Diagram's own notes). Keep this as a shared layout in the real app
(`app/(public)/layout.tsx`-style shared header/footer, per ARCHITECTURE.md), not copy-pasted
per page.

## Internal Back button — exact behavior to preserve
`GlobalBackButton` is a small, genuinely clever piece of real logic worth porting verbatim:
- Every internal page passes it `fallbackHref` + `fallbackLabel` (its safe parent/section
  destination) and `currentFile` (itself, so "came from myself" is never treated as valid
  history).
- A hardcoded `ROUTE_LABELS` map translates known internal filenames into friendly labels:
  Home, Dashboard, Analysis, Profile, Test History, Custom Test, Free Sample Test, etc.
- On mount, it inspects `document.referrer`: if it's same-origin, not the current page, and a
  known route, the button becomes "Back to {that page's label}" and clicking it calls
  `window.history.back()` (so browser back-forward state stays correct).
- Otherwise it silently falls back to the configured `fallbackHref`/`fallbackLabel` as a plain
  link — **it deliberately never calls `history.back()` blindly**, specifically to avoid users
  leaving the site or landing on an unrelated page. Preserve this "never blind-back" rule.
- Rendered directly below the page's own header/content start, never overlapping the header or
  logo (confirmed by its placement immediately after the header markup on every page that uses
  it) and never overlapping page content below it (it sits in normal flow with a bottom margin).

## Route → label examples already defined
Home, Dashboard, Analysis, Profile, Test History, Custom Test, Free Sample Test (and others per
the full `ROUTE_LABELS` map) — extend this map as new pages are added rather than inventing a
new mechanism.

## Production implementation notes
- `document.referrer`-based logic works the same in Next.js; alternatively use Next's router
  history/`usePathname` history stack for a more reliable same-app back-context, but keep the
  same fallback contract (always a safe named destination, never a raw browser back with no
  guardrail).
- Every dedicated internal page (Analysis, Profile, Test History, Saved Questions, Custom
  Module, Old Test Series, Test Player's review mode, etc.) must continue to supply a real
  `fallbackHref`/`fallbackLabel` — treat a page missing this as a defect during build QA.
