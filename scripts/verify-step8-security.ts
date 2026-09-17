/**
 * Step 8 — targeted cross-cutting security checks for the Live Test surface
 * that no prior script explicitly exercised (everything else — Grand Test,
 * Custom Module V2, Subject Test, AI review, AI variants, enrollment,
 * dashboard/analytics — already has its own dedicated verify script with
 * cross-exam/cross-student coverage baked in; see scripts/verify-*.ts).
 *
 *  1. Cross-student IDOR on a Live Test attempt — Student B cannot read or
 *     edit Student A's attempt via the same ownership-checked paths every
 *     other test type uses (getOwnedAttempt, saveAnswer).
 *  2. Live Test review-lock data check — the actual field the review page
 *     gates on (attempt.liveTest.status) reflects RESULT_PUBLISHED
 *     correctly through the same read path the page uses.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-step8-security.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, QuestionStatus, QuestionDifficulty, LiveTestStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { startLiveTestAttempt, saveAnswer } from "@/lib/test-attempt";
import { getOwnedAttempt } from "@/lib/student-data";

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
  console.log("=== Step 8 — Live Test cross-student security ===\n");
  const suffix = Date.now().toString(36);

  const exam = await prisma.exam.create({ data: { name: `Step8 Exam ${suffix}`, code: `STEP8-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Step8 Subject" } });
  const question = await prisma.question.create({
    data: {
      examId: exam.id,
      subjectId: subject.id,
      code: `Q-STEP8-${suffix}`,
      text: "Step8 fixture question?",
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
  });

  const passwordHash = await argon2.hash("Step8@12345");
  const [studentA, studentB] = await Promise.all([
    prisma.student.create({ data: { studentId: `STEP8A-${suffix}`, name: "Step8 A", email: `step8a-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS } }),
    prisma.student.create({ data: { studentId: `STEP8B-${suffix}`, name: "Step8 B", email: `step8b-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS } }),
  ]);

  const now = Date.now();
  const liveTest = await prisma.liveTest.create({
    data: {
      examId: exam.id,
      title: `Step8 Live Test ${suffix}`,
      startAt: new Date(now - 5 * 60_000),
      endAt: new Date(now + 55 * 60_000),
      studentDurationMinutes: 30,
      negativeMarking: 0,
      accessType: "FREE",
      questionCount: 1,
      status: LiveTestStatus.SCHEDULED,
      blueprint: [{ subjectId: subject.id, count: 1 }] as unknown as object,
      publishedAt: new Date(),
    },
  });
  await prisma.liveTestQuestion.create({ data: { liveTestId: liveTest.id, questionId: question.id, order: 0 } });

  try {
    const attemptA = await startLiveTestAttempt(studentA.id, liveTest.id);

    console.log("--- Cross-student IDOR on a Live Test attempt ---");
    const readByOwner = await getOwnedAttempt(attemptA.id, studentA.id);
    check("Student A can read her own Live Test attempt", readByOwner?.id === attemptA.id);

    const readByOther = await getOwnedAttempt(attemptA.id, studentB.id);
    check("Student B CANNOT read Student A's Live Test attempt (getOwnedAttempt returns null)", readByOther === null);

    await expectThrows("Student B CANNOT save an answer on Student A's Live Test attempt", () =>
      saveAnswer(attemptA.id, studentB.id, question.id, "B", false)
    );

    // Student B starting the SAME live test gets their OWN attempt, never A's.
    const attemptB = await startLiveTestAttempt(studentB.id, liveTest.id);
    check("Student B starting the same live test gets an independent attempt, not Student A's", attemptB.id !== attemptA.id);
    check("...and it belongs to Student B", attemptB.studentId === studentB.id);

    console.log("\n--- Review-lock data check ---");
    const beforePublish = await getOwnedAttempt(attemptA.id, studentA.id);
    check("before Publish Result, the field the review page gates on is NOT RESULT_PUBLISHED", beforePublish?.liveTest?.status !== "RESULT_PUBLISHED");

    await prisma.liveTest.update({ where: { id: liveTest.id }, data: { status: LiveTestStatus.RESULT_PUBLISHED } });
    const afterPublish = await getOwnedAttempt(attemptA.id, studentA.id);
    check("after Publish Result, the same field now reads RESULT_PUBLISHED", afterPublish?.liveTest?.status === "RESULT_PUBLISHED");

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    const studentIds = [studentA.id, studentB.id];
    await prisma.answer.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.liveTestQuestion.deleteMany({ where: { liveTestId: liveTest.id } });
    await prisma.liveTest.delete({ where: { id: liveTest.id } });
    await prisma.question.delete({ where: { id: question.id } });
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
