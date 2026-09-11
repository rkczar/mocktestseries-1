# Website Wiring Audit — MockTestSeries.in

Date: 08 Sep 2026 · Scope: all design files in this project (public site, student area, test player, admin panel).

**Nothing was deleted.** Existing pages, sections, cards, buttons and copy are preserved. Where a
connection could be made inside the design system it was made; where it needs a real backend it is
listed below as NEEDS WIRING rather than removed.

Classification used: WORKING · WIRED · NEEDS WIRING · BROKEN · MISSING · STATIC · NEEDS REVIEW
Priority: P0 critical · P1 high · P2 medium · P3 low

---

## A. Successfully wired (this project)

| Location | Element | Now does | Class |
|---|---|---|---|
| Homepage | Featured exam card | Opens RUHS-Medical-Officer page | WIRED · P1 |
| Exam page | Every paper card, Attempt paper, Start free mock | Opens Student-Login | WIRED · P1 |
| Student login | student / Student@123 | Validates and opens Student-Dashboard | WORKING · P0 |
| Dashboard | Full Mock Test card | Opens Test-Player | WIRED · P1 |
| Dashboard | Old Test Series card | Opens exam page papers section | WIRED · P2 |
| Dashboard | "Your account" grid | Six dedicated pages (profile, history, analysis, saved, queries, settings) | WIRED · P2 |
| Test player | Answer-mode modal → question → review → result → question-wise review | Full flow with state | WORKING · P0 |
| Test player | Report Question | Query form with auto-captured context, Submit Query / Cancel | WIRED · P1 |
| Test player | WhatsApp Share | Real wa.me share with formatted question | WORKING · P3 |
| Admin | Question Queries table → detail → resolution + status | Row click switches record, save writes reply/note/status | WIRED · P1 |
| Admin | Query question code | Opens All Questions with lookup chip + row highlight | WIRED · P2 |
| Admin | Bulk Import | Exam scope → template CSV download → validation → policy → preview → confirm | WIRED · P1 |
| Admin | Exams list Active toggle | Flips status, summary line and the student-exam-page wiring rows | WIRED · P1 |
| Admin | Exam manage tabs | Per-exam Overview/Settings/Instructions/Subjects/Topics/Syllabus/Cards/Tests/Bank/Page | WIRED · P1 |
| Admin | Students → Deletion Requests | Approve / Reject with 12-hour window message + deleted-account history | WIRED · P1 |
| Admin | Appearance → Colors/Fonts/Buttons | Writes the shared frontend appearance store; every public page reads it | WIRED · P2 |
| All pages | Day / Night / Eye theme button | Shared script, persisted, applies site-wide | WORKING · P3 |
| Admin | Sidebar sub-items (Appearance, Exams, Question Bank, Students) | Select the matching view/tab | WIRED · P3 |

## B. Broken links (exist, destination missing)

| Location | Element | Problem | Suggested destination | Class |
|---|---|---|---|---|
| Student Profile | "Edit profile" button | Student-Edit-Profile page not built yet | Dedicated edit-profile page | BROKEN · P2 |
| Dashboard hero | "Build a practice test" | Still an in-page anchor (#custom) | Dedicated practice/custom-test page | NEEDS REVIEW · P3 |
| Dashboard nav | "Practice" | Still an in-page anchor (#practice) | Dedicated practice page | NEEDS REVIEW · P3 |
| Homepage / exam page | Pricing, Upcoming Exams, Exams (listing) | No pages built | /pricing, /upcoming-exams, /exams | MISSING · P2 |
| Homepage footer | About, Contact, Privacy, Terms | Placeholder hrefs | Static content pages | MISSING · P3 |
| Admin | Website, Tests, Teachers, Analytics, Payments, Communications, SEO, Security, Backup | Scaffold view only | Full modules | NEEDS WIRING · P2 |
| Admin | Add Question, Categories | Not built | Question editor, category manager | MISSING · P2 |
| Test player | Ask AI follow-up field | Non-functional input | Claude API call + cached solution lookup | NEEDS WIRING · P2 |

## C. Missing connections (expected but not present)

- Custom practice test builder generates a summary but does not open a real generated test — needs
  Exam → Subject → Topic → Question query, then hand-off to the test player. **NEEDS WIRING · P1**
- Admin instructions tab content does not yet render on a student entry-direction screen (no such
  page exists). **MISSING · P1**
- Result → detailed analysis link exists on the dashboard, but a per-attempt result page (one route
  per attempt) is not built. **MISSING · P2**
- Student "My queries" statuses are illustrative; they do not read the admin resolution store.
  **NEEDS WIRING · P2**
- Exam ON/OFF does not actually hide the homepage card in the mockups (both are separate files).
  In production this is one query. **NEEDS WIRING · P1**

## D. Static values (candidates for database wiring)

All admin dashboard counters (total students 12,486 · questions 18,240 · attempts 39,517 · revenue
₹4.82L · AI requests 34,118 · cache hit 78%), student stat cards (86 solved today, 23 tests, 18-day
streak, 68% accuracy), exam-page at-a-glance numbers, syllabus card topic/question counts, import
history rows, audit log rows, deletion history, and every table row (questions, students, attempts,
queries, exams) are illustrative values held in the design files. **STATIC · P2** — each maps to a
table already described in `prisma/schema.prisma` (Student, Question, Test, TestAttempt, Exam,
Subject, UpcomingExam, AuditLog, AppearanceSetting, plus new: QuestionQuery, DeletionRequest,
ImportBatch, AiSolution).

## E. Admin-control opportunities not yet connected

1. Homepage hero heading/description, CTA labels, announcement bar — schema exists, admin editor not built. **P1**
2. Upcoming exams list and featured-exam ordering — admin fields defined, no UI yet. **P1**
3. Pricing plans and coupons — schema present, module is a scaffold. **P2**
4. Per-exam instructions publishing to the student entry screen. **P1**
5. Teacher assignment (subjects/exams) and reviewer approval on AI solutions. **P2**
6. Notification/announcement send to all / selected / exam-based students. **P2**
7. SEO fields per page, robots and sitemap toggles. **P3**

## F. Recommended additional connections

- One `getExam(slug)` server function feeding the exam page, homepage card, instructions screen and
  test player, so exam name/time/marking exist in exactly one place.
- `AiSolution` lookup before any model call (cache-first), keyed to the question code — the admin AI
  panel already describes this flow.
- `QuestionQuery` write from the test player, read by both admin queries and student My Queries.
- `DeletionRequest` state machine: pending → approved (12h timer) → deleted, with the student
  dashboard reading its own request state.
- Attempt-scoped routes: `/student/results/[attemptId]` and `/student/analysis/[attemptId]`.

## G. Needs owner review

- Exam mode conflict: public sources describe RUHS MO as computer-based in several cycles; these
  designs say offline OMR per your instruction. Confirm for 2026 before publishing. **P0 for content**
- Previous-year paper list: only 2020, 2022, 2023, 2024 are shown because those dates could be
  sourced. Confirm the full list of cycles.
- Demo login (student / Student@123) must be removed before any public deployment; replace with
  OTP/email verification. **P0**
- Whether the custom test builder should also allow difficulty and question-source filters.
- Whether deleted accounts keep anonymised attempt data for exam analytics (currently stated as yes).
