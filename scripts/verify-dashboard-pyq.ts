/**
 * Student Dashboard → Previous Year Papers regression (server side).
 *
 * Drives the real dashboard data path (getDashboardPaperViews) and the
 * canonical PYQ engine (startPreviousYearPaperAttempt → toPlayerQuestions →
 * saveAnswer → submitAttempt) with a disposable student it creates and
 * deletes itself. Checks: only active papers with published questions are
 * listed, Start creates one attempt and a second Start resumes it, the list
 * flips Start → Resume → View Result, the player payload carries no answer
 * key, and another student can't reach the attempt.
 *
 * Run against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-dashboard-pyq.ts
 */
import "dotenv/config";
import { StudentAuthProvider, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOwnedAttempt } from "@/lib/student-data";
import { saveAnswer, startPreviousYearPaperAttempt, submitAttempt } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { getDashboardPaperViews } from "@/app/student/(dashboard)/dashboard/pyq-view";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

  const paper = await prisma.previousYearPaper.findFirst({
    where: { isActive: true, exam: { isActive: true }, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { year: "desc" },
  });
  if (!paper) throw new Error("No active PYQ with published questions in this database.");
  const examId = paper.examId;

  const suffix = Date.now().toString(36);
  const mk = (tag: string) =>
    prisma.student.create({
      data: { studentId: `PYQ${tag}-${suffix}`, name: `PYQ ${tag}`, email: `pyq-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
  const [a, b] = await Promise.all([mk("A"), mk("B")]);

  try {
    console.log("\n--- Listing ---");
    const expected = await prisma.previousYearPaper.count({
      where: { examId, isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    });
    let views = await getDashboardPaperViews(a.id, examId);
    check("lists every active paper with published questions", views.length === expected && expected > 0, { views: views.length, expected });
    const v0 = views.find((v) => v.id === paper.id)!;
    const published = await prisma.question.count({ where: { previousYearPaperId: paper.id, status: QuestionStatus.PUBLISHED } });
    check("question count = published questions", v0.questionCount === published, { v: v0.questionCount, published });
    check("fresh student: Start state", !v0.inProgressAttemptId && !v0.lastSubmittedAttemptId);
    check("sorted newest year first", views.every((v, i) => i === 0 || views[i - 1].year >= v.year));
    check("payload carries no answer data", !/correct|isCorrect|answer/i.test(JSON.stringify(views)));

    await prisma.previousYearPaper.update({ where: { id: paper.id }, data: { isActive: false } });
    const hidden = await getDashboardPaperViews(a.id, examId);
    await prisma.previousYearPaper.update({ where: { id: paper.id }, data: { isActive: true } });
    check("inactive paper is not exposed", !hidden.some((v) => v.id === paper.id));

    console.log("\n--- Start / Resume ---");
    const first = await startPreviousYearPaperAttempt(a.id, paper.id);
    const again = await startPreviousYearPaperAttempt(a.id, paper.id);
    check("second Start resumes the same attempt", first.id === again.id);
    check("one IN_PROGRESS attempt only", (await prisma.testAttempt.count({ where: { studentId: a.id, previousYearPaperId: paper.id } })) === 1);
    check("PYQ attempt is EXAM mode", first.answerMode === "EXAM");
    views = await getDashboardPaperViews(a.id, examId);
    check("dashboard shows Resume for the in-progress attempt", views.find((v) => v.id === paper.id)?.inProgressAttemptId === first.id);

    const rows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: first.id }, orderBy: { order: "asc" }, include: { answer: true } });
    const payload = toPlayerQuestions(rows, { instantMode: false });
    check("player payload: no answer key", payload.every((p) => p.reveal === null) && !/correctLabel|isCorrect/.test(JSON.stringify(payload)));

    const label = payload.find((p) => !p.malformed)?.options[0]?.label;
    if (label) await saveAnswer(first.id, a.id, payload.find((p) => !p.malformed)!.questionId, label, false, 1);

    console.log("\n--- Ownership ---");
    check("other student can't load the attempt", (await getOwnedAttempt(first.id, b.id)) === null);
    check("other student's list shows no attempt state", !(await getDashboardPaperViews(b.id, examId)).some((v) => v.inProgressAttemptId || v.lastSubmittedAttemptId));
    let blocked = false;
    try {
      await submitAttempt(first.id, b.id);
    } catch {
      blocked = true;
    }
    check("other student can't submit the attempt", blocked);

    console.log("\n--- Submit → Result ---");
    const sub = await submitAttempt(first.id, a.id);
    check("submit → SUBMITTED", sub.status === "SUBMITTED");
    views = await getDashboardPaperViews(a.id, examId);
    const v1 = views.find((v) => v.id === paper.id)!;
    check("dashboard shows View Result, no Resume", v1.lastSubmittedAttemptId === first.id && v1.inProgressAttemptId === null);
    const retake = await startPreviousYearPaperAttempt(a.id, paper.id);
    check("Reattempt creates a new attempt", retake.id !== first.id);
  } finally {
    await prisma.student.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  }

  console.log(failures === 0 ? "\nALL DASHBOARD PYQ CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
