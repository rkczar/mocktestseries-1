# Question Retirement, Replacement and Attempt Reset

Phase 1 of the PYQ paper replacement project (owner-approved 2026-11-03).
Phase 2 (complete paper replacement through the AI Importer) builds on the
same tables and the same apply engine.

## Archived vs retired

| State | How it is set | Served to students? | Reversible | Resets attempts? |
|---|---|---|---|---|
| ARCHIVED | Question Bank Archive / Delete (a referenced question is archived instead of deleted) | **Never** — in any test type | Yes (publish again) | No |
| RETIRED (`retiredAt` set, always ARCHIVED — DB CHECK) | Admin → Question → **Retire / Replace**, or `scripts/retire-questions.ts` | **Never** | Only by rolling back its replacement record | Yes (policies below) |

A membership row (`MockTestQuestion`, `CustomModuleQuestion`,
`GrandTestQuestion`, `LiveTestQuestion`, `Question.previousYearPaperId`) is
never a reason to serve a question on its own.

## Serving guard

`lib/question-servable.ts` — `SERVABLE_QUESTION_WHERE = { status: PUBLISHED, retiredAt: null }`
is used by every start path in `lib/test-attempt.ts` (Mock, PYQ, admin /
student / shared Custom Module, Grand, Live) and by `lib/question-selection.ts`
(Subject Test, Custom Module builder). `createAttemptFromQuestions` re-checks the
final set inside its transaction (`SELECT … FOR SHARE`): a start racing a
retirement is refused ("This test was just updated") instead of freezing old
content. Before Phase 1, Custom Module, Grand and Live starts had **no** status
filter, so archived questions were still served there.

Retired questions are read-only: never published (`RETIRED` publish block in
`lib/question-publish-policy.ts`), never edited, never set to Draft, never
deleted, never matched as an import duplicate (skip / replace) and never
attachable to a test.

## Retire / Replace (one operation)

`lib/question-replacement/{plan,apply,rollback}.ts`. Admin UI:
`/admin/questions/[id]/replace` (preview: Question Bank manage; apply and
rollback: Master Admin). History and rollback: `/admin/questions/replacements`.

1. **Plan** (read-only, also rebuilt inside the apply transaction). It validates
   that the replacement exists, belongs to the same exam, is not an AI variant,
   is not already in another paper and passes the publish policy. It then lists
   every reference and every attempt in scope, plus a structural hash. Apply
   refuses if the hash changed since the preview.
2. **Apply**: one transaction under a global advisory lock:
   - publish the replacement and give it the old question's paper, source, year
     and paper number;
   - retire the old question and its AI variants (D7);
   - swap every test / module row **in place** (same `order`, so Q64 stays Q64;
     duration and count are unchanged);
   - HOLD admin containers that lost a question with no usable replacement
     (P1-E): Mock → DRAFT, admin module → INACTIVE, Grand → DRAFT, Live → DRAFT.
     The prior status is recorded. Publishing a held test/module is refused
     while it still contains a retired question;
   - SKIP the row in student modules (the guard leaves it out);
   - invalidate attempts, exclude answers from statistics, and write the audit
     record + AuditLog.

   A second idempotent sweep runs after commit.
3. **Rollback** restores everything from the record: questions, variants,
   replacement fields, swapped rows (only where they still hold the
   replacement), held containers (only while still held), attempt statuses and
   answer exclusions. It is refused once a later change retired the replacement.

## Attempt reset policy (owner decisions)

| Where the question was | Attempts reset | Decision |
|---|---|---|
| Admin Mock Test / Grand / Live whose question set changed | **All** IN_PROGRESS + SUBMITTED attempts of that test | D4 |
| Student-created module whose question set changed | **All** attempts of that module | D5 |
| Admin Custom Module whose question set changed | All attempts of that module | D4 (same rule) |
| PYQ paper (single-question replace) | IN_PROGRESS attempts holding it are closed; **SUBMITTED kept** | P1-D |
| Subject Test | IN_PROGRESS attempts holding it are closed; SUBMITTED kept | D6 |
| Any kept attempt | Its answers on the retired question leave student statistics | D6 |
| Anything not containing the question | **Nothing** | — |

