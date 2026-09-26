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
   an INSTANT attempt. INSTANT is only possible for student-built practice
   (`instantAnswerAllowed`): never Mock, PYQ, Grand/Live or admin modules.
   Revealing freezes the chosen option (`Answer.revealedAt`), so a student
   can't reveal and then switch to the correct option.
7. **A malformed snapshot is a skippable notice**, never a crash.

## Observability

Failed and slow (>1.5s) engine operations log one line each:

```
[test-engine] {"op":"save|reveal|submit","attemptId":…,"questionId":…,"code":…,"ms":…}
```

Search the PM2 error logs (`/var/log/mocktestseries/error-*.log`) for
`[test-engine]`. The log never includes answers, correct labels or secrets.

## Regression suite (run both before deploying engine changes)

Both suites run against a **disposable** database. Never point them at production.

```bash
# 0. disposable copy of production + migrations
createdb mts_engine_scratch && pg_dump --no-owner --no-privileges "$PROD_URL" | psql -q "$SCRATCH_URL"
DATABASE_URL="$SCRATCH_URL" npx prisma migrate deploy

# 1. server-side engine (~160 checks, includes a 40-student concurrency run)
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-test-engine-core.ts

# 2. real browser against a local production build on the scratch DB
npx next build
DATABASE_URL="$SCRATCH_URL" AUTH_URL=http://localhost:3100/api/student-auth NEXTAUTH_URL=http://localhost:3100 npx next start -p 3100 &
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/test-engine-ui-fixture.ts setup > /tmp/engine-fixture.json
BASE=http://localhost:3100 FIXTURE=/tmp/engine-fixture.json NODE_PATH=<dir containing playwright> node scripts/verify-test-engine-ui.mjs
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/test-engine-ui-fixture.ts cleanup <examId> <studentIds…>

# 3. answer-leak guard
DATABASE_URL="$SCRATCH_URL" NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-p0-answer-reveal.ts
```

The UI suite covers the builder, 1-, 2- and 10-question tests on desktop and a
touch phone, Mock/PYQ/Subject through the same player, and the following:
rapid taps, double Next, palette, refresh/resume, back/forward, Mark for
Review, all three duration modes, instant reveal and its lock, exam-mode
leakage, a malformed question, and concurrent browsers.
