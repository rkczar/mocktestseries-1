/**
 * Targeted verification for the "Targeted Student Experience Upgrade":
 * Active Exam dashboard scoping, Test on the Go (canonical engine reuse,
 * 1-minute-per-question timing, insufficient-availability handling),
 * Saved Questions counts (student + admin aggregate), and the Admin
 * WhatsApp Share template. Every fixture row is created here and deleted at
 * the end regardless of pass/fail — nothing touches real production data.
 *
 * Run from the repo root with the react-server condition so `import
 * "server-only"` resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-student-experience-upgrade.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, QuestionStatus, QuestionDifficulty } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { getExamSubjectsOverview, getExamScopedDashboardMetrics, isStudentEnrolledInExam, getSavedQuestionsCount } from "@/lib/student-data";
import { startSubjectTestAttempt } from "@/lib/test-attempt";
import { InsufficientQuestionsError, countPublishedQuestions } from "@/lib/question-selection";
import { getSavedQuestionsAdminOverview } from "@/lib/admin-saved-questions";
import { getWhatsAppShareConfig, saveWhatsAppShareConfig, renderWhatsAppShareText } from "@/lib/whatsapp-share-config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

function expectThrows(label: string, fn: () => Promise<unknown> | unknown): Promise<unknown> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        check(label, false);
        return null;
      },
      (error) => {
        check(label, true);
        return error;
      }
    );
}

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Verify Exam ${suffix}`, code: `VERIFY-${suffix}`, isActive: true } });
  const subjectPhysics = await prisma.subject.create({ data: { examId: exam.id, name: "Physics" } });
  const subjectChem = await prisma.subject.create({ data: { examId: exam.id, name: "Chemistry" } });

  const passwordHash = await argon2.hash("verify-password-not-real");
  const studentA = await prisma.student.create({
    data: { studentId: `MTS-VER-${suffix}A`, name: "Verify Student A", email: `verify-a-${suffix}@example.com`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const studentB = await prisma.student.create({
    data: { studentId: `MTS-VER-${suffix}B`, name: "Verify Student B", email: `verify-b-${suffix}@example.com`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });

  const questionIds: string[] = [];
  try {
    // 5 published questions in Physics, 0 in Chemistry — enough to exercise
    // both "plenty available" and "zero available" paths.
    for (let i = 0; i < 5; i++) {
      const q = await prisma.question.create({
        data: {
          code: `VERIFY-${suffix}-${i}`,
          examId: exam.id,
          subjectId: subjectPhysics.id,
          text: `Verification question ${i}`,
          difficulty: QuestionDifficulty.MEDIUM,
          status: QuestionStatus.PUBLISHED,
          options: {
            create: [
              { label: "A", text: "Correct", isCorrect: true, order: 0 },
              { label: "B", text: "Wrong", isCorrect: false, order: 1 },
            ],
          },
        },
      });
      questionIds.push(q.id);
    }

    // --- Section 1/2/27: enrollment gates Active Exam selection ---
    check("student A is NOT enrolled before enrolling", !(await isStudentEnrolledInExam(studentA.id, exam.id)));
    await prisma.studentExamEnrollment.create({ data: { studentId: studentA.id, examId: exam.id } });
    check("student A IS enrolled after enrolling", await isStudentEnrolledInExam(studentA.id, exam.id));
    check("student B (never enrolled) is NOT enrolled", !(await isStudentEnrolledInExam(studentB.id, exam.id)));

    // --- Section 3/26: Subjects in <Active Exam>, real DB counts, one query ---
    const overview = await getExamSubjectsOverview(exam.id);
    const physicsRow = overview.find((s) => s.id === subjectPhysics.id);
    const chemRow = overview.find((s) => s.id === subjectChem.id);
    check("Physics shows the real published count (5)", physicsRow?.questionCount === 5);
    check("Chemistry (no questions) shows 0, not omitted", chemRow?.questionCount === 0);
    const directCount = await countPublishedQuestions({ examId: exam.id, subjectId: subjectPhysics.id });
    check("overview count matches countPublishedQuestions directly", physicsRow?.questionCount === directCount);

    // --- Section 2: exam-scoped dashboard metrics don't throw for a fresh student ---
    const metrics = await getExamScopedDashboardMetrics(studentA.id, exam.id);
    check("fresh student has 0 tests completed for this exam", metrics.testsCompleted === 0);
    check("fresh student has no in-progress attempt", metrics.inProgress === null);

    // --- Section 5/7: Test on the Go reuses the canonical engine, 1Q = 1min ---
    const count = 3;
    const attempt = await startSubjectTestAttempt(studentA.id, { examId: exam.id, subjectId: subjectPhysics.id, count, durationMinutes: count });
    check("Test on the Go attempt has totalQuestions === requested count", attempt.totalQuestions === count);
    check("Test on the Go attempt duration === count minutes (1 question = 1 minute)", attempt.durationMinutes === count);
    check("attempt is the canonical SUBJECT_TEST type (no parallel engine)", attempt.testType === "SUBJECT_TEST");

    // --- Section 6: requesting more than available throws with the real available count ---
    const error = await expectThrows("requesting more than available throws InsufficientQuestionsError", () =>
      startSubjectTestAttempt(studentB.id, { examId: exam.id, subjectId: subjectPhysics.id, count: 999, durationMinutes: 999 })
    );
    check(
      "...and reports the real available count (5)",
      error instanceof InsufficientQuestionsError && error.available === 5
    );

    // --- Section 6: zero available never starts a test ---
    await expectThrows("zero-availability subject cannot start a test", () =>
      startSubjectTestAttempt(studentB.id, { examId: exam.id, subjectId: subjectChem.id, count: 1, durationMinutes: 1 })
    );

    // --- Section 17/18: Saved Questions counts (student card + Admin view) use the same real data ---
    await prisma.savedQuestion.create({ data: { studentId: studentA.id, questionId: questionIds[0] } });
    await prisma.savedQuestion.create({ data: { studentId: studentB.id, questionId: questionIds[0] } });
    const savedCountA = await getSavedQuestionsCount(studentA.id, exam.id);
    check("student A's exam-scoped saved count is 1", savedCountA === 1);
    const adminOverview = await getSavedQuestionsAdminOverview({ examId: exam.id });
    const adminRow = adminOverview.rows.find((r) => r.questionId === questionIds[0]);
    check("Admin Saved Questions aggregates BOTH students' saves for the same question (2)", adminRow?.saveCount === 2);
    check("Admin overview never duplicates SavedQuestion rows — distinctQuestions === 1", adminOverview.distinctQuestions === 1);

    // --- Section 16: Admin WhatsApp Share template, enabled gate, placeholders ---
    const before = await getWhatsAppShareConfig();
    check("WhatsApp Share defaults to disabled when never configured", before.enabled === false || before.updatedAt !== null);
    await saveWhatsAppShareConfig({ enabled: true, template: "{{question}} | {{exam}} | {{subject}} | {{website_url}} | {{unknown_token}}" });
    const after = await getWhatsAppShareConfig();
    check("WhatsApp Share config round-trips through Setting", after.enabled === true);
    const rendered = renderWhatsAppShareText(after.template, { exam: "Verify Exam", subject: "Physics", question: "Q?", website_url: "https://x.test" });
    check("known placeholders are substituted", rendered.includes("Q?") && rendered.includes("Verify Exam") && rendered.includes("Physics") && rendered.includes("https://x.test"));
    check("unknown placeholders are left untouched, never silently dropped", rendered.includes("{{unknown_token}}"));
    // Restore whatever was there before this run (disabled default) so the
    // verify script never leaves a live setting behind.
    await saveWhatsAppShareConfig({ enabled: before.enabled, template: before.template });

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.answer.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.savedQuestion.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: [studentA.id, studentB.id] } } });
    await prisma.student.deleteMany({ where: { id: { in: [studentA.id, studentB.id] } } });
    await prisma.question.deleteMany({ where: { examId: exam.id } });
    await prisma.subject.deleteMany({ where: { examId: exam.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
