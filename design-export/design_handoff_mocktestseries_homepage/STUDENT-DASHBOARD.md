# Student Dashboard — Production Specification

Source: `Student-Dashboard.dc.html` + `student-data.js`. Overview-only by design: "Detailed
information lives on its own page, so this dashboard stays an overview."

## Layout
Shared `Site-Header`/`Site-Footer` (see NAVIGATION.md), no back button on the dashboard itself
(it is the root of the student area). Sections top to bottom:

1. **Greeting/eyebrow row** with a link to Custom Module.
2. **Stat cards grid** (auto-fit, min 200px): Questions Attempted (all-time), MCQs Attempted
   Today (vs. a daily target, with a remaining-count hint line), Tests Completed (all-time +
   today), Study Streak (current + longest), Accuracy %, Saved Questions count, Mistake
   Questions count. All sourced from `StudentData.getStatistics()` — see student-data.js's
   real field list; nothing here is decorative/fake.
3. **Practice section** (`#practice`): entry cards into Full Mock Tests, Previous Year Papers
   (Old Test Series), Subject-wise practice — these are navigation cards, not data tables.
4. **Custom Module panel** (`#custom`): subject/count/mode/pool pickers reading live from the
   Question Bank via `CustomModules` (see QUESTION-BANK.md); a hint line surfaces a
   just-in-time summary ("N Q · subjects · mode"); a note links out to admin-built modules.
5. **Detail links section**: cards to Analysis, Test History, Saved Questions & mistake
   notebook, Candidate Profile — each shows a one-line live preview (e.g. "Accuracy 68% · Top
   22%", "23 tests completed", "37 saved · 64 mistakes").

## Student actions / transitions
- Any stat card or detail-link card navigates to its dedicated page (Analysis, Test History,
  Saved Questions, Profile) — dashboard itself holds no drill-down interactions.
- Practice cards launch a mode-selection flow that ends in Test-Player.
- Custom Module panel builds a filtered question pool and starts a frozen attempt (see
  QUESTION-BANK.md's attempt lifecycle) before handing off to Test-Player.

## Separation from Admin
Confirmed cleanly separated in the design: no admin-only affordance appears anywhere in the
student shell; student pages read from student-scoped stores only (`StudentData`,
`CustomModules` attempt lookups scoped by studentId). Production must mirror this with
genuinely separate session cookies/auth stacks per ARCHITECTURE.md's rule #3 — the design gives
no reason to deviate from that plan.

## Data model note
`student-data.js` is candid that it "Mirrors the intended production shape" — one
`StudentProfile` row + a `statistics` aggregate updated transactionally on test submission,
with a documented recovery function (`recalculateStudentStatistics`) that rebuilds aggregates
from full history. Carry this "aggregate + recompute-from-source-of-truth" pattern into Prisma:
don't trust a running counter alone — keep the ability to rebuild it from `TestAttempt` rows.
