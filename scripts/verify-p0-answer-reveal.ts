/**
 * Regression coverage for the two P0 pre-launch audit findings (2026-09-25):
 *
 *   P0-01  Saved Questions leaked the answer key: a question bookmarked from
 *          the live test player (or any arbitrary question id) was rendered
 *          on /student/saved with its correct option, mid-test or before the
 *          result was released.
 *   P0-02  Ask AI (explanation / explanation variant / AI Question Variants)
 *          served answer-revealing content for any question id the student
 *          had never legitimately reviewed.
 *
 * Both now go through one canonical rule, lib/student-data.ts
 * #getAnswerRevealStatuses. This drives the real start/save/submit and
 * serialization code against disposable fixtures.
 *
 * Run from the repo root against a DISPOSABLE database:
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-p0-answer-reveal.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  PrismaClient,
  StudentAuthProvider,
  QuestionStatus,
  QuestionDifficulty,
  MockResultRelease,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  getSavedQuestions,
  toggleSavedQuestion,
  getAnswerRevealStatus,
  getSavedQuestionIdSet,
} from "@/lib/student-data";
import { startMockTestAttempt, saveAnswer, submitAttempt } from "@/lib/test-attempt";
import { selectPublishedQuestions } from "@/lib/question-selection";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}
async function rejects(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `P0 Exam ${suffix}`, code: `P0-${suffix}`, isActive: true } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "P0 Subject" } });
  const mkQuestion = (n: number, status: QuestionStatus = QuestionStatus.PUBLISHED) =>
    prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        code: `Q-P0-${suffix}-${n}`,
        text: `Question ${n}?`,
        status,
        difficulty: QuestionDifficulty.EASY,
        options: {
          create: [
            { label: "A", text: "wrong", isCorrect: false, order: 0 },
            { label: "B", text: "right", isCorrect: true, order: 1 },
          ],
        },
      },
    });
  const q1 = await mkQuestion(1);
  const q2 = await mkQuestion(2);
  const qDraft = await mkQuestion(3, QuestionStatus.DRAFT);

  const future = new Date(Date.now() + 24 * 3600_000);
  const mock = await prisma.mockTest.create({
    data: {
      examId: exam.id,
      title: "P0 Mock",
      durationMinutes: 30,
      status: "PUBLISHED",
      resultReleaseMode: MockResultRelease.CUSTOM_DATE,
      resultReleaseAt: future,
      questions: { create: [{ questionId: q1.id, order: 0 }, { questionId: q2.id, order: 1 }] },
    },
  });
  const mkStudent = (tag: string) =>
    prisma.student.create({
      data: { studentId: `P0${tag}-${suffix}`, name: `P0 ${tag}`, email: `p0-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
  const a = await mkStudent("A");
  const b = await mkStudent("B");

  const noAnswerKey = (views: Awaited<ReturnType<typeof getSavedQuestions>>) =>
    !JSON.stringify(views).includes("isCorrect") && views.every((v) => !v.answerRevealed && v.options.every((o) => !("isCorrect" in o)));

  console.log("P0-01 — Saved Questions");
  const attempt = await startMockTestAttempt(a.id, mock.id);
  check("attempt started IN_PROGRESS", attempt.status === "IN_PROGRESS");

  // 7. Test player payload: the run page maps snapshot fields explicitly and never passes correctLabel/isCorrect.
  const runPage = readFileSync("app/student/attempt/[attemptId]/run/page.tsx", "utf8");
  check("test player payload omits correctLabel/isCorrect", !/correctLabel|isCorrect/.test(runPage));

  // 1. Bookmarking during an IN_PROGRESS attempt still works.
  check("save during IN_PROGRESS attempt succeeds", (await toggleSavedQuestion(a.id, q1.id)) === true);
  check("saved id set reflects the bookmark", (await getSavedQuestionIdSet(a.id, [q1.id])).has(q1.id));

  // 2. Saved view before submission: question visible, no answer key in the server data at all.
  let saved = await getSavedQuestions(a.id);
  check("saved question listed with its text/options", saved.length === 1 && saved[0].text === "Question 1?" && saved[0].options.length === 2);
  check("IN_PROGRESS: no isCorrect anywhere in the serialized data", noAnswerKey(saved));
  check("IN_PROGRESS: lockReason IN_PROGRESS", saved[0].lockReason === "IN_PROGRESS");

  // 3. Direct server-action style abuse: arbitrary ids cannot be saved.
  check("saving a question outside own attempts is refused (draft)", await rejects(() => toggleSavedQuestion(a.id, qDraft.id)));
  check("saving an unknown id is refused", await rejects(() => toggleSavedQuestion(a.id, "does-not-exist")));
  check("saving a malformed id is refused", await rejects(() => toggleSavedQuestion(a.id, "x".repeat(200))));

  // Custom Module SAVED filter must not hand the locked question back for a quick re-take.
  check(
    "SAVED practice filter excludes a question still in a running test",
    await rejects(() => selectPublishedQuestions({ examId: exam.id, studentId: a.id, attemptFilter: "SAVED", count: 1 }))
  );

  // Submit, with the mock's result held until tomorrow.
  await saveAnswer(attempt.id, a.id, q1.id, "A", false);
  await saveAnswer(attempt.id, a.id, q2.id, "B", false);
  const submitted = await submitAttempt(attempt.id, a.id);
  check("attempt submitted and scored (1 correct, 1 incorrect)", submitted.status === "SUBMITTED" && submitted.correctCount === 1 && submitted.incorrectCount === 1);
  check("answer save after submission is refused", await rejects(() => saveAnswer(attempt.id, a.id, q1.id, "B", false)));

  saved = await getSavedQuestions(a.id);
  check("RESULT_HELD: still no isCorrect in serialized data", noAnswerKey(saved));
  check("RESULT_HELD: lockReason RESULT_HELD", saved[0].lockReason === "RESULT_HELD");
  check(
    "INCORRECT practice filter excludes questions from a held result",
    await rejects(() => selectPublishedQuestions({ examId: exam.id, studentId: a.id, attemptFilter: "INCORRECT", count: 1 }))
  );

  console.log("P0-02 — Ask AI gate (the check every Ask AI action runs first)");
  check("held result -> RESULT_HELD", (await getAnswerRevealStatus(a.id, q1.id)) === "RESULT_HELD");
  check("never-attempted draft id -> NO_ACCESS", (await getAnswerRevealStatus(a.id, qDraft.id)) === "NO_ACCESS");
  check("unknown id -> NO_ACCESS", (await getAnswerRevealStatus(a.id, "does-not-exist")) === "NO_ACCESS");
  const aiSource = readFileSync("app/student/ai-actions.ts", "utf8");
  const actions = ["getExplanationAction", "getExplanationVariantAction", "getQuestionVariantsAction"];
  for (const name of actions) {
    const body = aiSource.slice(aiSource.indexOf(`export async function ${name}`));
    const gateAt = body.indexOf("answerLockMessage(student.id, questionId)");
    const firstAiCall = Math.min(
      ...["getStoredAiExplanation", "getOrCreateExplanation", "getStoredAiExplanationVariant", "getActiveVariants", "checkAiAccessQuota"]
        .map((f) => body.indexOf(`${f}(`))
        .filter((i) => i >= 0)
    );
    check(`${name}: canonical gate runs before any cache/quota/provider call`, gateAt > 0 && gateAt < firstAiCall);
  }
  check("old per-surface helpers no longer used by Ask AI", !/hasInProgressAttemptForQuestion|hasUnreleasedResultForQuestion/.test(aiSource));

  // 4. After legitimate submission AND release, answers behave as before.
  await prisma.mockTest.update({ where: { id: mock.id }, data: { resultReleaseAt: new Date(Date.now() - 60_000) } });
  check("released -> REVEALABLE (Ask AI allowed)", (await getAnswerRevealStatus(a.id, q1.id)) === "REVEALABLE");
  saved = await getSavedQuestions(a.id);
  check(
    "released: saved view carries the answer key (B correct)",
    saved[0].answerRevealed && saved[0].options.find((o) => o.label === "B")?.isCorrect === true && saved[0].lockReason === null
  );
  const practice = await selectPublishedQuestions({ examId: exam.id, studentId: a.id, attemptFilter: "SAVED", count: 1 });
  check("released: SAVED practice filter works again", practice.questions.length === 1 && practice.questions[0].id === q1.id);

  // A retake re-locks the question while the new attempt runs.
  const retake = await startMockTestAttempt(a.id, mock.id);
  check("retake IN_PROGRESS re-locks the answer", (await getAnswerRevealStatus(a.id, q1.id)) === "IN_PROGRESS" && noAnswerKey(await getSavedQuestions(a.id)));
  await submitAttempt(retake.id, a.id);
  check("retake submitted (released) -> REVEALABLE again", (await getAnswerRevealStatus(a.id, q1.id)) === "REVEALABLE");

  // 5. Cross-student.
  console.log("Cross-student");
  check("B sees none of A's saved questions", (await getSavedQuestions(b.id)).length === 0);
  check("B cannot save A's question (not in B's attempts)", await rejects(() => toggleSavedQuestion(b.id, q1.id)));
  check("B's Ask AI for A's question -> NO_ACCESS", (await getAnswerRevealStatus(b.id, q1.id)) === "NO_ACCESS");

  // 8. Unsave still works.
  check("unsave works", (await toggleSavedQuestion(a.id, q1.id)) === false && (await getSavedQuestions(a.id)).length === 0);

  // Cleanup (disposable fixtures only).
  await prisma.savedQuestion.deleteMany({ where: { studentId: { in: [a.id, b.id] } } });
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: [a.id, b.id] } } });
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: [a.id, b.id] } } });
  await prisma.student.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  await prisma.mockTest.delete({ where: { id: mock.id } });
  await prisma.exam.delete({ where: { id: exam.id } });

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
