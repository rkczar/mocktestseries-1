/**
 * Fixture helper for scripts/verify-test-engine-ui.mjs (TEST ENGINE CORE).
 *
 *   setup   → creates a disposable exam (12 questions + 10 PYQ questions), a
 *             disposable Mock Test, a disposable student + session cookie, and
 *             pre-started Mock / PYQ / Subject / malformed attempts; prints JSON.
 *   cleanup <examId> <studentId...> → deletes everything setup created.
 *
 * Point DATABASE_URL at the DISPOSABLE database the local server uses; needs
 * AUTH_SECRET (from .env) to mint the student session cookie.
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/test-engine-ui-fixture.ts setup
 */
import "dotenv/config";
import { PrismaClient, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encode } from "next-auth/jwt";
import { startMockTestAttempt, startPreviousYearPaperAttempt, startSubjectTestAttempt } from "@/lib/test-attempt";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to create UI fixtures in what looks like the production database.");
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function mintToken(student: { id: string; studentId: string; name: string; email: string | null }) {
  return encode({
    token: { studentDbId: student.id, studentId: student.studentId, authProvider: "CREDENTIALS", sub: student.id, name: student.name, email: student.email },
    secret: process.env.AUTH_SECRET!,
    salt: "student-session-token",
  });
}

async function setup() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `UI Engine Exam ${suffix}`, code: `UIE-${suffix}`, isActive: true } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "UI Engine Subject" } });
  const topic = await prisma.topic.create({ data: { subjectId: subject.id, name: "UI Engine Topic" } });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: `UI PYQ ${suffix}` } });
  const mk = (n: number, extra: Record<string, unknown> = {}) =>
    prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        code: `UIE-${suffix}-${n}`,
        text: `UI engine question ${n}: pick an answer`,
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        ...extra,
        options: {
          create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `Option ${label} of ${n}`, isCorrect: label === "B", order })),
        },
      },
    });
  const bank: Awaited<ReturnType<typeof mk>>[] = [];
  for (let n = 1; n <= 12; n++) bank.push(await mk(n));
  for (let n = 101; n <= 110; n++) await mk(n, { previousYearPaperId: paper.id, source: QuestionSource.PYQ });
  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `UI Engine Mock ${suffix}`,
      durationMinutes: 30,
      status: "PUBLISHED",
      questions: { create: bank.slice(0, 5).map((q, order) => ({ questionId: q.id, order })) },
    },
  });

  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `UIE${tag}-${suffix}`, name: `UI Engine ${tag}`, email: `uie-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    return { ...s, token: await mintToken(s) };
  };
  const main = await mkStudent("MAIN");
  // Independent students for the concurrent-browser run.
  const crowd: Awaited<ReturnType<typeof mkStudent>>[] = [];
  for (let i = 0; i < Number(process.env.UI_CONCURRENCY ?? 6); i++) crowd.push(await mkStudent(`C${i}`));

  const mockAttempt = await startMockTestAttempt(main.id, mock.id);
  const pyqAttempt = await startPreviousYearPaperAttempt(main.id, paper.id);
  const subjectAttempt = await startSubjectTestAttempt(main.id, { examId: exam.id, subjectId: subject.id, count: 3, durationMinutes: 0, minutesPerQuestion: 1 });

  // A second student holds an attempt whose 2nd frozen snapshot is corrupt (1 option).
  const mal = await mkStudent("MAL");
  const malAttempt = await startMockTestAttempt(mal.id, mock.id);
  const malRows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: malAttempt.id }, orderBy: { order: "asc" } });
  await prisma.testAttemptQuestion.update({
    where: { id: malRows[1].id },
    data: { questionSnapshot: { code: "BROKEN", text: "Broken question", imageUrl: null, difficulty: "MEDIUM", options: [{ label: "A", text: "only", imageUrl: null }], correctLabel: "A" } },
  });

  const crowdAttempts: { token: string; attemptId: string }[] = [];
  for (const c of crowd) crowdAttempts.push({ token: c.token, attemptId: (await startMockTestAttempt(c.id, mock.id)).id });

  console.log(
    JSON.stringify({
      examId: exam.id,
      studentIds: [main.id, mal.id, ...crowd.map((c) => c.id)],
      token: main.token,
      malToken: mal.token,
      mockAttemptId: mockAttempt.id,
      pyqAttemptId: pyqAttempt.id,
      subjectAttemptId: subjectAttempt.id,
      malAttemptId: malAttempt.id,
      crowd: crowdAttempts,
    })
  );
}

async function cleanup(examId: string, studentIds: string[]) {
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.savedQuestion.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.customModule.deleteMany({ where: { examId } });
  await prisma.mockTest.deleteMany({ where: { examId } });
  await prisma.question.deleteMany({ where: { examId } });
  await prisma.previousYearPaper.deleteMany({ where: { examId } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.exam.deleteMany({ where: { id: examId } });
  console.log("cleaned");
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "cleanup" ? cleanup(args[0], args.slice(1)) : Promise.reject(new Error("usage: setup | cleanup <examId> <studentId...>")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
