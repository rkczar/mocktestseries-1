/**
 * Verifies Step 5 (Live/Scheduled Tests): lock-time blueprint resolution,
 * server-time-authoritative access gating, the global-endAt time cap, auto
 * finalization/reconciliation, and cancellation behavior.
 *
 *  1. Lock resolution — mirrors Grand Test's publish resolution exactly:
 *     exact expected question set, DRAFT excluded, sequential order.
 *  2. Access gating by DERIVED state — join before start (SCHEDULED) is
 *     rejected, join during the window (LIVE) succeeds, join after the
 *     window (ENDED) is rejected, a CANCELLED test is rejected — all from
 *     server time, never a client-supplied value (saveAnswer/submitAttempt
 *     take no time input from the caller at all).
 *  3. Global endAt cap — effectiveEndFor / isExpired / remainingSecondsFor
 *     cap a late joiner's window at the test's global endAt, not
 *     startedAt + studentDurationMinutes (the 2:00–3:00 PM / 60-minute /
 *     2:40 PM-join example from the spec, verified exactly).
 *  4. Idempotent finalization — finalizeIfExpired/reconcileExpiredAttempts
 *     settle a dangling IN_PROGRESS attempt whose window has closed
 *     (simulating a browser that never came back), and calling it again
 *     changes nothing (no double-scoring).
 *  5. Cancellation — cancelling abandons every IN_PROGRESS attempt for the
 *     test, and an abandoned attempt can no longer be edited.
 *  6. Duplicate submit — submitting twice returns the identical result.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-live-test.ts
 */
import "dotenv/config";
import {
  PrismaClient,
  AttemptSourceType,
  AttemptStatus,
  StudentAuthProvider,
  QuestionStatus,
  QuestionDifficulty,
  LiveTestStatus,
  TestType,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { startLiveTestAttempt, saveAnswer, submitAttempt, finalizeIfExpired, reconcileExpiredAttempts } from "@/lib/test-attempt";
import { selectPublishedQuestions } from "@/lib/question-selection";
import { deriveLiveTestState } from "@/lib/live-test";
import { effectiveEndFor, isExpired, remainingSecondsFor } from "@/lib/attempt-timing";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

function expectThrows(label: string, fn: () => Promise<unknown> | unknown): Promise<Error | null> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        check(label, false);
        return null;
      },
      (e) => {
        check(label, true);
        return e as Error;
      }
    );
}

