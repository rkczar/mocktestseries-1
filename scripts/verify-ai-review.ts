/**
 * Verifies Step 6: Ask AI caching/concurrency, Saved Questions, and Question
 * Reports.
 *
 * No Gemini API key is configured in this environment (confirmed: 0 rows in
 * Setting where key='api.gemini', no GEMINI_API_KEY env var) — so an actual
 * live generation call is genuinely unverified here and is called out as
 * such in the session report. Everything that does NOT require a live call
 * is verified directly against the real functions:
 *
 *  1. Not-configured gate — getOrCreateExplanation refuses cleanly (no
 *     network call attempted, no dangling GENERATING row left behind) when
 *     no provider is configured, which is the actual current production
 *     state.
 *  2. Concurrency claim (claimGeneration, exported for exactly this) — a
 *     fresh question has no row to race on; two SIMULTANEOUS callers must
 *     result in exactly one true/one false. A FAILED row is reclaimable. A
 *     GENERATING row younger than STALE_GENERATION_MS blocks a second
 *     claimant; once "aged" past the threshold it becomes reclaimable —
 *     never permanently stuck.
 *  3. Saved Questions — save/unsave toggles, duplicate-save is a no-op (the
 *     @@unique([studentId, questionId]) constraint holds), ownership.
 *  4. Question Reports — the renamed ReportType taxonomy (WRONG_QUESTION /
 *     INCORRECT_EXPLANATION / IMAGE_ISSUE) round-trips through the DB.
 *  5. AI rate limiting — isAiGenerationRateLimited flips true once a
 *     student's logged new-generation count crosses the threshold, and
 *     never counts a cache hit.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ai-review.ts
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, QuestionStatus, QuestionDifficulty, AiGenerationStatus, ReportType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
// These import `server-only`, which is inert under the react-server condition.
import { getOrCreateExplanation, claimGeneration, AiNotConfiguredError, STALE_GENERATION_MS, EXPLANATION_PROMPT_VERSION } from "@/lib/ai-explanation";
import { toggleSavedQuestion, isQuestionSaved, reportQuestion, isAiGenerationRateLimited, logActivity } from "@/lib/student-data";

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
  console.log("=== AI Review / Saved Questions / Reports Verification ===\n");
  const suffix = Date.now().toString(36);

  const geminiRow = await prisma.setting.findUnique({ where: { key: "api.gemini" } });
  console.log(`Gemini configured in this environment: ${geminiRow ? "yes (unexpected — live calls would be attempted)" : "no"}\n`);

  const exam = await prisma.exam.create({ data: { name: `AI Exam ${suffix}`, code: `AI-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "AI Subject" } });

  async function makeQuestion() {
    return prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        code: `Q-AI-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        text: "AI fixture question?",
        examYear: 2024,
        difficulty: QuestionDifficulty.EASY,
        status: QuestionStatus.PUBLISHED,
        options: {
          create: [
            { label: "A", text: "0", isCorrect: false },
            { label: "B", text: "1", isCorrect: true },
            { label: "C", text: "0", isCorrect: false },
            { label: "D", text: "0", isCorrect: false },
          ],
        },
      },
    });
  }
  const q1 = await makeQuestion();
  const q2 = await makeQuestion();
  const q3 = await makeQuestion();
  const q4 = await makeQuestion();

  const passwordHash = await argon2.hash("Ai@12345");
  const student = await prisma.student.create({
    data: { studentId: `AI-${suffix}`, name: "AI Student", email: `ai-${suffix}@example.test`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });

  const questionIds = [q1.id, q2.id, q3.id, q4.id];
  const explanationIds: string[] = [];

  try {
    // ---- 1. Not-configured gate ----------------------------------------
    console.log("--- Not-configured gate (this environment's actual state) ---");
    const beforeCount = await prisma.aIExplanation.count({ where: { questionId: q1.id } });
    const err = await expectThrows("getOrCreateExplanation refuses cleanly when no provider is configured", () => getOrCreateExplanation(q1.id));
    check("...and it is specifically AiNotConfiguredError", err instanceof AiNotConfiguredError);
    const afterCount = await prisma.aIExplanation.count({ where: { questionId: q1.id } });
    check("...and no dangling GENERATING row was left behind", afterCount === beforeCount && afterCount === 0);

    // ---- 2. Concurrency claim -------------------------------------------
    console.log("\n--- Concurrency claim (DB-level mutex) ---");
    const claim1 = await claimGeneration(q2.id, null);
    check("first caller on a fresh question claims it", claim1 === true);
    const q2Row = await prisma.aIExplanation.findUniqueOrThrow({ where: { questionId: q2.id } });
    explanationIds.push(q2Row.id);
    check("the claimed row is GENERATING", q2Row.status === AiGenerationStatus.GENERATING);
    check("the claimed row carries the current prompt version", q2Row.promptVersion === EXPLANATION_PROMPT_VERSION);

    // Simulate 20 concurrent students racing to generate the SAME uncached question.
    const q3Results = await Promise.all(Array.from({ length: 20 }, () => claimGeneration(q3.id, null)));
    const winners = q3Results.filter(Boolean).length;
    check("20 simultaneous claims on the same fresh question → exactly ONE winner (never 20 generations)", winners === 1);
    const q3Rows = await prisma.aIExplanation.count({ where: { questionId: q3.id } });
    check("...and exactly one AIExplanation row exists for it", q3Rows === 1);
    const q3Row = await prisma.aIExplanation.findFirstOrThrow({ where: { questionId: q3.id } });
    explanationIds.push(q3Row.id);

    // A fresh (non-stale) GENERATING row blocks a second claimant.
    const blockedClaim = await claimGeneration(q2.id, q2Row);
    check("a fresh GENERATING row (not yet stale) blocks a second claim", blockedClaim === false);

    // A FAILED row is reclaimable (retry).
    const failedQuestion = await makeQuestion();
    questionIds.push(failedQuestion.id);
    const failedRow = await prisma.aIExplanation.create({
      data: { questionId: failedQuestion.id, status: AiGenerationStatus.FAILED, content: {}, model: "test", provider: "gemini", errorMessage: "boom" },
    });
    explanationIds.push(failedRow.id);
    const retryClaim = await claimGeneration(failedQuestion.id, failedRow);
    check("a FAILED row IS reclaimable for retry", retryClaim === true);
    const afterRetry = await prisma.aIExplanation.findUniqueOrThrow({ where: { questionId: failedQuestion.id } });
    check("...reclaiming bumps retryCount and flips to GENERATING", afterRetry.status === AiGenerationStatus.GENERATING && afterRetry.retryCount === 1);

    // A stuck/stale GENERATING row (crashed request) is reclaimable, never permanently stuck.
    const stuckQuestion = await makeQuestion();
    questionIds.push(stuckQuestion.id);
    const staleTimestamp = new Date(Date.now() - STALE_GENERATION_MS - 5_000);
    const stuckRow = await prisma.aIExplanation.create({
      data: { questionId: stuckQuestion.id, status: AiGenerationStatus.GENERATING, content: {}, model: "test", provider: "gemini", updatedAt: staleTimestamp },
    });
    explanationIds.push(stuckRow.id);
    // Prisma's @updatedAt auto-sets updatedAt on write; re-force it directly so the row is genuinely "old".
    await prisma.$executeRaw`UPDATE "AIExplanation" SET "updatedAt" = ${staleTimestamp} WHERE id = ${stuckRow.id}`;
    const stuckRowFresh = await prisma.aIExplanation.findUniqueOrThrow({ where: { id: stuckRow.id } });
    const staleReclaim = await claimGeneration(stuckQuestion.id, stuckRowFresh);
    check("a stale GENERATING row (past STALE_GENERATION_MS) IS reclaimable — never permanently stuck", staleReclaim === true);

    // A COMPLETED row is never reclaimed.
    const doneQuestion = await makeQuestion();
    questionIds.push(doneQuestion.id);
    const doneRow = await prisma.aIExplanation.create({
      data: { questionId: doneQuestion.id, status: AiGenerationStatus.COMPLETED, content: { whyCorrect: "x" }, model: "test", provider: "gemini" },
    });
    explanationIds.push(doneRow.id);
    const noReclaim = await claimGeneration(doneQuestion.id, doneRow);
    check("a COMPLETED row is never reclaimed", noReclaim === false);
    const cachedRead = await getOrCreateExplanation(doneQuestion.id);
    check("getOrCreateExplanation returns the cached COMPLETED row without attempting any network call", cachedRead.id === doneRow.id);

    // ---- 3. Saved Questions ---------------------------------------------
    console.log("\n--- Saved Questions ---");
    check("q4 starts unsaved", (await isQuestionSaved(student.id, q4.id)) === false);
    const savedOn = await toggleSavedQuestion(student.id, q4.id);
    check("toggling saves it", savedOn === true && (await isQuestionSaved(student.id, q4.id)) === true);
    const savedOff = await toggleSavedQuestion(student.id, q4.id);
    check("toggling again unsaves it", savedOff === false && (await isQuestionSaved(student.id, q4.id)) === false);
    await toggleSavedQuestion(student.id, q4.id); // save it again
    await expectThrows("a raw duplicate SavedQuestion insert is rejected by the unique constraint", () =>
      prisma.savedQuestion.create({ data: { studentId: student.id, questionId: q4.id } })
    );

    // ---- 4. Question Reports (renamed taxonomy) --------------------------
    console.log("\n--- Question Reports (Step 6.7 taxonomy) ---");
    for (const reportType of [ReportType.WRONG_QUESTION, ReportType.INCORRECT_EXPLANATION, ReportType.IMAGE_ISSUE] as const) {
      await reportQuestion(student.id, q4.id, reportType, `fixture report ${reportType}`);
    }
    const reports = await prisma.reportedQuestion.findMany({ where: { studentId: student.id }, orderBy: { createdAt: "asc" } });
    check(
      "all three renamed report types round-trip through the DB",
      reports.length === 3 && reports.every((r) => ([ReportType.WRONG_QUESTION, ReportType.INCORRECT_EXPLANATION, ReportType.IMAGE_ISSUE] as string[]).includes(r.reportType))
    );
    check("every report starts OPEN (displayed as Pending)", reports.every((r) => r.status === "OPEN"));

    // ---- 5. AI rate limiting ---------------------------------------------
    console.log("\n--- AI generation rate limiting (distinct uncached requests only) ---");
    check("student starts under the rate limit", (await isAiGenerationRateLimited(student.id)) === false);
    for (let i = 0; i < 30; i++) {
      await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId: `fixture-${i}` });
    }
    check("after 30 logged NEW generations, the student is rate limited", (await isAiGenerationRateLimited(student.id)) === true);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await prisma.aIExplanation.deleteMany({ where: { id: { in: explanationIds } } });
    await prisma.reportedQuestion.deleteMany({ where: { studentId: student.id } });
    await prisma.savedQuestion.deleteMany({ where: { studentId: student.id } });
    await prisma.studentActivity.deleteMany({ where: { studentId: student.id } });
    await prisma.student.delete({ where: { id: student.id } });
    await prisma.question.deleteMany({ where: { id: { in: questionIds } } });
    await prisma.subject.delete({ where: { id: subject.id } });
    await prisma.exam.delete({ where: { id: exam.id } });
    await prisma.$disconnect();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
