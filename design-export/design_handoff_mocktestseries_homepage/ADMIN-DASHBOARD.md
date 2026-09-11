# Admin Dashboard — Production Specification

Source: `Admin-Dashboard.dc.html` (design reference only, not production code — it is a
single client-side prototype using localStorage; the real app is Next.js server + Postgres).

## Shell
- Sticky header (68px), hamburger toggles a 264px left sidebar (collapsible, persisted in
  component state only — production should persist per-admin in a UI-prefs table or just
  client state).
- Sidebar: grouped nav list, "Admin panel" mono label, active item highlighted. Sections map
  1:1 to the modules below.
- Day / Night / Eye-protection mode toggle is available in the header (shared with the rest of
  the site — see APPEARANCE.md) but the **admin panel uses its own color namespace**
  (`--admin-*` CSS vars) independent from the public/student frontend palette, so changing
  student-facing colors in Appearance never restyles the admin panel.
- Many modules not yet fully designed render as a **"Module scaffold"** placeholder (mono
  "Module scaffold" label + generic CRUD action chips) — these are explicitly unbuilt UI, not
  just unbuilt backend. Treat scaffolded modules as "needs its own design pass," not just data
  wiring.

## Global UI conventions across modules
- List views: search input, filter dropdowns/chips, sortable table, pagination.
- Row actions: edit (opens modal or side panel), publish/unpublish toggle, duplicate, delete
  (confirm dialog), status badges (Published/Draft/Active/Coming Soon/Archived).
- Empty state: dashed-border panel with a short explanation, never a bare blank area.
- Bulk actions where relevant (Question Bank: bulk publish, bulk delete).
- All admin destructive actions (delete, replace-on-import, restore backup) require an explicit
  confirm step.

## Modules

### Dashboard (home)
Overview cards/stats (site-wide counts), quick links into the heaviest-traffic modules
(Question Bank, Students, AI). Numbers must be computed from real data — see DATA MAPPING.