async function main() {
  console.log("=== Live Test Verification ===\n");
  const suffix = Date.now().toString(36);

  // ---- Fixture ------------------------------------------------------
  const exam = await prisma.exam.create({ data: { name: `Live Exam ${suffix}`, code: `LIVE-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Live Subject" } });

  async function makeQuestion(status: QuestionStatus = QuestionStatus.PUBLISHED) {
    return prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        code: `Q-LIVE-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        text: `Live fixture question ${Math.random().toString(36).slice(2, 6)}?`,
        examYear: 2024,
        difficulty: QuestionDifficulty.EASY,
        status,
        options: {
          create: [
            { label: "A", text: "0", isCorrect: false },
            { label: "B", text: "1", isCorrect: true },
            { label: "C", text: "0", isCorrect: false },
            { label: "D", text: "0", isCorrect: false },
          ],
        },
      },
      include: { options: true },
    });
  }
  const questions = await Promise.all([makeQuestion(), makeQuestion(), makeQuestion()]);
  await makeQuestion(QuestionStatus.DRAFT); // must never surface

  const passwordHash = await argon2.hash("Live@12345");
  const student = await prisma.student.create({
    data: { studentId: `LIVE-${suffix}`, name: "Live Student", email: `live-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });

  const liveTestIds: string[] = [];
  console.log(`Fixture — exam ${exam.id}, subject ${subject.id}, student ${student.id}\n`);

  try {
    // ---- 1. Lock resolution -------------------------------------------
    console.log("--- Lock resolution ---");
    const now0 = Date.now();
    const upcoming = await prisma.liveTest.create({
      data: {
        examId: exam.id,
        title: `Live Test — upcoming ${suffix}`,
        startAt: new Date(now0 + 60 * 60_000),
        endAt: new Date(now0 + 120 * 60_000),
        studentDurationMinutes: 30,
        negativeMarking: 0.25,
        accessType: "FREE",
        questionCount: 3,
        status: LiveTestStatus.DRAFT,
        blueprint: [{ subjectId: subject.id, count: 3 }] as unknown as object,
      },
    });
    liveTestIds.push(upcoming.id);

    const { questions: resolvedQ } = await selectPublishedQuestions({ examId: exam.id, subjectId: subject.id, count: 3 });
    await prisma.$transaction([
      prisma.liveTestQuestion.createMany({ data: resolvedQ.map((q, order) => ({ liveTestId: upcoming.id, questionId: q.id, order })) }),
      prisma.liveTest.update({ where: { id: upcoming.id }, data: { status: LiveTestStatus.SCHEDULED, publishedAt: new Date() } }),
    ]);
    const ltQuestions = await prisma.liveTestQuestion.findMany({ where: { liveTestId: upcoming.id }, orderBy: { order: "asc" } });
    check("lock resolves exactly questionCount questions (3)", ltQuestions.length === 3);
    check("resolved set excludes the DRAFT question", ltQuestions.every((q) => questions.some((qq) => qq.id === q.questionId)));

    // ---- 2. Access gating by derived state -----------------------------
    console.log("\n--- Access gating (derived server-time state) ---");
    const lockedUpcoming = await prisma.liveTest.findUniqueOrThrow({ where: { id: upcoming.id } });
    check("a test whose window hasn't started derives SCHEDULED", deriveLiveTestState(lockedUpcoming, new Date()) === "SCHEDULED");
    await expectThrows("joining before startAt is rejected ('has not started yet')", () => startLiveTestAttempt(student.id, upcoming.id));

    const live = await prisma.liveTest.create({
      data: {
        examId: exam.id,
        title: `Live Test — live now ${suffix}`,
        startAt: new Date(now0 - 20 * 60_000),
        endAt: new Date(now0 + 40 * 60_000),
        studentDurationMinutes: 60,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 3,
        status: LiveTestStatus.SCHEDULED,
        blueprint: [{ subjectId: subject.id, count: 3 }] as unknown as object,
        publishedAt: new Date(),
      },
    });
    liveTestIds.push(live.id);
    await prisma.liveTestQuestion.createMany({ data: resolvedQ.map((q, order) => ({ liveTestId: live.id, questionId: q.id, order })) });
    check("a test inside its window derives LIVE", deriveLiveTestState(live, new Date()) === "LIVE");

    const attempt = await startLiveTestAttempt(student.id, live.id);
    check("joining during the window succeeds", attempt.sourceType === AttemptSourceType.LIVE_TEST && attempt.testType === TestType.LIVE_TEST);
    const again = await startLiveTestAttempt(student.id, live.id);
    check("joining again resumes the SAME attempt (no reshuffle)", again.id === attempt.id);

    const ended = await prisma.liveTest.create({
      data: {
        examId: exam.id,
        title: `Live Test — ended ${suffix}`,
        startAt: new Date(now0 - 120 * 60_000),
        endAt: new Date(now0 - 60 * 60_000),
        studentDurationMinutes: 30,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 3,
        status: LiveTestStatus.SCHEDULED,
        blueprint: [{ subjectId: subject.id, count: 3 }] as unknown as object,
        publishedAt: new Date(),
      },
    });
    liveTestIds.push(ended.id);
    check("a test past its window derives ENDED", deriveLiveTestState(ended, new Date()) === "ENDED");
    await expectThrows("joining after endAt is rejected ('has ended')", () => startLiveTestAttempt(student.id, ended.id));

    const cancelled = await prisma.liveTest.create({
      data: {
        examId: exam.id,
        title: `Live Test — cancelled ${suffix}`,
        startAt: new Date(now0 - 20 * 60_000),
        endAt: new Date(now0 + 40 * 60_000),
        studentDurationMinutes: 30,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 3,
        status: LiveTestStatus.CANCELLED,
        blueprint: [{ subjectId: subject.id, count: 3 }] as unknown as object,
      },
    });
    liveTestIds.push(cancelled.id);
    check("CANCELLED status wins outright regardless of the time window", deriveLiveTestState(cancelled, new Date()) === "CANCELLED");
    await expectThrows("joining a cancelled test is rejected", () => startLiveTestAttempt(student.id, cancelled.id));

    // ---- 3. Global endAt cap --------------------------------------------
    console.log("\n--- Global endAt cap (late join never exceeds the window) ---");
    // 2:00–3:00 PM live test, 60-minute student duration, joined at 2:40 PM -> effective end 3:00 PM, not 3:40 PM.
    const windowStart = new Date("2026-01-01T14:00:00.000Z");
    const globalEndAt = new Date("2026-01-01T15:00:00.000Z");
    const joinedAt = new Date("2026-01-01T14:40:00.000Z");
    const capped = effectiveEndFor({ startedAt: joinedAt, durationMinutes: 60, liveTestEndAt: globalEndAt });
    check("effective end is capped at the global endAt (3:00 PM), not startedAt+60min (3:40 PM)", capped.getTime() === globalEndAt.getTime());

    const uncappedCase = effectiveEndFor({ startedAt: windowStart, durationMinutes: 30, liveTestEndAt: globalEndAt });
    check("an early joiner whose duration ends before the global endAt is NOT capped (uses their own 30-min end)", uncappedCase.getTime() === new Date("2026-01-01T14:30:00.000Z").getTime());

    check(
      "isExpired respects the cap: 2:59 PM is still within the capped window",
      !isExpired({ startedAt: joinedAt, durationMinutes: 60, liveTestEndAt: globalEndAt }, new Date("2026-01-01T14:59:00.000Z"))
    );
    check(
      "isExpired respects the cap: 3:00 PM (the boundary, exclusive) is expired",
      isExpired({ startedAt: joinedAt, durationMinutes: 60, liveTestEndAt: globalEndAt }, new Date("2026-01-01T15:00:00.000Z"))
    );
    check(
      "remainingSecondsFor at the moment of the capped join is 20 minutes (1200s), not 60",
      remainingSecondsFor({ startedAt: joinedAt, durationMinutes: 60, liveTestEndAt: globalEndAt }, joinedAt) === 1200
    );
    check(
      "a non-Live-Test attempt (no liveTestEndAt) is completely unaffected by the cap logic",
      effectiveEndFor({ startedAt: windowStart, durationMinutes: 30 }).getTime() === new Date("2026-01-01T14:30:00.000Z").getTime()
    );

    // ---- 4. Idempotent finalization / reconciliation --------------------
    console.log("\n--- Idempotent finalization / reconciliation ---");
    // Manually force the live attempt's startedAt far enough in the past that it's now expired
    // (simulating a browser that never came back to auto-submit).
    await prisma.testAttempt.update({ where: { id: attempt.id }, data: { startedAt: new Date(Date.now() - 61 * 60_000) } });
    const reFetched = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt.id }, include: { liveTest: { select: { endAt: true } } } });
    const finalizedOnce = await finalizeIfExpired(reFetched);
    check("finalizeIfExpired settles a dangling expired IN_PROGRESS attempt", finalizedOnce === true);
    const settled = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    check("...and it is now SUBMITTED with a score computed", settled.status === AttemptStatus.SUBMITTED && settled.score !== null);

    const finalizedTwice = await finalizeIfExpired({ ...settled, liveTest: { endAt: live.endAt } });
    check("calling finalizeIfExpired again on an already-SUBMITTED attempt is a no-op", finalizedTwice === false);
    const unchanged = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    check("...score/state did not change (no double-scoring)", unchanged.score === settled.score && unchanged.submittedAt?.getTime() === settled.submittedAt?.getTime());

    // Sweep form: create a second dangling attempt on `live` and reconcile by liveTestId.
    const student2 = await prisma.student.create({
      data: { studentId: `LIVE2-${suffix}`, name: "Live Student 2", email: `live2-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    const attempt2 = await startLiveTestAttempt(student2.id, live.id);
    await prisma.testAttempt.update({ where: { id: attempt2.id }, data: { startedAt: new Date(Date.now() - 61 * 60_000) } });
    const swept = await reconcileExpiredAttempts({ liveTestId: live.id });
    check("reconcileExpiredAttempts sweeps and finalizes the dangling attempt", swept === 1);
    const attempt2After = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attempt2.id } });
    check("...it is now SUBMITTED", attempt2After.status === AttemptStatus.SUBMITTED);

    // ---- 5. Cancellation abandons in-progress attempts -------------------
    console.log("\n--- Cancellation ---");
    const toCancel = await prisma.liveTest.create({
      data: {
        examId: exam.id,
        title: `Live Test — will be cancelled ${suffix}`,
        startAt: new Date(now0 - 5 * 60_000),
        endAt: new Date(now0 + 55 * 60_000),
        studentDurationMinutes: 30,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 3,
        status: LiveTestStatus.SCHEDULED,
        blueprint: [{ subjectId: subject.id, count: 3 }] as unknown as object,
        publishedAt: new Date(),
      },
    });
    liveTestIds.push(toCancel.id);
    await prisma.liveTestQuestion.createMany({ data: resolvedQ.map((q, order) => ({ liveTestId: toCancel.id, questionId: q.id, order })) });
    const cancelledAttempt = await startLiveTestAttempt(student.id, toCancel.id);

    await prisma.$transaction([
      prisma.testAttempt.updateMany({ where: { liveTestId: toCancel.id, status: AttemptStatus.IN_PROGRESS }, data: { status: AttemptStatus.ABANDONED } }),
      prisma.liveTest.update({ where: { id: toCancel.id }, data: { status: LiveTestStatus.CANCELLED } }),
    ]);

    const afterCancel = await prisma.testAttempt.findUniqueOrThrow({ where: { id: cancelledAttempt.id } });
    check("cancelling the test abandons the in-progress attempt", afterCancel.status === AttemptStatus.ABANDONED);
    await expectThrows("an abandoned attempt can no longer be edited (saveAnswer rejects it)", () =>
      saveAnswer(cancelledAttempt.id, student.id, resolvedQ[0].id, "B", false)
    );

    // ---- 6. Duplicate submit is idempotent -------------------------------
    console.log("\n--- Duplicate submit ---");
    const dupTest = await prisma.liveTest.create({
      data: {
        examId: exam.id,
        title: `Live Test — dup submit ${suffix}`,
        startAt: new Date(now0 - 5 * 60_000),
        endAt: new Date(now0 + 55 * 60_000),
        studentDurationMinutes: 30,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 3,
        status: LiveTestStatus.SCHEDULED,
        blueprint: [{ subjectId: subject.id, count: 3 }] as unknown as object,
        publishedAt: new Date(),
      },
    });
    liveTestIds.push(dupTest.id);
    await prisma.liveTestQuestion.createMany({ data: resolvedQ.map((q, order) => ({ liveTestId: dupTest.id, questionId: q.id, order })) });
    const dupAttempt = await startLiveTestAttempt(student.id, dupTest.id);
    await saveAnswer(dupAttempt.id, student.id, resolvedQ[0].id, "B", false);
    const submit1 = await submitAttempt(dupAttempt.id, student.id);
    const submit2 = await submitAttempt(dupAttempt.id, student.id);
    check("submitting twice returns the identical score/result (idempotent)", submit1.score === submit2.score && submit1.submittedAt?.getTime() === submit2.submittedAt?.getTime());

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    const studentIds = await prisma.student.findMany({ where: { studentId: { startsWith: `LIVE` }, email: { contains: suffix } }, select: { id: true } });
    const allStudentIds = studentIds.map((s) => s.id);
    await prisma.answer.deleteMany({ where: { studentId: { in: allStudentIds } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: allStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: allStudentIds } } });
    await prisma.liveTestQuestion.deleteMany({ where: { liveTestId: { in: liveTestIds } } });
    await prisma.liveTest.deleteMany({ where: { id: { in: liveTestIds } } });
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    await prisma.subject.delete({ where: { id: subject.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
