/**
 * Student experience cleanup regression (DB-backed, targeted):
 *  - Subject Test effective count = min(requested, eligible pool), server-side,
 *    distinct questions, empty pool refused (selectPublishedQuestions#allowFewer),
 *    strict InsufficientQuestionsError contract unchanged for admin tests.
 *  - Full startSubjectTestAttempt → canonical TestAttempt with frozen
 *    snapshots, using ONE disposable student that is deleted afterwards
 *    (cascade removes its attempts/enrollments/activity).
 *  - Default enrollment: new student enrolled once; repeated + concurrent
 *    calls never duplicate; opt-out respected.
 *  - Mock start gate: UPCOMING refused before any attempt row exists;
 *    availability derivation for Scheduled / Fixed Window.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-student-experience-cleanup.ts
 */
import "dotenv/config";
import { AttemptStatus, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  selectPublishedQuestions,
  countPublishedQuestions,
  InsufficientQuestionsError,
  NoQuestionsAvailableError,
} from "@/lib/question-selection";
import { startSubjectTestAttempt, startMockTestAttempt } from "@/lib/test-attempt";
import { ensureDefaultExamEnrollment, resolveDefaultExam } from "@/lib/default-enrollment";
import { deriveMockTestAvailability, isMockTestAvailable, LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import { TEXT_SIZES, TEXT_SIZE_LABELS } from "@/lib/text-size";
import { THEMES } from "@/lib/theme";

let failures = 0;
function check(label: string, passed: boolean, detail = "") {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures++;
}
const distinct = (ids: string[]) => new Set(ids).size === ids.length;

async function main() {
  const exam = await resolveDefaultExam();
  if (!exam) throw new Error("No default exam — cannot run.");

  // Smallest subject with >= 7 published questions, and one with >= 20.
  const counts = await prisma.question.groupBy({ by: ["subjectId"], where: { examId: exam.id, status: QuestionStatus.PUBLISHED }, _count: true });
  const byCount = counts.filter((c) => c.subjectId).sort((a, b) => a._count - b._count);
  const small = byCount.find((c) => c._count >= 7)!;
  const large = byCount.find((c) => c._count >= 20)!;
  const smallName = (await prisma.subject.findUnique({ where: { id: small.subjectId! } }))!.name;

  console.log(`--- Subject Test selection (${smallName}: ${small._count} available) ---`);
  const base = { examId: exam.id, subjectId: small.subjectId! };
  const avail = await countPublishedQuestions(base);

  const r15 = await selectPublishedQuestions({ ...base, count: 15, allowFewer: true });
  check(`requested 15 / available ${avail} → ${Math.min(15, avail)}`, r15.questions.length === Math.min(15, avail), `got ${r15.questions.length}`);
  check("no duplicate questions (15 req)", distinct(r15.questions.map((q) => q.id)));

  const r1 = await selectPublishedQuestions({ ...base, count: 1, allowFewer: true });
  check("requested 1 → 1", r1.questions.length === 1);

  const r5 = await selectPublishedQuestions({ examId: exam.id, subjectId: large.subjectId!, count: 5, allowFewer: true });
  check(`requested 5 / available ${large._count} → 5`, r5.questions.length === 5 && distinct(r5.questions.map((q) => q.id)));

  let zeroErr: unknown = null;
  try {
    await selectPublishedQuestions({ ...base, year: 1901, count: 15, allowFewer: true });
  } catch (e) {
    zeroErr = e;
  }
  check("available 0 → NoQuestionsAvailableError (no attempt)", zeroErr instanceof NoQuestionsAvailableError);

  let strictErr: unknown = null;
  try {
    await selectPublishedQuestions({ ...base, count: 15 });
  } catch (e) {
    strictErr = e;
  }
  check("admin/strict callers still get InsufficientQuestionsError", strictErr instanceof InsufficientQuestionsError);

  // ---- ONE disposable student for the write paths ----
  const tag = `DISPOSABLE-VERIFY-${Date.now()}`;
  const student = await prisma.student.create({
    data: { studentId: tag, name: "Disposable Verify (auto-deleted)", email: `${tag.toLowerCase()}@invalid.test`, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  try {
    console.log("--- Default enrollment ---");
    const first = await ensureDefaultExamEnrollment(student.id);
    check("new student → enrolled in default exam", first.status === "ENROLLED" && first.examId === exam.id);
    const again = await Promise.all([1, 2, 3, 4, 5].map(() => ensureDefaultExamEnrollment(student.id)));
    check("5 concurrent repeat calls → all ALREADY_ENROLLED", again.every((o) => o.status === "ALREADY_ENROLLED"));
    const rows = await prisma.studentExamEnrollment.count({ where: { studentId: student.id } });
    check("exactly one enrollment row", rows === 1, `rows=${rows}`);

    await prisma.studentExamEnrollment.deleteMany({ where: { studentId: student.id } });
    await prisma.studentActivity.create({ data: { studentId: student.id, activity: "EXAM_UNENROLLED", metadata: { examId: exam.id } } });
    const optOut = await ensureDefaultExamEnrollment(student.id);
    check("student who unenrolled is not re-enrolled", optOut.status === "OPTED_OUT");

    console.log("--- Subject Test attempt (canonical TestAttempt) ---");
    const attempt = await startSubjectTestAttempt(student.id, { ...base, count: 15, durationMinutes: 30 });
    const tq = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt.id }, select: { questionId: true, questionSnapshot: true } });
    check(`attempt.totalQuestions = ${avail}`, attempt.totalQuestions === avail, `got ${attempt.totalQuestions}`);
    check("frozen question rows = effective count, distinct", tq.length === avail && distinct(tq.map((t) => t.questionId)));
    check("every row carries a snapshot", tq.every((t) => t.questionSnapshot !== null));
    const resumed = await startSubjectTestAttempt(student.id, { ...base, count: 3, durationMinutes: 30 });
    check("re-open same subject resumes the same attempt", resumed.id === attempt.id);
    await prisma.testAttempt.update({ where: { id: attempt.id }, data: { status: AttemptStatus.SUBMITTED, submittedAt: new Date() } });

    const totg = await startSubjectTestAttempt(student.id, { ...base, count: 15, durationMinutes: 15, minutesPerQuestion: 1 });
    check("Test on the Go duration follows effective count (1 min/question)", totg.durationMinutes === avail, `duration=${totg.durationMinutes}`);

    console.log("--- Mock Test gate ---");
    const upcoming = await prisma.mockTest.findFirst({ where: { ...LIVE_MOCK_TEST_WHERE, accessType: "FREE", availableFrom: { gt: new Date() } } });
    if (upcoming) {
      let err: unknown = null;
      try {
        await startMockTestAttempt(student.id, upcoming.id);
      } catch (e) {
        err = e;
      }
      const created = await prisma.testAttempt.count({ where: { studentId: student.id, mockTestId: upcoming.id } });
      check("scheduled future mock → refused (Upcoming/Locked)", err instanceof Error && /not available yet/.test(err.message));
      check("no attempt row created for the refused start", created === 0);
    } else {
      console.log("  SKIP  no FREE upcoming mock to test against");
    }
  } finally {
    await prisma.student.delete({ where: { id: student.id } });
    const left = await prisma.testAttempt.count({ where: { studentId: student.id } });
    check("disposable student + its attempts removed", left === 0);
  }

  const now = new Date("2026-10-01T10:00:00Z");
  const h = (n: number) => new Date(now.getTime() + n * 3600_000);
  check("Scheduled Release before start → UPCOMING", deriveMockTestAvailability({ availableFrom: h(1), availableUntil: null }, now) === "UPCOMING");
  check("Fixed Window open → LIVE_NOW + startable", isMockTestAvailable({ status: "PUBLISHED", availableFrom: h(-1), availableUntil: h(1) }, now));
  check("Fixed Window closed → CLOSED, not startable", !isMockTestAvailable({ status: "PUBLISHED", availableFrom: h(-2), availableUntil: h(-1) }, now));

  console.log("--- Preferences ---");
  check("text sizes = Very Small/Small/Default/Large/Extra Large", TEXT_SIZES.map((s) => TEXT_SIZE_LABELS[s]).join("/") === "Very Small/Small/Default/Large/Extra Large");
  check("themes = light/dark/eyesaver", THEMES.join("/") === "light/dark/eyesaver");

  const dupes = await prisma.studentExamEnrollment.groupBy({ by: ["studentId", "examId"], _count: true, having: { studentId: { _count: { gt: 1 } } } });
  check("no duplicate enrollment rows platform-wide", dupes.length === 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
