# Data Mapping — UI to Backend Entities

Format: UI COMPONENT → DATA REQUIRED → DATABASE ENTITY → USER ACTION → EXPECTED RESULT.
Entities reference `design_handoff_mocktestseries_homepage/prisma/schema.prisma` as the
starting point; new entities are called out explicitly where the schema doesn't yet cover them.

## Homepage / public
- Hero, CTA buttons, featured exams, announcement bar, upcoming exams, pricing → `HomepageContent`,
  `CtaButton`, `Exam`, `Announcement`, `UpcomingExam`, `PricingPlan`, `HomepageSection` (all
  already in the starting schema) → Admin edits in Website Configuration → homepage re-renders
  from DB on next request (tag-revalidated).

## Student Dashboard
- Stat cards → `StudentProfile`/`Statistics` aggregate (needs adding to schema; mirror
  `student-data.js`'s exact field list: questionsAttemptedTotal/Today, testsCompletedTotal/
  Today, studyStreak, longestStudyStreak, totalCorrect/Incorrect/Skipped,
  totalTimeSpentSeconds, averageScore, accuracy, savedQuestionsCount, mistakeQuestionsCount,
  aiQuestionsAsked) → student submits a test / attempts a question → aggregate updates in one
  transaction, recomputable from `TestAttempt` history.
- Practice/Custom Module entry cards → live query against `Question` table scoped by exam +
  enabled subjects → student picks filters + count → `TestAttempt` (frozen question set) created.

## Question Bank / Bulk Import
- Question list/filter/sort → `Question` (needs adding: id, code, examId, examYear, subject,
  topic, subtopic, question, optionA-D, correctAnswer, explanation, source, difficulty, status,
  createdById, createdAt) → admin imports CSV/XLSX → server-side parse+validate (port the exact
  validation rules from `question-bank-data.js`) → rows inserted/replaced per duplicate policy
  → `ImportHistory` row logged.

## Custom Module / Previous Year Papers
- Subject availability toggles → new `CustomModuleSubjectConfig` (examId, subject, enabled) →
  admin toggles → Custom Module pool query excludes disabled subjects.
- Attempt creation → `TestAttempt` (id, studentId, examId, subjects[], year, topic, difficulty,
  requested, available, actual, questionIds[] frozen, timed, durationMinutes, status,
  startedAt, submittedAt, result JSON or normalized `QuestionAttempt` rows) → student starts →
  frozen snapshot persists even if the Question Bank later changes.

## Test Player
- Question screen, palette, timer → `TestAttempt` + its frozen question set → student
  answers/marks/navigates → session state (can be client + periodic autosave) → on submit,
  `QuestionAttempt` rows (per-question: selected answer, correctness, time) + `TestAttempt.result`
  written in one transaction.
- Report Question → new `QuestionReport` (questionId, studentId, reason, comment, status,
  createdAt) → student submits → row created → surfaces in Admin's Question Queries.

## AI System
- Ask AI / explanation panel → `AiSolution` (questionId, explanation, optionAnalysis,
  memoryTrick, model, promptVersion, generationStatus, generatedVariants[] as related rows) +
  `AiUsage` log (studentId, questionId, actionType, cacheHit, model, generationStatus,
  timestamp) — both new tables, not yet in the starting schema → student asks → cache check →
  generate-if-missing via server-side model call → cached row served to all future askers.

## Results & Analysis
- Test History rows, Analysis subject-mastery bars → aggregated from `QuestionAttempt`/
  `TestAttempt` rows grouped by subject/topic → no separate materialized table required unless
  performance demands it; compute on read initially.

## Authentication
- Student session → Auth.js Credentials + Google OAuth (per ARCHITECTURE.md), separate
  `StudentUser` table/session cookie from `AdminUser`.
- OTP login → real MSG91 (or equivalent) server-side verification endpoint; **rotate the
  currently-exposed MSG91 token before this is built** (see AUTHENTICATION.md).

## Appearance
- Color/font/button settings → new `AppearanceSetting` table (singleton row or versioned) →
  admin saves → server renders `:root{--frontend-*}` into every page's `<head>`.

## Payments (❌ not designed)
- No UI exists yet to map. Needs its own design pass before a `Payment`/`Transaction` entity
  can be specified with confidence — placeholder only: `Exam.price`/`PricingPlan` already exist
  as the pricing side; the actual checkout/gateway/webhook side is undesigned.
