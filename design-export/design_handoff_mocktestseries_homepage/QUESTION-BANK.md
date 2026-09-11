# Question Bank — Production Specification

Source: `question-bank-data.js` — note its own header comment: "the parsing/validation/storage
here is REAL and runs entirely client-side... every step (parse → validate → store → filter by
exam) genuinely executes, nothing is faked" — this file is the strongest piece of *logic* (not
UI) in the whole prototype to port almost directly into a server-side import pipeline.

## Hierarchy
```
Exam → Exam Year → Subject → Topic → SubTopic → Question
```
Exam Year is the **paper**: there is no separate Paper entity. A question's `paperYear` field
(resolved from the row's `ExamYear` column) is both the year and the paper identity used
throughout Custom Module and Previous-Year-Papers.

## Question fields (from the real record shape built by `import()`)
`id, code, examId, examName, paperYear, questionNumber, subject, topic, subtopic, question,
optionA, optionB, optionC, optionD, correctAnswer (A–D), explanation, source, difficulty,
status (Published/Draft), createdBy, createdAt`. AI fields are layered on top via a **separate**
store keyed by question id (see AI-SYSTEM.md) — explanation/variant generation is not stored
inline on the question row itself, by design (keeps AI content reusable/regenerable
independently of the question record).

## Question code
Format: `{ShortCode}-{Year}-{4-digit-seq}`, e.g. `RUHS-MO-2024-Q0014`-style (prototype's exact
seed uses a slightly different scheme; the generator function is `shortCode(examName) + "-" +
year + "-" + padded sequence`). Must be unique per exam+year; duplicate detection keys off
(Exam, Exam Year, Question Number) OR explicit Question Code, whichever is present.

## Bulk import — CSV and XLSX
- Template headers (admin-configurable subset, required ones always included):
  `QuestionNumber, QuestionCode, ExamYear, Subject, Topic, SubTopic, Question, OptionA,
  OptionB, OptionC, OptionD, CorrectAnswer, Explanation, Source, Difficulty, Status`.
- **Required per row**: ExamYear, Subject, Topic, Question, OptionA–D, CorrectAnswer.
- Header aliasing: a real alias map normalizes common variants ("Q.No", "Opt A", "Correct
  Answer", etc.) to canonical headers — keep this in the server-side parser, it materially
  reduces admin friction on real-world spreadsheets.
- **Exam Year is required per row**, must be a 4-digit year 1990–2035, and a single file may
  legitimately span multiple years (each row resolves its own year).
- CorrectAnswer must be one of A/B/C/D.
- **Duplicate handling**: duplicate Question Code or (Exam+Year+Question Number) is flagged, not
  silently imported; admin chooses **Replace** (same id, same code, historical refs stay valid)
  or **Add Anyway** (new row, code suffixed `-DUP1`, `-DUP2`...). Within-file duplicates are
  also caught (two rows in the same upload sharing a code/number for the same year).
- Validation output distinguishes **invalid** (missing/malformed fields — rejected outright) from
  **duplicate** (structurally valid but colliding with existing data — needs a policy decision)
  — preserve this three-way split (valid / invalid / duplicate) in the real import UI, it maps
  well to a clear preview screen.
- **Import history log**: file name, hash (cheap collision check so the same file isn't
  re-imported unnoticed), counts (imported/replaced/added-anyway), admin, timestamp — keep as an
  audit trail table.
- Template download: CSV always available; XLSX via SheetJS in-browser in the prototype — in
  production this can be generated server-side or still client-side (no security concern, it's
  just a blank template).

## Filtering & sorting (admin Question Bank list view)
By Exam, Exam Year, Subject, Topic, SubTopic, Source, Status, Teacher/created-by, Date added —
all of these are real fields on the record above, so this is a straightforward indexed-query
concern in Postgres (composite index on examId+paperYear+subject+topic recommended given how
heavily Custom Module and the Old-Test-Series screen filter on exactly these).

## Draft/Published status
`status` field already exists (Published/Draft). Only `Published` questions are eligible for
Custom Module pools and Old-Test-Series papers (`CustomModules.getEligibleQuestions` filters
`q.status !== "Published"` out) — enforce the same filter server-side.

## Custom Module (subject-scoped practice) — reads the bank live
`custom-module-data.js`'s subjects/counts are **derived live** from the Question Bank per exam,
never a hand-typed catalog — this fixed a real prototype bug where a hardcoded practice-set list
silently went stale. Preserve "derive from source of truth" as a hard rule for whoever builds
this: Custom Module must never cache/duplicate its own subject list.
Admin only controls per-subject **availability** (enable/disable) for Custom Module — never
subject naming/creation.
Attempt lifecycle: eligible pool computed from (enabled subjects ∩ requested filters ∩
Published-only) → shuffled → capped at requested-vs-available → **frozen** into the attempt
(`questions` snapshot, never regenerated) → submitted with per-question correctness → scored.
Timed mode is fixed at 1 minute per selected question, decided once at creation, not the exam's
own default duration.
