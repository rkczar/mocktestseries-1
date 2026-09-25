import "server-only";
import { AiGenerationStatus, AiSlot, AiVariantType, Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateWithAi, isAiGenerationConfigured, AiNotConfiguredError, type AiGenerationResult, type AiGenerationOptions } from "@/lib/ai-provider";
import { AiGenerationInProgressError, STALE_GENERATION_MS, type ExplanationContent } from "@/lib/ai-explanation";
import { getAiSettings } from "@/lib/ai-settings";
import { parseCandidateBatch, screenCandidates, type ComparableQuestion, type GeneratedVariant } from "@/lib/ai-variant-validation";

export { validateGenerated } from "@/lib/ai-variant-validation";

/**
 * AI Question Variants (AI01–AI05) — generated automatically from Ask AI and
 * saved straight into the canonical Question Bank, linked to their source
 * question via `parentQuestionId`. Admin → AI → Variants is monitoring and
 * quality control only; no normal variant needs an admin approval step.
 *
 * Flow (ensureQuestionVariants):
 *   existing active variants → if enough, return them (no provider call)
 *   → claim a per-source generation lock → generate ONLY the missing count
 *   → validate + dedupe against source/siblings/each other → at most one
 *   bounded retry for what's still missing → insert into free slots inside
 *   one transaction → return.
 *
 * Code convention (unchanged): `<source code> AI0<n>` — the slot is the
 * sequence, so codes are deterministic and collision-safe by construction.
 * Max 5 is enforced by the database: `@@unique([parentQuestionId, aiSlot])`
 * and AiSlot has exactly five values.
 */

export class MaxVariantsReachedError extends Error {}
export class InvalidVariantSourceError extends Error {}
export class VariantNotPublishableError extends Error {}

export const VARIANT_PROMPT_VERSION = "variant-v2";
export const MAX_VARIANTS_PER_QUESTION = 5;
/** Total provider calls per request: the first generation plus ONE retry for whatever is still missing. Never loops to force a count. */
export const MAX_GENERATION_ATTEMPTS = 2;
export const ALL_SLOTS: AiSlot[] = [AiSlot.AI01, AiSlot.AI02, AiSlot.AI03, AiSlot.AI04, AiSlot.AI05];

const LOCK_KEY_PREFIX = "ai.variant-generation-lock:";

type Generator = (prompt: string, opts: AiGenerationOptions) => Promise<AiGenerationResult>;
type Db = Prisma.TransactionClient | typeof prisma;

type SourceQuestion = Prisma.QuestionGetPayload<{ include: { options: true } }>;

/** The student-/admin-facing shape of one stored variant. */
export interface VariantView {
  id: string;
  code: string;
  slot: AiSlot;
  text: string;
  options: { label: string; text: string; isCorrect: boolean }[];
  explanation: string;
  optionAnalysis: Record<string, string>;
}

export interface EnsureVariantsResult {
  variants: VariantView[];
  requested: number;
  /** New variants saved by THIS call (0 = pure reuse). */
  generatedNow: number;
  providerCalls: number;
  rejectedDuplicate: number;
  rejectedInvalid: number;
  provider: string;
  model: string;
}

/** Variants a student can see / that count toward "already have enough": generated successfully and not archived by an admin. */
export const ACTIVE_VARIANT_WHERE = {
  aiGenerationStatus: AiGenerationStatus.COMPLETED,
  status: { not: QuestionStatus.ARCHIVED },
} satisfies Prisma.QuestionWhereInput;

export function clampVariantTarget(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_VARIANTS_PER_QUESTION, Math.max(1, Math.floor(value)));
}

/** Default number of variants Ask AI aims for — the existing admin setting (AI → Settings), clamped to 1..5. */
export async function getDefaultVariantTarget(): Promise<number> {
  const { maxRelatedQuestions } = await getAiSettings();
  return clampVariantTarget(maxRelatedQuestions);
}

