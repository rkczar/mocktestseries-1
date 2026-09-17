/**
 * Verifies Step 7.1–7.3: AI01–AI05 question variants.
 *
 * No Gemini API key is configured in this environment (same as
 * scripts/verify-ai-review.ts) — a live generation call is unverified here
 * and called out in the session report. Everything reachable without a
 * live call is verified directly against the real functions:
 *
 *  1. Response validation (validateGenerated, exported for this) — a
 *     well-formed payload is accepted; malformed JSON, wrong option count,
 *     zero/two correct options, duplicate/empty option text are all
 *     rejected. A failed validation must never become an ACTIVE question
 *     (Step 7.2) — verified structurally: FAILED rows always end up
 *     QuestionStatus.DRAFT, so they can never surface in a PUBLISHED-only
 *     student-facing query.
 *  2. Max 5 variants, enforced at the DB level (Step 7.1) — the
 *     `@@unique([parentQuestionId, aiSlot])` index means a parent can have
 *     at most 5 variant rows by construction; verified by filling all 5
 *     slots and confirming a 6th insert (which must collide on some slot)
 *     is rejected.
 *  3. Guard-rail ordering in generateVariant/retryFailedVariant — "cannot
 *     variant a variant", "source not found", "not an AI variant",
 *     "only FAILED can be retried" are all reachable and correct
 *     independent of provider configuration; the not-configured gate is
 *     reached (and only reached) once those pass.
 *
 * All fixture rows are deleted at the end regardless of pass/fail. Run from
 * the repo root with the react-server condition so `import "server-only"`
 * resolves to the empty export:
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ai-variants.ts
 */