### Exams
CRUD for the `Exam` entity (title, description, icon/image, status ACTIVE/COMING_SOON/ARCHIVED,
featured flag, order, price, short code). Mirrors `exams-data.js` (`ExamsData.getCurrentExams`,
`setCurrentPrice`, `setShortCode`) and the Upcoming Exams list (`getUpcoming`,
`addUpcoming`, `updateUpcoming`, `reorderUpcoming`, enable/disable/archive).
Adding an exam must require zero code changes elsewhere (per ARCHITECTURE.md rule #2).

### Exam Years
Per-exam year list. **Important architecture note from the prototype**: there is no separate
"Paper" entity — a resolved `ExamYear` value on a question IS the paper/year grouping (see
Question Bank + Previous-Year-Papers). Keep this 1:1 mapping in the real schema unless a real
requirement needs multiple papers per year.

### Subjects / Topics
Not separate CRUD tables in the prototype — subject/topic values are derived live from
whatever exists in the Question Bank (`QuestionBank.getSubjects`, `getTopics`), so a new
subject appears automatically the moment a question using it is imported. Custom Module admin
screen only controls **per-subject availability** (enable/disable), never subject naming.
Decide in the real app whether Subject/Topic become first-class lookup tables (recommended, for
validation + consistent casing) while preserving this "derived, not hand-typed" UX.

### Questions / Question Bank
See QUESTION-BANK.md for the full spec — code, exam, exam year, subject, topic, subtopic,
options, correct answer, explanation, source, difficulty, status, created by/at.

### Bulk Import
See QUESTION-BANK.md — CSV and XLSX (SheetJS-parsed in-browser in the prototype), per-row
validation, duplicate detection by (Exam + Exam Year + Question Number/Code), replace vs.
add-anyway policy, downloadable/admin-configurable template columns, import history log.

### Tests / Mock Tests
CRUD for Full Mock Test definitions: name, exam, total questions, duration, negative marking,
status (active/draft), published flag, instructions, resumable flag. Mirrors
`admin-test-data.js` (`AdminTests`). Only `published && status === "active"` tests are ever
visible to students — enforce this filter server-side, not just in the admin UI.

### Live Tests
Not present as a distinct concept in the current design — no scheduled/synchronous "live test"
screen exists yet. Flag as ❌ missing if the business needs real-time proctored/synchronized
tests; otherwise "Mock Tests" (self-paced, admin-published) covers the current scope.

### Students
Student list/search/detail is implied by the Website Diagram's student-management need but has
no dedicated built screen in this design — currently only the Student's own profile/stats
exist (`student-data.js`), viewable by the student, not an admin list-of-all-students table.
Needs real design + build: list, search/filter, detail (profile + test history + AI usage),
suspend/reactivate.

### Teachers
Referenced as a "created by" attribution field on questions (`createdBy`) and as a Grow-With-Us
category ("As a Teacher" / "As a Question Bank Reviewer"), but there is no Teacher entity, login,
or teacher-facing screen designed. Needs its own design if the business wants teacher accounts
rather than all content attributed to "Master Admin".

### Roles & Permissions
The prototype has a single implicit "Master Admin" role (hardcoded string used as the
`adminName`/`createdBy` value everywhere). No role model, no permission matrix, no admin login
screen exists. ARCHITECTURE.md specifies `AdminRole` enum (ADMIN / SUPER_ADMIN) in the Prisma
schema as the intended real model — build the UI to manage it from scratch.

### AI Solution Manager
See AI-SYSTEM.md. Settings screen maps to `ai-data.js` `AI.getSettings`/`updateSettings`:
enabled toggle, model name, max variants (hard-capped at 5, not admin-raisable), caching toggle,
temperature, max output tokens, retry count, timeout, prompt templates for explanation and
similar-question generation. Admin AI Analytics: total requests/responses/API calls, cache hit
rate, unique questions, per-student and per-question breakdowns, error log — all computed from
the (currently client-side, must move server-side) usage log.

### Question Queries
The in-test "Report Question" flow (see TEST-PLAYER.md) needs an admin inbox to triage reported
questions (reason, comment, question ref, reporting student, status). Not a built admin screen
in this design yet — currently reports only produce a client-side toast; there is no queue.
Site-wide "Messages" inbox (`site-config.js` `Messages`) DOES exist and handles Grow-With-Us,
Contact-Us, and general categories, but "Question Issue"/"Test Issue" categories in that same
inbox are the closest existing analog — decide whether Question Queries is its own module or
folds into Messages filtered by category.

### Reports
No dedicated cross-cutting "Reports" module beyond AI Analytics and per-exam Custom Module
analytics (`CustomModules.getExamAnalytics`: total attempts, unique students, completed
attempts, average score, recent activity). Needs scope clarification with the business —
student performance reports, revenue reports, content reports are all plausible and none are
built.

### Payments
No payment UI, no Payment/Transaction entity, no gateway integration exists in the design.
`api-management-data.js` lists Razorpay as a configurable integration (key ID, environment
Test/Live) but this is admin *configuration* UI only — there is no checkout flow, pricing page
wiring, or webhook handling anywhere in the prototype. Exam `price` fields exist
(`exams-data.js`) but nothing currently gates access on payment. Full payments flow is ❌
missing and needs its own design + build.

### Website Configuration
Maps to `site-config.js`: announcement bar (enabled, tag, text, link), header nav items
(label/route/enabled), footer sections/links/contact info, legal content (About/Privacy/Terms —
Markdown-ish text blocks with lastUpdated), and a Pages Registry (per-route enable/disable).
Publish/Draft split already modeled (`getDraft`/`saveDraft`/`publish`/`discardDraft`,
`isDirty` for unsaved-changes detection) — preserve this draft→publish pattern in production
(cache-tag revalidation on publish, per ARCHITECTURE.md).

### Appearance
See APPEARANCE.md.

### Website Diagram
See WEBSITE-DIAGRAM.md. Already has real prototype data: an internal array of
`[id, label, route, x, y, status, sourceFile, note, connections[]]` tuples describing every
known page, its build status (working/missing), the .dc.html it maps to, and its outgoing
links — this is a genuinely useful artifact to carry into the real app's route/nav map.

## Admin permissions
Not modeled at all in the prototype (everything is "Master Admin"). Production must enforce
per-role permissions server-side on every mutation, not just hide/show UI.

## Responsive behavior
Sidebar should collapse to an overlay/drawer below ~900px; tables need horizontal scroll or a
stacked card view on mobile; modals must fit small viewports without overlapping the header.
The current design targets desktop admin use primarily — verify/adjust breakpoints during
build rather than assuming full mobile parity was designed.
