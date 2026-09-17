/**
 * Regression coverage for the audit fix in app/student/ai-actions.ts /
 * lib/student-data.ts (hasInProgressAttemptForQuestion): Ask AI is shared by
 * both Attempt Review and Saved Questions, and neither call site carries an
 * attemptId — so without this check, a student could Save a question while
 * an attempt is still IN_PROGRESS (the Save button is on the live test
 * player) and immediately view its AI explanation from a second tab, before
 * submitting. This proves the gate blocks exactly that window and nothing
 * else: not gated with no attempt, gated while IN_PROGRESS, un-gated again
 * once SUBMITTED.
 *
 * Run from the repo root:
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ai-review-gate.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, QuestionStatus, QuestionDifficulty, TestType, AttemptSourceType, AttemptStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hasInProgressAttemptForQuestion } from "@/lib/student-data";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Gate Exam ${suffix}`, code: `GATE-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Gate Subject" } });
  const question = await prisma.question.create({
    data: {
      examId: exam.id,
      subjectId: subject.id,
      code: `Q-GATE-${suffix}`,
      text: "2+2?",
      examYear: 2024,
      status: QuestionStatus.PUBLISHED,
      difficulty: QuestionDifficulty.EASY,
      options: {
        create: [
          { label: "A", text: "3", isCorrect: false },
          { label: "B", text: "4", isCorrect: true },
          { label: "C", text: "5", isCorrect: false },
          { label: "D", text: "6", isCorrect: false },
        ],
      },
    },
  });
  const student = await prisma.student.create({
    data: {
      studentId: `GATE-${suffix}`,
      name: "Gate Student",
      email: `gate-${suffix}@example.test`,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });

  check("no attempt at all -> not gated", (await hasInProgressAttemptForQuestion(student.id, question.id)) === false);

  const attempt = await prisma.testAttempt.create({
    data: {
      studentId: student.id,
      sourceType: AttemptSourceType.SUBJECT_TEST,
      testType: TestType.SUBJECT_TEST,
      examId: exam.id,
      subjectId: subject.id,
      durationMinutes: 10,
      negativeMarking: 0,
      totalQuestions: 1,
      status: AttemptStatus.IN_PROGRESS,
      startedAt: new Date(),
    },
  });
  await prisma.testAttemptQuestion.create({
    data: { attemptId: attempt.id, questionId: question.id, order: 0, questionSnapshot: {} },
  });

  check("question inside an IN_PROGRESS attempt -> gated", (await hasInProgressAttemptForQuestion(student.id, question.id)) === true);

  await prisma.testAttempt.update({ where: { id: attempt.id }, data: { status: AttemptStatus.SUBMITTED, submittedAt: new Date() } });
  check("same question after attempt is SUBMITTED -> no longer gated", (await hasInProgressAttemptForQuestion(student.id, question.id)) === false);

  await prisma.testAttempt.delete({ where: { id: attempt.id } });
  await prisma.student.delete({ where: { id: student.id } });
  await prisma.question.delete({ where: { id: question.id } });
  await prisma.subject.delete({ where: { id: subject.id } });
  await prisma.exam.delete({ where: { id: exam.id } });

  console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
