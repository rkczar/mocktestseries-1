# Results & Analysis — Production Specification

Source: `Student-Analysis.dc.html`, `Test-Player.dc.html` (review/result state),
`Student-Test-History.dc.html`, `student-data.js`.

## Relationship
```
Test Attempt (Test-Player submit)
  → Result (score, accuracy, correct/incorrect/skipped, time taken)
  → Question-wise Analysis (per-question correctness, review list in Test-Player's review mode)
  → AI Explanation (per question, cached — see AI-SYSTEM.md)
  → Weak Topics (aggregated from subject/topic accuracy across attempts, surfaced on Analysis
     page and referenced from the Dashboard hint line: "Pharmacology is your weakest subject")
  → Practice Again (Saved Questions / mistake notebook feeds back into a new Custom Module
     attempt scoped to those questions)
```

## Analysis page content
- Header metrics row: Accuracy %, Avg. time/question, Unattempted %, Percentile (e.g. "Top
  22%" — **percentile is currently a hardcoded design placeholder, not computed**; production
  needs a real cohort-percentile calculation or this must be removed/clarified with the
  business before launch).
- **Subject mastery** list: per-subject percentage bars, color-coded (green = strong). Currently
  derived from design-time sample data in the .dc.html, not from `student-data.js`'s real
  per-subject breakdown — production must compute this from actual per-subject correct/attempted
  counts across the student's `TestAttempt`/`QuestionAttempt` history.
- Empty/low-data state: an error-tinted panel pointing to Saved Questions and Test History when
  there isn't enough attempt history yet to analyze.

## Test History
Per-attempt row: test name, exam, date, total/attempted/correct/incorrect/skipped, score,
accuracy, time taken (`student-data.js`'s `testHistory` array — every field listed there is
real and must be persisted, not fabricated). Each row links to its own result page.

## Score computation ownership
`StudentData.recordTestCompletion` shows the intended aggregate-update transaction shape:
increments totals, recomputes accuracy, updates rolling average score, touches the study-streak
counter — idempotent per test id. Recreate this as a single DB transaction on submit in
production (Prisma), not as separate unguarded writes.

## AI Explanation integration
Per RESULTS-ANALYSIS → AI-SYSTEM: explanation panel triggers **only on student action** ("Ask
AI" / opening the review's AI panel), reuses a cached `AiSolution` row per question if present,
and only calls the model when no cache exists.

## Practice Again
"Weak topics" and the Saved Questions/mistake notebook are the two feeders into a repeat
practice loop, both ultimately creating a new Custom Module attempt scoped to a specific
subject/topic/question-id set (see QUESTION-BANK.md's `CustomModules.createAttempt`). No
separate "Practice Again" button/flow is visible as distinct UI in the current design — it is
implemented as "open Custom Module / Saved Questions and start a new attempt from there."
