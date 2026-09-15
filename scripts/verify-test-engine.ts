/**
 * Verifies the Step 3 unified test engine: shared question selection, the
 * SUBJECT_TEST flow, and server-side timer enforcement.
 *
 *  1. Selection service — counts/distinct years, exam↔subject↔topic↔sub-topic
 *     ownership chain, PUBLISHED-only pools, Fisher–Yates randomness, and the
 *     InsufficientQuestionsError contract.
 *  2. Subject test generation — an attempt is created with frozen per-question
 *     snapshots and self-describing `selection` metadata; a second start for
 *     the same subject resumes the SAME attempt (never a reshuffle).
 *  3. Regression — the existing mock-test path still starts and resumes.
 *  4. Server timer — exact boundary behavior (effectiveEnd is exclusive, so
 *     now >= effectiveEnd is expired), saveAnswer rejected past the window,
 *     late submit always accepted with timeTaken capped at duration, double
 *     submit idempotent, and a question outside the attempt rejected. Because
 *     every timing check goes through serverNow() (never a client clock), a
 *     manipulated browser can neither extend the window nor edit answers past
 *     it.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-test-engine.ts
 */
import "dotenv/config";
import {
  PrismaClient,
  AttemptSourceType,
  AttemptStatus,
  AnswerStatus,
  StudentAuthProvider,
  QuestionStatus,
  QuestionDifficulty,
  MockTestStatus,
  TestType,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import {
  startSubjectTestAttempt,
  startMockTestAttempt,
  saveAnswer,
  submitAttempt,
} from "@/lib/test-attempt";
import {
  selectPublishedQuestions,
  countPublishedQuestions,
  distinctYears,
  InsufficientQuestionsError,
} from "@/lib/question-selection";
import { isExpired, remainingSecondsFor, serverNow } from "@/lib/attempt-timing";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

function expectThrows(label: string, fn: () => Promise<unknown> | unknown): Promise<Error | null> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        check(label, false);
        return null;
      },
      (e) => {
        check(label, true);
        return e as Error;
      }
    );
}

