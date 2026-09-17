/**
 * Verifies the Step 4 Grand Test feature: blueprint validation, publish-time
 * resolution into an immutable GrandTestQuestion set, and the student-facing
 * attempt flow.
 *
 *  1. Blueprint ownership — assertValidOwnershipChain rejects a blueprint
 *     line whose subject belongs to a different exam (exported for exactly
 *     this reuse by createGrandTestAction/updateGrandTestAction).
 *  2. Publish resolution — replicates what publishGrandTestAction does
 *     (resolve every blueprint line via selectPublishedQuestions, freeze the
 *     union into GrandTestQuestion, flip status to PUBLISHED) and checks the
 *     resulting set is exactly the expected questions, DRAFT questions never
 *     included, and overlapping blueprint lines are caught before being
 *     written (same de-dupe check the action performs).
 *  3. Student attempt flow — startGrandTestAttempt only works once PUBLISHED,
 *     freezes the exact GrandTestQuestion set/order into the attempt via
 *     frozen snapshots, and a second start for the same student resumes the
 *     SAME attempt rather than reshuffling.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-grand-test.ts
 */
import "dotenv/config";
import {
  PrismaClient,
  AttemptSourceType,
  StudentAuthProvider,
  QuestionStatus,
  QuestionDifficulty,
  GrandTestStatus,
  TestType,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { startGrandTestAttempt } from "@/lib/test-attempt";
import { selectPublishedQuestions, assertValidOwnershipChain, InsufficientQuestionsError } from "@/lib/question-selection";

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

type BlueprintLine = {
  subjectId: string;
  topicId?: string;
  subTopicId?: string;
  difficulty?: QuestionDifficulty[];
  count: number;
};

/** Mirrors publishGrandTestAction's resolution loop exactly (see app/admin/(dashboard)/tests/grand/actions.ts). */
async function resolveAndPublish(grandTestId: string, examId: string, lines: BlueprintLine[]) {
  const resolvedQuestionIds: string[] = [];
  for (const line of lines) {
    const { questions } = await selectPublishedQuestions({
      examId,
      subjectId: line.subjectId,
      topicId: line.topicId || undefined,
      subTopicId: line.subTopicId || undefined,
      difficulty: line.difficulty && line.difficulty.length > 0 ? line.difficulty : undefined,
      count: line.count,
    });
    resolvedQuestionIds.push(...questions.map((q) => q.id));
  }
  const uniqueQuestionIds = Array.from(new Set(resolvedQuestionIds));
  if (uniqueQuestionIds.length !== resolvedQuestionIds.length) {
    throw new Error("OVERLAP");
  }
  await prisma.$transaction([
    prisma.grandTestQuestion.deleteMany({ where: { grandTestId } }),
    prisma.grandTestQuestion.createMany({
      data: uniqueQuestionIds.map((questionId, order) => ({ grandTestId, questionId, order })),
    }),
    prisma.grandTest.update({ where: { id: grandTestId }, data: { status: GrandTestStatus.PUBLISHED, publishedAt: new Date() } }),
  ]);
  return uniqueQuestionIds;
}

async function main() {
  console.log("=== Grand Test Verification ===\n");

  const suffix = Date.now().toString(36);

  // ---- Fixture ----------------------------------------------------------
  const examA = await prisma.exam.create({ data: { name: `Grand Exam A ${suffix}`, code: `GRD-A-${suffix}` } });
  const examB = await prisma.exam.create({ data: { name: `Grand Exam B ${suffix}`, code: `GRD-B-${suffix}` } });

  const subjA = await prisma.subject.create({ data: { examId: examA.id, name: "Grand Subject A" } });
  const subjB = await prisma.subject.create({ data: { examId: examA.id, name: "Grand Subject B" } });
  const subjX = await prisma.subject.create({ data: { examId: examB.id, name: "Grand Subject X" } });
  const topicA1 = await prisma.topic.create({ data: { subjectId: subjA.id, name: "Grand Topic A1" } });

  async function makeQuestion(opts: { subjectId: string; topicId?: string; status?: QuestionStatus }) {
    return prisma.question.create({
      data: {
        examId: examA.id,
        subjectId: opts.subjectId,
        topicId: opts.topicId,
        code: `Q-GRD-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        text: `Grand fixture question ${Math.random().toString(36).slice(2, 6)}?`,
        examYear: 2024,
        difficulty: QuestionDifficulty.EASY,
        status: opts.status ?? QuestionStatus.PUBLISHED,
        options: {
          create: [
            { label: "A", text: "0", isCorrect: false },
            { label: "B", text: "1", isCorrect: true },
            { label: "C", text: "0", isCorrect: false },
            { label: "D", text: "0", isCorrect: false },
          ],
        },
      },
      include: { options: true },
    });
  }

  // subjA/topicA1: 3 PUBLISHED + 1 DRAFT. subjB: 2 PUBLISHED.
  const [a1, a2, a3] = await Promise.all([
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id }),
    makeQuestion({ subjectId: subjA.id, topicId: topicA1.id }),
  ]);
  await makeQuestion({ subjectId: subjA.id, topicId: topicA1.id, status: QuestionStatus.DRAFT });
  const [b1, b2] = await Promise.all([
    makeQuestion({ subjectId: subjB.id }),
    makeQuestion({ subjectId: subjB.id }),
  ]);

  const passwordHash = await argon2.hash("Grand@12345");
  const student = await prisma.student.create({
    data: {
      studentId: `GRD-${suffix}`,
      name: "Grand Student",
      email: `grand-${suffix}@example.test`,
      passwordHash,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });

  const grandTestIds: string[] = [];
  console.log(`Fixture — examA ${examA.id}, subjA ${subjA.id}, subjB ${subjB.id}, subjX ${subjX.id} (examB), student ${student.id}\n`);

  try {
    // ---- 1. Blueprint ownership --------------------------------------
    console.log("--- Blueprint ownership ---");
    await expectThrows(
      "a blueprint line whose subject belongs to another exam is rejected",
      () => assertValidOwnershipChain({ examId: examA.id, subjectId: subjX.id })
    );
    await assertValidOwnershipChain({ examId: examA.id, subjectId: subjA.id, topicId: topicA1.id });
    check("a valid exam→subject→topic chain does not throw", true);

    // ---- 2. Publish resolution ----------------------------------------
    console.log("\n--- Publish resolution ---");
    const gt1 = await prisma.grandTest.create({
      data: {
        examId: examA.id,
        title: `Grand Test 1 ${suffix}`,
        durationMinutes: 60,
        negativeMarking: 0.25,
        accessType: "FREE",
        questionCount: 5,
        status: GrandTestStatus.DRAFT,
        blueprint: [
          { subjectId: subjA.id, topicId: topicA1.id, count: 3 },
          { subjectId: subjB.id, count: 2 },
        ] as unknown as object,
      },
    });
    grandTestIds.push(gt1.id);

    const resolved = await resolveAndPublish(gt1.id, examA.id, [
      { subjectId: subjA.id, topicId: topicA1.id, count: 3 },
      { subjectId: subjB.id, count: 2 },
    ]);
    check("publish resolves exactly questionCount questions (5)", resolved.length === 5);
    const expectedIds = [a1.id, a2.id, a3.id, b1.id, b2.id].sort();
    check("resolved set is exactly the in-scope PUBLISHED questions (DRAFT excluded)", JSON.stringify(resolved.slice().sort()) === JSON.stringify(expectedIds));

    const gtQuestions = await prisma.grandTestQuestion.findMany({ where: { grandTestId: gt1.id }, orderBy: { order: "asc" } });
    check("GrandTestQuestion rows persisted with sequential order", gtQuestions.every((q, i) => q.order === i));

    const publishedRow = await prisma.grandTest.findUniqueOrThrow({ where: { id: gt1.id } });
    check("GrandTest.status flipped to PUBLISHED with publishedAt set", publishedRow.status === GrandTestStatus.PUBLISHED && publishedRow.publishedAt !== null);

    // Overlapping blueprint lines (subject-only row overlaps the topic-scoped row) must be caught.
    const gt2 = await prisma.grandTest.create({
      data: {
        examId: examA.id,
        title: `Grand Test 2 (overlap) ${suffix}`,
        durationMinutes: 30,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 6,
        status: GrandTestStatus.DRAFT,
        blueprint: [
          { subjectId: subjA.id, count: 3 },
          { subjectId: subjA.id, topicId: topicA1.id, count: 3 },
        ] as unknown as object,
      },
    });
    grandTestIds.push(gt2.id);
    await expectThrows("overlapping blueprint rows (same question drawn twice) are rejected before writing", () =>
      resolveAndPublish(gt2.id, examA.id, [
        { subjectId: subjA.id, count: 3 },
        { subjectId: subjA.id, topicId: topicA1.id, count: 3 },
      ])
    );
    const gt2AfterFail = await prisma.grandTest.findUniqueOrThrow({ where: { id: gt2.id } });
    check("a failed publish leaves the grand test in DRAFT (no partial write)", gt2AfterFail.status === GrandTestStatus.DRAFT);

    // Insufficient pool.
    const gt3 = await prisma.grandTest.create({
      data: {
        examId: examA.id,
        title: `Grand Test 3 (insufficient) ${suffix}`,
        durationMinutes: 30,
        negativeMarking: 0,
        accessType: "FREE",
        questionCount: 50,
        status: GrandTestStatus.DRAFT,
        blueprint: [{ subjectId: subjB.id, count: 50 }] as unknown as object,
      },
    });
    grandTestIds.push(gt3.id);
    const insufficientErr = await expectThrows("a blueprint line asking for more questions than exist throws InsufficientQuestionsError", () =>
      resolveAndPublish(gt3.id, examA.id, [{ subjectId: subjB.id, count: 50 }])
    );
    check("...and it is specifically InsufficientQuestionsError", insufficientErr instanceof InsufficientQuestionsError);

    // ---- 3. Student attempt flow ---------------------------------------
    console.log("\n--- Student attempt flow ---");
    await expectThrows("starting an attempt on a DRAFT/unpublished grand test is rejected", () => startGrandTestAttempt(student.id, gt2.id));
    await expectThrows("starting an attempt on a nonexistent grand test is rejected", () => startGrandTestAttempt(student.id, "nonexistent-id"));

    const attempt1 = await startGrandTestAttempt(student.id, gt1.id);
    check("attempt created with sourceType/testType GRAND_TEST", attempt1.sourceType === AttemptSourceType.GRAND_TEST && attempt1.testType === TestType.GRAND_TEST);
    check("attempt.grandTestId points at the published grand test", attempt1.grandTestId === gt1.id);
    check("attempt carries the grand test's duration/negative marking", attempt1.durationMinutes === 60 && attempt1.negativeMarking === 0.25);

    const attemptQuestions = await prisma.testAttemptQuestion.findMany({ where: { attemptId: attempt1.id }, orderBy: { order: "asc" } });
    check("attempt froze exactly the published GrandTestQuestion set", JSON.stringify(attemptQuestions.map((q) => q.questionId).sort()) === JSON.stringify(expectedIds));
    check("attempt question order matches GrandTestQuestion order", JSON.stringify(attemptQuestions.map((q) => q.questionId)) === JSON.stringify(gtQuestions.map((q) => q.questionId)));

    const attempt2 = await startGrandTestAttempt(student.id, gt1.id);
    check("starting the same grand test again resumes the SAME attempt (no reshuffle)", attempt2.id === attempt1.id);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.answer.deleteMany({ where: { studentId: student.id } });
    await prisma.testAttempt.deleteMany({ where: { studentId: student.id } });
    await prisma.student.delete({ where: { id: student.id } });
    await prisma.grandTestQuestion.deleteMany({ where: { grandTestId: { in: grandTestIds } } });
    await prisma.grandTest.deleteMany({ where: { id: { in: grandTestIds } } });
    await prisma.question.deleteMany({ where: { examId: { in: [examA.id, examB.id] } } });
    await prisma.topic.deleteMany({ where: { id: topicA1.id } });
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
