# Test Engine Core

> **TEST ENGINE CORE — HIGH RISK SHARED PATH.**
> Changes to option selection, answer persistence, navigation, attempt
> snapshots, timer, submission or answer reveal require the focused
> test-engine regression suite before deployment.

Every attemptable test type (Mock Test, Previous Year Paper, Custom Module,
Subject Test, Grand/Live) runs through one engine and one player:

```
start*Attempt (lib/test-attempt.ts)  → TestAttempt + TestAttemptQuestion (frozen snapshot) + Answer, in ONE transaction
run page (app/student/attempt/[attemptId]/run/page.tsx) → lib/test-player-data.ts#toPlayerQuestions
TestPlayer (…/run/test-player.tsx)   → lib/answer-save-queue.ts → saveAnswerAction / revealAnswerAction / submitAttemptAction
result → review
```

Test types only supply data and configuration. There is no per-type player.

## Setup vs. player vs. policy

- **UniversalTestSetup** (`components/student/universal-test-setup.tsx`) is the
  one pre-test configuration form, used by **Custom Module** and **Subject
  Test**: subject, topic, source, year, difficulty, question count (1 up to
  the eligible pool, never padded), answer mode (exam, instant) and — for
  exam mode only — time (1 min/question default, unlimited, custom). Filters
  never appear inside the running player.
- **Pre-Test Setup** (`components/student/pre-test-setup.tsx`, since
  2026-10-03) is the same choice for a NEW **Mock Test** (hosted on the Mock
  details page) or **Previous Year Paper** (hosted on
  `/student/attempt/resume?paper=`), using the answer-mode-first model below.
  Every
  in-app and public Start for these tests goes through
  `/student/attempt/resume`, which never writes: `previewFormalTestStart` runs
  the start's own gates (entitlement → resume → availability/policy → Platform
  Controls) and either resumes the running attempt untouched or shows the
  setup. The setup posts to `startConfiguredTestAction`. Both setup forms share
  `components/student/test-mode-fields.tsx` and parse through
  `lib/attempt-config.ts#parseAttemptConfigForm`.
- **The one answer-mode-first model** (`lib/attempt-config.ts`, rendered by
  `components/student/test-mode-fields.tsx`, since 2026-10-03):

  | Student choice | Mode | Time | During the attempt |
  |---|---|---|---|
  | Show answers after completing the test (`EXAM`, default) | **Exam Mode** | timed: Mock/PYQ Standard (admin duration, `FIXED`) / 1 min per question / Custom 1–600; Subject/Custom 1 min per question / Unlimited / Custom | normal secure exam: answers editable, no key, no explanation, no Ask AI until Review |
  | Show answer after each question (`INSTANT`) | **Practice Mode** | always `UNLIMITED`: no duration choice, no countdown, no time-based auto-submit | tapping an option commits + locks it on the server; the SAME question then shows Correct/Incorrect, the correct answer and the review tools; no Check Answer button; Next is manual |

  The setup shows the duration only for Exam Mode, and its notes follow the
  chosen mode (Practice Mode never shows timer rules). The parser ignores any
  posted time field for `INSTANT`, and `createAttemptFromQuestions` forces
  `UNLIMITED` for a formal Practice Mode attempt and refuses Exam Mode
  Unlimited, so a stale or crafted form can't get a timed practice attempt or
  an untimed formal exam. **Legacy:** attempts frozen by b5f4ea4 as INSTANT
  with a timer keep their timer (no data rewrite); Custom Module retakes reuse
  the module's frozen config (an old INSTANT + timed module stays timed;
  modules created now in Practice Mode store `UNLIMITED`). **Test on the
  Go** is a deliberate quick-start preset: Exam Mode, 1 min per question, no
  setup.
- **UniversalTestPlayer** (`run/test-player.tsx`) runs every attempt.
- **Policy is per test type and enforced server-side.** Mock Test, Previous
  Year Paper, Grand and Live are *formal*: admin-defined question set.
  `createAttemptFromQuestions` forces `EXAM` + `FIXED` admin timing for formal
  sources unless the caller passes a Pre-Test Setup choice it was allowed to
  offer (`studentConfigAllowed`: PYQ, and Mock Tests with IMMEDIATE result
  release and no Fixed Window). Grand/Live, Offline OMR entry and mocks whose
  answer key is held never get a choice, and `revealAnswer` re-checks this on
  every reveal (an admin holding the key mid-attempt stops further reveals).
  Hiding buttons is never the control.