function buildPrompt(source: SourceQuestion, count: number, avoid: ComparableQuestion[]): string {
  const optionsText = source.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  const correct = source.options.find((o) => o.isCorrect)?.label ?? "";
  const avoidText = avoid.length
    ? `\nThese questions ALREADY EXIST — do not repeat, reword or reorder any of them:\n${avoid.map((q, i) => `${i + 1}. ${q.text}`).join("\n")}\n`
    : "";

  return `You are an expert exam-question author. Source multiple-choice question:

Question:
${source.text}

Options:
${optionsText}

Correct answer: ${correct}
${avoidText}
Write ${count} NEW practice question${count === 1 ? "" : "s"} that test the SAME underlying concept/topic as the source.

Rules:
- Preserve the tested concept and stay within the same exam/topic scope; each question must be factually correct and solvable.
- Every question must be MEANINGFULLY different from the source and from each other — vary the scenario, clinical/application context, numbers, direction of reasoning (e.g. inverse), or distractors.
- Do NOT reuse the source wording, do NOT just reorder options, do NOT make cosmetic rewordings.
- Exactly 4 options labelled A, B, C, D; exactly ONE option has "isCorrect": true; option texts non-empty and distinct.
- "explanation": concise (under 60 words) reason the correct option is right.
- "optionAnalysis": one short reason per INCORRECT option label.

Respond with ONLY a JSON object (no markdown fences) shaped exactly like:
{"variants": [{"text": "...", "options": [{"label":"A","text":"...","isCorrect":false},{"label":"B","text":"...","isCorrect":true},{"label":"C","text":"...","isCorrect":false},{"label":"D","text":"...","isCorrect":false}], "explanation": "...", "optionAnalysis": {"A":"...","C":"...","D":"..."}}]}`;
}

async function loadSource(sourceQuestionId: string): Promise<SourceQuestion> {
  const source = await prisma.question.findUnique({ where: { id: sourceQuestionId }, include: { options: { orderBy: { order: "asc" } } } });
  if (!source) throw new InvalidVariantSourceError("Source question not found.");
  if (source.parentQuestionId) throw new InvalidVariantSourceError("AI variants are generated from the original question, not from another variant.");
  if (source.status !== QuestionStatus.PUBLISHED) throw new InvalidVariantSourceError("AI variants are only available for published questions.");
  if (source.options.filter((o) => o.isCorrect).length !== 1) throw new InvalidVariantSourceError("The source question has no single correct answer configured.");
  return source;
}

function toView(row: Prisma.QuestionGetPayload<{ include: { options: true; aiExplanation: true } }>): VariantView {
  const content = (row.aiExplanation?.status === AiGenerationStatus.COMPLETED ? row.aiExplanation.content : null) as Partial<ExplanationContent> | null;
  return {
    id: row.id,
    code: row.code,
    slot: row.aiSlot as AiSlot,
    text: row.text,
    options: [...row.options].sort((a, b) => a.order - b.order).map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect })),
    explanation: typeof content?.concept === "string" ? content.concept : "",
    optionAnalysis: content?.optionAnalysis && typeof content.optionAnalysis === "object" ? content.optionAnalysis : {},
  };
}

/** Active (COMPLETED, not archived) variants of a source, in slot order. Pure DB read. */
export async function getActiveVariants(sourceQuestionId: string): Promise<VariantView[]> {
  const rows = await prisma.question.findMany({
    where: { parentQuestionId: sourceQuestionId, ...ACTIVE_VARIANT_WHERE },
    include: { options: true, aiExplanation: true },
    orderBy: { aiSlot: "asc" },
  });
  return rows.map(toView);
}

/**
 * Slots a new variant may be written into: never-used slots, plus slots whose
 * row is a generation placeholder that never completed (legacy FAILED rows,
 * or a GENERATING row abandoned for longer than STALE_GENERATION_MS) and was
 * never snapshotted into an attempt. COMPLETED rows — active or archived —
 * are never overwritten.
 */
