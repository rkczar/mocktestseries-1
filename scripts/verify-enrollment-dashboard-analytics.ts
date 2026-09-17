/**
 * Verifies Step 7.5–7.7: exam enrollment, dashboard metrics, and analytics —
 * every number is a real server-side aggregate against a student's own rows,
 * checked against hand-computed expected values from a known fixture.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-enrollment-dashboard-analytics.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, QuestionStatus, QuestionDifficulty, AttemptStatus, AnswerStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import {
  enrollInExam,
  unenrollFromExam,
  getEnrolledExams,
  getUpcomingExamForStudent,
  getDashboardMetrics,
  getStudentAnalytics,
  getWeakTopics,
} from "@/lib/student-data";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

async function main() {
  console.log("=== Enrollment / Dashboard / Analytics Verification ===\n");
  const suffix = Date.now().toString(36);

  const examA = await prisma.exam.create({ data: { name: `Dash Exam A ${suffix}`, code: `DASHA-${suffix}`, isActive: true } });
  const examB = await prisma.exam.create({
    data: { name: `Dash Exam B ${suffix}`, code: `DASHB-${suffix}`, isActive: true, isUpcoming: true, upcomingDate: new Date(Date.now() + 10 * 24 * 60 * 60_000) },
  });
  const examC = await prisma.exam.create({
    data: { name: `Dash Exam C ${suffix}`, code: `DASHC-${suffix}`, isActive: true, isUpcoming: true, upcomingDate: new Date(Date.now() + 3 * 24 * 60 * 60_000) },
  });
  const subjectA = await prisma.subject.create({ data: { examId: examA.id, name: "Dash Subject A" } });
  const topic1 = await prisma.topic.create({ data: { subjectId: subjectA.id, name: "Weak Topic 1" } });
  const topic2 = await prisma.topic.create({ data: { subjectId: subjectA.id, name: "Weak Topic 2" } });

  async function makeQuestion(topicId: string) {
    return prisma.question.create({
      data: {
        examId: examA.id,
        subjectId: subjectA.id,
        topicId,
        code: `Q-DASH-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        text: "Dashboard fixture question?",
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
  }
  const q1 = await makeQuestion(topic1.id); // will be answered WRONG twice (2 attempts)
  const q2 = await makeQuestion(topic1.id); // answered WRONG once
  const q3 = await makeQuestion(topic2.id); // answered WRONG once
  const q4 = await makeQuestion(topic1.id); // answered CORRECT

  const passwordHash = await argon2.hash("Dash@12345");
  const student = await prisma.student.create({
    data: { studentId: `DASH-${suffix}`, name: "Dash Student", email: `dash-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });

  const attemptIds: string[] = [];
  const questionIds = [q1.id, q2.id, q3.id, q4.id];

  try {
    // ---- 1. Enrollment --------------------------------------------------
    console.log("--- Enrollment ---");
    check("student starts with no enrollments", (await getEnrolledExams(student.id)).length === 0);
    await enrollInExam(student.id, examA.id);
    await enrollInExam(student.id, examA.id); // idempotent
    const enrolled = await getEnrolledExams(student.id);
    check("enrolling (twice) results in exactly one enrollment row", enrolled.length === 1 && enrolled[0].id === examA.id);
    await unenrollFromExam(student.id, examA.id);
    check("unenrolling removes it", (await getEnrolledExams(student.id)).length === 0);

    // Upcoming exam: enrolled exam (examB, 10d out) should NOT beat a non-enrolled, sooner exam (examC, 3d out)
    // once the student enrolls specifically in examC — enrolled exams are preferred, nearest first.
    await enrollInExam(student.id, examC.id);
    const upcoming1 = await getUpcomingExamForStudent(student.id);
    check("with only examC enrolled, examC (enrolled) wins over examB (not enrolled, further out anyway)", upcoming1?.id === examC.id);

    await enrollInExam(student.id, examB.id); // now enrolled in both B (10d) and C (3d)
    const upcoming2 = await getUpcomingExamForStudent(student.id);
    check("with both B and C enrolled, the NEARER enrolled one (C, 3d) wins over the further one (B, 10d)", upcoming2?.id === examC.id);
    check("daysLeft is computed and positive for an upcoming exam", (await getDashboardMetrics(student.id)).upcomingExam?.daysLeft === 3 || (await getDashboardMetrics(student.id)).upcomingExam!.daysLeft! > 0);

    // ---- 2. Build a known attempt/answer history for dashboard + analytics checks ----
    console.log("\n--- Building known fixture history ---");
    async function makeSubmittedAttempt(questionAnswers: { question: typeof q1; selected: string; correct: boolean }[], score: number, subjectId?: string) {
      const attempt = await prisma.testAttempt.create({
        data: {
          studentId: student.id,
          sourceType: "SUBJECT_TEST",
          testType: "SUBJECT_TEST",
          examId: examA.id,
          subjectId: subjectId ?? null,
          durationMinutes: 10,
          negativeMarking: 0,
          totalQuestions: questionAnswers.length,
          status: AttemptStatus.SUBMITTED,
          submittedAt: new Date(),
          score,
          maxScore: questionAnswers.length,
        },
      });
      for (const [i, qa] of questionAnswers.entries()) {
        const taq = await prisma.testAttemptQuestion.create({
          data: { attemptId: attempt.id, questionId: qa.question.id, order: i, questionSnapshot: { correctLabel: "B", options: [] } },
        });
        await prisma.answer.create({
          data: {
            attemptId: attempt.id,
            attemptQuestionId: taq.id,
            studentId: student.id,
            questionId: qa.question.id,
            selectedOptionLabel: qa.selected,
            isCorrect: qa.correct,
            status: AnswerStatus.ANSWERED,
            answeredAt: new Date(),
          },
        });
      }
      attemptIds.push(attempt.id);
      return attempt;
    }

    // Attempt 1 (subjectA): q1 wrong, q4 correct — score 1/2
    await makeSubmittedAttempt(
      [
        { question: q1, selected: "A", correct: false },
        { question: q4, selected: "B", correct: true },
      ],
      1,
      subjectA.id
    );
    // Attempt 2 (subjectA): q1 wrong again, q2 wrong, q3 wrong — score 0/3
    await makeSubmittedAttempt(
      [
        { question: q1, selected: "A", correct: false },
        { question: q2, selected: "A", correct: false },
        { question: q3, selected: "A", correct: false },
      ],
      0,
      subjectA.id
    );

    // ---- 3. Dashboard metrics --------------------------------------------
    console.log("\n--- Dashboard metrics ---");
    const metrics = await getDashboardMetrics(student.id);
    check("testsCompleted counts both submitted attempts", metrics.testsCompleted === 2);
    check("questionsAttempted is the DISTINCT question count across both attempts (q1,q2,q3,q4 → 4, not 5)", metrics.questionsAttempted === 4);
    check("mcqSolvedToday counts today's answers (all 5 answered just now)", metrics.mcqSolvedToday === 5);
    check("averageScore is (1+0)/2 = 0.5", metrics.averageScore === 0.5);
    check("recentTest reflects the most recently submitted attempt", metrics.recentTest !== null && metrics.recentTest.score === 0);
    check("inProgress is null (nothing left in progress)", metrics.inProgress === null);

    const weak = await getWeakTopics(student.id, 5);
    check("weak topics: topic1 (q1 wrong x2 + q2 wrong x1 = 3) outranks topic2 (q3 wrong x1 = 1)", weak[0]?.name === "Weak Topic 1" && weak[0].incorrectCount === 3);
    check("...topic2 is second with count 1", weak[1]?.name === "Weak Topic 2" && weak[1].incorrectCount === 1);

    // ---- 4. Analytics -----------------------------------------------------
    console.log("\n--- Analytics ---");
    const analytics = await getStudentAnalytics(student.id);
    check("correct count is 1 (only q4)", analytics.correct === 1);
    check("incorrect count is 4 (q1 x2, q2, q3)", analytics.incorrect === 4);
    check("accuracy is 1/(1+4) = 20%", analytics.accuracy !== null && Math.abs(analytics.accuracy - 20) < 0.01);
    check("exam performance shows examA with 2 attempts, avg score 0.5", analytics.examPerformance.some((e) => e.examId === examA.id && e.attempts === 2 && e.averageScore === 0.5));
    check("subject performance shows subjectA with 2 attempts, avg score 0.5", analytics.subjectPerformance.some((s) => s.subjectId === subjectA.id && s.attempts === 2 && s.averageScore === 0.5));
    check("performanceOverTime has 2 entries, oldest first", analytics.performanceOverTime.length === 2 && analytics.performanceOverTime[0].score === 1 && analytics.performanceOverTime[1].score === 0);
    check("analytics weakTopics agrees with dashboard weakTopics (topic1 first)", analytics.weakTopics[0]?.name === "Weak Topic 1");

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.answer.deleteMany({ where: { studentId: student.id } });
    await prisma.testAttempt.deleteMany({ where: { studentId: student.id } });
    await prisma.studentExamEnrollment.deleteMany({ where: { studentId: student.id } });
    await prisma.studentActivity.deleteMany({ where: { studentId: student.id } });
    await prisma.student.delete({ where: { id: student.id } });
    await prisma.question.deleteMany({ where: { id: { in: questionIds } } });
    await prisma.topic.deleteMany({ where: { id: { in: [topic1.id, topic2.id] } } });
    await prisma.subject.delete({ where: { id: subjectA.id } });
    await prisma.exam.deleteMany({ where: { id: { in: [examA.id, examB.id, examC.id] } } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
