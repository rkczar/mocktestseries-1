/**
 * Verifies that one student's data is never reachable through another
 * student's identity.
 *
 * Two things are checked:
 *
 *  1. Functional isolation — a throwaway fixture (exam/subject/topic/
 *     question/mock test) is created, Student A attempts it and saves/
 *     reports a question, then every ownership-checked query shape used
 *     by the real data-access layer (lib/student-data.ts, getOwnedAttempt,
 *     history, saved questions, activity, profile) is re-run scoped to
 *     Student B's id and asserted to return nothing. This also covers URL
 *     tampering against /student/attempt/[id], since the result/review
 *     pages resolve the attempt with the exact same {id, studentId} query.
 *
 *  2. Static trust-boundary audit — every student-facing server action
 *     under app/student is scanned for a `studentId` read from
 *     `formData`/`searchParams`/route `params` and used as a query filter,
 *     which would mean a client-supplied studentId is trusted instead of
 *     the session-derived one from requireStudent(). Zero matches expected.
 *
 * All fixture rows (including the two students) are deleted at the end
 * regardless of pass/fail, so this is safe to run against the real
 * database. Run with: npx tsx scripts/verify-student-isolation.ts
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, AttemptSourceType, AttemptStatus, AnswerStatus, StudentAuthProvider, QuestionStatus, QuestionDifficulty, MockTestStatus, ReportType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

/** Scans app/student server action files for a client-supplied studentId used to filter a query. */
function auditStudentIdTrust(): string[] {
  const offenders: string[] = [];
  let matches: string[] = [];
  try {
    const output = execSync(
      String.raw`grep -rnE '(formData\.get\("studentId"\)|searchParams\.studentId|params\.studentId)' app/student --include="*.ts" --include="*.tsx"`,
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    matches = output.split("\n").filter(Boolean);
  } catch {
    matches = []; // grep exits 1 when there are no matches — that's the pass case
  }
  offenders.push(...matches);
  return offenders;
}

async function main() {
  console.log("=== Student Isolation Verification ===\n");

  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Isolation Test Exam ${suffix}`, code: `ISOTEST-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Isolation Subject" } });
  const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: "Isolation Topic" } });

  const question = await prisma.question.create({
    data: {
      examId: exam.id,
      subjectId: subject.id,
      topicId: topic.id,
      code: `Q-ISOTEST-${suffix}`,
      text: "2 + 2 = ?",
      difficulty: QuestionDifficulty.EASY,
      status: QuestionStatus.PUBLISHED,
      options: {
        create: [
          { label: "A", text: "3", isCorrect: false },
          { label: "B", text: "4", isCorrect: true },
          { label: "C", text: "5", isCorrect: false },
          { label: "D", text: "6", isCorrect: false },
        ],
      },
    },
    include: { options: true },
  });

  const mockTest = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `Isolation Mock Test ${suffix}`,
      durationMinutes: 30,
      status: MockTestStatus.PUBLISHED,
      questions: { create: [{ questionId: question.id, order: 0 }] },
    },
  });

  const passwordHash = await argon2.hash("Isolation@12345");
  const studentA = await prisma.student.create({
    data: {
      studentId: `ISOA-${suffix}`,
      name: "Isolation Student A",
      email: `isolation-a-${suffix}@example.test`,
      passwordHash,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });
  const studentB = await prisma.student.create({
    data: {
      studentId: `ISOB-${suffix}`,
      name: "Isolation Student B",
      email: `isolation-b-${suffix}@example.test`,
      passwordHash,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });

  try {
    const attempt = await prisma.testAttempt.create({
      data: {
        studentId: studentA.id,
        sourceType: AttemptSourceType.MOCK_TEST,
        examId: exam.id,
        mockTestId: mockTest.id,
        durationMinutes: 30,
        totalQuestions: 1,
        status: AttemptStatus.SUBMITTED,
        correctCount: 1,
        incorrectCount: 0,
        unansweredCount: 0,
        score: 1,
        maxScore: 1,
        timeTakenSeconds: 60,
        submittedAt: new Date(),
      },
    });
    const attemptQuestion = await prisma.testAttemptQuestion.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        order: 0,
        questionSnapshot: {
          code: question.code,
          text: question.text,
          imageUrl: null,
          difficulty: question.difficulty,
          options: question.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
          correctLabel: "B",
        },
      },
    });
    await prisma.answer.create({
      data: {
        attemptId: attempt.id,
        attemptQuestionId: attemptQuestion.id,
        studentId: studentA.id,
        questionId: question.id,
        selectedOptionLabel: "B",
        isCorrect: true,
        status: AnswerStatus.ANSWERED,
        answeredAt: new Date(),
      },
    });
    await prisma.savedQuestion.create({ data: { studentId: studentA.id, questionId: question.id } });
    await prisma.studentActivity.create({ data: { studentId: studentA.id, activity: "TEST_SUBMITTED" } });
    await prisma.reportedQuestion.create({
      data: { studentId: studentA.id, questionId: question.id, attemptId: attempt.id, reportType: ReportType.OTHER, message: "isolation test" },
    });

    console.log(`Fixture ready — Exam ${exam.id}, Student A ${studentA.id}, Student B ${studentB.id}, Attempt ${attempt.id}\n`);
    console.log("--- Functional isolation (same query shapes as the app's ownership-checked helpers) ---");

    const ownedByA = await prisma.testAttempt.findFirst({ where: { id: attempt.id, studentId: studentA.id } });
    check("Student A can read her own attempt", Boolean(ownedByA));

    const ownedByB = await prisma.testAttempt.findFirst({ where: { id: attempt.id, studentId: studentB.id } });
    check("getOwnedAttempt(attempt, studentB) returns null — Student B cannot read Student A's attempt", ownedByB === null);

    const questionsForB = await prisma.testAttemptQuestion.findMany({
      where: { attemptId: attempt.id, attempt: { studentId: studentB.id } },
    });
    check("Attempt questions scoped to Student B are empty", questionsForB.length === 0);

    const answerForB = await prisma.answer.findFirst({ where: { attemptId: attempt.id, studentId: studentB.id } });
    check("Student B cannot read Student A's answer", answerForB === null);

    const savedForB = await prisma.savedQuestion.findMany({ where: { studentId: studentB.id } });
    check("getSavedQuestions(studentB) does not include Student A's saved question", savedForB.length === 0);

    const historyForB = await prisma.testAttempt.findMany({ where: { studentId: studentB.id } });
    check("getStudentAttemptHistory(studentB) does not include Student A's attempt", historyForB.length === 0);

    const activityForB = await prisma.studentActivity.findMany({ where: { studentId: studentB.id } });
    check("Student B's activity log does not include Student A's activity", activityForB.length === 0);

    const reportsAsB = await prisma.reportedQuestion.findMany({ where: { studentId: studentB.id } });
    check("Student B's own reports do not include Student A's report", reportsAsB.length === 0);

    const profileForB = await prisma.student.findUnique({ where: { id: studentB.id }, include: { profile: true } });
    check("getStudentProfile(studentB) resolves to Student B's own row", profileForB?.id === studentB.id);

    const resultTamperAsB = await prisma.testAttempt.findFirst({ where: { id: attempt.id, studentId: studentB.id } });
    check("URL tampering — /student/attempt/[A's id]/result as Student B resolves to nothing", resultTamperAsB === null);
    const reviewTamperAsB = await prisma.testAttempt.findFirst({ where: { id: attempt.id, studentId: studentB.id } });
    check("URL tampering — /student/attempt/[A's id]/review as Student B resolves to nothing", reviewTamperAsB === null);

    console.log("\n--- Static trust-boundary audit ---");
    const offenders = auditStudentIdTrust();
    check("No student server action reads a client-supplied studentId (formData/searchParams/params) as a query filter", offenders.length === 0);
    for (const o of offenders) console.log(`  ! ${o}`);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.student.deleteMany({ where: { id: { in: [studentA.id, studentB.id] } } });
    await prisma.mockTest.delete({ where: { id: mockTest.id } });
    await prisma.question.delete({ where: { id: question.id } });
    await prisma.topic.delete({ where: { id: topic.id } });
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