async function findWritableSlots(db: Db, sourceQuestionId: string) {
  const rows = await db.question.findMany({
    where: { parentQuestionId: sourceQuestionId },
    select: { id: true, aiSlot: true, aiGenerationStatus: true, updatedAt: true },
  });
  const bySlot = new Map(rows.map((r) => [r.aiSlot, r]));
  const staleBefore = Date.now() - STALE_GENERATION_MS;
  const reclaimCandidates = rows.filter(
    (r) =>
      r.aiGenerationStatus === AiGenerationStatus.FAILED ||
      r.aiGenerationStatus === AiGenerationStatus.PENDING ||
      (r.aiGenerationStatus === AiGenerationStatus.GENERATING && r.updatedAt.getTime() < staleBefore)
  );
  const snapshotted = reclaimCandidates.length
    ? new Set(
        (await db.testAttemptQuestion.findMany({ where: { questionId: { in: reclaimCandidates.map((r) => r.id) } }, select: { questionId: true } })).map(
          (r) => r.questionId
        )
      )
    : new Set<string>();
  const reclaimable = new Map(reclaimCandidates.filter((r) => !snapshotted.has(r.id)).map((r) => [r.aiSlot, r.id]));

  return ALL_SLOTS.flatMap((slot) => {
    if (!bySlot.has(slot)) return [{ slot, existingId: null as string | null }];
    const reclaimId = reclaimable.get(slot);
    return reclaimId ? [{ slot, existingId: reclaimId }] : [];
  });
}

/** Everything a new candidate must differ from: the source and every stored sibling with real content (active or archived). */
async function loadComparisonPool(source: SourceQuestion): Promise<ComparableQuestion[]> {
  const siblings = await prisma.question.findMany({
    where: { parentQuestionId: source.id, aiGenerationStatus: AiGenerationStatus.COMPLETED },
    select: { text: true, options: { select: { text: true, isCorrect: true } } },
  });
  return [{ text: source.text, options: source.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })) }, ...siblings];
}

/**
 * Per-source generation lock, stored as a short-lived row in the existing
 * `Setting` table (primary key = the claim; same compare-and-swap reclaim of
 * an abandoned lock as lib/ai-explanation.ts#claimGeneration). Stops five
 * concurrent students from each paying for a provider call; slot uniqueness
 * + the advisory lock in persistVariants remain the hard guarantee.
 */
async function claimGenerationLock(sourceQuestionId: string, retried = false): Promise<boolean> {
  const key = `${LOCK_KEY_PREFIX}${sourceQuestionId}`;
  // INSERT .. ON CONFLICT DO NOTHING: the affected-row count is the claim, and
  // a lost race is not logged as a Prisma error.
  const { count } = await prisma.setting.createMany({ data: [{ key, value: { claimedAt: new Date().toISOString() } }], skipDuplicates: true });
  if (count === 1) return true;
  const existing = await prisma.setting.findUnique({ where: { key } });
  if (!existing) return retried ? false : claimGenerationLock(sourceQuestionId, true);
  if (Date.now() - existing.updatedAt.getTime() <= STALE_GENERATION_MS) return false;
  const claim = await prisma.setting.updateMany({
    where: { key, updatedAt: existing.updatedAt },
    data: { value: { claimedAt: new Date().toISOString() } },
  });
  return claim.count === 1;
}

async function releaseGenerationLock(sourceQuestionId: string) {
  await prisma.setting.deleteMany({ where: { key: `${LOCK_KEY_PREFIX}${sourceQuestionId}` } });
}

/**
 * Writes accepted variants into free slots in ONE transaction, serialized per
 * source by a transaction-scoped advisory lock. Re-checks the active count and
 * free slots inside the lock, so a racing writer can never push a source past
 * 5 or double-claim a slot. Every row is fully valid before insert — no
 * placeholder/partial rows are ever created.
 */
