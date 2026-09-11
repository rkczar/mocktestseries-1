# Handoff: MockTestSeries.in — Full Application Handoff

## What this project is
A Claude Design prototype of MockTestSeries.in — an AI-powered mock-test platform for Indian
competitive/recruitment exams. Every `.dc.html` file is a **visual and functional reference**
rendered by Claude Design's own runtime; **none of it is production application code**. There is
no server, no real database, no real authentication, and no live AI calls anywhere in the
prototype — see the design-only vs. production-ready split below. This bundle now covers the
full application, not just the homepage — see Files at the bottom for the per-area specs.

## Design-only vs. production-ready
- **Design-only (100% of the UI)**: every `.dc.html` screen — Homepage, Admin Dashboard, Student
  Dashboard, Test Player, Analysis, Question Bank, Login, etc. These show the intended look,
  copy, layout and interaction states, nothing more.
- **Real, portable logic** (safe to translate near-verbatim into server code): the *data-shape
  and business-rule* JS files — `question-bank-data.js` (CSV/XLSX parsing, validation, duplicate
  handling), `custom-module-data.js` (live-derived subject pools, attempt freezing), `ai-data.js`
  (cache-before-generate rule, 5-variant cap, usage/content separation), `student-data.js`
  (statistics aggregate + recompute-from-history pattern). These ran as real client-side logic
  against `localStorage`; the *rules* are real, the *storage* is not.
- **Production-ready**: nothing. Every localStorage-backed store must become a real database
  table; every simulated network call (AI generation, OTP send/verify, payment) must move
  server-side.

## GitHub handoff instructions
The connected repository (`rkczar/mocktestseries-1`) currently has **zero commits**. Claude
Design cannot push to it. Hand this whole project + this `design_handoff_mocktestseries_homepage/`
folder to a build agent (e.g. Claude Code) with repo access to scaffold the real Next.js app and
make the first commit.

## Handoff completeness report
| Area | Status |
|---|---|
| Homepage | ✅ Complete |
| Admin Dashboard | ⚠️ Needs clarification — several modules (Students, Teachers, Roles & Permissions, Live Tests, Reports, Question Queries) have no built screen, only a generic scaffold |
| Student Dashboard | ✅ Complete |
| Test Player | ✅ Complete — reveal-mode-per-attempt vs. per-exam-config needs a business decision |
| Results | ✅ Complete |
| Analysis | ⚠️ Needs clarification — "Percentile" is a hardcoded placeholder, not computed; subject-mastery bars need wiring to real per-subject stats |
| Question Bank | ✅ Complete — strongest-specified area; import logic is close to portable as-is |
| Bulk Import | ✅ Complete |
| Exam Year | ✅ Complete |
| Previous Year Papers | ✅ Complete |
| AI | ⚠️ Needs clarification — no admin-approval gate exists before AI content goes live; confirm if one is wanted |
| Authentication | ⚠️ Needs clarification / ❌ mostly missing — UI only; registration, forgot/reset password, admin login all unbuilt; one exposed OTP credential needs rotating |
| Payments | ❌ Missing — no UI, no entity, no gateway flow designed |
| Student Management | ❌ Missing — no admin-facing student list/detail screen exists |
| Admin Management | ❌ Missing — no roles/permissions UI, single implicit "Master Admin" |
| Appearance | ✅ Complete |
| Website Diagram | ✅ Complete |
| Navigation | ✅ Complete |
| Responsive Design | ⚠️ Needs clarification — admin sidebar/table mobile behavior not confirmed in source |
| Database schema | ⚠️ Needs clarification — starting schema covers homepage/CMS only; question bank, attempts, AI, reports, appearance need adding (see `DATA-MAPPING.md`) |
| Deployment architecture | ❌ Missing — out of scope until a real app exists to deploy |

## Homepage-specific overview (original scope of this bundle)
MockTestSeries.in is an AI-powered mock test platform for Indian competitive and recruitment
exams. This bundle covers the **public homepage** design and the architecture required to build
the surrounding application: a Next.js + TypeScript app with an Admin Panel that controls all
dynamic homepage content, separated student and admin authentication, and an exam model that
scales to unlimited exams without touching homepage code.

The first active exam is **RUHS Medical Officer 2026**.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype showing the
intended look, content and behaviour. They are **not production code to copy directly**.