- **Leaderboard** (Ranking Phase 1, `lib/leaderboard.ts` + `lib/leaderboard-core.ts`):
  Mock Tests and Previous Year Papers only. Ranks are derived on read from stored
  attempt columns (never Answer rows, never a write): each student's earliest
  SUBMITTED attempt that is ONLINE + Standard time + answers after the test; a
  student whose earlier attempt exposed the key (Practice Mode, a submitted
  custom/1-min/OMR attempt) is unranked for that test. Rank = score, then
  accuracy, then correct answers; equal performance SHARES a rank and time taken
  never affects any rank (shown only). Overall Rank (per exam) = average per-test
  percentile over Mock Tests with Counts Toward Overall Ranking ON (leaderboard on,
  result released), 3+ ranked tests, equal averages share; PYQs never count; memoized
  60 s per process. `isLeaderboardAttempt` is still set by `submitAttempt` but is
  legacy: ranking does not read it.
- **PYQ full paper** freezes the whole published paper in original order
  (question `createdAt`, then `code`). It is never sampled or shuffled.
  PYQ-only practice goes through Custom Module with Source = PYQ.
- **History is immutable.** Retake/Reattempt always creates a new attempt.

## Frozen per attempt

When an attempt is created, these are fixed on it and never re-derived:

- the ordered question snapshots, with options in A-D order
- `durationMode` (FIXED / PER_QUESTION / CUSTOM / UNLIMITED) and `durationMinutes`
- `answerMode` (EXAM / INSTANT)
- `negativeMarking`

## Invariants

Each of these once caused a real production failure.

1. **React state updaters are pure.** The 2026-09-26 P0 happened because
   `persist()` (a server action wrapped in `startTransition`) was called inside
   a `setStates(prev => …)` updater. React re-runs updaters during render, so
   one option click became an endless save loop, around 40 requests per
   second. Selections never committed ("option does nothing") and Save & Next
   starved ("hangs"). Side effects belong in event handlers and effects only.
2. **Selection is local-first.** The UI updates immediately. Persistence goes
   through `AnswerSaveQueue`: one request in flight per question, latest value
   wins, a 12-second timeout, backoff retries, and then a visible "failed"
   state with Retry. It never spins forever.
3. **Every save carries a monotonic `seq`.** The server applies a save with a
   single conditional UPDATE (`saveSeq < seq`, attempt IN_PROGRESS, not
   revealed). Stale, replayed or late (timed-out) requests can never overwrite
   a newer answer. Saves are idempotent. Exactly one Answer row exists per
   attempt-question.
4. **Navigation never waits on the network.** Next, Previous and the palette
   are local state only.
5. **The timer counts down to a fixed deadline.** Unlimited attempts have no
   deadline and no time-based auto-submit.
6. **Answers are only revealed after the server authorizes it.** A correct
   label is serialized only for a question the server has already revealed in
   an INSTANT attempt ("Show answer after each question"). In Practice Mode
   the option tap IS the commit: it never goes through the save queue; it
   calls `revealAnswerAction`, and the player shows nothing until the server
   confirms. Opening, navigating to or skipping a question reveals nothing;
   a plain save never reveals. INSTANT is
   possible for student-built practice (`instantAnswerAllowed`) and for a
   configurable Mock/PYQ (`studentConfigAllowed`); never Grand/Live, OMR entry,
   held-key mocks or admin modules. Revealing freezes the chosen option
   (`Answer.revealedAt`), so a student can't reveal and then switch to the
   correct option. The update is conditional (`revealedAt IS NULL`), so two
   tabs or a double tap racing on one question commit exactly one answer and
   every response reports that one. After a reveal the player reuses the Review tools (Ask AI
   hook, WhatsApp share, Save, Report); Ask AI is authorized for exactly those
   revealed questions by `getAnswerRevealStatuses` (any other running or held
   attempt containing the question still wins). Scoring is the one
   `submitAttempt` for both modes.
7. **A malformed snapshot is a skippable notice**, never a crash.
8. **Content corrections never rewrite a snapshot.** An IN_PROGRESS attempt
   frozen from wrong content is set to `ABANDONED` and gets an AuditLog row.
   Its snapshot and answers are kept, the next Start is a fresh attempt, and
   the attempt pages render `AttemptResetNotice`. SUBMITTED attempts are never
   changed. See `docs/CONTENT-OWNERSHIP.md`.
