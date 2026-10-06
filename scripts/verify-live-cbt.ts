/**
 * Live CBT + enrollment regression (lib/live-cbt.ts, the enrollment gate in
 * lib/test-attempt.ts#planMockTestStart, the Solution PDF hold and the
 * window-end sweep). Real engine flows with short real-time windows.
 *
 * DISPOSABLE database only (refuses the production DB name):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-live-cbt.ts
 */
import "dotenv/config";
import { QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enrollInMockTest, finalizeClosedWindowAttempts, isEnrolledInMockTest, countMockTestEnrollments, EnrollmentError } from "@/lib/live-cbt";
import { enrollmentWindowState, effectiveEnrollmentCloseAt, formatCountdown } from "@/lib/live-cbt-core";
import { previewFormalTestStart, remainingSecondsFor, saveAnswer, startMockTestAttempt, submitAttempt, toServerTimedAttempt } from "@/lib/test-attempt";
import { getAnswerRevealStatus, isAttemptAnswerKeyHeld } from "@/lib/student-data";
import { canAccessTestResource } from "@/lib/test-resources-access";
import { isMockResultReleased } from "@/lib/mock-test-schedule";
import { testRefusalKey } from "@/lib/test-refusals";
import { getLeaderboard, getStudentRankedTests } from "@/lib/leaderboard";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.findFirstOrThrow({
    where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { questions: { _count: "desc" } },
  });
  const bank = await prisma.question.findMany({
    where: { examId: exam.id, status: QuestionStatus.PUBLISHED, questionType: "SINGLE_CORRECT", options: { some: { isCorrect: true } } },
    take: 4,
    orderBy: { code: "asc" },
    include: { options: true },
  });
  const correctOf = (qid: string) => bank.find((q) => q.id === qid)!.options.find((o) => o.isCorrect)!.label;
  const students: string[] = [];
  const mkStudent = async (name: string) => {
    const s = await prisma.student.create({
      data: { studentId: `LCB-${suffix}-${students.length}`, name, email: `lcb-${suffix}-${students.length}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };
  const mocks: string[] = [];
  const mkMock = async (tag: string, extra: Partial<Prisma.MockTestUncheckedCreateInput> = {}) => {
    const m = await prisma.mockTest.create({
      data: {
        examId: exam.id,
        title: `LCB ${tag} ${suffix}`,
        durationMinutes: 60,
        status: "PUBLISHED",
        accessType: "FREE",
        ...extra,
        questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) },
      },
    });
    mocks.push(m.id);
    return m;
  };
  const now = () => new Date();
  const min = (n: number) => new Date(Date.now() + n * 60_000);
  const attemptsOf = (studentId: string, mockTestId: string) => prisma.testAttempt.count({ where: { studentId, mockTestId } });
  const integrityBefore = await prisma.$queryRaw<{ h: string }[]>`SELECT md5(string_agg(concat_ws('|',id,status,score,"submittedAt","timeTakenSeconds"), ',' ORDER BY id)) h FROM "TestAttempt"`;

  // ------------------------------------------------------------------
  console.log("\n--- Pure rules ---");
  const base = { enrollmentEnabled: true, enrollmentOpensAt: null, enrollmentClosesAt: null, availableUntil: min(60) };
  check("enrollment OFF → DISABLED", enrollmentWindowState({ ...base, enrollmentEnabled: false }) === "DISABLED");
  check("no open time → OPEN now", enrollmentWindowState(base) === "OPEN");
  check("opens in future → NOT_OPEN_YET", enrollmentWindowState({ ...base, enrollmentOpensAt: min(5) }) === "NOT_OPEN_YET");
  check("no close time → closes with the window", effectiveEnrollmentCloseAt(base)?.getTime() === base.availableUntil.getTime());
  check("past close → CLOSED", enrollmentWindowState({ ...base, enrollmentClosesAt: min(-1) }) === "CLOSED");
  check("window over (no own close) → CLOSED", enrollmentWindowState({ ...base, availableUntil: min(-1) }) === "CLOSED");
  check("countdown format HH:MM:SS", formatCountdown(3_723_000) === "01:02:03" && formatCountdown(-5) === "00:00:00" && formatCountdown(90_061_000) === "1d 01:01:01");

  // ------------------------------------------------------------------
  console.log("\n--- Enrollment OFF = unchanged ---");
  const off = await mkMock("OFF", { availableFrom: min(-5), availableUntil: min(55) });
  const s0 = await mkStudent("Off Student");
  const a0 = await startMockTestAttempt(s0, off.id);
  check("enrollment OFF: an unenrolled student starts a fixed-window mock as before", a0.status === "IN_PROGRESS");

  // ------------------------------------------------------------------
  console.log("\n--- Enrollment ON: gate, idempotency, window ---");
  const live = await mkMock("LIVE", { availableFrom: min(-5), availableUntil: min(55), enrollmentEnabled: true, attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW" });
  const sA = await mkStudent("Asha Live");
  const r1 = await refusal(() => startMockTestAttempt(sA, live.id));
  check("unenrolled student cannot start", r1.includes("Enroll in this live test"), r1);
  check("…the refusal explains itself (not-enrolled)", testRefusalKey(r1) === "not-enrolled");
  check("…Pre-Test preview refuses too", (await refusal(() => previewFormalTestStart(sA, { kind: "MOCK_TEST", id: live.id }))).includes("Enroll"));
  check("…and no attempt was created", (await attemptsOf(sA, live.id)) === 0);
  check("enroll → ENROLLED", (await enrollInMockTest(sA, live.id)) === "ENROLLED");
  check("enroll again → ALREADY_ENROLLED", (await enrollInMockTest(sA, live.id)) === "ALREADY_ENROLLED");
  const sB = await mkStudent("Bala Live");
  const race = await Promise.all(Array.from({ length: 6 }, () => enrollInMockTest(sB, live.id)));
  check("6 concurrent enrolls → exactly one row", (await prisma.mockTestEnrollment.count({ where: { studentId: sB, mockTestId: live.id } })) === 1 && race.filter((r) => r === "ENROLLED").length === 1, race);
  check("enrolling never creates a TestAttempt", (await attemptsOf(sA, live.id)) === 0 && (await attemptsOf(sB, live.id)) === 0);
  check("enrolled count = 2", (await countMockTestEnrollments(live.id)) === 2);
  let dup = "accepted";
  try {
    await prisma.mockTestEnrollment.create({ data: { mockTestId: live.id, studentId: sA } });
  } catch (e) {
    dup = (e as { code?: string }).code ?? "error";
  }
  check("DB unique (mockTestId, studentId) refuses a duplicate", dup === "P2002", dup);
  const aA = await startMockTestAttempt(sA, live.id);
  check("enrolled student can start", aA.status === "IN_PROGRESS" && (await isEnrolledInMockTest(sA, live.id)));

  const notYet = await mkMock("NOTYET", { availableFrom: min(30), availableUntil: min(90), enrollmentEnabled: true, enrollmentOpensAt: min(10) });
  const sC = await mkStudent("Chitra Live");
  const e1 = await refusal(() => enrollInMockTest(sC, notYet.id));
  check("enrollment not open yet → refused", e1.includes("not opened yet"), e1);
  await prisma.mockTest.update({ where: { id: notYet.id }, data: { enrollmentOpensAt: min(-1), enrollmentClosesAt: min(-0.5) } });
  check("enrollment closed (own close time) → refused", (await refusal(() => enrollInMockTest(sC, notYet.id))).includes("closed"));
  await prisma.mockTest.update({ where: { id: notYet.id }, data: { enrollmentClosesAt: null } });
  check("enrollment open (window not started) → ENROLLED", (await enrollInMockTest(sC, notYet.id)) === "ENROLLED");
  const before = await refusal(() => startMockTestAttempt(sC, notYet.id));
  check("enrolled but before the start time → cannot start, no attempt", before.includes("not available yet") && (await attemptsOf(sC, notYet.id)) === 0, before);
  const disabled = await mkMock("NOENROLL", { availableFrom: min(-5), availableUntil: min(55) });
  check("enrollment disabled → enroll refused", (await refusal(() => enrollInMockTest(sC, disabled.id))).includes("not open"));
  const paid = await mkMock("PAID", { availableFrom: min(-5), availableUntil: min(55), enrollmentEnabled: true, accessType: "PAID" });
  const pe = await refusal(() => enrollInMockTest(sC, paid.id));
  check("PAID test without access → enrollment refused (no payment bypass)", pe.includes("Unlock"), pe);
  check("an EnrollmentError is a typed refusal", (await enrollInMockTest(sC, disabled.id).catch((e) => e)) instanceof EnrollmentError);

  const ended = await mkMock("ENDED", { availableFrom: min(-120), availableUntil: min(-60), enrollmentEnabled: true });
  const sD = await mkStudent("Dinesh Live");
  check("after the window → enrollment refused", (await refusal(() => enrollInMockTest(sD, ended.id))).includes("closed"));
  await prisma.mockTestEnrollment.create({ data: { mockTestId: ended.id, studentId: sD } });
  const after = await refusal(() => startMockTestAttempt(sD, ended.id));
  check("enrolled, after the end → cannot start, no attempt", after.includes("window has closed") && (await attemptsOf(sD, ended.id)) === 0, after);

  // ------------------------------------------------------------------
  console.log("\n--- Late join, single attempt ---");
  const late = await mkMock("LATE", { availableFrom: min(-50), availableUntil: min(10), durationMinutes: 60, enrollmentEnabled: true, attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW" });
  await enrollInMockTest(sD, late.id);
  const lateAttempt = await startMockTestAttempt(sD, late.id);
  const remaining = remainingSecondsFor(toServerTimedAttempt({ ...lateAttempt, mockTest: { availableUntil: late.availableUntil } }));
  check("late join (50 of 60 min gone) gets only the remaining window (~600 s, not 3600)", remaining <= 600 && remaining > 590, remaining);
  check("formal Exam Mode + Standard time (no practice during a live test)", lateAttempt.answerMode === "EXAM" && lateAttempt.durationMode === "FIXED");
  await submitAttempt(lateAttempt.id, sD);
  const second = await refusal(() => startMockTestAttempt(sD, late.id));
  check("single attempt enforced inside the window", second.includes("Retakes are not allowed"), second);

  // ------------------------------------------------------------------
  console.log("\n--- Early finisher: everything held until the window closes ---");
  const q0 = (await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: aA.id }, orderBy: { order: "asc" } })).questionId;
  await saveAnswer(aA.id, sA, q0, correctOf(q0), false);
  const subA = await submitAttempt(aA.id, sA);
  const liveRow = await prisma.mockTest.findUniqueOrThrow({ where: { id: live.id } });
  check("result not released during the window", !isMockResultReleased(liveRow));
  check("answer key held (result + review pages)", isAttemptAnswerKeyHeld({ testType: subA.testType, mockTest: liveRow }));
  const revealHeld = await getAnswerRevealStatus(sA, q0);
  check("Ask AI / saved-question reveal: RESULT_HELD", revealHeld === "RESULT_HELD", revealHeld);
  const solutionCtx = { resourceType: "SOLUTION_PDF" as const, releasePolicy: "AFTER_SUBMISSION" as const, releaseAt: null, isActive: true, mockTestAvailable: true, hasSubmittedAttempt: true };
  check("Solution PDF (After submission) LOCKED while the result is held — leak fixed", !canAccessTestResource({ ...solutionCtx, resultReleased: isMockResultReleased(liveRow) }));
  check("Solution PDF (Custom date already passed) still LOCKED while held", !canAccessTestResource({ ...solutionCtx, releasePolicy: "CUSTOM_DATE", releaseAt: min(-10), resultReleased: false }));
  check("Paper PDF / ordinary resources unaffected by the hold", canAccessTestResource({ ...solutionCtx, resourceType: "PAPER_PDF", releasePolicy: "AFTER_AVAILABLE_FROM", resultReleased: false }));
  check("ordinary mock (released) Solution PDF unchanged", canAccessTestResource({ ...solutionCtx, resultReleased: true }));
  check("held test is not in Ranking & Progress", !(await getStudentRankedTests(exam.id, sA)).some((r) => r.title === liveRow.title));

  // ------------------------------------------------------------------
  console.log("\n--- Abandoned attempt finalized server-side at the deadline ---");
  const sweepMock = await mkMock("SWEEP", { availableFrom: min(-5), availableUntil: new Date(Date.now() + 6_000), enrollmentEnabled: true, attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW" });
  const sE = await mkStudent("Eshan Abandon");
  const sF = await mkStudent("Farid Finisher");
  for (const s of [sE, sF]) await enrollInMockTest(s, sweepMock.id);
  const aE = await startMockTestAttempt(sE, sweepMock.id);
  const aF = await startMockTestAttempt(sF, sweepMock.id);
  const qs = await prisma.testAttemptQuestion.findMany({ where: { attemptId: aE.id }, orderBy: { order: "asc" } });
  await saveAnswer(aE.id, sE, qs[0].questionId, correctOf(qs[0].questionId), false);
  await saveAnswer(aE.id, sE, qs[1].questionId, correctOf(qs[1].questionId), false);
  const qf = await prisma.testAttemptQuestion.findMany({ where: { attemptId: aF.id }, orderBy: { order: "asc" } });
  for (const q of qf) await saveAnswer(aF.id, sF, q.questionId, correctOf(q.questionId), false);
  const fSubmitted = await submitAttempt(aF.id, sF);
  check("nothing finalized before the deadline", (await finalizeClosedWindowAttempts()).finalized === 0);
  const ordinary = await mkMock("ORDINARY", {});
  const sG = await mkStudent("Gita Ordinary");
  const aG = await startMockTestAttempt(sG, ordinary.id);
  await prisma.testAttempt.update({ where: { id: aG.id }, data: { startedAt: min(-600) } }); // long expired, no window
  await sleep(6_500);
  const late3 = await refusal(() => saveAnswer(aE.id, sE, qs[2].questionId, correctOf(qs[2].questionId), false));
  check("a save after the deadline is refused (EXPIRED)", /Time is up/i.test(late3), late3);
  const sweep = await finalizeClosedWindowAttempts();
  check("sweep finalizes the abandoned attempt (student never came back)", sweep.finalized === 1, sweep);
  const eFinal = await prisma.testAttempt.findUniqueOrThrow({ where: { id: aE.id } });
  check("…graded from answers saved BEFORE the deadline only (2 correct)", eFinal.status === "SUBMITTED" && eFinal.correctCount === 2 && eFinal.score === 2, eFinal);
  check("…time capped at the window", (eFinal.timeTakenSeconds ?? 0) <= Math.ceil((sweepMock.availableUntil!.getTime() - eFinal.startedAt.getTime()) / 1000));
  const again = await finalizeClosedWindowAttempts();
  check("sweep rerun is a no-op (idempotent)", again.finalized === 0);
  const fAfter = await prisma.testAttempt.findUniqueOrThrow({ where: { id: aF.id } });
  check("already-submitted attempt untouched", fAfter.score === fSubmitted.score && fAfter.submittedAt?.getTime() === fSubmitted.submittedAt?.getTime());
  check("ordinary (no window) expired attempt NOT touched by the sweep", (await prisma.testAttempt.findUniqueOrThrow({ where: { id: aG.id } })).status === "IN_PROGRESS");
  const swept = await Promise.all([finalizeClosedWindowAttempts(), finalizeClosedWindowAttempts(), finalizeClosedWindowAttempts()]);
  check("concurrent sweeps safe", swept.every((r) => r.finalized === 0));

  // ------------------------------------------------------------------
  console.log("\n--- After the window: released, leaderboard includes finalized attempt ---");
  const sweepRow = await prisma.mockTest.findUniqueOrThrow({ where: { id: sweepMock.id } });
  check("result released after the window (AFTER_WINDOW)", isMockResultReleased(sweepRow));
  check("answer key no longer held", !isAttemptAnswerKeyHeld({ testType: "FULL_MOCK", mockTest: sweepRow }));
  check("Solution PDF unlocks after release", canAccessTestResource({ ...solutionCtx, resultReleased: isMockResultReleased(sweepRow) }));
  const board = await getLeaderboard({ kind: "MOCK_TEST", id: sweepMock.id }, sE);
  check("leaderboard includes the finalized abandoned attempt (#2 of 2) and the finisher (#1)", board.totalParticipants === 2 && board.self?.rank === 2 && board.rows[0].score === 4, board.rows.map((r) => [r.rank, r.score]));
  check("released test appears in Ranking & Progress", (await getStudentRankedTests(exam.id, sE)).some((r) => r.title === sweepRow.title && r.rank === 2));

  // ------------------------------------------------------------------
  console.log("\n--- Cleanup / integrity ---");
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
  await prisma.mockTest.deleteMany({ where: { id: { in: mocks } } });
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: students } } });
  await prisma.student.deleteMany({ where: { id: { in: students } } });
  const integrityAfter = await prisma.$queryRaw<{ h: string }[]>`SELECT md5(string_agg(concat_ws('|',id,status,score,"submittedAt","timeTakenSeconds"), ',' ORDER BY id)) h FROM "TestAttempt"`;
  check("every pre-existing attempt unchanged (sweep touched only fixture attempts)", integrityBefore[0].h === integrityAfter[0].h);
  void now;

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
