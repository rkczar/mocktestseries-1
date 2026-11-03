/**
 * Fixture for scripts/verify-question-safety-ui.mjs (DISPOSABLE database only).
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/question-safety-ui-fixture.ts setup > fx.json
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/question-safety-ui-fixture.ts cleanup
 *
 * One exam, a 5-question PYQ paper, a published "QSUI Grand Test" whose
 * position 4 is paper Q3, a corrected DRAFT copy of Q3, a MASTER_ADMIN, and
 * two students: A with an IN_PROGRESS attempt (the open session), B with a
 * SUBMITTED attempt (the old result that must disappear).
 */
import "dotenv/config";
import argon2 from "argon2";
import { QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saveAnswer, startMockTestAttempt, submitAttempt } from "@/lib/test-attempt";
import { createFixtureSubject, createFixtureTopic } from "./fixture-taxonomy";

const TAG = "QSUI";
const PASSWORD = "QsafUi!2345x";
const ADMIN = "qsui-admin";
const EMAIL_A = "qsui-a@example.test";
const EMAIL_B = "qsui-b@example.test";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

async function cleanup() {
  const admin = await prisma.adminUser.findUnique({ where: { username: ADMIN }, select: { id: true } });
  if (admin) {
    await prisma.loginAttempt.deleteMany({ where: { adminUserId: admin.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } }).catch(() => {});
    await prisma.adminUser.delete({ where: { id: admin.id } });
  }
  const students = await prisma.student.findMany({ where: { studentId: { startsWith: `${TAG}-` } }, select: { id: true } });
  const ids = students.map((s) => s.id);
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentLoginAttempt.deleteMany({ where: { OR: [{ studentId: { in: ids } }, { identifier: { in: [EMAIL_A, EMAIL_B] } }] } });
  for (const t of ["studentActivity", "studentSession", "studentDevice", "studentProfile", "savedQuestion"] as const) {
    await (prisma[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { studentId: { in: ids } } });
  }
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
}

async function setup() {
  await cleanup();
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `${TAG} Exam ${sfx}`, code: `${TAG}${sfx}`.toUpperCase(), isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: `${TAG} Subject ${sfx}` });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: `${TAG} Topic ${sfx}` });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2016, title: `${TAG} PYQ ${sfx}` } });
  const mkQ = (n: number, text: string, extra: Record<string, unknown> = {}) =>
    prisma.question.create({
      data: {
        code: `${TAG}-${sfx}-${n}`,
        examId: exam.id,
        subjectId: subject.id,
        topicId: topic.id,
        text,
        status: QuestionStatus.PUBLISHED,
        examYear: 2016,
        ...extra,
        options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `${text} — option ${label}`, isCorrect: label === "A", order })) },
      },
    });
  const paperQs = [];
  for (let n = 1; n <= 5; n++) {
    paperQs.push(await mkQ(n, `QSUI paper question ${n} (OLD)`, { previousYearPaperId: paper.id, source: QuestionSource.PYQ, paperQuestionNumber: n }));
  }
  const corrected = await mkQ(99, "QSUI paper question 3 (CORRECTED)", { status: QuestionStatus.DRAFT });
  const order = [paperQs[0], paperQs[1], paperQs[3], paperQs[2], paperQs[4]]; // paper Q3 at position 4
  const mock = await prisma.mockTest.create({
    data: { examId: exam.id, title: `${TAG} Grand Test ${sfx}`, durationMinutes: 60, status: "PUBLISHED", questions: { create: order.map((q, i) => ({ questionId: q.id, order: i })) } },
  });

  const passwordHash = await argon2.hash(PASSWORD);
  const masterRole = await prisma.role.findUniqueOrThrow({ where: { name: "MASTER_ADMIN" }, select: { id: true } });
  await prisma.adminUser.create({ data: { name: "QSUI Admin", username: ADMIN, passwordHash, roleId: masterRole.id } });
  const mkStudent = async (n: number, email: string) => {
    const s = await prisma.student.create({
      data: { studentId: `${TAG}-${n}`, name: `QSUI Student ${n}`, email, mobile: `+9198765${String(43000 + n)}`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    await prisma.studentProfile.create({ data: { studentId: s.id } });
    return s.id;
  };
  const a = await mkStudent(1, EMAIL_A);
  const b = await mkStudent(2, EMAIL_B);
  const openAttempt = await startMockTestAttempt(a, mock.id);
  const doneAttempt = await startMockTestAttempt(b, mock.id);
  for (const q of order) await saveAnswer(doneAttempt.id, b, q.id, "A", false);
  await submitAttempt(doneAttempt.id, b);

  console.log(
    JSON.stringify({
      password: PASSWORD,
      adminUsername: ADMIN,
      emailA: EMAIL_A,
      emailB: EMAIL_B,
      examId: exam.id,
      paperId: paper.id,
      mockId: mock.id,
      oldQ3: { id: paperQs[2].id, code: paperQs[2].code },
      corrected: { id: corrected.id, code: corrected.code },
      openAttemptId: openAttempt.id,
      doneAttemptId: doneAttempt.id,
    })
  );
}

(process.argv[2] === "cleanup" ? cleanup() : setup())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