9. **Start is idempotent; so is submit.** `createAttemptFromQuestions` takes a per-student,
   per-test advisory lock and re-checks for an IN_PROGRESS attempt inside the
   transaction. Before 2026-10-02 a double-clicked Start (or two tabs) created
   one attempt per request.
    `submitAttempt` flips IN_PROGRESS → SUBMITTED conditionally, so concurrent
    submits grade once-equivalently and log one submission; an ABANDONED
    attempt is never turned into a result by a stale tab.
10. **A timed-out attempt is never resumed.** `findResumableAttempt` finalizes
    an IN_PROGRESS attempt whose time ran out and starts a fresh one; it used
    to hand back the dead attempt, which then auto-submitted on the next page.
11. **A refused start explains itself.** Start refusals are
    `TestEngineError("UNAVAILABLE")`. Inline forms show the message; plain
    links and bare forms go through `startOrExplain` (lib/payments/paywall.ts)
    to `/student/unavailable?test=<reason>`, never the crash screen.

## Observability

Failed and slow (>1.5s) engine operations log one line each:

```
[test-engine] {"op":"save|reveal|submit","attemptId":…,"questionId":…,"code":…,"ms":…}
```

Search the PM2 error logs (`/var/log/mocktestseries/error-*.log`) for
`[test-engine]`. Refused starts log `[test-start] {"route","studentId","contentId","code","reason"}`,
and the proxy logs `[auth] {"event":"student-session-rejected","route","student","reason"}`
when a page load arrives with a session that was logged out or revoked. The log never includes answers, correct labels or secrets.

## Regression suite (run both before deploying engine changes)

Both suites run against a **disposable** database. Never point them at production.

