/**
 * Verifies the Scheduled Mock Test Series core engine: availableFrom-derived
 * access gating, attempt policy (single vs multiple), leaderboard
 * first-submission-only eligibility + deterministic ranking, student
 * isolation, and TestResource release-policy enforcement.
 *
 *  1. Locked before availableFrom — starting rejected, no attempt row
 *     created (so there is nothing to leak via a direct attempt URL either).
 *  2. Auto-available at/after availableFrom — starting succeeds exactly at
 *     and after the instant, without any admin action.
 *  3. Still available long after — a test scheduled far in the past remains
 *     startable (no availableUntil, unlike Live Test).
 *  4. A PUBLISHED test with no availableFrom is available immediately
 *     (legacy-compatibility: every pre-existing MockTest row behaves
 *     exactly as before this feature).
 *  5. First attempt / Result / Review — full start -> answer -> submit flow
 *     scores correctly and the frozen snapshot is readable afterward.
 *  6. Attempt policy — SINGLE_ATTEMPT blocks a second start after a
 *     SUBMITTED attempt; MULTIPLE_PRACTICE (default) allows it.
 *  7. Leaderboard — only the first SUBMITTED attempt per student is marked
 *     isLeaderboardAttempt; a MULTIPLE_PRACTICE retake never displaces it or
 *     appears twice in the leaderboard; ranking is deterministic (score,
 *     then accuracy, then time, then submission order).
 *  8. Student isolation / IDOR — one student's attempt is invisible via
 *     getOwnedAttempt scoped to a different student.
 *  9. TestResource release policy — AFTER_AVAILABLE_FROM, AFTER_SUBMISSION,
 *     CUSTOM_DATE, DISABLED all gate correctly; OMR_TEMPLATE always passes
 *     when isActive regardless of policy.
 * 10. RBAC — TEST_SERIES_MANAGE is granted to MASTER_ADMIN and withheld from
 *     FULL_ADMIN/TEACHER in DEFAULT_ROLE_PERMISSIONS.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-test-series-schedule.ts
 */
