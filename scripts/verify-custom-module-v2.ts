/**
 * Verifies the Step 4 repair: Custom Module V2 (student self-service
 * builder). Covers exactly the gaps found during the Step 4 regression gate:
 *
 *  1. History filters — Incorrect / Unattempted / Saved resolve to exactly
 *     the expected question ids for one student's own history, scoped to
 *     PUBLISHED questions in the right exam.
 *  2. Resolve-once — the module's question set is frozen at creation;
 *     starting it again (refresh/resume) returns the SAME attempt, never a
 *     reshuffle.
 *  3. Cross-student privacy — a private, student-owned module cannot be
 *     read (getCustomModuleDetailForStudent) or started
 *     (startCustomModuleAttempt) by a different student, even knowing its id.
 *  4. Secure sharing — a share link only works via its unguessable token
 *     (not the module id), and lets a different student start their OWN
 *     independent attempt against the same fixed question set.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-custom-module-v2.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, QuestionStatus, QuestionDifficulty, AnswerStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { countPublishedQuestions, selectPublishedQuestions } from "@/lib/question-selection";
import { startCustomModuleAttempt, startSharedCustomModuleAttempt } from "@/lib/test-attempt";
import {
  getCustomModuleDetailForStudent,
  ensureCustomModuleShareToken,
  getCustomModuleByShareToken,
} from "@/lib/student-data";

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
  console.log("=== Custom Module V2 Verification ===\n");
  const suffix = Date.now().toString(36);

  const exam = await prisma.exam.create({ data: { name: `CMV2 Exam ${suffix}`, code: `CMV2-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "CMV2 Subject" } });

  async function makeQuestion(status: QuestionStatus = QuestionStatus.PUBLISHED) {
    return prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        code: `Q-CMV2-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        text: `CMV2 fixture question ${Math.random().toString(36).slice(2, 6)}?`,
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

  // q1: will be answered incorrectly. q2: never attempted. q3: saved. q4: plain published, no history.
  const [q1, q2, q3, q4] = await Promise.all([makeQuestion(), makeQuestion(), makeQuestion(), makeQuestion()]);
  await makeQuestion(QuestionStatus.DRAFT); // must never surface

  const passwordHash = await argon2.hash("Cmv2@12345");
  const [studentA, studentB] = await Promise.all([
    prisma.student.create({
      data: { studentId: `CMV2A-${suffix}`, name: "CMV2 Student A", email: `cmv2a-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    }),
    prisma.student.create({
      data: { studentId: `CMV2B-${suffix}`, name: "CMV2 Student B", email: `cmv2b-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    }),
  ]);

  const moduleIds: string[] = [];
  console.log(`Fixture — exam ${exam.id}, subject ${subject.id}, studentA ${studentA.id}, studentB ${studentB.id}\n`);

  try {
    // Build studentA's history: q1 answered incorrectly, q3 saved. q2/q4 untouched.
    const historyAttempt = await prisma.testAttempt.create({
      data: {
        studentId: studentA.id,
        sourceType: "SUBJECT_TEST",
        testType: "SUBJECT_TEST",
        examId: exam.id,
        subjectId: subject.id,
        durationMinutes: 10,
        negativeMarking: 0,
        totalQuestions: 1,
        status: "SUBMITTED",
      },
    });
    const historyTAQ = await prisma.testAttemptQuestion.create({
      data: { attemptId: historyAttempt.id, questionId: q1.id, order: 0, questionSnapshot: { correctLabel: "B", options: [] } },
    });
    await prisma.answer.create({
      data: { attemptId: historyAttempt.id, attemptQuestionId: historyTAQ.id, studentId: studentA.id, questionId: q1.id, selectedOptionLabel: "A", isCorrect: false, status: AnswerStatus.ANSWERED },
    });
    await prisma.savedQuestion.create({ data: { studentId: studentA.id, questionId: q3.id } });

    // ---- 1. History filters ------------------------------------------
    console.log("--- History filters ---");
    const incorrectCount = await countPublishedQuestions({ examId: exam.id, studentId: studentA.id, attemptFilter: "INCORRECT" });
    check("INCORRECT filter finds exactly the one wrongly-answered question", incorrectCount === 1);
    const incorrectSel = await selectPublishedQuestions({ examId: exam.id, studentId: studentA.id, attemptFilter: "INCORRECT", count: 1 });
    check("...and it is q1", incorrectSel.questions[0]?.id === q1.id);

    const savedCount = await countPublishedQuestions({ examId: exam.id, studentId: studentA.id, attemptFilter: "SAVED" });
    check("SAVED filter finds exactly the one saved question", savedCount === 1);
    const savedSel = await selectPublishedQuestions({ examId: exam.id, studentId: studentA.id, attemptFilter: "SAVED", count: 1 });
    check("...and it is q3", savedSel.questions[0]?.id === q3.id);

    const unattemptedCount = await countPublishedQuestions({ examId: exam.id, studentId: studentA.id, attemptFilter: "UNATTEMPTED" });
    check("UNATTEMPTED filter excludes q1 (attempted) — finds q2, q3, q4 (3)", unattemptedCount === 3);

    const unfilteredCount = await countPublishedQuestions({ examId: exam.id, studentId: studentB.id, attemptFilter: "INCORRECT" });
    check("a different student's INCORRECT filter is empty (history is per-student)", unfilteredCount === 0);

    // ---- 2. Resolve-once + privacy -------------------------------------
    console.log("\n--- Resolve-once & cross-student privacy ---");
    const privateModule = await prisma.customModule.create({
      data: {
        examId: exam.id,
        title: "Student A private module",
        selectionMode: "RULE_BASED",
        durationMinutes: 15,
        accessType: "FREE",
        status: "ACTIVE",
        isStudentOwned: true,
        createdByStudentId: studentA.id,
      },
    });
    moduleIds.push(privateModule.id);
    await prisma.customModuleQuestion.createMany({
      data: [q2, q4].map((q, order) => ({ customModuleId: privateModule.id, questionId: q.id, order })),
    });

    const detailForOwner = await getCustomModuleDetailForStudent(privateModule.id, studentA.id);
    check("owner can read their own private module", detailForOwner !== null);
    const detailForOther = await getCustomModuleDetailForStudent(privateModule.id, studentB.id);
    check("a different student CANNOT read it by id — getCustomModuleDetailForStudent returns null", detailForOther === null);

    await expectThrows("a different student CANNOT start it by id — startCustomModuleAttempt throws", () =>
      startCustomModuleAttempt(studentB.id, privateModule.id)
    );

    const attempt1 = await startCustomModuleAttempt(studentA.id, privateModule.id);
    check("owner can start their own module", attempt1.customModuleId === privateModule.id);
    const attemptQuestions = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt1.id }, orderBy: { order: "asc" } });
    check("frozen set matches CustomModuleQuestion exactly ([q2, q4])", JSON.stringify(attemptQuestions.map((q) => q.questionId)) === JSON.stringify([q2.id, q4.id]));

    const attempt2 = await startCustomModuleAttempt(studentA.id, privateModule.id);
    check("starting again (refresh/resume) returns the SAME attempt — never regenerated", attempt2.id === attempt1.id);

    // ---- 3. Secure sharing ------------------------------------------
    console.log("\n--- Secure sharing (token, not id) ---");
    const token = await ensureCustomModuleShareToken(privateModule.id, studentA.id);
    check("share token is generated and non-empty", typeof token === "string" && token.length > 10);
    const sameToken = await ensureCustomModuleShareToken(privateModule.id, studentA.id);
    check("re-requesting a share token is idempotent (same token, not a new one each time)", sameToken === token);

    await expectThrows("a non-owner cannot mint a share token for someone else's module", () =>
      ensureCustomModuleShareToken(privateModule.id, studentB.id)
    );

    const byToken = await getCustomModuleByShareToken(token);
    check("the module resolves by its real token", byToken?.id === privateModule.id);
    const byGarbageToken = await getCustomModuleByShareToken("not-a-real-token");
    check("a guessed/garbage token resolves to nothing", byGarbageToken === null);

    const sharedAttempt = await startSharedCustomModuleAttempt(studentB.id, token);
    check("a different student CAN start it via the token — gets their own attempt", sharedAttempt.studentId === studentB.id);
    check("...against the same frozen question set", sharedAttempt.customModuleId === privateModule.id);
    check("...as an INDEPENDENT attempt, not student A's", sharedAttempt.id !== attempt1.id);

    const sharedAttemptAgain = await startSharedCustomModuleAttempt(studentB.id, token);
    check("student B resuming via the token returns their own same attempt (no reshuffle)", sharedAttemptAgain.id === sharedAttempt.id);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.answer.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.savedQuestion.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.customModuleQuestion.deleteMany({ where: { customModuleId: { in: moduleIds } } });
    await prisma.customModule.deleteMany({ where: { id: { in: moduleIds } } });
    await prisma.student.deleteMany({ where: { id: { in: [studentA.id, studentB.id] } } });
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
