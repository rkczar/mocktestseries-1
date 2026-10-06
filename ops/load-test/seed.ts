/**
 * Synthetic load-test dataset. Writes ONLY to a disposable database whose
 * name contains "loadtest" (refuses anything else, including production).
 * No real student data, no financial rows, no emails/OTPs.
 *
 *   DATABASE_URL=<.../mts_loadtest_x> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx ops/load-test/seed.ts --students 300 --mocks 5 --questions 100 --out /path/fixture.json
 *
 * Produces: 1 exam + published series, N FREE mocks x Q questions (text and
 * options larger than the real average: ~200 / ~40 chars), students with
 * minted session cookies (same JWT shape as scripts/test-engine-ui-fixture.ts),
 * enrollment, some submitted history, and the current build's server-action
 * ids. Cleanup = drop the database (ops/load-test/run-light.sh does this).
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { encode } from "next-auth/jwt";
import { QuestionDifficulty, QuestionStatus, StudentAuthProvider } from "@prisma/client";

const DB = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*loadtest[^/?]*(\?|$)/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must point at a disposable database whose name contains 'loadtest'.");
  process.exit(2);
}
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const STUDENTS = Number(arg("students", "300"));
const MOCKS = Number(arg("mocks", "5"));
const QUESTIONS = Number(arg("questions", "100"));
const HISTORY = Number(arg("history", "2")); // submitted attempts per student (dashboard realism)
const OUT = arg("out", "/tmp/loadtest-fixture.json");
const pad = (s: string, n: number) => (s + " " + "lorem ipsum dolor sit amet ".repeat(20)).slice(0, n);

function actionIds(): Record<string, string> {
  const m = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as { node: Record<string, { exportedName?: string; workers: Record<string, unknown> }> };
  const want: Record<string, string> = { saveAnswerAction: "attempt", attemptHeartbeatAction: "attempt", submitAttemptAction: "attempt", startConfiguredTestAction: "test-series", startMockTestFromDetailsAction: "test-series" };
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(m.node)) {
    const name = v.exportedName;
    if (name && want[name] && Object.keys(v.workers).some((w) => w.includes(want[name]))) out[name] = id;
  }
  return out;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { startMockTestAttempt, saveAnswer, submitAttempt } = await import("@/lib/test-attempt");
  const t0 = Date.now();
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `LoadTest Exam ${sfx}`, code: `LT-${sfx}`, durationMinutes: 120, publicSlug: `loadtest-${sfx}` } });
  const { createFixtureSubject } = await import("../../scripts/fixture-taxonomy");
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "LoadTest Subject" });
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `LoadTest Series ${sfx}`, status: "PUBLISHED", testCount: MOCKS } });

  const mocks: string[] = [];
  for (let m = 0; m < MOCKS; m++) {
    const qIds: string[] = [];
    for (let n = 0; n < QUESTIONS; n++) {
      const q = await prisma.question.create({
        data: {
          examId: exam.id,
          subjectId: subject.id,
          code: `LT-${sfx}-${m}-${n}`,
          text: pad(`Q${m}.${n}: A 45-year-old patient presents with the following findings.`, 200),
          difficulty: QuestionDifficulty.MEDIUM,
          status: QuestionStatus.PUBLISHED,
          options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: pad(`Option ${label}`, 40), isCorrect: label === "B", order })) },
        },
        select: { id: true },
      });
      qIds.push(q.id);
    }
    const mock = await prisma.mockTest.create({
      data: {
        examId: exam.id,
        testSeriesId: series.id,
        order: m + 1,
        title: `LoadTest Mock ${m + 1}`,
        durationMinutes: 120,
        status: "PUBLISHED",
        accessType: "FREE",
        questions: { create: qIds.map((questionId, order) => ({ questionId, order })) },
      },
    });
    mocks.push(mock.id);
  }

  const students: { id: string; token: string }[] = [];
  for (let i = 0; i < STUDENTS; i++) {
    const s = await prisma.student.create({
      data: { studentId: `LT${i}-${sfx}`, name: `Load Student ${i}`, email: `lt-${i}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    await prisma.studentProfile.create({ data: { studentId: s.id } });
    await prisma.studentExamEnrollment.create({ data: { studentId: s.id, examId: exam.id } });
    const token = await encode({
      token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email },
      secret: process.env.AUTH_SECRET!,
      salt: "student-session-token",
    });
    students.push({ id: s.id, token });
  }

  // Submitted history on the LAST mock (the load scenarios use the others).
  const histMock = mocks[mocks.length - 1];
  for (const s of students.slice(0, Math.min(students.length, 100))) {
    for (let h = 0; h < HISTORY; h++) {
      const a = await startMockTestAttempt(s.id, histMock);
      const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, select: { questionId: true }, take: 60 });
      for (const r of rows) await saveAnswer(a.id, s.id, r.questionId, ["A", "B", "C", "D"][Math.floor(Math.random() * 4)], false, 1);
      await submitAttempt(a.id, s.id);
    }
  }

  const questionIdsByMock: Record<string, string[]> = {};
  for (const id of mocks) {
    questionIdsByMock[id] = (await prisma.mockTestQuestion.findMany({ where: { mockTestId: id }, orderBy: { order: "asc" }, select: { questionId: true } })).map((r) => r.questionId);
  }
  writeFileSync(OUT, JSON.stringify({ examId: exam.id, seriesId: series.id, mocks, questionIdsByMock, students, actions: actionIds() }));
  console.log(`seeded ${STUDENTS} students, ${MOCKS} mocks x ${QUESTIONS} questions in ${Math.round((Date.now() - t0) / 1000)}s → ${OUT}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