async function persistVariants(source: SourceQuestion, accepted: GeneratedVariant[], target: number, gen: { provider: string; model: string }) {
  if (accepted.length === 0) return 0;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-variant:${source.id}`}))`;
    const activeCount = await tx.question.count({ where: { parentQuestionId: source.id, ...ACTIVE_VARIANT_WHERE } });
    const room = Math.max(0, Math.min(target, MAX_VARIANTS_PER_QUESTION) - activeCount);
    const slots = (await findWritableSlots(tx, source.id)).slice(0, Math.min(room, accepted.length));
    const now = new Date();

    for (const [i, { slot, existingId }] of slots.entries()) {
      const variant = accepted[i];
      const data = {
        text: variant.text,
        examId: source.examId,
        subjectId: source.subjectId,
        topicId: source.topicId,
        subTopicId: source.subTopicId,
        difficulty: source.difficulty,
        // Part of the canonical Question Bank immediately — no admin approval
        // step. Provenance is parentQuestionId + aiVariantType + aiSlot; the
        // source is QUESTION_BANK (never PYQ, never linked to a PYQ paper).
        status: QuestionStatus.PUBLISHED,
        source: "QUESTION_BANK" as const,
        previousYearPaperId: null,
        examYear: null,
        aiVariantType: AiVariantType.AI_SIMILAR,
        aiGenerationStatus: AiGenerationStatus.COMPLETED,
        aiProvider: gen.provider,
        aiModel: gen.model,
        aiPromptVersion: VARIANT_PROMPT_VERSION,
        aiGeneratedAt: now,
        aiErrorMessage: null,
      };
      const row = existingId
        ? await tx.question.update({ where: { id: existingId }, data })
        : await tx.question.create({ data: { ...data, code: `${source.code} ${slot}`, parentQuestionId: source.id, aiSlot: slot } });

      await tx.questionOption.deleteMany({ where: { questionId: row.id } });
      await tx.questionOption.createMany({
        data: variant.options.map((o, order) => ({ questionId: row.id, label: o.label, text: o.text, isCorrect: o.isCorrect, order })),
      });
      // The variant's explanation is stored as that question's own Ask AI
      // explanation (the existing AIExplanation cache), so Ask AI on the
      // variant later is a cache hit rather than a second provider call.
      const content: ExplanationContent = {
        concept: variant.explanation,
        optionAnalysis: variant.optionAnalysis,
        pointsToRemember: [],
        memoryTrick: "",
        examinerTraps: [],
        trapWords: [],
        examinerVariation: "",
      };
      const explanationData = {
        status: AiGenerationStatus.COMPLETED,
        content: content as unknown as Prisma.InputJsonValue,
        provider: gen.provider,
        model: gen.model,
        promptVersion: VARIANT_PROMPT_VERSION,
        generatedAt: now,
        errorMessage: null,
        isStale: false,
      };
      await tx.aIExplanation.upsert({ where: { questionId: row.id }, update: explanationData, create: { questionId: row.id, ...explanationData } });
    }
    return slots.length;
  });
}

/**
 * The one entry point for Ask AI → AI Question Variants (and admin
 * "Generate missing"). Global per source question: whoever asks first pays
 * for generation, everyone after reuses the same stored variants.
 * `opts.generate` exists only so scripts/verify-ai-variants.ts can drive the
 * real flow with scripted provider output.
 */
