/**
 * Fixture for scripts/verify-test-deletion-ui.mjs (scratch DB only).
 *   npx tsx scripts/test-deletion-ui-fixture.ts setup   → prints JSON ids
 *   npx tsx scripts/test-deletion-ui-fixture.ts state   → prints JSON of what still exists
 *   npx tsx scripts/test-deletion-ui-fixture.ts cleanup
 */
import "dotenv/config";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const TAG = "TDELUI";

async function setup() {
  await cleanup();
  const exam = await prisma.exam.upsert({ where: { code: "TDEL" }, update: {}, create: { name: "TDEL Fixture Exam", code: "TDEL" } });
  const subject = await prisma.subject.upsert({ where: { nameKey: "tdel-fixture-subject" }, update: {}, create: { name: "TDEL Subject", nameKey: "tdel-fixture-subject" } });
  const qs = await Promise.all(
    [0, 1].map((i) =>
      prisma.question.create({
        data: {
          code: `${TAG}-Q${i}`,
          examId: exam.id,
          subjectId: subject.id,
          text: `${TAG} question ${i}`,
          status: "PUBLISHED",
          options: { create: ["A", "B"].map((label, order) => ({ label, text: label, order, isCorrect: label === "A" })) },
        },
      })
    )
  );
  const links = { create: qs.map((q, order) => ({ questionId: q.id, order })) };
  const mk = (title: string) => prisma.mockTest.create({ data: { examId: exam.id, title, durationMinutes: 30, status: "PUBLISHED", questions: links } });
  const unused = await mk(`${TAG} Unused Duplicate`);
  const mobile = await mk(`${TAG} Mobile Duplicate`);
  const detail = await mk(`${TAG} Detail Page Duplicate`);
  const authz = await mk(`${TAG} Authz Target`);
  const attempted = await mk(`${TAG} Attempted`);
  const student = await prisma.student.create({ data: { studentId: `${TAG}-S`, name: `${TAG} Student`, email: "tdelui@example.test", authProvider: StudentAuthProvider.CREDENTIALS } });
  const attempt = await prisma.testAttempt.create({
    data: { studentId: student.id, sourceType: "MOCK_TEST", examId: exam.id, mockTestId: attempted.id, durationMinutes: 30, totalQuestions: 2, status: "SUBMITTED", score: 4, submittedAt: new Date() },
  });
  const customModule = await prisma.customModule.create({ data: { examId: exam.id, title: `${TAG} Custom Module`, questions: links } });
  console.log(JSON.stringify({ unused: unused.id, mobile: mobile.id, detail: detail.id, authz: authz.id, attempted: attempted.id, attempt: attempt.id, module: customModule.id, questions: qs.map((q) => q.id) }));
}

async function state() {
  const [mocks, modules, attempts, questions] = await Promise.all([
    prisma.mockTest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, title: true, status: true } }),
    prisma.customModule.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } }),
    prisma.testAttempt.findMany({ where: { student: { studentId: `${TAG}-S` } }, select: { id: true, mockTestId: true, score: true } }),
    prisma.question.count({ where: { code: { startsWith: `${TAG}-Q` } } }),
  ]);
  console.log(JSON.stringify({ mocks, modules, attempts, questions }));
}

async function cleanup() {
  await prisma.testAttempt.deleteMany({ where: { student: { studentId: `${TAG}-S` } } });
  await prisma.student.deleteMany({ where: { studentId: `${TAG}-S` } });
  await prisma.mockTest.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.customModule.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.question.deleteMany({ where: { code: { startsWith: `${TAG}-Q` } } });
}

(async () => {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
  const cmd = process.argv[2];
  if (cmd === "setup") await setup();
  else if (cmd === "state") await state();
  else if (cmd === "cleanup") await cleanup();
  else throw new Error("usage: setup | state | cleanup");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
