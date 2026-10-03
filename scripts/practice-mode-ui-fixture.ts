/**
 * Fixture helper for scripts/verify-practice-mode-ui.mjs (TEST ENGINE CORE).
 *
 *   setup   → a disposable exam with a 100-question Mock (keys rotate C/A/D/B,
 *             0.25 negative marking, Standard 120 min), a held-answer-key mock,
 *             a 10-question PYQ paper and one fresh student per browser flow;
 *             prints JSON (tokens, ids, the mock's answer key in order).
 *   inspect <attemptId> → prints the attempt's frozen config, score and the
 *             stored answers (what the browser suite asserts scoring against).
 *   cleanup <examId> <studentId...> → deletes everything setup created.
 *
 * Point DATABASE_URL at the DISPOSABLE database the local server uses; needs
 * AUTH_SECRET (from .env) to mint the student session cookies.
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/practice-mode-ui-fixture.ts setup
 */
import "dotenv/config";
import { PrismaClient, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encode } from "next-auth/jwt";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to create UI fixtures in what looks like the production database.");
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const KEYS = ["C", "A", "D", "B"] as const;
const FLOWS = ["practice", "examStd", "examPerQ", "examCustom", "pyq", "subject", "custom", "held", "themes"] as const;

async function setup() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Practice UI Exam ${suffix}`, code: `PMU-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "Practice UI Subject" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "Practice UI Topic" });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2025, title: `Practice UI PYQ ${suffix}` } });

  const mk = (n: number, extra: Record<string, unknown> = {}) => {
    const key = KEYS[n % KEYS.length];
    return prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        code: `PMU-${suffix}-${n}`,
        text: `Practice question ${n}: which drug is first line?`,
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        ...extra,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `Drug ${label} (q${n})`, isCorrect: label === key, order })) },
      },
    });
  };
  const bank: { id: string; key: string }[] = [];
  for (let n = 1; n <= 100; n++) bank.push({ id: (await mk(n)).id, key: KEYS[n % KEYS.length] });
  const pyqKeys: string[] = [];
  for (let n = 201; n <= 210; n++) {
    await mk(n, { previousYearPaperId: paper.id, source: QuestionSource.PYQ });
    pyqKeys.push(KEYS[n % KEYS.length]);
  }

  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `Practice UI Mock ${suffix}`,
      durationMinutes: 120,
      negativeMarking: 0.25,
      status: "PUBLISHED",
      accessType: "FREE",
      questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) },
    },
  });
  const held = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: `Practice UI Held Key ${suffix}`,
      durationMinutes: 30,
      status: "PUBLISHED",
      accessType: "FREE",
      resultReleaseMode: "CUSTOM_DATE",
      resultReleaseAt: new Date(Date.now() + 7 * 86_400_000),
      questions: { create: bank.slice(0, 5).map((q, order) => ({ questionId: q.id, order })) },
    },
  });

  const tokens: Record<string, string> = {};
  const studentIds: string[] = [];
  for (const flow of FLOWS) {
    const s = await prisma.student.create({
      data: { studentId: `PMU${flow}-${suffix}`, name: `Practice UI ${flow}`, email: `pmu-${flow.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    studentIds.push(s.id);
    tokens[flow] = await encode({
      token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email },
      secret: process.env.AUTH_SECRET!,
      salt: "student-session-token",
    });
  }

  console.log(
    JSON.stringify({
      examId: exam.id,
      studentIds,
      mockId: mock.id,
      heldMockId: held.id,
      paperId: paper.id,
      keys: bank.map((q) => q.key),
      questionTexts: bank.map((_, i) => `Practice question ${i + 1}: which drug is first line?`),
      pyqKeys,
      tokens,
    })
  );
}

async function inspect(attemptId: string) {
  const a = await prisma.testAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { questions: { orderBy: { order: "asc" }, include: { answer: true } } },
  });
  console.log(
    JSON.stringify({
      status: a.status,
      answerMode: a.answerMode,
      durationMode: a.durationMode,
      durationMinutes: a.durationMinutes,
      score: a.score,
      correctCount: a.correctCount,
      incorrectCount: a.incorrectCount,
      unansweredCount: a.unansweredCount,
      isLeaderboardAttempt: a.isLeaderboardAttempt,
      answers: a.questions.map((q) => ({ selected: q.answer?.selectedOptionLabel ?? null, revealed: !!q.answer?.revealedAt })),
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
  await deleteFixtureTaxonomy(prisma, [examId]);
  await prisma.exam.deleteMany({ where: { id: examId } });
  console.log("cleaned");
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "inspect" ? inspect(args[0]) : cmd === "cleanup" ? cleanup(args[0], args.slice(1)) : Promise.reject(new Error("usage: setup | inspect <attemptId> | cleanup <examId> <studentId...>")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
