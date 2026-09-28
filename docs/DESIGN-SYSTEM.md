# Design System (current production baseline)

> This file describes what the MockTestSeries.in UI **actually ships today**. It is not an aspirational spec. Every statement cites the file it comes from. When the code changes, update this document in the same PR.
>
> Baseline taken: 2026-09-28, release `b3363309`.

---

## 1. Stack and UI libraries

| Concern | What we use | Where |
|---|---|---|
| Framework | Next.js 16 (App Router), React 19 | `package.json` |
| Styling | Tailwind CSS v4, CSS-first config (no `tailwind.config.*`) | `app/globals.css`, `postcss.config.mjs` |
| Primitives | shadcn/ui-style components on Radix UI | `components/ui/*` |
| Radix packages in use | slot, dialog, dropdown-menu, checkbox, switch, tabs, tooltip, label | `components/ui/*` |
| Variants | `class-variance-authority` | `button.tsx`, `badge.tsx` |
| Class merging | `cn()` = `clsx` + `tailwind-merge` | `lib/utils.ts` |
| Icons | `lucide-react` | used in about 137 files |
| Fonts | `next/font/google`: Geist, Geist Mono | `app/layout.tsx` |

`@radix-ui/react-toast`, `@radix-ui/react-avatar` and `@radix-ui/react-select` are installed but not used.

---

## 2. Typography

### Families
| Token | Default value | Set in |
|---|---|---|
| `--font-geist-sans` / `--font-geist-mono` | next/font variables (latin, variable 100–900, `display: swap`) | `app/layout.tsx:10-18` |
| `--font-body` | `var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif` | `app/globals.css:19`, admin-overridable |
| `--font-heading` | same as body | `app/globals.css:18`, admin-overridable |
| `--font-mono` | `var(--font-geist-mono), ui-monospace, "SF Mono", "Roboto Mono", monospace` | `app/globals.css:20` |

- Tailwind mapping: `font-sans` maps to `--font-body`, `font-heading` to `--font-heading` and `font-mono` to `--font-mono` (`@theme inline`, `globals.css:132-150`).
- `body` uses `--font-body`.
- `h1–h6` use `--font-heading` with **weight 400** and `text-wrap: balance` (`globals.css:195-199`). Emphasis is added per use.
- Admin → Website → Appearance can replace the heading and body stacks. They are validated against `FONT_STACK_RE` in `lib/appearance.ts`.

### Scale
Tailwind's steps are overridden and all of them scale with `--text-scale` (`globals.css:157-181`):