```bash
# 0. disposable copy of production + migrations
createdb mts_engine_scratch && pg_dump --no-owner --no-privileges "$PROD_URL" | psql -q "$SCRATCH_URL"
DATABASE_URL="$SCRATCH_URL" npx prisma migrate deploy
# The copy carries LIVE Razorpay keys, AI keys and the SMS provider: scrub them before starting a server on it.
psql "$SCRATCH_URL" -c "delete from \"Setting\" where key in ('api.razorpay','api.gemini','api.openai')"
psql "$SCRATCH_URL" -c "update \"Setting\" set value = jsonb_set(value, '{msg91}', '{\"enabled\":false}') where key='auth.providers'"

# 1. server-side engine (~160 checks, includes a 40-student concurrency run)
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-test-engine-core.ts

# 2. real browser against a local production build on the scratch DB
npx next build
DATABASE_URL="$SCRATCH_URL" AUTH_URL=http://localhost:3100/api/student-auth NEXTAUTH_URL=http://localhost:3100 npx next start -p 3100 &
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/test-engine-ui-fixture.ts setup > /tmp/engine-fixture.json
BASE=http://localhost:3100 FIXTURE=/tmp/engine-fixture.json NODE_PATH=<dir containing playwright> node scripts/verify-test-engine-ui.mjs
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/test-engine-ui-fixture.ts cleanup <examId> <studentIds…>

# 3. every critical student journey (login → paid access → start → answer → submit → result → review),
#    plus a crawl of every page per persona (anonymous, free, paid, admin; MOBILE=1 for a phone)
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/critical-flows-fixture.ts setup > /tmp/flows.json
BASE=http://localhost:3100 FIXTURE=/tmp/flows.json DATABASE_URL="$SCRATCH_URL" NODE_PATH=<dir containing playwright> node scripts/verify-critical-flows.mjs
BASE=http://localhost:3100 FIXTURE=/tmp/flows.json NODE_PATH=<dir containing playwright> node scripts/verify-site-crawl.mjs

# 4. answer-leak guard
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-p0-answer-reveal.ts

# 5. Pre-Test Setup (server: config, reveal/AI gate, held keys, OMR, scoring parity,
#    leaderboard, concurrent start/submit, timeout, legacy rows, payment, pause)
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-pre-test-setup.ts
#    …and in a browser (uses the step-2 fixture: setupToken / examModeToken / mockId / paperId)
BASE=http://localhost:3100 FIXTURE=/tmp/engine-fixture.json NODE_PATH=<dir containing playwright> node scripts/verify-pre-test-setup-ui.mjs

# 6. Practice Mode vs Exam Mode release gate (100-question Mock on a phone, PYQ,
#    Subject, Custom, held key, Standard/1-min/Custom timers + timeout, themes × widths)
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/practice-mode-ui-fixture.ts setup > /tmp/pm.json
BASE=http://localhost:3100 FIXTURE=/tmp/pm.json DATABASE_URL="$SCRATCH_URL" NODE_PATH=<dir containing playwright> node scripts/verify-practice-mode-ui.mjs
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/practice-mode-ui-fixture.ts cleanup <examId> <studentIds…>

# 7. inactive-exam draft-leak gate (lib/exam-live.ts): an inactive exam with an active paper,
#    PUBLISHED questions, a mock and modules is never readable/startable by direct id
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-exam-live-gate.ts
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-exam-live-gate.ts setup > /tmp/elg.json
BASE=http://localhost:3100 FIXTURE=/tmp/elg.json DATABASE_URL="$SCRATCH_URL" NODE_PATH=<dir containing playwright> node scripts/verify-exam-live-gate.mjs
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-exam-live-gate.ts cleanup /tmp/elg.json

# 8. rich content (NEET Phase 1): renderer, PLAIN compatibility, snapshot v2, explanation leak gate
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-rich-content.ts
npx tsx scripts/verify-rich-content-plain.tsx
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-rich-content.ts setup > /tmp/rc.json
BASE=http://localhost:3100 FIXTURE=/tmp/rc.json DATABASE_URL="$SCRATCH_URL" NODE_PATH=<dir containing playwright> node scripts/verify-rich-content.mjs
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-rich-content.ts cleanup /tmp/rc.json

# 9. scientific media (NEET Phase 2): validation, immutable storage, dedup, history, viewer, preload, CLS.
#    STORAGE_DIR must be a disposable directory; the browser half needs nginx in front (see the .mjs header).
STORAGE_DIR=/tmp/media-scratch DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-media-engine.ts
STORAGE_DIR=/tmp/media-scratch DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-media-engine.ts setup > /tmp/med.json
BASE=<nginx origin> NEXT_DIRECT=http://127.0.0.1:3100 FIXTURE=/tmp/med.json STORAGE_DIR=/tmp/media-scratch FX_DIR=<dir with fixture PNGs> DATABASE_URL="$SCRATCH_URL" ADMIN_USER=… ADMIN_PASS=… NODE_PATH=<dir containing playwright> node scripts/verify-media-engine.mjs

# 10. rich import (NEET Phase 3): ZIP security, manifest, validation, idempotency, commit, snapshot,
#     leak gate, REPLACE history, rollback, legacy behaviour. STORAGE_DIR / IMPORT_STAGING_DIR disposable.
#     Browser + scale halves need the step-9 scratch nginx (production limits: 20 MB body, 60 s timeout).
npx tsx scripts/rich-import-fixtures.ts /tmp/rifx
STORAGE_DIR=/tmp/media-scratch IMPORT_STAGING_DIR=/tmp/ri-staging DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-rich-import.ts
…same env… npx tsx scripts/verify-rich-import.ts setup > /tmp/ri.json
PHASE=import BASE=<nginx origin> FIXTURE=/tmp/ri.json FX_DIR=/tmp/rifx ADMIN_USER=… ADMIN_PASS=… FULL_ADMIN_USER=… DATABASE_URL="$SCRATCH_URL" NODE_PATH=<playwright> node scripts/verify-rich-import.mjs
…same env… npx tsx scripts/verify-rich-import.ts attempts /tmp/ri.json
PHASE=player …same… node scripts/verify-rich-import.mjs
PKG=pilot45|scale180|stress180 SERVER_PID=<next pid> STORAGE_DIR=/tmp/media-scratch …same… node scripts/verify-rich-import-scale.mjs
…same env… npx tsx scripts/verify-rich-import.ts cleanup /tmp/ri.json
# legacy parity: run from a worktree of the previous release and from HEAD, outputs must be identical
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/legacy-import-parity.ts /tmp/rifx > out.json

# 12. ranking & leaderboard (Phase 1): order, eligibility, percentile, privacy, SQL ⇄ reference parity,
#     10k-participant timing, read-only proof; then the browser half (result summary, board, YOU, Your Position,
#     not-ranked states, PYQ, payload leak check, 360 px dark, admin Ranking forms)
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-leaderboard.ts
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/leaderboard-ui-fixture.ts setup > /tmp/lb.json
BASE=http://localhost:3100 FIXTURE=/tmp/lb.json DATABASE_URL="$SCRATCH_URL" NODE_PATH=<playwright> node scripts/verify-leaderboard-ui.mjs
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/leaderboard-ui-fixture.ts cleanup

# 11. advanced question types (NEET Phase 4): snapshot v3, label-set save/seq/race, all-or-nothing matrix,
#     negative marking, practice reveal lock, exam leak gate, history after edits, OMR / AI guards, insights,
#     share text, importer manifest. Browser half: checkboxes, autosave, Match lists, 360 px light/dark, 180-question perf
#     (needs the step-9 scratch nginx; REAL_MEDIA=1 stores real figures in STORAGE_DIR).
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-question-types.ts
STORAGE_DIR=/tmp/media-scratch REAL_MEDIA=1 …same env… npx tsx scripts/verify-question-types.ts setup > /tmp/qt.json
BASE=<nginx origin> FIXTURE=/tmp/qt.json DATABASE_URL="$SCRATCH_URL" NODE_PATH=<playwright> node scripts/verify-question-types.mjs
…same env… npx tsx scripts/verify-question-types.ts cleanup /tmp/qt.json
```

