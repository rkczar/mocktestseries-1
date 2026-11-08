# Teacher Portal — Phase A

Approved by the owner on 2026-11-08 (decisions 1–4 in
`/root/mts-evidence/teacher-portal-audit-20261108/PHASE-A-REVISED.md`). Phase A
gives teachers content management inside their **assigned exams**. Publishing,
permanent deletion, restoration and every approval stay with the **Master
Admin**. Commission, payment attribution and teacher analytics are later phases
and are not part of this.

## Who is a teacher

A teacher is an `AdminUser` with role `TEACHER`, an `ACTIVE` `TeacherProfile`
and at least one active `TeacherExamAssignment`.

- Teachers sign in at `/admin/login` and are sent to `/teacher`.
- They can never open `/admin`, `/api/admin` or `/storage/test-resources`:
  - `lib/rbac.ts#getAdminSession` returns `null` for a teacher. Every admin
    page, Server Action and API reads the session there.
  - `proxy.ts` also redirects teachers early, or returns 403 on the API.
- The TEACHER role holds one key only: `TEACHER_PORTAL`. The old global
  `EXAMS_MANAGE` + `QUESTIONS_MANAGE` + `SEO_INTEL_VIEW` grant is gone.
- **Scope:** `lib/teacher/scope.ts` defines it as the exams of active
  assignments, re-read on every request. Suspend, deactivate or revoke takes
  effect on the teacher's next request. An id outside the scope is reported as
  *not found*.
- **Management:** Admin → Users & Access → Teachers. Changes need
  `TEACHERS_MANAGE`, which only the Master Admin holds.

## What a teacher can do (assigned exams only)

| Action | Effect |
|---|---|
| View questions, options, answer key, explanation | read-only |
| Create a question | always **DRAFT**, `Question.createdByAdminId` = author |
| Edit a DRAFT question | written directly (Drafts are never served) — any teacher of the exam |
| Edit a PUBLISHED question | saved as a **QuestionRevision**; the live question is unchanged until approved |
| Submit a Draft for publication / submit a revision | request with a mandatory reason |
| Unpublish a question from a **Mock Test** (not Live CBT) | immediate, per test, future attempts only; Master Admin notified |
| Unpublish from Live CBT / Grand Test / Live Test / PYQ paper | request only |
| Request a restore / permanent deletion | request only |
| Withdraw own open request | yes (not an already-applied unpublish) |

A teacher can't publish anything, delete anything, add questions to tests,
upload images, or use Bulk Import, AI Importer, Payments, Backup, Users or
Settings.

## Draft vs Unpublish

- **Draft** is `Question.status = DRAFT`.
  - It is never served (`lib/question-servable.ts`).
  - The Mock Test builder refuses non-published questions (`attachableIds`).
  - Publishing a Mock Test is refused while it contains a Draft.
  - A Standard bulk import never attaches a Draft to an already **published**
    Mock Test.
- **Unpublish** sets `MockTestQuestion.excludedAt/By/Reason` on one test row.
  - `SERVABLE_MOCK_MEMBERSHIP_WHERE` skips that row for **new** attempts only.
  - Started and finished attempts keep their frozen `questionSnapshot`, so
    answers, scores and results never change.
  - The question itself stays PUBLISHED, and every other test — in the same
    exam or another exam — is unaffected.
  - The builder's add, remove, reorder and replace keep the exclusion
    (`writeAssignment`).
  - The last servable question of a published test can't be unpublished.

## Concurrent editing

- **Version check on every save.** The editor posts the version it was opened
  from (`baseVersion`, from `lib/teacher/content.ts#editVersion`):
  - a DRAFT question → its `updatedAt`;
  - a PUBLISHED question → the open revision's `updatedAt`, or `none` when no
    revision is open.
- **Serialized saves.** A save locks the question row (`SELECT … FOR UPDATE`)
  and is refused if the version changed. The second editor gets "Someone else
  changed this question…" and nothing is overwritten.
- **Save vs submit.** Submitting a Draft for publication takes the same lock,
  so a save and a submission never interleave.
- **One decision only.** Approve and reject move the request OPEN → decided
  in one conditional update.

## Revisions

- **One open revision per question.** It is shared by every teacher of the
  exam, with `authorId` and `lastEditedById` recorded. A partial unique index
  enforces it.
- **Stale check.** Approval compares the live content with the revision's
  `baseSnapshot`.
  - If anyone changed the question in the meantime, approval is refused. The
    revision becomes STALE and nothing changes.
  - Otherwise the proposal is written in one transaction and must pass the
    publishing policy, or the whole approval rolls back.
- **History.** `QuestionRevision` rows plus `AuditLog`
  (`TEACHER_*`, `QUESTION_UPDATED` with `teacherRevisionId`).

## Teacher Content Approvals queue

Admin → Users & Access → Teachers → Content Approvals
(`/admin/users/teachers/approvals`). The dashboard's "Action required" panel
also shows it.

- **Who:** FULL_ADMIN can view; only the MASTER_ADMIN decides.
- **Each item shows:**
  - teacher, exam, test or paper;
  - the reason;
  - a before/after table (revisions);
  - usage and attempt counts;
  - the impact of an unpublish, including the ranking note;
  - the full history.