| Class | Size (at scale 1) | Line height | Typical use |
|---|---|---|---|
| `text-xs` | 0.75rem / 12px | 1rem | meta, labels, table captions, palette numbers |
| `text-sm` | 0.875rem / 14px | 1.25rem | **default UI text**: buttons, inputs, body copy in cards |
| `text-base` | 1rem | 1.5rem | large buttons, card titles |
| `text-question` | 0.9375rem / 15px | 1.625 | question, option and explanation body (player, review, saved) |
| `text-lg` | 1.125rem | 1.5rem | section subtitles |
| `text-xl` | **1.5rem** (not Tailwind's 1.25rem) | 1.9rem | page titles (admin and student `h1`) |
| `text-2xl` | **2rem** | 2.3rem | hero or score numbers |
| `text-3xl` | 2.625rem | 1.15 | marketing headings |
| `text-4xl` | 3.25rem | 1.05 | homepage hero |
| `text-5xl` | 4rem | 0.98 | homepage hero (large) |

- **Weights used:** `font-medium` (labels, buttons, nav), `font-semibold` (titles, card titles, emphasis) and `font-bold` (rare: brand wordmark, OTP digits). Headings default to 400.
- **Tracking:** Button uses `tracking-[-0.01em]`, Badge uses `tracking-[0.02em]`, and the brand wordmark uses `tracking-tight`.
- **Student Text Size control** (`components/theme/text-size-control.tsx`, `lib/text-size.ts`) sets `html[data-text-size]` to one of:

  | Value | Label | `--text-scale` |
  |---|---|---|
  | `xs` | Very Small | 0.85 |
  | `sm` | Small | 0.9 |
  | `md` | Default | 1 |
  | `lg` | Large | 1.125 |
  | `xl` | Extra Large | 1.25 |

  It is stored in the `mts-text-size` cookie and localStorage, and server-rendered in `app/layout.tsx`. It scales type only, not spacing.

---

## 3. Color tokens

All structural tokens are defined in `app/globals.css`:
- Dark: `:root, :root[data-theme="dark"]` (lines 58-73).
- Light: `:root[data-theme="light"]` (75-89).
- Eye-Saver: `:root[data-theme="eyesaver"]` (91-111).

Brand and semantic tokens have defaults in `:root` (10-17). At runtime they are **overridden by the admin Appearance config**, which is injected as an inline `<style>:root{…}</style>` on every page (`lib/appearance.ts:appearanceToCssVariables`, `app/layout.tsx:59`). Eye-Saver deliberately beats the admin values through selector specificity and forces grayscale.

**How to use a token in a class:** the codebase convention is `bg-[var(--color-card)]`, `text-[var(--color-muted-foreground)]`, `border-[var(--color-border)]` (about 3,000 uses). The short forms (`bg-card`, `text-muted-foreground`) also resolve through `@theme inline`, but they are not used. Stay consistent with the `[var(--…)]` form.

### Structural tokens (per theme, not admin-configurable)
| Variable | Dark (default) | Light ("Day") | Eye-Saver | Tailwind class | Role |
|---|---|---|---|---|---|
| `--color-background` | `#000000` | `#fbfbfc` | `#000000` | `bg-[var(--color-background)]` | page canvas |
| `--color-surface` | `#141414` | `#ffffff` | `#050505` | `bg-[var(--color-surface)]` | inputs, headers, hover fill, tab list |
| `--color-card` | `#171717` | `#ffffff` | `#0a0a0a` | `bg-[var(--color-card)]` | cards, dialogs, menus |
| `--color-foreground` | `#f5f5f5` | `#16171a` | `#ffffff` | `text-[var(--color-foreground)]` | primary text |
| `--color-muted-foreground` | `#a3a3a3` | `#61646b` | `#c4c4c4` | `text-[var(--color-muted-foreground)]` | secondary text, placeholders, icons |
| `--color-border` | `rgba(255,255,255,.12)` | `#e6e7ea` | `#4a4a4a` | `border-[var(--color-border)]` | hairlines; also the global `* { border-color }` default |
| `--color-action-fill` | `#f2f2f2` | `#16171a` | `#ffffff` | used by Button `primary`/`cta` | solid CTA fill (neutral, not brand-colored) |
| `--color-action-ink` | `#1a1a1a` | `#ffffff` | `#000000` | used by Button `primary`/`cta` | text on action fill |
| `--shadow-card` | layered black + 6% white ring | soft 4–14% ink | 1px 10% white ring | `shadow-[var(--shadow-card)]` | cards, dialogs, menus |

### Brand and semantic tokens (admin-configurable in Dark and Light; grayscale in Eye-Saver)
| Variable | Default (Dark & Light) | Eye-Saver (forced) | Tailwind class | Role |
|---|---|---|---|---|
| `--color-primary` | `#3b82f6` | `#ffffff` | `text-/bg-/border-[var(--color-primary)]` | links, active and selected state, focus ring. **Never a large fill.** |
| `--color-secondary` | `#60a5fa` | `#d4d4d4` | `…[var(--color-secondary)]` | lighter informational blue |
| `--color-accent` | `#ea580c` | `#e5e5e5` | `…[var(--color-accent)]` | decorative or urgency (trophies, highlights). **Not a CTA color.** |
| `--color-success` | `#22c55e` | `#8cc4a0` | `…[var(--color-success)]` | correct, answered, active switch |
| `--color-error` | `#f87171` | `#e0a0a0` | `…[var(--color-error)]` | incorrect, errors, destructive (**this is the "destructive" token**) |
| `--color-warning` | `#f59e0b` | `#a3a3a3` | `…[var(--color-warning)]` | marked for review, warnings |
| `--color-info` | `#60a5fa` | `#d4d4d4` | `…[var(--color-info)]` | answered and marked, info callouts |

**Tokens that do not exist:**
- `muted` (as a background). Nine usages reference `var(--color-muted)`, which is undefined and renders transparent. See §13.
- `destructive`: use `error`.
- `link`: use `primary`.
- `ring`/`focus`: the focus ring is `primary`.
- `popover`: use `card`.

**Tints:** state backgrounds use opacity modifiers on the token, e.g. `bg-[var(--color-error)]/10` with `border-[var(--color-error)]/30`, or `color-mix(in srgb, var(--color-foreground) 6–14%, transparent)` for neutral hovers (Button secondary, outline and ghost).

**Eye-Saver ink flip:** on light fills, `text-white` is automatically turned black when combined with a `bg-[var(--color-{primary,secondary,accent,info,warning,success,error})]` class (`globals.css:115-127`). It does not match variant-prefixed classes such as `data-[state=checked]:bg-…`.

**Selection:** `::selection` uses primary at 35%.

### Contrast reference (computed, WCAG 2.x)
| Pair | Dark | Light | Eye-Saver |
|---|---|---|---|
| foreground on background | 19.3 | 17.3 | 21.0 |
| muted-foreground on card | 7.1 | 5.9 | 11.4 |
| primary as text on card | 4.9 | 3.7 ✗ | 19.8 |
| success / error / warning / info as text on card | 7.9 / 6.5 / 8.4 / 7.1 | 2.3 / 2.8 / 2.2 / 2.5 ✗ | ≥ 7.9 |
| action-ink on action-fill | 15.6 | 17.9 | 21.0 |
| white text on success / warning / info fill | 2.3 / 2.2 / 2.5 ✗ | same ✗ | n/a (ink flips to black) |

Semantic colors as **text** are only safe in Dark and Eye-Saver. See the rules in §12.

---

## 4. Themes and how they switch

| Theme | `data-theme` | Character |
|---|---|---|
| Night (**default**) | `dark` | pure-black canvas, neutral charcoal cards, brand color kept |
| Day | `light` | near-white canvas, white cards |
| Eye Saver | `eyesaver` | black and white reading mode. Brand colors go grayscale; only a desaturated green/red pair remains for correct/incorrect. |

- **Source of truth:** `lib/theme.ts` (`THEMES`, cookie `mts-theme`).
- **SSR:** `app/layout.tsx` reads the cookie and sets `<html data-theme data-text-size>` server-side, so there is no flash. It falls back to `dark`. `color-scheme` is set per theme. `<meta name="theme-color">` is `#fbfbfc` for light and `#000000` otherwise.
- **Toggle:** `components/theme/theme-toggle.tsx` renders one icon button that cycles Day → Night → Eye Saver. It writes the attribute, the cookie and localStorage. It is placed in the public header, the student header, the test player and the admin login.
- **Exception:** the student `/login` page always renders its own dark "login aesthetic". It re-maps the tokens inline to an indigo palette (`app/login/page.tsx:38-49`), configured in Admin → Website → Login Page (`lib/login-page.ts`).

---

## 5. Components: canonical files

Always import from these files. Do not re-create them.

| Component | Canonical file | Source | Notes |
|---|---|---|---|
| Button | `components/ui/button.tsx` | cva + Radix Slot | variants `primary` (default), `secondary`, `outline`, `ghost`, `danger`, `success`, `cta`; sizes `sm` h-8, `default` h-10, `lg` h-12, `icon` 36×36, `compact` h-7; `asChild` for links |
| Input | `components/ui/input.tsx` | Tailwind | h-10, surface fill, primary focus outline |
| Textarea | `components/ui/textarea.tsx` | Tailwind | |
| Select | `components/ui/select-native.tsx` (`SelectNative`) | native `<select>` | no Radix Select in use |
| Label | `components/ui/label.tsx` | Radix Label | always pair it with `htmlFor` |
| Checkbox | `components/ui/checkbox.tsx` | Radix | |
| Radio | native `<input type="radio">` inside `<label>` with `role="radiogroup"` | native | see `test-player.tsx` |
| Switch | `components/ui/switch.tsx` | Radix | checked = success |
| Card (+Header/Title/Description/Content/Footer) | `components/ui/card.tsx` | shadcn-style | radius-card, border, card fill; padding p-5 |
| Dialog | `components/ui/dialog.tsx` | Radix Dialog | built-in close with sr-only label; max-w-md; overlay black/50 |
| Confirm dialog | `components/security/confirm-action-dialog.tsx` | on Dialog | use it instead of `window.confirm` |
| Dropdown menu | `components/ui/dropdown-menu.tsx` | Radix | Content, Item, Separator, Label |
| Tooltip | `components/ui/tooltip.tsx` | Radix | inverted (foreground bg) |
| Tabs | `components/ui/tabs.tsx` | Radix | admin hubs wrap it in `components/admin/control-center-tabs.tsx` (URL `?tab=`) |
| Badge | `components/ui/badge.tsx` | cva | `neutral`, `primary`, `success`, `error`, `warning`, `info`; 11px |
| Alert | `components/ui/alert.tsx` | custom | `default` \| `destructive`; `role="alert"` |
| Brand wordmark | `components/brand/BrandLogo.tsx` | custom | text-only, sizes sm–xl |
| Public header / footer | `components/homepage/site-header.tsx`, `site-footer.tsx`, shell `public-page-shell.tsx` | custom | footer is shared by public and student pages |
| Student header / shell | `components/student/header.tsx`, `components/student/shell.tsx` | custom | the test player deliberately has no shell |
| Admin sidebar / header | `components/admin/sidebar.tsx`, `components/admin/header.tsx` | custom | collapsible; mobile overlay |
| Breadcrumbs | `components/public-exam/breadcrumbs.tsx` (public) | custom | `aria-current="page"` |
| Theme / text-size controls | `components/theme/theme-toggle.tsx`, `text-size-control.tsx` | custom + Radix menu | |

**Not yet standardized (built ad hoc):** Table (raw `<table>` about 50 times), Drawer/Sheet, Toast (none; inline banners are used), Pagination, Skeleton, EmptyState, error page.

---

## 6. Spacing

Tailwind's default 4px scale. Observed conventions:

| Context | Convention |
|---|---|
| Inline icon + text | `gap-1.5` / `gap-2` |
| Form field (label → input) | `flex flex-col gap-2` |
| Form stack | `gap-4` / `gap-5` |
| Card padding | `p-5` (Card primitives); `p-4` for compact aside cards; `p-6` for dialogs and auth cards |
| Section / page stack | `gap-6` (admin pages), `gap-4` (player) |
| Page gutter | `px-4 sm:px-6` |

---

## 7. Radius

| Token | Default | Admin options | Used for |
|---|---|---|---|
| `--radius-button` | 0.625rem | 0 / 0.375 / 0.5 / 1rem | buttons, inputs, selects, tabs, palette cells |
| `--radius-card` | 0.75rem | 0 / 0.5 / 0.75 / 1.25rem | cards, dialogs, menus, option rows, images |
| `--radius-badge` | 0.375rem | not admin-configurable | badges, callouts |
| `rounded-full` | n/a | n/a | pills, avatars, timer, dots |

Nested items use `rounded-[calc(var(--radius-button)-2px)]` (menu items, segmented controls).

---

## 8. Shadows and elevation

- The only token is `--shadow-card` (per theme). Use `shadow-[var(--shadow-card)]` for cards that float, dialogs, dropdowns and tabs' active pill.
- Elevation is expressed mainly by **hairline borders plus a fill step** (background → surface → card), not by shadow.
- Button `primary`/`cta` carry a fixed subtle shadow.
- The admin "Shadow intensity" setting is currently **not applied** (see §13).

---

## 9. Breakpoints, containers and layout patterns

- **Breakpoints:** Tailwind defaults (`sm` 640, `md` 768, `lg` 1024, `xl` 1280). The code is mobile-first and `sm:` is the main switch (about 350 uses). `lg:` handles two-column layouts. `xl:` is almost unused.
- **Containers:**
  - `mx-auto w-full max-w-6xl px-4 sm:px-6` for public and student chrome and content.
  - `max-w-2xl`/`3xl` for reading and result pages.
  - `max-w-sm` for the admin login card.
  - Configurable `cardWidth` (440px) for the student login.
- **Headers:**
  - Sticky with `backdrop-blur`: public h-[4.5rem], student h-16.
  - The public nav becomes a horizontally scrolling second row below `md`.
  - The student nav collapses to a toggle menu below `md`.
  - The admin sidebar is collapsible on `lg+` and an overlay drawer below `lg`.
- **Test player:**
  - Single column on mobile with the palette below the question.
  - `lg:grid-cols-[1fr_280px]` with a sticky aside on desktop.
  - One question per screen, and the same in Review.
- **Tables:** wrapped in `overflow-x-auto` with `min-w-[640–900px]`, so they scroll horizontally on mobile.

---

## 10. Icons

- Use `lucide-react` only.
- **Sizes:** `h-4 w-4` is the default (inline with text-sm), `h-3.5 w-3.5` sits next to text-xs, `h-5 w-5` is used for stat and state icons, and `h-8 w-8` to `h-10 w-10` for empty or hero states.
- Decorative icons **must** have `aria-hidden`. This is followed nearly everywhere.
- Icon-only buttons **must** have an `aria-label`, or a `<span className="sr-only">`.
- The homepage builder maps icon names through `lib/homepage-icons.ts`.
- The only inline SVG is the Google "G" on the login page.

---

## 11. Loading, empty and error patterns (as they exist today)

- **Pending actions:**
  - The button shows `<Loader2 className="h-4 w-4 animate-spin" aria-hidden />` and swaps its label ("Signing in…"), using `useFormStatus`.
  - Buttons are `disabled` while the action is pending.
- **Inline errors:** a `<p role="alert">` with `rounded-[var(--radius-button)] border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]`. This is duplicated in several forms and is a candidate for `<Alert variant="destructive">`.
- **Warning banners (player):** full-width `role="alert"` bar with a `warning/50` border and `warning/10` background, plus action buttons.
- **Empty states:** inline muted text ("No … yet", about 70 places), sometimes with a large muted lucide icon and a CTA `Button`.
- **Route-level:** there is **no** `loading.tsx`, `error.tsx` or `not-found.tsx`. Next.js defaults apply.
- **Notifications:** no toast system. Feedback is inline.

---

## 12. Rules for future UI work

1. **Tokens, not literals.**
   - Use `[var(--color-*)]` classes for every color.
   - No hex, `rgb()`, or raw palette classes (`bg-blue-600`, `text-indigo-400`).
   - The only accepted exceptions are third-party brand marks (Google G, WhatsApp green) and the self-contained `/login` aesthetic.
2. **Primitives first.**
   - Use `components/ui/*` for Button, Input, Textarea, SelectNative, Label, Checkbox, Switch, Card, Dialog, DropdownMenu, Tabs, Badge, Alert and Tooltip.
   - Do not hand-write `<button className="…">` for anything that looks like a button. Use `<Button variant size>` or `asChild`.
   - Use `ConfirmActionDialog` instead of `window.confirm` / `alert`.
3. **Merge classes with `cn()`**, so callers can override.
4. **Semantic colors as text:**
   - `success`, `error`, `warning`, `info` and `primary` fail contrast as small text in Day mode.
   - Prefer them for borders, fills, tints and icons, and pair them with `text-[var(--color-foreground)]` for copy.
   - When colored text is required, mix it toward the foreground (see the `.ai-expl` pattern in `globals.css`) until ink tokens exist.
   - On solid semantic fills, use dark ink (`text-[#1a1a1a]` as in Button `danger`/`success`), not `text-white`.
5. **Never rely on color alone for state.** Add a text label, an icon or `aria-*`, as the review page's "Correct answer" / "Your answer" labels do.
6. **Typography:**
   - Use the scale classes (`text-xs` … `text-5xl`, `text-question`) so the student Text Size control keeps working.
   - Avoid `text-[10px]`/`[11px]`: they do not scale.
   - Headings are weight 400 by default; add `font-semibold` for UI titles.
7. **Focus:**
   - Do not remove outlines. The global `:focus-visible` outline is the standard.
   - If you add `outline-none`, add an equivalent ring or background change.
8. **Forms:** every field needs `<Label htmlFor>` + `id`, `autoComplete` where applicable, and errors in `role="alert"`.
9. **Icons:** lucide only, `aria-hidden` on decoration, `aria-label` on icon-only controls, `h-4 w-4` by default.
10. **Radius and shadow:**
    - Only `--radius-button`, `--radius-card`, `--radius-badge` and `rounded-full`.
    - Only `--shadow-card`.
11. **Layout:**
    - Mobile-first.
    - Container `max-w-6xl px-4 sm:px-6`.
    - Wide tables go inside `overflow-x-auto`.
    - Touch targets are at least 36px, 44px preferred for student-facing controls.
12. **Themes:** test every new screen in Night, Day **and** Eye-Saver. In Eye-Saver, hue is gone, so state must survive in grayscale.
13. **Heavy libraries** (`xlsx`, `pdf-lib`, `papaparse`, `@xyflow/react`, `dagre`, `@dnd-kit`):
    - Import them only from server modules or admin client components.
    - Never import them from student or public components.
    - Prefer `next/dynamic` for admin-only visualizations.
14. **Test engine:** `app/student/attempt/[attemptId]/run/test-player.tsx` is high risk. Even visual-only changes need the regression pass in `ops/TEST-ENGINE.md`.

---

## 13. Known inconsistencies to clean later

1. **`--color-muted` is referenced but undefined:**
   - Used in 9 places: `components/ui/alert.tsx:17`, the admin payments and backup progress tracks, and the bulk-import panel and sticky `thead`.
   - These render transparent.
   - Fix: define it per theme or switch the uses to `--color-surface`.
2. **Light-mode semantic text contrast** (2.0–3.7:1). Add `--color-*-ink` tokens and migrate Badge, error banners and the review labels.
3. **Test-player palette:** white digits on success, warning and info fills (about 2.2–2.5:1), and status conveyed only by hue. Neither `aria-label` nor `aria-current` conveys the status.
4. **Off-scale font sizes:** `text-[9px]`/`[10px]`/`[11px]` appear 92 times, including in the Badge base class. Introduce a scalable `--text-2xs`.
5. **Admin "Shadow intensity"** is saved but never emitted (`lib/appearance.ts:139-153`).
6. **Login palette:** `/login` and its admin preview use raw `indigo-*`, `white/…` and `#6366f1` (`app/login/*`, `app/admin/(dashboard)/website/login-page/login-page-form.tsx`). Intentional, but it should become named login tokens.
7. **No Table, EmptyState, Skeleton, Pagination, Toast or Drawer primitives.** There are about 50 hand-written tables with 4 `<thead>` styles, and the admin mobile sidebar and diagram drawer are hand-rolled overlays without focus management.
8. **Error-banner markup is duplicated** (`app/login/login-screen.tsx:44`, `app/admin/login/login-form.tsx:69`, and others) instead of using `<Alert variant="destructive">`.
9. **Native `confirm()`/`alert()`** are used 10 times in admin, although `ConfirmActionDialog` exists.
10. **`alert.tsx` and `checkbox.tsx`** build classes with template strings rather than `cn()`.
11. **Tooltip animation classes** (`animate-in`, `fade-in-0`, …) are used without the plugin that defines them, so they are no-ops.
12. **Unused dependencies:** `@radix-ui/react-toast`, `@radix-ui/react-avatar`, `@radix-ui/react-select`.
13. **The Eye-Saver ink flip** misses variant-prefixed fills. For example, a checked `Checkbox` shows a white check on a white fill.
14. **Current-question ring offset** uses Tailwind's default white ring-offset color, which creates a white halo in the dark themes (`test-player.tsx:132`).
15. **Token class style:** only the `[var(--color-*)]` form is used. The `@theme inline` short names (`bg-card`, …) work but are unused. Pick one form; today's convention is the long form.
16. **Missing app-wide patterns:** no skip link, no `prefers-reduced-motion` rule, and no route-level `loading.tsx`, `error.tsx` or `not-found.tsx`.