## Rich content and snapshot v2 (since NEET Phase 1)

- `Question.contentFormat` is `PLAIN` (default, every legacy row) or `RICH_V1`.
  PLAIN text is never parsed: `components/content/rich-text.tsx` renders it as
  the same text node as before. RICH_V1 text, option text and the explanation
  carry `$…$`, `$$…$$` and `\ce{…}`, rendered on the server only by
  `lib/rich-content.ts` (KaTeX + mhchem, `trust:false`); students never get a
  math runtime.
- A question freezes to **snapshot v1** (unchanged keys) unless it is RICH_V1
  or has a human `explanation`; then it freezes to **v2** = v1 keys + `v:2`,
  `contentFormat`, `explanation`, `assets`. Readers treat a missing `v` as v1.
- `explanation` (and EXPLANATION images) are answer-key data, like
  `correctLabel`: `toPlayerQuestions` puts them only inside `reveal`, and
  `revealAnswer` returns them with the correct label. Review shows them after
  submit; Saved Questions only when the answer is REVEALABLE.
- Media (Phase 2): RICH_V1 images are `QuestionAsset` rows pointing at
  immutable files (`lib/media-storage.ts`); v2 snapshots freeze their keys, so
  replacing/removing an image never changes a past attempt. The player
  preloads only the NEXT question's images (`preloadImages`), and every image
  has a reserved box from its stored width/height (no layout shift).

Bulk Import has a Rich mode (NEET Phase 3, docs/RICH-IMPORT.md). Rich imports create ordinary
RICH_V1 SINGLE_CORRECT questions (always DRAFT) with QuestionAsset references to Phase 2 media, so
they freeze to the same snapshot v2 and go through the same player/reveal/review paths. Standard
(legacy) imports are unchanged.

**Question types (NEET Phase 4, docs/NEET-QUESTION-TYPES.md).** `Question.questionType` defaults to
`SINGLE_CORRECT`, which keeps every path above unchanged. `MULTIPLE_CORRECT` freezes **snapshot v3**
(`correctLabels`, `correctLabel: ""`) and saves `Answer.selectedLabels` through `saveAnswerLabels` /
`revealAnswerLabels` (same seq + revealedAt contract); the player shows checkboxes and Practice Mode
commits with an explicit Check answer. Scoring is all-or-nothing, `[]` = unanswered. `MATCH_THE_FOLLOWING`
freezes v3 with `matchSpec` and is otherwise a single-correct question. OMR entry refuses mocks with an MSQ.

Every start (and resume-by-id) first runs `assertExamLive(examId)`: an exam
with `isActive = false` is private, whatever its papers, tests or question
statuses say. Admin tools never call it.

Browser suites that need the server-rendered player payload (answer-leak
checks) fetch it from inside the page. The hydrated DOM (`page.content()`)
no longer contains it, and Playwright's `page.request` drops the Secure
device cookie over http, so the server sees a new device (`OTHER_DEVICE`)
or a signed-out session.

The UI suite covers the builder, 1-, 2- and 10-question tests on desktop and a
touch phone, Mock/PYQ/Subject through the same player, and the following:
rapid taps, double Next, palette, refresh/resume, back/forward, Mark for
Review, all three duration modes, instant reveal and its lock, exam-mode
leakage, a malformed question, and concurrent browsers.
