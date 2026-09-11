# Previous-Year Papers — Production Specification

Source: `Student-Old-Test-Series.dc.html`, `custom-module-data.js`.

## Hierarchy
```
Exam → Exam Year → Previous Year Paper
```
There is **no separate Paper entity** — each Exam Year with at least one eligible (Published,
enabled-subject) question in the bank automatically becomes a selectable paper
(`CustomModules.getPapersByYear`). This must not be modeled as a set of unrelated standalone
"exams" in the real schema or nav — each paper's identity is always Exam + Year, and its
subjects line is derived live from whichever subjects have Published questions for that year.

## Screen flow
1. Year list (button rows), each showing the year, a subject-count summary line, and a visual
   "selected" state.
2. Selecting a year shows a confirmation panel: "{Year} Paper — {N} questions", a note that it
   is timed at exactly 1 minute per question (so duration = question count in minutes — not the
   exam's configured mock-test duration), and a Start button.
3. Start creates a frozen Custom-Module-style attempt (same `createAttempt` mechanism as regular
   Custom Module, with `subjects: []`/"All" so the whole year's paper is included) and hands off
   into Test-Player.
4. Empty state: "No previous year papers are available yet for this exam" when no year has
   eligible questions.

## Do not conflate with "Exams" list
Per the explicit user requirement: previous-year papers must never render as unrelated entries
in the main Exams list — they are a *view* into one exam's Question Bank grouped by year, always
reachable from within that exam's context (Old Test Series screen), not top-level catalog items.

## Result / History
Uses the same attempt → result → Test History pipeline as every other test type (see
RESULTS-ANALYSIS.md) — no separate result/history model needed for previous-year papers.