Ordinary Mock Builder edits (add / remove / reorder) never reset attempts. The
builder shows a warning with the attempt count (P1-A).

Full-paper replacement (Phase 2, D3) will reset **all** attempts of the
replaced paper. That is the only exception to `docs/CONTENT-OWNERSHIP.md`'s
"SUBMITTED attempts are never changed" rule, and it applies only to an
explicitly approved complete paper replacement.

**Invalidated attempt** = `status ABANDONED` + `invalidatedAt`,
`invalidationReason`, `invalidatedByReplacementId`, `statusBeforeInvalidation`.
The DB CHECK `invalidatedAt IS NULL OR status = 'ABANDONED'` prevents
reactivation. Score, snapshot and answers are kept for audit.

Students never see invalidated attempts:
- they are gone from History;
- the test / module / PYQ card shows Not Attempted, with no Resume;
- they are excluded from scores, averages and analytics charts;
- they are excluded from leaderboards. The leaderboard "answer-exposing earlier
  attempt" rule ignores them too (D9);
- old links show "This attempt was reset", and Start gives a fresh attempt.

Answers carry `statsExcludedAt`, which accuracy, questions practised, today's
answers and weak topics all filter on.

Saved Questions hides a retired question. The bookmark row is kept, and
bookmarks are not moved to the replacement (D8 — owner decision pending).

## Open sessions

Save, reveal, heartbeat and submit all check the attempt on the server. A reset
attempt answers with the engine code `RESET`. The player stops its save queue,
clears that attempt's unsent answers from sessionStorage and goes to the reset
notice. A stale submit never grades it.

Caches:
- no Redis;
- the service worker is network-only for `/student/attempt`, `/api` and `/admin`;
- Apply / Rollback expire the `exam-pyq-insights`, `exam-pyq-analysis-meta`
  and `homepage-statistics` tags and revalidate the admin, student dashboard
  and public PYQ paths. Script runs leave those caches to expire on their own
  TTL (at most 1 h), because a script has no Next.js cache context.

## PYQ paper order

`Question.paperQuestionNumber` is the printed number. It is separate from any
test position. The PYQ attempt and the admin paper page order by it, then by
`createdAt, code`. Bulk / AI imports into a paper record it (numeric
`questionNumber` only). `scripts/backfill-paper-question-numbers.ts` fills
existing papers.

## Dependency view

`lib/question-dependencies.ts`:
- `/admin/exams/previous-year-papers/[paperId]/dependencies` (+ CSV via
  `/api/admin/questions/dependencies?paperId=`);
- the dependency card on `/admin/questions/[id]/replace`;
- "Uses" in the Question Bank list.

## Scripts (production data operations; every write needs a dry-run hash)

```bash
# OP-1 read-only module audit
NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit-module-dependencies.ts --exam RUHSMO --out <dir>
# OP-2 paper numbers
NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-paper-question-numbers.ts --dry-run
NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-paper-question-numbers.ts --apply --confirm <hash>
NODE_OPTIONS=--conditions=react-server npx tsx scripts/backfill-paper-question-numbers.ts --revert --apply
# OP-3 retire (same engine as the admin action) + rollback
NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts --paper <id> --status ARCHIVED --reason "<why>" --dry-run
NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts --paper <id> --status ARCHIVED --reason "<why>" --apply --confirm <hash>
NODE_OPTIONS=--conditions=react-server npx tsx scripts/retire-questions.ts rollback --replacement <id> --apply
```

## Regression

`scripts/verify-question-safety.ts` (server, scratch DB only) and
`scripts/verify-question-safety-ui.mjs` (browser). Run both together with the
test-engine regressions in `ops/TEST-ENGINE.md`.
