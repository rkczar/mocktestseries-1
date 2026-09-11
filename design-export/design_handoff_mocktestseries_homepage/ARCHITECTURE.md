# MockTestSeries.in — Application Architecture

Build this as a production Next.js application, not a static page.

## Stack (fixed)
Next.js (App Router) · TypeScript (strict) · Tailwind CSS · shadcn/ui · Lucide icons ·
PostgreSQL · Prisma · Auth.js. Zod for validation, React Hook Form for forms,
`next/image` for images, `next/font` for fonts.

## Non-negotiable rules
1. No hard-coded homepage content in the production data layer. Every item below is read from
   the database at request time. Seed scripts may insert initial rows, but nothing may be
   embedded as a permanent constant in app code.
2. Adding an exam must require **zero homepage code changes** — the homepage renders whatever
   the `Exam` and `HomepageSection` tables contain, ordered by an admin-set `order` field.
3. Student and admin authentication are completely separate: separate Auth.js configurations,
   separate session cookies (`mts.student.session` / `mts.admin.session`), separate user
   tables, separate login routes. An admin session never authenticates a student route and
   vice versa.
4. Public pages (`/`, `/exams`, `/exams/[slug]`, `/test-series`, `/upcoming-exams`, `/pricing`)
   are accessible without login.
5. No `index.php`, `index.html`, `student.php` or any file extension in a user-facing URL.
   All routing is via the App Router; extensionless, slug-based, lowercase, hyphenated.
6. Component-based architecture — many small typed components, no giant page component.

## Admin-controlled content (all of it)
| # | Content | Source |
|---|---|---|
| 1 | Hero heading | `HomepageContent.heroHeading` |
| 2 | Hero description | `HomepageContent.heroDescription` |
| 3 | CTA buttons (label + href, primary & secondary, hero & final) | `CtaButton` |
| 4 | Featured exams | `Exam.isFeatured` |
| 5 | Exam ordering | `Exam.order` |
| 6 | Exam status | `Exam.status` enum ACTIVE / COMING_SOON / ARCHIVED |
| 7 | Exam title | `Exam.title` |
| 8 | Exam description | `Exam.description` |
| 9 | Exam icon / image | `Exam.iconUrl`, `Exam.imageUrl` |
| 10 | Popular test series | `TestSeries.isPopular` + `order` |
| 11 | Upcoming exams | `UpcomingExam` |
| 12 | Homepage announcements | `Announcement` (active + date window) |
| 13 | Pricing / CTA sections | `PricingPlan`, `HomepageContent.final*` |
| — | Section visibility & order | `HomepageSection` (key, isVisible, order) |

## Routes
### Public (`app/(public)/`) — shared layout with reusable `<SiteHeader />` and `<SiteFooter />`
`/` · `/exams` · `/exams/[slug]` · `/test-series` · `/test-series/[slug]` ·
`/upcoming-exams` · `/pricing`

### Student (`app/student/`)
`/student/login` · `/student/register` · `/student/dashboard` (protected) ·
`/student/tests/[attemptId]` · `/student/results/[attemptId]`

### Admin (`app/admin/`) — separate layout, no public header/footer
`/admin/login` · `/admin/dashboard` (protected) · `/admin/homepage` · `/admin/exams` ·
`/admin/exams/[id]` · `/admin/test-series` · `/admin/upcoming-exams` · `/admin/announcements` ·
`/admin/pricing`

`/admin/*` must be excluded from `robots.txt` and the sitemap, and return 404-style behaviour
for unauthenticated non-admins rather than revealing structure.

## Middleware
`middleware.ts` matches `/student/:path*` and `/admin/:path*`:
- `/student/dashboard` and below without a student session → redirect `/student/login?next=…`
- `/admin/*` except `/admin/login` without an admin session **with role ADMIN or SUPER_ADMIN**
  → redirect `/admin/login`
- An admin session on a student-only route (and the reverse) is treated as unauthenticated.

## Auth
- Student: Auth.js Credentials (email + password, argon2id) plus optional Google OAuth.
  Email verification, rate-limited login, password reset tokens.
- Admin: Auth.js Credentials only, no self-registration, mandatory strong password, TOTP 2FA
  recommended, audit log of every content mutation (`AuditLog`).
- Separate `authOptions` objects, separate route handlers
  (`app/api/auth/student/[...nextauth]`, `app/api/auth/admin/[...nextauth]`), distinct cookie
  names and `AUTH_SECRET`s where possible. Sessions are JWT with role claims; all server actions
  re-verify role server-side.

## Data flow
```
lib/content/getHomepageContent.ts   -> single typed query for all homepage data
lib/content/types.ts                -> HomepageContentDTO
lib/db.ts                           -> Prisma singleton
```
Homepage is a server component: `const content = await getHomepageContent()`, then it maps
sections. Cache with `unstable_cache` tagged `homepage`; every admin mutation calls
`revalidateTag('homepage')`. Never fetch homepage content client-side.

## Component breakdown
```
components/layout/     SiteHeader, MobileNav, SiteFooter, AnnouncementBar, Container
components/home/       HeroSection, TestPreviewCard, TrustStrip, FeaturedExamsSection,
                       ExamCard, PopularTestSeriesSection, TestSeriesCard, AiUspSection,
                       AiExplanationPanel, WhyUsSection, HowItWorksSection,
                       UpcomingExamsSection, UpcomingExamRow, FinalCtaSection
components/ui/         shadcn/ui primitives (button, card, badge, input, sheet, separator…)
components/common/     SectionHeading, EyebrowLabel, StatusBadge, MetaChip, ImagePlaceholder
components/admin/      DataTable, ContentForm, OrderableList, ImageUploadField, StatusSelect
```
Every section component takes typed props from the DTO and renders nothing when its data is
empty or its `HomepageSection.isVisible` is false.

## Tailwind config
Map the tokens in README.md into `theme.extend.colors` (`primary`, `accent`, `success`,
`error`, `surface`, `ink`…) and register the three fonts as `font-display`, `font-sans`,
`font-mono`. Use token classes only — no arbitrary hex in components.

## Accessibility & quality
WCAG AA contrast (already satisfied by the token pairs), semantic landmarks, one `h1` per page,
visible focus rings, keyboard-operable nav and sheet, `aria-current` on the active nav item,
alt text on exam images, metadata + OpenGraph per route, `sitemap.ts` and `robots.ts` covering
public routes only.

## Build order
1. Scaffold Next.js + TypeScript + Tailwind + shadcn/ui; add fonts and tokens.
2. Prisma schema + migration + seed (RUHS Medical Officer 2026, homepage content, one
   announcement, three test series, upcoming exams).
3. `SiteHeader` / `SiteFooter` / `Container` and the public layout.
4. Homepage sections against the DTO, top to bottom, matching `Homepage.dc.html`.
5. `/exams`, `/exams/[slug]`, `/test-series`, `/upcoming-exams`, `/pricing`.
6. Student auth + dashboard shell; then admin auth + middleware.
7. Admin Panel CRUD for all 13 content areas, with ordering and visibility.
8. Responsive, a11y and Lighthouse pass.