`Homepage.dc.html` is a streaming HTML design component with inline styles. Recreate it in the
target stack (Next.js App Router + TypeScript + Tailwind CSS + shadcn/ui + Lucide icons) using
that stack's established patterns: Tailwind utility classes mapped to the design tokens below,
shadcn/ui primitives (`Button`, `Card`, `Badge`, `Separator`, `Input`, `Sheet` for the mobile nav),
and Lucide components in place of the inline SVGs. Do not port inline styles.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, copy and states are final. Recreate the UI
faithfully; substitute equivalents only where a shadcn/ui primitive achieves the same result.

---

## Design Tokens

### Colors
| Token | Hex | Use |
|---|---|---|
| `primary` | #0F4C81 | Brand navy: header logo, primary buttons, headings accent, final CTA panel |
| `primary-hover` | #0B3A63 | Primary button hover, announcement bar background |
| `primary-tint` | #EEF4FA | Active nav pill, badge fill, icon tiles |
| `primary-border` | #DCE7F2 | Border on tinted surfaces |
| `background` | #F6F9FC | Page background, inset cards on white sections |
| `surface` | #FFFFFF | Cards, header, alternating sections |
| `border` | #E3EAF2 | Default card / section border |
| `border-strong` | #CFDCE9 | Secondary button + input borders, dashed placeholders |
| `border-subtle` | #EDF2F7 | Internal dividers |
| `text` | #212529 | Body text |
| `text-heading` | #0F2B45 | Section and card headings |
| `text-muted` | #41505E | Secondary body copy |
| `text-faint` | #7A8899 | Meta text |
| `text-placeholder` | #9AA7B4 | Placeholder labels, footer legal |
| `success` | #2E7D32 | Correct answer, active exam status |
| `success-tint` / border / text | #EEF7EE / #CFE3D0 / #1E5620 | Success chips + correct option row |
| `error` | #C62828 | Timer, wrong-answer heading |
| `error-tint` / border | #FDEDED / #F6D5D5 | Timer chip |
| `accent` | #F57C00 | Eyebrow labels, `.in` in wordmark, step numbers, CTA button |
| `accent-hover` | #DC6F00 | Accent button hover |
| `accent-tint` / border / text | #FFF6EC / #F8DDBE / #B25E00 | Exam Pearl + "Expected" chips |
| Dark-panel body text | #D7E5F1 | Copy inside the navy final CTA |
| Dark-panel border / faint | #4A7BA5 / #A9C4DA | Ghost button border + mono note in final CTA |

Do not add gradients, glassmorphism or neon. The only gradient in the design is a diagonal
`repeating-linear-gradient(135deg, #F2F6FA 0 8px, #FFFFFF 8px 16px)` used for image placeholders,
which real exam images replace.

### Typography
- **Display / headings** — Source Serif 4, weight 700, `letter-spacing: -0.015em` (hero -0.02em).
  H1: `clamp(38px, 5.2vw, 60px)`, line-height 1.06. H2: `clamp(27px, 3vw, 38px)`, line-height 1.15.
- **UI / body** — Manrope. Body 14–18.5px; card titles 17–20px at weight 700/800; nav 14.5px.
- **Labels / numerals** — IBM Plex Mono, 10–13px, weight 600, `letter-spacing: .06–.1em`,
  uppercase. Used for eyebrows, status chips, step numbers, route references.
- Load via `next/font/google`. Body copy `line-height: 1.55–1.6`, `text-wrap: pretty`;
  headlines `text-wrap: balance`.

### Spacing, radius, shadow
- Container: `max-width: 1200px`, `padding-inline: 24px`.
- Section padding: `clamp(56px, 7vw, 92px)` vertical; hero `clamp(44px, 6vw, 80px)`.
- Grid gaps: 20px (card grids), `clamp(28px, 4vw, 56px)` (two-column splits).
- Radii: 7px chips/option letters · 9–10px buttons · 11–12px inset panels · 14–16px cards · 20px CTA panel · 999px pills.
- Shadows (sparingly): card `0 10px 30px -20px rgba(15,76,129,.4)`;
  raised preview `0 14px 40px -22px rgba(15,76,129,.35)`.
- Header is `sticky`, top 0, height 72px, `z-index: 50`, bottom border `#E3EAF2`.

---

## Screens / Views

### Homepage `/`
Alternating section bands: `#F6F9FC` page background with `#FFFFFF` sections separated by 1px
`#E3EAF2` borders. Order top to bottom:

1. **Announcement bar** — `#0B3A63`, 13px, centered. Mono `New` tag in `#F57C00`, message text,
   underlined white link. Copy: "RUHS Medical Officer 2026 test series is live — AI explanations
   on every question." / "View exam". Admin-controlled; hidden when no active announcement.
2. **Header** — logo lockup (34px navy rounded square with clipboard-check icon + wordmark
   "MockTestSeries" in Source Serif 700, ".in" in accent) linking to `/`; nav Home · Exams ·
   Test Series · Upcoming Exams · Pricing (active item is a `#EEF4FA` pill, 700 weight, navy);
   right side outlined **Login** + solid navy **Start Free**. Below `lg`, collapse nav into a
   shadcn `Sheet` triggered by a Lucide `Menu` button; keep the logo and Start Free visible.
3. **Hero** — two columns, `minmax(320px, 1fr)` auto-fit so it stacks below ~700px.
   Left: pill badge (Lucide `Sparkles`, accent) "AI-Powered Exam Preparation"; H1
   "Practice Smart. / Understand Every Answer." (explicit line break); description; buttons
   "Start Free Mock Test" (navy, `ArrowRight`) and "Browse Exams" (white/outline); trust row of
   three `CircleCheck` items in success green — No card required · Real exam interface ·
   Instant analysis.
   Right: **Interactive Test Preview** — mono label + red timer chip `18:24`; card with
   "Q 14 / 100 · Pharmacology" header and a 5-swatch palette (green/red/accent/2×grey);
   question stem; three options where B (Lorazepam) is the correct state — `1.5px #2E7D32`
   border, `#EEF7EE` fill, filled letter chip, trailing `Check`; then an AI Explanation panel
   (`#EEF4FA`) with three pills: Why others wrong? · Core concept · Memory trick.
4. **Trust / stats strip** — white band, 4 icon+label pairs: Exam-focused Questions (mapped to
   the real syllabus) · AI Explanations (on every single question) · Detailed Analysis
   (accuracy, speed, weak topics) · Real Exam Experience (timed, palette-based UI).
5. **Featured Exams** — eyebrow + H2 "Start with the exam you are preparing for" + "All exams"
   link. Card grid `minmax(290px, 1fr)`. First card is the live exam: navy 1.5px border,
   icon tile, green **Active** status chip with dot, title "RUHS Medical Officer 2026",
   description, meta chips (100 Q · 90 min / 12 mock tests / AI explanations), navy
   "Open exam page" button. Whole card is a link to `/exams/[slug]`. Remaining cards are dashed
   "Coming soon" placeholders illustrating that admin-added exams populate the grid.
6. **Popular Test Series** — H2 "Three ways to practice"; three linked cards on `#F6F9FC`
   (hover: white fill + navy border): Full Mock Tests (12 tests · 100 Q each) · Previous Year
   Papers (2019 – 2025) · Subject-wise Practice (19 subjects).
7. **AI USP** — two columns. Left: eyebrow "The AI difference", H2 "Every question comes with a
   full explanation", paragraph, then a 2-up chip grid of the six AI actions: Why Correct?
   (green check) · Why Others Wrong? (red X) · Core Concept · Exam Pearl (accent `Zap`) ·
   Memory Trick · **Ask AI** (inverted, navy fill, white text). Right: explanation panel with a
   navy header "AI Explanation · Q14"; a green "Why Correct?" block; a red "Why Others Wrong?"
   block listing A and C; an accent "Exam Pearl" callout; and an Ask-AI input row.
8. **Why MockTestSeries.in** — 4 cards on `#F6F9FC` with white icon tiles: Real Exam Experience ·
   Performance Analytics · Weak Topic Detection · Practice Again.
9. **How It Works** — 4 columns, each a top rule (`2px`; first is navy, rest `#DCE7F2`), mono
   step number in accent, title, one-line description: 01 Choose Exam · 02 Take Test ·
   03 Understand With AI · 04 Analyze & Improve.
10. **Upcoming Exams** — H2 "Know what is next" + "Full calendar" link; stacked rows with a
    56px date tile (mono month in accent over bold day), title + meta, status chip
    (green "Notification out" / accent "Expected"), and a right-aligned action link.
11. **Final CTA** — navy `#0F4C81` panel, radius 20px: H2 "Take your first mock test today",
    supporting line, accent "Start Free Mock Test" button + ghost "View Pricing" button, and a
    mono note. Content is admin-editable.