| Type | Approve | Reject |
|---|---|---|
| PUBLISH_QUESTION | publish (publishing policy) | stays Draft |
| REVISION | apply if not stale | revision REJECTED |
| UNPUBLISH_NOTICE | keep unpublished | **Restore** (clears the exclusion) |
| UNPUBLISH_REQUEST | Mock/Live CBT: unpublish now; Grand/Live Test/PYQ: decision recorded* | nothing |
| RESTORE_REQUEST | clear the exclusion | nothing |
| DELETE_REQUEST | decision recorded; execute with **Retire / Replace** | nothing |

\* Grand Tests, Live Tests and PYQ papers have no per-test exclusion in
Phase A. The Master Admin applies an approved change with Retire / Replace.
Adding exclusion columns for those tables is a separate change that needs
approval.

No email is sent. "Notification" means the queue and the dashboard counter.

### Request status shown everywhere (queue, request page, teacher pages)

Derived from the current question and test state on every view
(`lib/teacher/request-status.ts`); no stored flag that could drift.

| Status | Meaning |
|---|---|
| Pending | waiting for the Master Admin |
| Approved — action not yet applied | deletion, or a Grand Test / Live Test / PYQ unpublish, approved but not yet carried out with Retire / Replace |
| Applied | the change is in effect: applied by the approval itself, or the question is now retired or deleted, or no longer in that test / paper |
| Rejected / Withdrawn | nothing changed |

- **Retire / Replace link.** Deletion and non-Mock unpublish requests link
  straight to the Retire / Replace preview for the question
  (`/admin/questions/<id>/replace`).
- **Queue tab.** The "Approved — action not yet applied" tab lists what is
  still to do.
- **Live CBT.** An approved Live CBT unpublish is applied in the approval
  transaction, so it shows as Applied.

## Images

- **Public by design (unchanged).** Question images are served by nginx from
  shared storage under unguessable names (UUID, or the SHA-256 of the
  content), with no directory listing. Students load them during tests.
- **What a teacher sees.** Teachers get no admin image API (`/api/admin/*`
  returns 403). Teacher pages render only images of questions in their
  scope.
- **No new images.** A teacher can keep or remove an existing image but never
  set an image URL the question doesn't already have. This blocks reusing
  another exam's image.
- **Removing an image** clears only that question's reference. Files are never
  deleted. Other questions using the same file, and attempts whose snapshots
  contain it, are unaffected.
- **Revisions** change only `imageUrl` fields. Rich-media `QuestionAsset` rows
  are never touched.

## Database (migration `20261109000000_teacher_portal_phase_a`)

The migration is additive only:

- **New enums:** TeacherStatus, QuestionRevisionStatus, TeacherRequestType,
  TeacherRequestStatus.
- **New tables:** TeacherProfile, TeacherExamAssignment, QuestionRevision,
  TeacherContentRequest.
- **New nullable columns:**
  - `Question.createdByAdminId`
  - `MockTestQuestion.excludedAt` / `excludedById` / `excludedReason`
- **Partial unique indexes:**
  - one active assignment per teacher + exam
  - one open revision per question
- **CHECKs:**
  - a request reason has at least 5 non-blank characters (the app requires 10)
  - an exclusion always records who and why

No existing row is rewritten and no existing enum gains a value. The deploy
needs `APPLY_MIGRATIONS=1`.

## Rollback

The previous release ignores every new table and column, so a code rollback
is a normal `atomic_switch` to the previous release. **One behavioural
catch:** the old code does not know `excludedAt`, so questions unpublished
by teachers would be **served again** after a rollback. Before rolling back,
list them and decide:

```sql
SELECT mt.title, q.code, mtq."excludedAt", mtq."excludedReason"
FROM "MockTestQuestion" mtq JOIN "MockTest" mt ON mt.id = mtq."mockTestId" JOIN "Question" q ON q.id = mtq."questionId"
WHERE mtq."excludedAt" IS NOT NULL ORDER BY mtq."excludedAt";
```

If a listed question must stay hidden after the rollback, remove it from that
test in the old builder, or retire it.

**Deactivate every teacher before rolling back** (Teachers → Deactivate, which
sets `AdminUser.isActive = false`). The old code doesn't know
`TeacherProfile`, so a teacher who is only *suspended* would get the old,
unsafe TEACHER role back: global `EXAMS_MANAGE` + `QUESTIONS_MANAGE` and the
whole admin area. Only `isActive = false` locks them out on the old release.

```sql
SELECT u.username, u."isActive", p.status FROM "AdminUser" u JOIN "Role" r ON r.id = u."roleId"
LEFT JOIN "TeacherProfile" p ON p."adminUserId" = u.id WHERE r.name = 'TEACHER';
```

Dropping the schema is never needed for a rollback. If it is ever wanted, it is
a separate, reviewed migration.

## Tests

- `scripts/verify-teacher-portal.ts` — scratch `mts_*` database, synthetic
  data, 130 checks.
- `scripts/verify-teacher-portal-final.ts` — 58 checks:
  - concurrency;
  - images;
  - access invalidation;
  - unpublish vs marks, accuracy, counts, leaderboard and Overall Rank;
  - retire + rollback;
  - request statuses.
- `scripts/teacher-portal-http-fixture.ts` + `verify-teacher-portal-http.mjs` —
  59 browser/HTTP checks:
  - role crawl of every admin page and API;
  - forged Server Action calls;
  - two-browser conflict;
  - live session invalidation;
  - status labels and the Retire / Replace link.
- Focused regressions: `verify-test-engine-core`, `verify-question-safety`,
  `verify-mock-bulk-import`, `verify-live-cbt`, `verify-payments`,
  `verify-platform-controls`, and the site crawl.