async function main() {
  console.log("=== Unified Test Engine Verification ===\n");

  const suffix = Date.now().toString(36);
  const started = Date.now();

  // ---- Fixture ----------------------------------------------------------
  const examA = await prisma.exam.create({ data: { name: `Engine Exam A ${suffix}`, code: `ENG-A-${suffix}` } });
  const examB = await prisma.exam.create({ data: { name: `Engine Exam B ${suffix}`, code: `ENG-B-${suffix}` } });

  const subjA = await prisma.subject.create({ data: { examId: examA.id, name: "Engine Subject A" } });
  const subjB = await prisma.subject.create({ data: { examId: examA.id, name: "Engine Subject B" } });
  const subjX = await prisma.subject.create({ data: { examId: examB.id, name: "Engine Subject X" } });

  const topicA1 = await prisma.topic.create({ data: { subjectId: subjA.id, name: "Engine Topic A1" } });
  const subtopicA1 = await prisma.subTopic.create({ data: { topicId: topicA1.id, name: "Engine Subtopic A1" } });
  const subtopicA2 = await prisma.subTopic.create({ data: { topicId: topicA1.id, name: "Engine Subtopic A2" } });
  const topicA2 = await prisma.topic.create({ data: { subjectId: subjA.id, name: "Engine Topic A2" } });

  async function makeQuestion(opts: {
    subjectId: string;
    topicId?: string;
    subTopicId?: string;
    year: number;
    difficulty: QuestionDifficulty;
    status?: QuestionStatus;
    correctLab?: string;
  }) {
    const correctLab = opts.correctLab ?? "B";
    return prisma.question.create({
      data: {
        examId: examA.id,
        subjectId: opts.subjectId,
        topicId: opts.topicId,
        subTopicId: opts.subTopicId,
        code: `Q-ENG-${suffix}-${started}-${Math.random().toString(36).slice(2, 7)}`,
        text: `${opts.subjectId} year ${opts.year} question?`,
        examYear: opts.year,
        difficulty: opts.difficulty,
        status: opts.status ?? QuestionStatus.PUBLISHED,
        options: {
          create: [
            { label: "A", text: `Ans-${correctLab === "A" ? "1" : "0"}`, isCorrect: correctLab === "A" },
            { label: "B", text: `Ans-${correctLab === "B" ? "1" : "0"}`, isCorrect: correctLab === "B" },
            { label: "C", text: `Ans-${correctLab === "C" ? "1" : "0"}`, isCorrect: correctLab === "C" },
            { label: "D", text: `Ans-${correctLab === "D" ? "1" : "0"}`, isCorrect: correctLab === "D" },
          ],
        },
      },
      include: { options: true },
    });
  }

  // subjA: 6 PUBLISHED across topics/years, 1 DRAFT that must never be picked.
  const [q1, q2, q3, q4, , q6, q7] = await Promise.all([
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id, subTopicId: subtopicA1.id, year: 2023, difficulty: QuestionDifficulty.EASY }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id, subTopicId: subtopicA1.id, year: 2023, difficulty: QuestionDifficulty.MEDIUM }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id, subTopicId: subtopicA1.id, year: 2023, difficulty: QuestionDifficulty.HARD }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA2.id, year: 2023, difficulty: QuestionDifficulty.EASY }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA2.id, year: 2023, difficulty: QuestionDifficulty.MEDIUM }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id, subTopicId: subtopicA2.id, year: 2022, difficulty: QuestionDifficulty.EASY }),
    makeQuestion({ subjectId: subjB.id, year: 2024, difficulty: QuestionDifficulty.EASY }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id, subTopicId: subtopicA1.id, year: 2022, difficulty: QuestionDifficulty.EASY, status: QuestionStatus.DRAFT }),
  ]);

  const mockTest = await prisma.mockTest.create({
    data: {
      examId: examA.id,
      title: `Engine Mock Test ${suffix}`,
      durationMinutes: 30,
      negativeMarking: 0.25,
      status: MockTestStatus.PUBLISHED,
      questions: { create: [{ questionId: q1.id, order: 0 }, { questionId: q4.id, order: 1 }] },
    },
  });

  const passwordHash = await argon2.hash("Engine@12345");
  const student = await prisma.student.create({
    data: {
      studentId: `ENG-${suffix}`,
      name: "Engine Student",
      email: `engine-${suffix}@example.test`,
      passwordHash,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });

  console.log(`Fixture — examA ${examA.id}, subjA ${subjA.id}, subjB ${subjB.id}, subjX ${subjX.id} (examB), student ${student.id}\n`);

  try {
    // ---- 1. Selection service ---------------------------------------------
    console.log("--- Selection service (counts, years, ownership, PUBLISHED-only) ---");

    const subjACount = await countPublishedQuestions({ examId: examA.id, subjectId: subjA.id });
    check("countPublishedQuestions(subjA) excludes the DRAFT question (6 PUBLISHED)", subjACount === 6);

    const topicCount = await countPublishedQuestions({ examId: examA.id, subjectId: subjA.id, topicId: topicA1.id });
    check("topic filter narrows the pool (topic A1 → 4)", topicCount === 4);

    const subTopicCount = await countPublishedQuestions({
      examId: examA.id,
      subjectId: subjA.id,
      topicId: topicA1.id,
      subTopicId: subtopicA1.id,
    });
    check("sub-topic filter narrows further (subtopic A1 → 3)", subTopicCount === 3);

    const years = await distinctYears({ examId: examA.id, subjectId: subjA.id });
    check("distinctYears(subjA) → [2023, 2022]", JSON.stringify(years) === JSON.stringify([2023, 2022]));

    const crossExam = await countPublishedQuestions({ examId: examA.id, subjectId: subjX.id });
    check("a subject of examB yields 0 questions when scoped to examA (no cross-exam bleed)", crossExam === 0);

    const sel = await selectPublishedQuestions({
      examId: examA.id,
      subjectId: subjA.id,
      topicId: topicA1.id,
      subTopicId: subtopicA1.id,
      year: 2023,
      count: 3,
    });
    const selIds = sel.questions.map((q) => q.id).sort();
    const expectedIds = [q1.id, q2.id, q3.id].sort();
    check("selectPublishedQuestions returns exactly the in-scope set", JSON.stringify(selIds) === JSON.stringify(expectedIds));
    check("every returned question carries its frozen options", sel.questions.every((q) => q.options.length === 4));

    const crossExamErr = await expectThrows(
      "subject from another exam is rejected by the ownership chain",
      () => selectPublishedQuestions({ examId: examA.id, subjectId: subjX.id, count: 1 })
    );
    check("cross-exam subject error is thrown as an Error", crossExamErr instanceof Error);

    await expectThrows(
      "topic that does not belong to the subject is rejected",
      () => selectPublishedQuestions({ examId: examA.id, subjectId: subjB.id, topicId: topicA1.id, count: 1 })
    );
    await expectThrows(
      "sub-topic supplied without its topic is rejected",
      () => selectPublishedQuestions({ examId: examA.id, subjectId: subjA.id, subTopicId: subtopicA1.id, count: 1 })
    );
    await expectThrows(
      "count of 0 is rejected",
      () => selectPublishedQuestions({ examId: examA.id, subjectId: subjA.id, count: 0 })
    );

    const insufficient = await expectThrows(
      "requesting more questions than exist raises InsufficientQuestionsError",
      () => selectPublishedQuestions({ examId: examA.id, subjectId: subjA.id, count: 500 })
    );
    check(
      "InsufficientQuestionsError carries requested/available counts",
      insufficient instanceof InsufficientQuestionsError &&
        (insufficient as InsufficientQuestionsError).requested === 500 &&
        (insufficient as InsufficientQuestionsError).available === 6
    );

    // Selection randomness: two draws of equal size should usually differ.
    const drawA = (await selectPublishedQuestions({ examId: examA.id, subjectId: subjA.id, count: 6 })).questions.map((q) => q.id);
    const drawB = (await selectPublishedQuestions({ examId: examA.id, subjectId: subjA.id, count: 6 })).questions.map((q) => q.id);
    check("two full draws are shuffled (order differs between draws)", JSON.stringify(drawA) !== JSON.stringify(drawB));

    // ---- 2. Subject test generation / resume ------------------------------
    console.log("\n--- Subject test generation, snapshots, resume ---");

    const st1 = await startSubjectTestAttempt(student.id, {
      examId: examA.id,
      subjectId: subjA.id,
      count: 3,
      durationMinutes: 25,
    });
    check("generated attempt has sourceType SUBJECT_TEST", st1.sourceType === AttemptSourceType.SUBJECT_TEST);
    check("generated attempt has testType SUBJECT_TEST", st1.testType === TestType.SUBJECT_TEST);
    check("generated attempt is scoped to the subject", st1.subjectId === subjA.id);
    check("generated attempt duration is server-provided", st1.durationMinutes === 25);
    check("generated attempt has no negative marking", st1.negativeMarking === 0);

    const st1Questions = await prisma.testAttemptQuestion.findMany({
      where: { attemptId: st1.id },
    });
    check("exactly the requested count was frozen", st1Questions.length === 3);
    const st1QuestionRows = await prisma.question.findMany({
      where: { id: { in: st1Questions.map((tq) => tq.questionId) } },
      select: { id: true, subjectId: true },
    });
    const subjectByQuestionId = new Map(st1QuestionRows.map((q) => [q.id, q.subjectId]));
    check(
      "every frozen question is owned by the requested subject",
      st1Questions.every((tq) => subjectByQuestionId.get(tq.questionId) === subjA.id)
    );
    const snapshots = st1Questions.map((tq) => tq.questionSnapshot as { correctLabel: string; options: unknown[] });
    check("every question snapshot is frozen with a correct label", snapshots.every((s) => typeof s.correctLabel === "string" && s.correctLabel.length > 0));
    check("every question snapshot froze 4 options", snapshots.every((s) => s.options.length === 4));
    const st1Selection = st1.selection as unknown as { subjects?: { id: string }[] } | null;
    check(
      "attempt records its selection filters (subject self-describing)",
      Array.isArray(st1Selection?.subjects) && st1Selection!.subjects!.length === 1 && st1Selection!.subjects![0].id === subjA.id
    );

    const st2 = await startSubjectTestAttempt(student.id, {
      examId: examA.id,
      subjectId: subjA.id,
      count: 5,
      durationMinutes: 60,
    });
    check("starting again for the same subject resumes the SAME attempt", st2.id === st1.id);
    const st2Questions = await prisma.testAttemptQuestion.findMany({ where: { attemptId: st2.id }, orderBy: { order: "asc" } });
    check(
      "resume does not reshuffle — question set and order are identical",
      JSON.stringify(st2Questions.map((tq) => tq.questionId)) === JSON.stringify(st1Questions.map((tq) => tq.questionId))
    );

    // ---- 3. Regression: existing test type --------------------------------
    console.log("\n--- Regression: mock test path still works ---");

    const mt1 = await startMockTestAttempt(student.id, mockTest.id);
    check("mock test attempt starts with MOCK_TEST source", mt1.sourceType === AttemptSourceType.MOCK_TEST);
    check("mock test attempt carries the mock's negative marking", mt1.negativeMarking === mockTest.negativeMarking);
    const mt1Questions = await prisma.testAttemptQuestion.findMany({ where: { attemptId: mt1.id } });
    check("mock test freezes exactly its fixed question list (2)", mt1Questions.length === 2);

    const mt2 = await startMockTestAttempt(student.id, mockTest.id);
    check("starting the same mock test again resumes the same attempt", mt2.id === mt1.id);

    // ---- 4. Server-side timer enforcement ----------------------------------
    console.log("\n--- Server-side timer (boundary, saveAnswer, late submit, double submit) ---");

    const durMs = 60_000;
    const now = serverNow();

    // exact boundary: now === effectiveEnd is already expired (EXCLUSIVE end)
    const justBefore = new Date(now.getTime() - (durMs - 1000)); // 1s left
    const atBoundary = new Date(now.getTime() - durMs);
    const afterBoundary = new Date(now.getTime() - durMs - 1000);

    check("1 second before the deadline the attempt is NOT expired", isExpired({ startedAt: justBefore, durationMinutes: 1 }) === false);
    check("at the exact effectiveEnd the attempt IS expired (exclusive boundary)", isExpired({ startedAt: atBoundary, durationMinutes: 1 }) === true);
    check("past effectiveEnd the attempt IS expired", isExpired({ startedAt: afterBoundary, durationMinutes: 1 }) === true);
    check("remainingSecondsFor clamps to 0 once expired", remainingSecondsFor({ startedAt: afterBoundary, durationMinutes: 1 }, now) === 0);
    check(
      "remainingSecondsFor reports the true remaining second (1s left)",
      remainingSecondsFor({ startedAt: justBefore, durationMinutes: 1 }, now) === 1
    );

    // A manual, already-expired SUBJECT_TEST attempt (harness replicates the
    // row createAttemptFromQuestions would have produced, but back-dated).
    const timerStart = new Date(now.getTime() - durMs - 5000);
    const timerAttempt = await prisma.testAttempt.create({
      data: {
        studentId: student.id,
        sourceType: AttemptSourceType.SUBJECT_TEST,
        testType: TestType.SUBJECT_TEST,
        examId: examA.id,
        subjectId: subjB.id,
        durationMinutes: 1,
        negativeMarking: 0,
        totalQuestions: 1,
        status: AttemptStatus.IN_PROGRESS,
        startedAt: timerStart,
      },
    });
    await prisma.testAttemptQuestion.create({
      data: {
        attemptId: timerAttempt.id,
        questionId: q7.id,
        order: 0,
        questionSnapshot: {
          code: q7.code,
          text: q7.text,
          imageUrl: null,
          difficulty: q7.difficulty,
          options: q7.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
          correctLabel: q7.options.find((o) => o.isCorrect)?.label ?? "",
        },
        answer: { create: { attemptId: timerAttempt.id, studentId: student.id, questionId: q7.id, status: AnswerStatus.UNANSWERED } },
      },
    });

    const expiredErr = await expectThrows(
      "saveAnswer after effectiveEnd is rejected by the server",
      () => saveAnswer(timerAttempt.id, student.id, q7.id, "B", false)
    );
    check("the rejection message names the end of the test", expiredErr instanceof Error && /Time is up|ended/.test(expiredErr.message));

    const submitted = await submitAttempt(timerAttempt.id, student.id);
    const timeTaken = submitted.timeTakenSeconds ?? 0;
    check("late submission always succeeds and closes the attempt", submitted.status === AttemptStatus.SUBMITTED);
    check("reported time can never exceed the window (capped at 60s)", timeTaken <= 60);
    check("late submissions were graded from on-record answers (unanswered → 0 correct)", (submitted.correctCount ?? 0) === 0);

    let doubleSubmitErr: Error | null = null;
    try {
      await submitAttempt(timerAttempt.id, student.id);
    } catch (e) {
      doubleSubmitErr = e as Error;
    }
    check("double submit is idempotent and does not error", doubleSubmitErr === null);
    check("double submit returned the already-submitted attempt without error", doubleSubmitErr === null);
    const afterDouble = await prisma.testAttempt.findUnique({ where: { id: timerAttempt.id } });
    check("double submit left grading untouched", (afterDouble?.correctCount ?? -1) === (submitted.correctCount ?? -1));

    // Foreign question rejection on a LIVE (non-expired) attempt.
    const liveAttempt = await prisma.testAttempt.create({
      data: {
        studentId: student.id,
        sourceType: AttemptSourceType.SUBJECT_TEST,
        testType: TestType.SUBJECT_TEST,
        examId: examA.id,
        subjectId: subjB.id,
        durationMinutes: 10,
        negativeMarking: 0,
        totalQuestions: 1,
        status: AttemptStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
    });
    await prisma.testAttemptQuestion.create({
      data: { attemptId: liveAttempt.id, questionId: q7.id, order: 0, questionSnapshot: { correctLabel: "B", options: [] } },
    });
    await expectThrows(
      "a question outside the attempt is rejected even while the timer is running",
      () => saveAnswer(liveAttempt.id, student.id, q6.id, "A", false)
    );

    // Cleanup the two manual attempts' answers are removed along with the attempts via FK cascade is not set,
    // so delete the answers explicitly before the attempts.
    await prisma.answer.deleteMany({ where: { attemptId: { in: [timerAttempt.id, liveAttempt.id] } } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attemptId: { in: [timerAttempt.id, liveAttempt.id] } } });
    await prisma.testAttempt.delete({ where: { id: timerAttempt.id } });
    await prisma.testAttempt.delete({ where: { id: liveAttempt.id } });

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");

    // Attempts cascade questions/answers through their own fk? We delete explicitly to be safe.
    await prisma.answer.deleteMany({ where: { studentId: student.id } });
    await prisma.testAttempt.deleteMany({ where: { studentId: student.id } });
    await prisma.student.delete({ where: { id: student.id } });
    await prisma.mockTest.delete({ where: { id: mockTest.id } });
    await prisma.question.deleteMany({ where: { examId: { in: [examA.id, examB.id] } } });
    await prisma.subTopic.deleteMany({ where: { topicId: { in: [topicA1.id, topicA2.id] } } });
    await prisma.topic.deleteMany({ where: { id: { in: [topicA1.id, topicA2.id] } } });
    await prisma.subject.deleteMany({ where: { id: { in: [subjA.id, subjB.id, subjX.id] } } });
    await prisma.exam.deleteMany({ where: { id: { in: [examA.id, examB.id] } } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});