12. **Footer** — white, 4 columns: brand + description; Practice (Exams, Test Series, Upcoming
    Exams, Pricing); Students (Login, Register, Dashboard); Company (About, Contact, Privacy
    Policy, Terms). Bottom bar: copyright + mono tagline. **No admin links in the footer.**

### Other routes
Only the homepage is designed here. Build the remaining routes with the same header, footer,
tokens and card language; ask for designs before inventing complex screens (test player,
analytics, admin tables).

## Interactions & Behavior
- Logo always navigates to `/`.
- Hover: primary button → #0B3A63; accent button → #DC6F00; outline button → #F2F6FA fill;
  nav item → #F2F6FA fill + navy text; test-series card → white fill + navy border; featured
  exam card → deeper shadow. Transitions ~150ms ease-out on background, border and box-shadow
  only. No entrance animations, parallax or scroll effects.
- Focus: visible 2px `#0F4C81` ring with 2px offset on every interactive element.
- Responsive: all grids are `auto-fit` + `minmax`, so they collapse without media queries.
  Verify at 375 / 768 / 1024 / 1440. Minimum tap target 44px on mobile.
- The preview card and AI panel are static in the design. If made interactive, selecting an
  option reveals the explanation panel; keep it non-blocking and optional.

## State Management
The homepage is a **server component** with no client state beyond the mobile nav sheet.
All content is fetched server-side from the CMS tables described in `ARCHITECTURE.md`
(`getHomepageContent()`), cached with tag-based revalidation invalidated by admin writes.
Client islands: mobile nav (`useState`), and any future interactive preview.

## Assets
No production assets are included. Placeholders in the design:
- Exam icon / image slots — the diagonal striped placeholder; replace with admin-uploaded
  `iconUrl` / `imageUrl` (SVG or PNG, square, ≥ 128px), rendered through `next/image`.
- All icons are Lucide: `ClipboardCheck`, `Sparkles`, `ArrowRight`, `CircleCheck`, `Check`, `X`,
  `Clock`, `FileText`, `BarChart3`, `Monitor`, `Target`, `Zap`, `RotateCcw`, `MessageSquare`,
  `Menu`, `LayoutGrid`.
- Fonts: Source Serif 4, Manrope, IBM Plex Mono (Google Fonts).

## What this project is
A Claude Design prototype of MockTestSeries.in — an AI-powered mock-test platform for Indian
competitive/recruitment exams. Every `.dc.html` file is a **visual and functional reference**
rendered by Claude Design's own runtime; **none of it is production application code**. There is
no server, no real database, no real authentication, and no live AI calls anywhere in the
prototype — see the "design-only vs. production-ready" split below.

## Design-only vs. production-ready
- **Design-only (100% of the UI)**: every `.dc.html` screen — Homepage, Admin Dashboard, Student
  Dashboard, Test Player, Analysis, Question Bank, Login, etc. These show the intended look,
  copy, layout and interaction states, nothing more.
- **Real, portable logic (safe to translate near-verbatim into server code)**: the *data-shape
  and business-rule* JS files — `question-bank-data.js` (CSV/XLSX parsing, validation, duplicate
  handling), `custom-module-data.js` (live-derived subject pools, attempt freezing), `ai-data.js`
  (cache-before-generate rule, 5-variant cap, usage/content separation), `student-data.js`
  (statistics aggregate + recompute-from-history pattern). These ran as real client-side logic
  against `localStorage`; the *rules* are real, the *storage* is not.
- **Production-ready**: nothing. Every localStorage-backed store must become a real database
  table; every simulated network call (AI generation, OTP send/verify, payment) must move
  server-side.

## What must be built
See the per-area specs listed under Files below. In short: a real Postgres/Prisma schema
(exams, questions, attempts, results, AI content/usage, students, admins, appearance settings),
Auth.js for both student and admin (completely separate sessions/tables/routes), server-side AI
generation with caching, a real OTP/Google-login backend, and — not yet designed at all —
payments.

## Technology stack (intended, fixed)
Next.js (App Router) · TypeScript (strict) · Tailwind CSS · shadcn/ui · Lucide icons ·
PostgreSQL · Prisma · Auth.js. See `ARCHITECTURE.md` for routes, middleware, and build order.

## Database architecture
Starting schema: `prisma/schema.prisma`. Extend per `DATA-MAPPING.md` for entities not yet
modeled there (Question, TestAttempt, QuestionAttempt, AiSolution, AiUsage, QuestionReport,
CustomModuleSubjectConfig, AppearanceSetting, StudentUser/AdminUser, StudentProfile/Statistics).

