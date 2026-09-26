/**
 * Universal test setup + formal-test policy regression (server side).
 *
 * Covers what UniversalTestSetup / the Student Dashboard layout added on top
 * of scripts/verify-test-engine-core.ts:
 *  - Subject Test: 1 / 2 / N questions, all three time modes frozen on the
 *    attempt (unlimited = genuinely untimed), exam + instant answer modes.
 *  - Mock Test: admin-defined count + duration, EXAM/FIXED only; reveal is
 *    refused even if the stored attempt were tampered to INSTANT.
 *  - PYQ: the full published paper in original order, EXAM only.
 *  - History: a submitted attempt is untouched by a retake (new attempt).
 *  - Dashboard layout normalization / strict parsing.
 *
 * Run against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-universal-setup-policy.ts
 */
import "dotenv/config";
import { AttemptAnswerMode, AttemptDurationMode, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  revealAnswer,
  saveAnswer,
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startSubjectTestAttempt,
  submitAttempt,
  isFormalSource,
} from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { normalizeStudentDashboardLayout, parseSubmittedLayout } from "@/lib/student-dashboard-layout";
import { DEFAULT_STUDENT_DASHBOARD_LAYOUT, STUDENT_DASHBOARD_BLOCKS } from "@/lib/student-dashboard-blocks";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function code(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

  const suffix = Date.now().toString(36);
  const students: string[] = [];
  const mockIds: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `USP${tag}-${suffix}`, name: `USP ${tag}`, email: `usp-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };

  try {
    // A subject with enough published questions for every case below.
    const subject = await prisma.subject.findFirst({
      where: { exam: { isActive: true }, questions: { some: { status: QuestionStatus.PUBLISHED } } },
      orderBy: { questions: { _count: "desc" } },
    });
    if (!subject) throw new Error("No subject with published questions.");
    const base = { examId: subject.examId, subjectId: subject.id, durationMinutes: 0 };

    console.log("\n--- Subject Test via UniversalTestSetup ---");
    for (const n of [1, 2, 7]) {
      const sid = await mkStudent(`S${n}`);
      const a = await startSubjectTestAttempt(sid, { ...base, count: n, durationMode: AttemptDurationMode.PER_QUESTION });
      check(`${n}q: exactly ${n} distinct questions`, a.totalQuestions === n && (await prisma.testAttemptQuestion.count({ where: { attemptId: a.id } })) === n);
      check(`${n}q: 1 minute per question frozen`, a.durationMode === "PER_QUESTION" && a.durationMinutes === n);
    }
    {
      const sid = await mkStudent("UNL");
      const a = await startSubjectTestAttempt(sid, { ...base, count: 3, durationMode: AttemptDurationMode.UNLIMITED, answerMode: AttemptAnswerMode.INSTANT });
      check("unlimited: durationMode UNLIMITED, no fake duration", a.durationMode === "UNLIMITED" && a.durationMinutes === 0);
      check("subject test may be INSTANT", a.answerMode === "INSTANT");
      const again = await startSubjectTestAttempt(sid, { ...base, count: 9, durationMode: AttemptDurationMode.CUSTOM, customMinutes: 5 });
      check("resume returns the frozen attempt untouched", again.id === a.id && again.durationMode === "UNLIMITED" && again.totalQuestions === 3);

      const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, orderBy: { order: "asc" }, include: { answer: true } });
      check("instant: no answer key before Check Answer", toPlayerQuestions(rows, { instantMode: true }).every((p) => p.reveal === null));
      const q = rows[0];
      const label = (q.questionSnapshot as { options: { label: string }[] }).options[0].label;
      await saveAnswer(a.id, sid, q.questionId, label, false, 1);
      const r = await revealAnswer(a.id, sid, q.questionId, label, 2);
      check("instant: server-authorized reveal", typeof r.correctLabel === "string" && r.correctLabel.length > 0);
      check("instant: revealed answer is frozen", (await code(() => saveAnswer(a.id, sid, q.questionId, r.correctLabel === label ? "B" : r.correctLabel, false, 3))) !== null);
    }
    {
      const sid = await mkStudent("CUS");
      const a = await startSubjectTestAttempt(sid, { ...base, count: 4, durationMode: AttemptDurationMode.CUSTOM, customMinutes: 13 });
      check("custom: 13 minutes frozen", a.durationMode === "CUSTOM" && a.durationMinutes === 13 && a.answerMode === "EXAM");
      const sid2 = await mkStudent("CUS0");
      check("custom: out-of-range minutes refused", (await code(() => startSubjectTestAttempt(sid2, { ...base, count: 1, durationMode: AttemptDurationMode.CUSTOM, customMinutes: 0 }))) === "NOT_ALLOWED");
      check("custom: refused start creates no attempt", (await prisma.testAttempt.count({ where: { studentId: sid2 } })) === 0);
    }
    {
      const sid = await mkStudent("TOTG");
      const a = await startSubjectTestAttempt(sid, { ...base, count: 3, durationMinutes: 0, minutesPerQuestion: 1 });
      check("Test on the Go (legacy caller) unchanged: PER_QUESTION = count", a.durationMode === "PER_QUESTION" && a.durationMinutes === 3);
    }

    console.log("\n--- Mock Test: fixed formal exam mode ---");
    // A disposable mock (the 21 production mocks are never touched): 6 of the
    // subject's published questions, admin duration 17 minutes.
    const mockQuestions = await prisma.question.findMany({ where: { subjectId: subject.id, status: QuestionStatus.PUBLISHED }, take: 6, select: { id: true } });
    const mock = await prisma.mockTest.create({
      data: {
        examId: subject.examId,
        title: `USP Mock ${suffix}`,
        durationMinutes: 17,
        status: "PUBLISHED",
        questions: { create: mockQuestions.map((q, order) => ({ questionId: q.id, order })) },
      },
      include: { _count: { select: { questions: true } } },
    });
    mockIds.push(mock.id);
    if (!mock) {
      check("an available mock test exists to exercise", false);
    } else {
      const before = JSON.stringify(await prisma.mockTest.findUnique({ where: { id: mock.id }, include: { questions: { orderBy: { order: "asc" } } } }));
      const sid = await mkStudent("MOCK");
      const a = await startMockTestAttempt(sid, mock.id);
      check("mock: admin question count", a.totalQuestions === mock._count.questions, { a: a.totalQuestions, m: mock._count.questions });
      check("mock: admin duration", a.durationMinutes === mock.durationMinutes && a.durationMode === "FIXED");
      check("mock: EXAM mode", a.answerMode === "EXAM");
      const q = await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: a.id }, orderBy: { order: "asc" } });
      const lbl = (q.questionSnapshot as { options: { label: string }[] }).options[0].label;
      await saveAnswer(a.id, sid, q.questionId, lbl, false, 1);
      check("mock: Check Answer refused", (await code(() => revealAnswer(a.id, sid, q.questionId, lbl, 2))) === "NOT_ALLOWED");
      // Defense in depth: even a tampered attempt row can't reveal on a formal test.
      await prisma.testAttempt.update({ where: { id: a.id }, data: { answerMode: AttemptAnswerMode.INSTANT } });
      check("mock: tampered INSTANT still refused server-side", (await code(() => revealAnswer(a.id, sid, q.questionId, lbl, 3))) === "NOT_ALLOWED");
      check("mock/PYQ/grand/live are formal sources", ["MOCK_TEST", "PREVIOUS_YEAR_PAPER", "GRAND_TEST", "LIVE_TEST"].every((s) => isFormalSource(s as never)) && !isFormalSource("SUBJECT_TEST" as never) && !isFormalSource("CUSTOM_MODULE" as never));
      const after = JSON.stringify(await prisma.mockTest.findUnique({ where: { id: mock.id }, include: { questions: { orderBy: { order: "asc" } } } }));
      check("mock definition untouched by attempts", before === after);
    }

    console.log("\n--- PYQ full paper ---");
    const paper = await prisma.previousYearPaper.findFirstOrThrow({
      where: { isActive: true, exam: { isActive: true }, questions: { some: { status: QuestionStatus.PUBLISHED } } },
      orderBy: { year: "desc" },
    });
    {
      const sid = await mkStudent("PYQ");
      const a = await startPreviousYearPaperAttempt(sid, paper.id);
      const expected = await prisma.question.findMany({
        where: { previousYearPaperId: paper.id, status: QuestionStatus.PUBLISHED },
        orderBy: [{ createdAt: "asc" }, { code: "asc" }],
        select: { id: true },
      });
      const got = await prisma.testAttemptQuestion.findMany({ where: { attemptId: a.id }, orderBy: { order: "asc" }, select: { questionId: true } });
      check("PYQ: whole published paper", got.length === expected.length);
      check("PYQ: original paper order", got.every((g, i) => g.questionId === expected[i].id));
      check("PYQ: EXAM + FIXED", a.answerMode === "EXAM" && a.durationMode === "FIXED");

      console.log("\n--- History immutability ---");
      await saveAnswer(a.id, sid, got[0].questionId, "A", false, 1);
      const sub = await submitAttempt(a.id, sid);
      const snap = JSON.stringify(await prisma.testAttempt.findUnique({ where: { id: a.id }, include: { answers: { orderBy: { id: "asc" } } } }));
      const retake = await startPreviousYearPaperAttempt(sid, paper.id);
      check("retake creates a NEW attempt", retake.id !== a.id && retake.status === "IN_PROGRESS");
      await saveAnswer(retake.id, sid, got[0].questionId, "B", false, 1);
      const snapAfter = JSON.stringify(await prisma.testAttempt.findUnique({ where: { id: a.id }, include: { answers: { orderBy: { id: "asc" } } } }));
      check("completed attempt unchanged by the retake", snap === snapAfter && sub.status === "SUBMITTED");
      check("submitted attempt can't be edited", (await code(() => saveAnswer(a.id, sid, got[0].questionId, "C", false, 9))) === "NOT_EDITABLE");
    }

    console.log("\n--- Dashboard layout ---");
    const ids = STUDENT_DASHBOARD_BLOCKS.map((b) => b.id);
    check("empty setting → default layout", JSON.stringify(normalizeStudentDashboardLayout(null)) === JSON.stringify(DEFAULT_STUDENT_DASHBOARD_LAYOUT));
    const partial = normalizeStudentDashboardLayout([{ id: "previous-year-papers", visible: false }, { id: "bogus", visible: true }, { id: "performance-summary", visible: true }, { id: "performance-summary", visible: false }]);
    check("normalize: unknown ids dropped, duplicates collapsed", partial.length === ids.length && new Set(partial.map((b) => b.id)).size === ids.length);
    check("normalize: saved order + hidden state kept", partial[0].id === "previous-year-papers" && partial[0].visible === false);
    check("strict parse rejects incomplete / unknown / non-boolean", parseSubmittedLayout([{ id: "mock-tests", visible: true }]) === null && parseSubmittedLayout(ids.map((id) => ({ id, visible: "yes" }))) === null && parseSubmittedLayout([...ids.slice(1), "x"].map((id) => ({ id, visible: true }))) === null);
    check("strict parse accepts a full permutation", parseSubmittedLayout([...ids].reverse().map((id) => ({ id, visible: id !== "weak-topics" })))?.[0].id === ids[ids.length - 1]);
  } finally {
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.mockTest.deleteMany({ where: { id: { in: mockIds } } });
  }

  console.log(failures === 0 ? "\nALL UNIVERSAL SETUP / POLICY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
