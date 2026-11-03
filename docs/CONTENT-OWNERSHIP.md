# Content Ownership vs. Membership

Six ideas about a question are **separate**. Code that mixes them up caused
the 2026-09 RUHS PYQ inflation (RUHS MO 2024 grew from 100 to 443
questions). Each concept has one owner field or table. Nothing may infer one
of them from another.

| Concept | Stored as | Set by | Never inferred from |
|---|---|---|---|
| **Question Bank ownership** (which exam a question belongs to) | `Question.examId` + `code` | Authoring, or a Question Bank import of that exam | Being used in another exam's mock |
| **PYQ ownership** (the historical paper it appeared in) | `Question.previousYearPaperId` (with `source = PYQ` mirroring it) | Explicit paper selection, or a **Question Bank** import of the paper's own exam + year | Exam, year, subject, `source`, or Mock / Test Series / Subject Test / Custom Module membership |
| **Subject classification** | `Question.subjectId` / `topicId` / `subTopicId` (canonical taxonomy, `lib/exam-taxonomy.ts`) | Authoring or import (names map to existing canonical records; the importer never invents taxonomy) | Mock category |
| **Mock membership** (which tests reuse it) | `MockTestQuestion` (`CustomModuleQuestion`, …) | Mock Builder / import attach (`lib/mock-test-questions.ts`) | — and it never writes Question fields |
| **Subject Mock classification** | `MockTest.coverageType = SUBJECT_WISE` + exactly one `coverageSubjectIds` entry (`lib/subject-mocks.ts`) | Admin → Mock → Step 2 "Mock Category" (server enforces one subject) | The questions it contains |
| **Attempt snapshot** (what a student actually sat) | `TestAttemptQuestion.questionSnapshot`, frozen at start | `createAttemptFromQuestions` | Anything later — content fixes never rewrite it |

## Rules

- **PYQ paper = `previousYearPaperId` only.** Every count and list uses
  `lib/pyq-membership.ts`: the student dashboard, the public exam page, the
  admin PYQ pages and `startPreviousYearPaperAttempt`.
- **A Mock Test import never links to a PYQ paper by exam + year**
  (`resolveRow`, with `RunExamContext.mockTarget`). REPLACE from a mock import
  never changes a question's exam, paper, source or year.
- **Cross-exam reuse is reference-only.** A Punjab PYQ added to a RUHS mock
  stays Punjab (`lib/mock-question-bank.ts` search, `lib/mock-test-questions.ts`
  attach). No RUHS count changes.
- **Subject Test and Custom Module** select by `examId + subjectId (+ topic)`.
  The PYQ / Non-PYQ filter uses `Question.source`. Year never makes a non-PYQ
  question a PYQ.
- **Correcting content never rewrites an attempt.** If an IN_PROGRESS attempt
  was frozen from wrong content, set it to `ABANDONED`. Record an AuditLog row
  (e.g. `PYQ_DATA_CORRECTION`) and keep the snapshot and answers. Resume only
  considers IN_PROGRESS, so the next Start is fresh. The attempt pages show
  `AttemptResetNotice`. SUBMITTED attempts are never touched — **except**
  through Retire / Replace (`docs/QUESTION-RETIREMENT.md`, owner-approved
  2026-11-03):
  - D4/D5: every attempt of a test or module whose question set the replacement
    changed is invalidated;
  - D3 (Phase 2 only): an explicitly approved complete paper replacement
    invalidates all attempts of that paper.

  Invalidation is `ABANDONED` + `invalidatedAt`; snapshots, answers and scores
  are still never rewritten.
- **Archived and retired questions are never served**, whatever still links to
  them (`lib/question-servable.ts`). Retired is terminal and read-only.
- **A paper's question number** is `Question.paperQuestionNumber`. It is
  separate from a test position (`MockTestQuestion.order` etc.).

## Regression

`scripts/verify-pyq-membership-isolation.ts` checks membership isolation, the
cross-exam builder and the importer.
`scripts/verify-ruhs-pyq-dermatology.ts` checks real-data paper counts,
Dermatology subject practice, Custom Module source, Subject Mocks and reset
attempts.