## Authentication architecture
See `AUTHENTICATION.md`. Nothing currently works end-to-end. **One real security item**: a live
MSG91 OTP token is hardcoded in `Student-Login.dc.html`'s source — rotate it before any further
work, and never place a provider secret in frontend code again.

## AI architecture
See `AI-SYSTEM.md`. Server-side generation only, cache-before-generate, 5-variant cap, content
vs. usage logs kept separate, API keys server-env-only.

## Admin / Student architecture
See `ADMIN-DASHBOARD.md` and `STUDENT-DASHBOARD.md` for full per-module specs, plus
`TEST-PLAYER.md`, `RESULTS-ANALYSIS.md`, `QUESTION-BANK.md`, `PREVIOUS-YEAR-PAPERS.md`,
`APPEARANCE.md`, `WEBSITE-DIAGRAM.md`, `NAVIGATION.md`, `RESPONSIVE-DESIGN.md`.

## Deployment target
The user's own VPS, via GitHub as the single source of truth. This handoff package does not
include VPS/CI setup — that only becomes meaningful once a real Next.js app exists to deploy
(see the project's deployment-audit conversation for the intended Nginx/PM2/Postgres shape).

## GitHub handoff instructions
The connected repository (`rkczar/mocktestseries-1`) currently has **zero commits**. Claude
Design cannot push to it. Hand this whole project + this `design_handoff_mocktestseries_homepage/`
folder to a build agent (e.g. Claude Code) with repo access to scaffold the real Next.js app and
make the first commit.

## Files
- `Homepage.dc.html` — the high-fidelity homepage design reference (open in a browser).
- `ARCHITECTURE.md` — required stack, routes, auth separation, admin-controlled content model,
  component breakdown, build order.
- `ADMIN-DASHBOARD.md`, `STUDENT-DASHBOARD.md`, `TEST-PLAYER.md`, `RESULTS-ANALYSIS.md`,
  `QUESTION-BANK.md`, `AI-SYSTEM.md`, `AUTHENTICATION.md`, `PREVIOUS-YEAR-PAPERS.md`,
  `APPEARANCE.md`, `WEBSITE-DIAGRAM.md`, `NAVIGATION.md`, `RESPONSIVE-DESIGN.md`,
  `DATA-MAPPING.md` — per-area production specs written from the actual `.dc.html` sources.
- `prisma/schema.prisma` — starting database schema for the CMS + exam + auth model.

## Handoff completeness report
| Area | Status |
|---|---|
| Homepage | ✅ Complete |
| Admin Dashboard | ⚠️ Needs clarification — several modules (Students, Teachers, Roles & Permissions, Live Tests, Reports, Question Queries) have no built screen, only a generic scaffold |
| Student Dashboard | ✅ Complete |
| Test Player | ✅ Complete — reveal-mode-per-attempt vs. per-exam-config needs a business decision |
| Results | ✅ Complete |
| Analysis | ⚠️ Needs clarification — "Percentile" is a hardcoded placeholder, not computed; subject-mastery bars need wiring to real per-subject stats |
| Question Bank | ✅ Complete — strongest-specified area; import logic is close to portable as-is |
| Bulk Import | ✅ Complete |
| Exam Year | ✅ Complete |
| Previous Year Papers | ✅ Complete |
| AI | ⚠️ Needs clarification — no admin-approval gate exists before AI content goes live; confirm if one is wanted |
| Authentication | ⚠️ Needs clarification / ❌ mostly missing — UI only; registration, forgot/reset password, admin login all unbuilt; one exposed OTP credential needs rotating |
| Payments | ❌ Missing — no UI, no entity, no gateway flow designed |
| Student Management | ❌ Missing — no admin-facing student list/detail screen exists |
| Admin Management | ❌ Missing — no roles/permissions UI, single implicit "Master Admin" |
| Appearance | ✅ Complete |
| Website Diagram | ✅ Complete |
| Navigation | ✅ Complete |
| Responsive Design | ⚠️ Needs clarification — admin sidebar/table mobile behavior not confirmed in source |
| Database schema | ⚠️ Needs clarification — starting schema covers homepage/CMS only; question bank, attempts, AI, reports, appearance need adding (see `DATA-MAPPING.md`) |
| Deployment architecture | ❌ Missing — out of scope until a real app exists to deploy |