import "dotenv/config";
import {
  PrismaClient,
  StudentAuthProvider,
  QuestionStatus,
  QuestionDifficulty,
  MockTestStatus,
  AttemptStatus,
  RoleName,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { startMockTestAttempt, saveAnswer, submitAttempt } from "@/lib/test-attempt";
import { getOwnedAttempt } from "@/lib/student-data";
import { isMockTestAvailable, deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { getMockTestLeaderboard } from "@/lib/leaderboard";
import { canAccessTestResource } from "@/lib/test-resources-access";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

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
  console.log("=== Scheduled Mock Test Series Verification ===\n");
  const suffix = Date.now().toString(36);
  const now = Date.now();

  const exam = await prisma.exam.create({ data: { name: `Series Exam ${suffix}`, code: `TS-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Series Subject" } });

  async function makeQuestion() {
    return prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        code: `Q-TS-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        text: `Series fixture question ${Math.random().toString(36).slice(2, 6)}?`,
        examYear: 2024,
        difficulty: QuestionDifficulty.EASY,
        status: QuestionStatus.PUBLISHED,
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
  const questions = await Promise.all([makeQuestion(), makeQuestion()]);

  async function makeStudent(tag: string) {
    const passwordHash = await argon2.hash("Series@12345");
    return prisma.student.create({
      data: { studentId: `TS-${tag}-${suffix}`, name: `Series Student ${tag}`, email: `ts-${tag}-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
  }
  const studentA = await makeStudent("A");
  const studentB = await makeStudent("B");
  const studentC = await makeStudent("C");

  const mockTestIds: string[] = [];
  async function makeMockTest(opts: { availableFrom: Date | null; attemptPolicy?: "SINGLE_ATTEMPT" | "MULTIPLE_PRACTICE" }) {
    const mt = await prisma.mockTest.create({
      data: {
        examId: exam.id,
        title: `Series Mock Test ${suffix}-${mockTestIds.length}`,
        durationMinutes: 60,
        negativeMarking: 0.25,
        accessType: "FREE",
        status: MockTestStatus.PUBLISHED,
        availableFrom: opts.availableFrom,
        attemptPolicy: opts.attemptPolicy ?? "MULTIPLE_PRACTICE",
        questions: { create: questions.map((q, order) => ({ questionId: q.id, order })) },
      },
    });
    mockTestIds.push(mt.id);
    return mt;
  }

  console.log(`Fixture — exam ${exam.id}, subject ${subject.id}, students ${studentA.id}/${studentB.id}/${studentC.id}\n`);

  try {
    // ---- 1-4: availableFrom-derived access gating -----------------------
    console.log("--- availableFrom access gating ---");
    const upcoming = await makeMockTest({ availableFrom: new Date(now + 60 * 60_000) });
    check("derives UPCOMING before availableFrom", deriveMockTestAvailability(upcoming, new Date(now)) === "UPCOMING");
    await expectThrows("starting before availableFrom is rejected ('not available yet')", () => startMockTestAttempt(studentA.id, upcoming.id));
    const attemptCountBefore = await prisma.testAttempt.count({ where: { mockTestId: upcoming.id } });
    check("no TestAttempt row was created by the rejected start (no payload to leak)", attemptCountBefore === 0);

    const justReleased = await makeMockTest({ availableFrom: new Date(now - 1000) });
    check("derives AVAILABLE at/after availableFrom", deriveMockTestAvailability(justReleased, new Date(now)) === "AVAILABLE");
    const releasedAttempt = await startMockTestAttempt(studentA.id, justReleased.id);
    check("starting at/after availableFrom succeeds", releasedAttempt.status === AttemptStatus.IN_PROGRESS);

    const longAgo = await makeMockTest({ availableFrom: new Date(now - 365 * 24 * 60 * 60_000) });
    const longAgoAttempt = await startMockTestAttempt(studentB.id, longAgo.id);
    check("a test scheduled long ago is still startable (no availableUntil)", longAgoAttempt.status === AttemptStatus.IN_PROGRESS);

    const legacy = await makeMockTest({ availableFrom: null });
    check("null availableFrom = available immediately (legacy behavior preserved)", isMockTestAvailable(legacy, new Date(now)));

    // ---- 5: full attempt flow -------------------------------------------
    console.log("\n--- First attempt / Result / Review ---");
    await saveAnswer(releasedAttempt.id, studentA.id, questions[0].id, "B", false);
    await saveAnswer(releasedAttempt.id, studentA.id, questions[1].id, "A", false);
    const result = await submitAttempt(releasedAttempt.id, studentA.id);
    check("scoring: 1 correct - 1 incorrect*0.25 = 0.75", result.score === 0.75);
    check("submitted attempt is marked SUBMITTED", result.status === AttemptStatus.SUBMITTED);
    const reviewLoad = await getOwnedAttempt(releasedAttempt.id, studentA.id);
    check("review can read the frozen question snapshot after submission", (reviewLoad?.questions.length ?? 0) === 2);

    // ---- 6: attempt policy -------------------------------------------
    console.log("\n--- Attempt policy ---");
    const singleAttemptTest = await makeMockTest({ availableFrom: new Date(now - 1000), attemptPolicy: "SINGLE_ATTEMPT" });
    const firstSingle = await startMockTestAttempt(studentA.id, singleAttemptTest.id);
    await submitAttempt(firstSingle.id, studentA.id);
    await expectThrows("SINGLE_ATTEMPT blocks a second start after submission", () => startMockTestAttempt(studentA.id, singleAttemptTest.id));

    const multiTest = await makeMockTest({ availableFrom: new Date(now - 1000), attemptPolicy: "MULTIPLE_PRACTICE" });
    const firstMulti = await startMockTestAttempt(studentA.id, multiTest.id);
    await submitAttempt(firstMulti.id, studentA.id);
    const secondMulti = await startMockTestAttempt(studentA.id, multiTest.id);
    check("MULTIPLE_PRACTICE allows a second start after submission", secondMulti.status === AttemptStatus.IN_PROGRESS && secondMulti.id !== firstMulti.id);
    await submitAttempt(secondMulti.id, studentA.id);

    // ---- 7: leaderboard ---------------------------------------------
    console.log("\n--- Leaderboard ---");
    const firstAttemptFresh = await prisma.testAttempt.findUniqueOrThrow({ where: { id: firstMulti.id } });
    const secondAttemptFresh = await prisma.testAttempt.findUniqueOrThrow({ where: { id: secondMulti.id } });
    check("first submission is marked isLeaderboardAttempt", firstAttemptFresh.isLeaderboardAttempt === true);
    check("practice retake is NOT marked isLeaderboardAttempt (does not displace rank)", secondAttemptFresh.isLeaderboardAttempt === false);

    // Second student scores higher (both correct) to verify deterministic ordering.
    const attemptB = await startMockTestAttempt(studentB.id, multiTest.id);
    await saveAnswer(attemptB.id, studentB.id, questions[0].id, "B", false);
    await saveAnswer(attemptB.id, studentB.id, questions[1].id, "B", false);
    await submitAttempt(attemptB.id, studentB.id);

    const leaderboard = await getMockTestLeaderboard(multiTest.id, studentA.id);
    check("leaderboard has exactly one entry per student despite A's retake", leaderboard.totalParticipants === 2);
    check("higher score ranks first (student B rank 1)", leaderboard.entries[0]?.studentId === studentB.id && leaderboard.entries[0]?.rank === 1);
    check("leaderboard never exposes phone/email fields", !("phone" in leaderboard.entries[0]!) && !("email" in leaderboard.entries[0]!));
    check("selfEntry resolves to the requesting student's own rank", leaderboard.selfEntry?.studentId === studentA.id);

    // ---- 8: student isolation / IDOR -----------------------------------
    console.log("\n--- Student isolation ---");
    const crossAccess = await getOwnedAttempt(releasedAttempt.id, studentC.id);
    check("a non-owned attempt is invisible to another student (IDOR-safe)", crossAccess === null);

    // ---- 9: resource release policy -------------------------------------
    console.log("\n--- TestResource release policy ---");
    check(
      "AFTER_AVAILABLE_FROM: locked while test is UPCOMING",
      canAccessTestResource({ resourceType: "PAPER_PDF", releasePolicy: "AFTER_AVAILABLE_FROM", releaseAt: null, isActive: true, mockTestAvailable: false, hasSubmittedAttempt: false }) === false
    );
    check(
      "AFTER_AVAILABLE_FROM: unlocked once test is AVAILABLE",
      canAccessTestResource({ resourceType: "PAPER_PDF", releasePolicy: "AFTER_AVAILABLE_FROM", releaseAt: null, isActive: true, mockTestAvailable: true, hasSubmittedAttempt: false }) === true
    );
    check(
      "AFTER_SUBMISSION: locked before the student has submitted",
      canAccessTestResource({ resourceType: "SOLUTION_PDF", releasePolicy: "AFTER_SUBMISSION", releaseAt: null, isActive: true, mockTestAvailable: true, hasSubmittedAttempt: false }) === false
    );
    check(
      "AFTER_SUBMISSION: unlocked after the student has submitted",
      canAccessTestResource({ resourceType: "SOLUTION_PDF", releasePolicy: "AFTER_SUBMISSION", releaseAt: null, isActive: true, mockTestAvailable: true, hasSubmittedAttempt: true }) === true
    );
    check(
      "CUSTOM_DATE: locked before releaseAt",
      canAccessTestResource({ resourceType: "SOLUTION_PDF", releasePolicy: "CUSTOM_DATE", releaseAt: new Date(now + 60_000), isActive: true, mockTestAvailable: true, hasSubmittedAttempt: true, now: new Date(now) }) === false
    );
    check(
      "CUSTOM_DATE: unlocked at/after releaseAt",
      canAccessTestResource({ resourceType: "SOLUTION_PDF", releasePolicy: "CUSTOM_DATE", releaseAt: new Date(now - 60_000), isActive: true, mockTestAvailable: true, hasSubmittedAttempt: true, now: new Date(now) }) === true
    );
    check(
      "DISABLED: never accessible regardless of state",
      canAccessTestResource({ resourceType: "SOLUTION_PDF", releasePolicy: "DISABLED", releaseAt: null, isActive: true, mockTestAvailable: true, hasSubmittedAttempt: true }) === false
    );
    check(
      "OMR_TEMPLATE: accessible whenever active, ignoring release policy",
      canAccessTestResource({ resourceType: "OMR_TEMPLATE", releasePolicy: "DISABLED", releaseAt: null, isActive: true, mockTestAvailable: false, hasSubmittedAttempt: false }) === true
    );
    check(
      "any resource: inactive is never accessible",
      canAccessTestResource({ resourceType: "OMR_TEMPLATE", releasePolicy: "AFTER_AVAILABLE_FROM", releaseAt: null, isActive: false, mockTestAvailable: true, hasSubmittedAttempt: true }) === false
    );

    // ---- 10: RBAC ---------------------------------------------------
    console.log("\n--- RBAC ---");
    check("MASTER_ADMIN has TEST_SERIES_MANAGE", DEFAULT_ROLE_PERMISSIONS[RoleName.MASTER_ADMIN].includes(PERMISSIONS.TEST_SERIES_MANAGE));
    check("FULL_ADMIN does NOT have TEST_SERIES_MANAGE (read-only on Test Series Control Center)", !DEFAULT_ROLE_PERMISSIONS[RoleName.FULL_ADMIN].includes(PERMISSIONS.TEST_SERIES_MANAGE));
    check("TEACHER does NOT have TEST_SERIES_MANAGE", !DEFAULT_ROLE_PERMISSIONS[RoleName.TEACHER].includes(PERMISSIONS.TEST_SERIES_MANAGE));
    check("FULL_ADMIN still has TESTS_MANAGE (Live Test unaffected)", DEFAULT_ROLE_PERMISSIONS[RoleName.FULL_ADMIN].includes(PERMISSIONS.TESTS_MANAGE));

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    const studentIds = [studentA.id, studentB.id, studentC.id];
    await prisma.answer.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.mockTestQuestion.deleteMany({ where: { mockTestId: { in: mockTestIds } } });
    await prisma.mockTest.deleteMany({ where: { id: { in: mockTestIds } } });
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