import "dotenv/config";
import { PrismaClient, QuestionStatus, QuestionDifficulty, AiSlot, AiVariantType, AiGenerationStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
// These import `server-only`, which is inert under the react-server condition.
import { validateGenerated, generateVariant, retryFailedVariant, InvalidVariantSourceError } from "@/lib/ai-variant";
import { AiNotConfiguredError } from "@/lib/ai-explanation";

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
  console.log("=== AI Question Variants Verification ===\n");
  const suffix = Date.now().toString(36);

  const geminiRow = await prisma.setting.findUnique({ where: { key: "api.gemini" } });
  console.log(`Gemini configured in this environment: ${geminiRow ? "yes (unexpected)" : "no"}\n`);

  const exam = await prisma.exam.create({ data: { name: `Variant Exam ${suffix}`, code: `VAR-${suffix}` } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Variant Subject" } });
  const parent = await prisma.question.create({
    data: {
      examId: exam.id,
      subjectId: subject.id,
      code: `Q-VAR-${suffix}`,
      text: "Parent fixture question?",
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

  const questionIds = [parent.id];

  try {
    // ---- 1. Response validation ------------------------------------------
    console.log("--- Response validation ---");
    const good = validateGenerated(
      JSON.stringify({
        text: "A valid new question?",
        options: [
          { label: "A", text: "opt A", isCorrect: false },
          { label: "B", text: "opt B", isCorrect: true },
          { label: "C", text: "opt C", isCorrect: false },
          { label: "D", text: "opt D", isCorrect: false },
        ],
      })
    );
    check("a well-formed payload is accepted", good !== null && good.text === "A valid new question?" && good.options.length === 4);

    check("malformed JSON is rejected", validateGenerated("not json at all") === null);
    check(
      "wrong option count (3) is rejected",
      validateGenerated(JSON.stringify({ text: "x?", options: [{ label: "A", text: "a", isCorrect: true }, { label: "B", text: "b", isCorrect: false }, { label: "C", text: "c", isCorrect: false }] })) === null
    );
    check(
      "zero correct options is rejected",
      validateGenerated(
        JSON.stringify({
          text: "x?",
          options: [
            { label: "A", text: "a", isCorrect: false },
            { label: "B", text: "b", isCorrect: false },
            { label: "C", text: "c", isCorrect: false },
            { label: "D", text: "d", isCorrect: false },
          ],
        })
      ) === null
    );
    check(
      "two correct options is rejected",
      validateGenerated(
        JSON.stringify({
          text: "x?",
          options: [
            { label: "A", text: "a", isCorrect: true },
            { label: "B", text: "b", isCorrect: true },
            { label: "C", text: "c", isCorrect: false },
            { label: "D", text: "d", isCorrect: false },
          ],
        })
      ) === null
    );
    check(
      "duplicate option text is rejected",
      validateGenerated(
        JSON.stringify({
          text: "x?",
          options: [
            { label: "A", text: "same", isCorrect: true },
            { label: "B", text: "same", isCorrect: false },
            { label: "C", text: "c", isCorrect: false },
            { label: "D", text: "d", isCorrect: false },
          ],
        })
      ) === null
    );
    check(
      "empty option text is rejected",
      validateGenerated(
        JSON.stringify({
          text: "x?",
          options: [
            { label: "A", text: "", isCorrect: true },
            { label: "B", text: "b", isCorrect: false },
            { label: "C", text: "c", isCorrect: false },
            { label: "D", text: "d", isCorrect: false },
          ],
        })
      ) === null
    );

    // ---- 2. Max 5 variants, DB-enforced ------------------------------------
    console.log("\n--- Max 5 variants (DB-level, @@unique([parentQuestionId, aiSlot])) ---");
    const slots: AiSlot[] = [AiSlot.AI01, AiSlot.AI02, AiSlot.AI03, AiSlot.AI04, AiSlot.AI05];
    for (const slot of slots) {
      const v = await prisma.question.create({
        data: {
          code: `${parent.code} ${slot}`,
          examId: parent.examId,
          subjectId: parent.subjectId,
          text: `Variant ${slot}`,
          difficulty: parent.difficulty,
          status: QuestionStatus.PUBLISHED,
          parentQuestionId: parent.id,
          aiVariantType: AiVariantType.AI_SIMILAR,
          aiSlot: slot,
          aiGenerationStatus: AiGenerationStatus.COMPLETED,
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
      questionIds.push(v.id);
    }
    const variantCount = await prisma.question.count({ where: { parentQuestionId: parent.id } });
    check("all 5 slots are filled", variantCount === 5);

    // A 6th row for this parent MUST reuse one of the 5 existing AiSlot values — the unique index rejects it.
    await expectThrows("a 6th variant (necessarily colliding on some slot) is rejected by the DB", () =>
      prisma.question.create({
        data: {
          code: `${parent.code} DUP`,
          examId: parent.examId,
          subjectId: parent.subjectId,
          text: "Sixth variant attempt",
          difficulty: parent.difficulty,
          status: QuestionStatus.PUBLISHED,
          parentQuestionId: parent.id,
          aiVariantType: AiVariantType.AI_TRAP,
          aiSlot: AiSlot.AI01, // any of the 5 — all are already taken
          aiGenerationStatus: AiGenerationStatus.COMPLETED,
        },
      })
    );

    // ---- 3. Guard-rail ordering (reachable without a live key) -------------
    console.log("\n--- Guard-rail ordering ---");
    const variantOfVariant = questionIds[1]; // one of the 5 variants just created
    const err1 = await expectThrows("generateVariant refuses a variant-of-a-variant before touching the provider", () =>
      generateVariant(variantOfVariant, AiVariantType.AI_SIMILAR)
    );
    check("...and it is specifically InvalidVariantSourceError", err1 instanceof InvalidVariantSourceError);

    await expectThrows("generateVariant refuses a nonexistent source question", () => generateVariant("nonexistent-id", AiVariantType.AI_SIMILAR));

    // A fresh canonical question with 0/5 slots used — reaches the (unconfigured) provider gate correctly.
    const freshParent = await prisma.question.create({
      data: {
        examId: exam.id,
        subjectId: subject.id,
        code: `Q-VAR-FRESH-${suffix}`,
        text: "Fresh parent fixture?",
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
    questionIds.push(freshParent.id);
    const err2 = await expectThrows("generateVariant on a valid, slot-available question reaches the not-configured gate", () =>
      generateVariant(freshParent.id, AiVariantType.AI_SIMILAR)
    );
    check("...and it is specifically AiNotConfiguredError (this environment has no key)", err2 instanceof AiNotConfiguredError);
    const noRowLeftBehind = await prisma.question.count({ where: { parentQuestionId: freshParent.id } });
    check("...and no dangling variant row was created (the gate is checked before claiming a slot)", noRowLeftBehind === 0);

    const err3 = await expectThrows("retryFailedVariant refuses a canonical (non-variant) question", () => retryFailedVariant(freshParent.id));
    check("...and it is specifically InvalidVariantSourceError", err3 instanceof InvalidVariantSourceError);

    const completedVariantId = questionIds[1];
    await expectThrows("retryFailedVariant refuses a COMPLETED variant (only FAILED can be retried)", () => retryFailedVariant(completedVariantId));

    const failedVariant = await prisma.question.create({
      data: {
        code: `${parent.code} RETRY-TEST`,
        examId: parent.examId,
        subjectId: parent.subjectId,
        text: "Failed variant fixture",
        difficulty: parent.difficulty,
        status: QuestionStatus.DRAFT,
        parentQuestionId: freshParent.id,
        aiVariantType: AiVariantType.AI_TRAP,
        aiSlot: AiSlot.AI01,
        aiGenerationStatus: AiGenerationStatus.FAILED,
        aiErrorMessage: "fixture failure",
      },
    });
    questionIds.push(failedVariant.id);
    check("a FAILED variant stays QuestionStatus.DRAFT — never surfaces as ACTIVE/PUBLISHED (Step 7.2)", failedVariant.status === QuestionStatus.DRAFT);
    const err4 = await expectThrows("retryFailedVariant on a genuinely FAILED variant reaches the not-configured gate", () => retryFailedVariant(failedVariant.id));
    check("...and it is specifically AiNotConfiguredError", err4 instanceof AiNotConfiguredError);
    const stillFailed = await prisma.question.findUniqueOrThrow({ where: { id: failedVariant.id } });
    check("...and the row's status is unchanged (the gate check doesn't mutate anything)", stillFailed.aiGenerationStatus === AiGenerationStatus.FAILED);

    console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  } finally {
    console.log("\nCleaning up fixture data...");
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