export async function ensureQuestionVariants(
  sourceQuestionId: string,
  opts: { target?: number; generate?: Generator } = {}
): Promise<EnsureVariantsResult> {
  const source = await loadSource(sourceQuestionId);
  const target = clampVariantTarget(opts.target ?? (await getDefaultVariantTarget()));
  const base = { requested: target, generatedNow: 0, providerCalls: 0, rejectedDuplicate: 0, rejectedInvalid: 0, provider: "", model: "" };

  const existing = await getActiveVariants(source.id);
  if (existing.length >= target) return { ...base, variants: existing };
  if ((await findWritableSlots(prisma, source.id)).length === 0) return { ...base, variants: existing };

  const generate = opts.generate ?? generateWithAi;
  if (!opts.generate && !(await isAiGenerationConfigured())) {
    if (existing.length > 0) return { ...base, variants: existing };
    throw new AiNotConfiguredError("AI variants aren't configured yet. An admin needs to add a provider API key under AI → Settings.");
  }

  if (!(await claimGenerationLock(source.id))) {
    throw new AiGenerationInProgressError("Practice questions for this question are being generated — please try again in a few seconds.");
  }

  try {
    // Re-read under the lock: a concurrent request may have just finished.
    const current = await getActiveVariants(source.id);
    const freeSlots = (await findWritableSlots(prisma, source.id)).length;
    const needed = Math.min(target - current.length, freeSlots);
    if (needed <= 0) return { ...base, variants: current };

    const pool = await loadComparisonPool(source);
    const accepted: GeneratedVariant[] = [];
    let last: AiGenerationResult | null = null;
    let providerCalls = 0;
    let rejectedDuplicate = 0;
    let rejectedInvalid = 0;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS && accepted.length < needed; attempt += 1) {
      const missing = needed - accepted.length;
      let result: AiGenerationResult;
      try {
        providerCalls += 1;
        result = await generate(buildPrompt(source, missing, [...pool.slice(1), ...accepted]), {
          temperature: 0.8,
          maxOutputTokens: Math.min(6000, 900 * missing + 600),
        });
      } catch (error) {
        if (accepted.length > 0) break; // keep what we already have
        if (attempt === MAX_GENERATION_ATTEMPTS - 1) throw error;
        continue; // one bounded retry for a transient provider failure
      }
      last = result;
      const screened = screenCandidates(parseCandidateBatch(result.text), [...pool, ...accepted], missing);
      accepted.push(...screened.accepted);
      rejectedDuplicate += screened.rejectedDuplicate;
      rejectedInvalid += screened.rejectedInvalid;
    }

    const gen = { provider: last?.provider ?? "", model: last?.model ?? "" };
    const generatedNow = await persistVariants(source, accepted, target, gen);
    return {
      variants: await getActiveVariants(source.id),
      requested: target,
      generatedNow,
      providerCalls,
      rejectedDuplicate,
      rejectedInvalid,
      ...gen,
    };
  } finally {
    await releaseGenerationLock(source.id);
  }
}

// ---------------------------------------------------------------------------
// Admin quality control
// ---------------------------------------------------------------------------

async function loadVariant(variantId: string) {
  const variant = await prisma.question.findUnique({ where: { id: variantId } });
  if (!variant || !variant.parentQuestionId || !variant.aiVariantType) throw new InvalidVariantSourceError("Not an AI variant.");
  return variant;
}

/** Archives a variant: hidden from Ask AI and from test selection. Never deletes (it may be referenced by attempts/analytics), and the archived text still counts for duplicate detection. */
export async function archiveVariant(variantId: string) {
  await loadVariant(variantId);
  return prisma.question.update({ where: { id: variantId }, data: { status: QuestionStatus.ARCHIVED } });
}

/** Restores an archived (or legacy draft) COMPLETED variant into the active Question Bank. Refuses if the source already has 5 active variants. */
export async function publishVariant(variantId: string) {
  const variant = await loadVariant(variantId);
  if (variant.aiGenerationStatus !== AiGenerationStatus.COMPLETED) {
    throw new VariantNotPublishableError("Only a successfully generated variant can be published.");
  }
  if (variant.status === QuestionStatus.PUBLISHED) return variant;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-variant:${variant.parentQuestionId}`}))`;
    const activeCount = await tx.question.count({ where: { parentQuestionId: variant.parentQuestionId, ...ACTIVE_VARIANT_WHERE } });
    if (variant.status === QuestionStatus.ARCHIVED && activeCount >= MAX_VARIANTS_PER_QUESTION) {
      throw new MaxVariantsReachedError("This question already has 5 active AI variants.");
    }
    return tx.question.update({ where: { id: variantId }, data: { status: QuestionStatus.PUBLISHED } });
  });
}
