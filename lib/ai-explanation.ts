import "server-only";
import { AiGenerationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateWithAi, isAiGenerationConfigured, AiNotConfiguredError, type AiGenerationResult } from "@/lib/ai-provider";
import { getAiSettings, type AiSettings } from "@/lib/ai-settings";

/**
 * Ask AI explanations. Generation itself goes through lib/ai-provider.ts
 * (Gemini/OpenAI, active + fallback — see that module), never a provider
 * SDK directly, so this file and the student UI stay provider-agnostic.
 */

export { AiNotConfiguredError };
export class AiGenerationInProgressError extends Error {}
export class ExplanationNotReadyError extends Error {}

/** Bump this whenever the prompt shape changes materially. Stored per explanation so old/new output is never silently mixed (Step 6/7.3). */
export const EXPLANATION_PROMPT_VERSION = "explain-v2";

/** A GENERATING/PENDING row older than this is assumed abandoned (crashed request, dead connection) and safe to reclaim. */
export const STALE_GENERATION_MS = 2 * 60_000;

export interface QuestionForExplanation {
  code: string;
  text: string;
  options: { label: string; text: string }[];
  correctLabel: string;
}

/** Structured Ask AI content — see prisma AIExplanation.content and the student explanation panel. */
export interface ExplanationContent {
  concept: string;
  optionAnalysis: Record<string, string>;
  pointsToRemember: string[];
  memoryTrick: string;
  examinerTraps: string[];
  trapWords: string[];
  examinerVariation: string;
}

async function loadCanonicalQuestion(questionId: string): Promise<QuestionForExplanation> {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    include: { options: { orderBy: { order: "asc" } } },
  });
  if (!question) throw new Error("Question not found.");
  const correct = question.options.find((o) => o.isCorrect);
  if (!correct) throw new Error("This question has no correct option configured.");
  return {
    code: question.code,
    text: question.text,
    options: question.options.map((o) => ({ label: o.label, text: o.text })),
    correctLabel: correct.label,
  };
}

function buildPrompt(question: QuestionForExplanation, settings: AiSettings): string {
  const optionsText = question.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  const sections = ['- "concept": why the correct option is right (under 60 words)'];
  if (settings.generateOptionAnalysis) {
    sections.push(
      '- "optionAnalysis": an object with one key per INCORRECT option label (e.g. "A", "C", "D" if B is correct), each value a short reason that option is wrong (under 40 words)'
    );
  }
  if (settings.generatePointsToRemember) {
    sections.push('- "pointsToRemember": an array of 2-5 short, exam-focused facts related to this question');
  }
  if (settings.generateMemoryTrick) {
    sections.push('- "memoryTrick": a short mnemonic or memory aid (empty string if none is genuinely useful)');
  }
  if (settings.generateExaminerTraps) {
    sections.push('- "examinerTraps": an array of 0-3 short descriptions of common mistakes examiners exploit on this topic');
    sections.push(
      '- "trapWords": an array of specific words this question (or close variants) hinges on, e.g. "except", "not", "most likely" — empty array if none are actually relevant'
    );
  }
  sections.push('- "examinerVariation": one short sentence on how an examiner could plausibly change this question (empty string if not applicable)');

  return `You are an expert exam tutor helping a student understand a multiple-choice question. The stored correct answer is canonical and must never be second-guessed in your explanation — if you believe it is wrong, still explain it as correct but note the discrepancy in "examinerVariation" prefixed with "CONFLICT:".

Question:
${question.text}

Options:
${optionsText}

The correct answer is ${question.correctLabel}.

Respond with ONLY a JSON object (no markdown fences) with these keys:
${sections.join("\n")}

Keep the tone encouraging and exam-focused. Never fabricate citations or references.`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

/** Validates/repairs a provider response into ExplanationContent — never throws, always returns a usable (possibly sparse) object. Exported for scripts/tests. */
export function validateExplanationContent(text: string): ExplanationContent {
  const fallback: ExplanationContent = {
    concept: "",
    optionAnalysis: {},
    pointsToRemember: [],
    memoryTrick: "",
    examinerTraps: [],
    trapWords: [],
    examinerVariation: "",
  };
  let parsed: unknown;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ...fallback, concept: text.trim().slice(0, 500) || "No explanation could be generated." };
    parsed = JSON.parse(match[0]);
  } catch {
    return { ...fallback, concept: text.trim().slice(0, 500) || "No explanation could be generated." };
  }
  if (!parsed || typeof parsed !== "object") return fallback;
  const obj = parsed as Record<string, unknown>;

  const optionAnalysis: Record<string, string> = {};
  if (obj.optionAnalysis && typeof obj.optionAnalysis === "object") {
    for (const [label, value] of Object.entries(obj.optionAnalysis as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) optionAnalysis[label] = value.trim();
    }
  }

  return {
    concept: typeof obj.concept === "string" ? obj.concept.trim() : "",
    optionAnalysis,
    pointsToRemember: asStringArray(obj.pointsToRemember),
    memoryTrick: typeof obj.memoryTrick === "string" ? obj.memoryTrick.trim() : "",
    examinerTraps: asStringArray(obj.examinerTraps),
    trapWords: asStringArray(obj.trapWords),
    examinerVariation: typeof obj.examinerVariation === "string" ? obj.examinerVariation.trim() : "",
  };
}

async function runAndPersist(questionId: string, question: QuestionForExplanation, settings: AiSettings) {
  try {
    const result: AiGenerationResult = await generateWithAi(buildPrompt(question, settings), { temperature: 0.4, maxOutputTokens: 900 });
    const content = validateExplanationContent(result.text);
    return await prisma.aIExplanation.update({
      where: { questionId },
      data: {
        status: AiGenerationStatus.COMPLETED,
        content: content as unknown as Prisma.InputJsonValue,
        provider: result.provider,
        model: result.model,
        generatedAt: new Date(),
        errorMessage: null,
      },
    });
  } catch (error) {
    await prisma.aIExplanation.update({
      where: { questionId },
      data: { status: AiGenerationStatus.FAILED, errorMessage: error instanceof Error ? error.message : "Generation failed." },
    });
    throw error;
  }
}

/**
 * Global, per-Question cache with DB-level concurrency control (Step 6.2/6.3).
 *
 * `AIExplanation.questionId` is `@unique`, so the very first `create` for a
 * question is the only one that can ever succeed — every concurrent caller
 * that loses the race gets a unique-constraint error, catches it, and reads
 * back whatever the winner is doing. A GENERATING row older than
 * STALE_GENERATION_MS (crashed request, dropped connection) is reclaimed via
 * a conditional `updateMany` whose affected-row count is the compare-and-swap:
 * exactly one caller ever sees `count === 1` and becomes the new owner.
 * Nobody can get stuck waiting on a dead generation forever.
 */
export async function getOrCreateExplanation(questionId: string) {
  // A cached explanation must always be servable, even if the provider is
  // currently unconfigured (key rotated out, admin mid-setup) — "not
  // configured" only ever blocks a NEW generation, never a cache read.
  const existing = await prisma.aIExplanation.findUnique({ where: { questionId } });
  if (existing?.status === AiGenerationStatus.COMPLETED) return existing;

  // Checked BEFORE claiming: an unconfigured provider must refuse with no
  // DB write at all (no network call attempted, no dangling GENERATING row).
  if (!(await isAiGenerationConfigured())) {
    throw new AiNotConfiguredError("AI explanations aren't configured yet. An admin needs to add a provider API key under AI → Settings.");
  }

  const settings = await getAiSettings();
  const owned = await claimGeneration(questionId, existing);
  if (!owned) {
    throw new AiGenerationInProgressError("This explanation is being generated — please try again in a few seconds.");
  }

  const question = await loadCanonicalQuestion(questionId);
  return runAndPersist(questionId, question, settings);
}

/**
 * Tries to become the sole owner of generating this explanation. Returns
 * true iff this call won the claim. Exported (only) so
 * scripts/verify-ai-review.ts can exercise the exact concurrency/staleness
 * logic directly — including simulated concurrent races — without needing a
 * live provider call.
 */
export async function claimGeneration(
  questionId: string,
  existing: { status: AiGenerationStatus; updatedAt: Date } | null
): Promise<boolean> {
  if (!existing) {
    try {
      await prisma.aIExplanation.create({
        data: {
          questionId,
          status: AiGenerationStatus.GENERATING,
          content: {} as unknown as Prisma.InputJsonValue,
          model: "",
          provider: "",
          promptVersion: EXPLANATION_PROMPT_VERSION,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false; // someone else created it in the race between our findUnique and this create
      }
      throw error;
    }
  }

  const isStale = existing.status !== AiGenerationStatus.COMPLETED && Date.now() - existing.updatedAt.getTime() > STALE_GENERATION_MS;
  if (existing.status !== AiGenerationStatus.FAILED && !isStale) return false;

  const claim = await prisma.aIExplanation.updateMany({
    where: { questionId, status: existing.status, updatedAt: existing.updatedAt },
    data: { status: AiGenerationStatus.GENERATING, retryCount: { increment: 1 }, promptVersion: EXPLANATION_PROMPT_VERSION },
  });
  return claim.count === 1;
}

/**
 * Explicit admin regeneration of an already-COMPLETED explanation (spec
 * §11: "Regeneration MUST be an explicit Admin action. Do not regenerate
 * merely because an Admin opens the page."). Unlike claimGeneration's
 * stale-reclaim, this force-reclaims a healthy COMPLETED row — the outgoing
 * content is snapshotted into AIExplanationVersion first so it is never
 * silently lost, then `version` is incremented.
 */
export async function regenerateExplanation(questionId: string) {
  const existing = await prisma.aIExplanation.findUnique({ where: { questionId } });
  if (!existing) throw new ExplanationNotReadyError("No explanation exists yet for this question — use Generate instead.");

  if (!(await isAiGenerationConfigured())) {
    throw new AiNotConfiguredError("AI explanations aren't configured yet. An admin needs to add a provider API key under AI → Settings.");
  }
  if (existing.status === AiGenerationStatus.GENERATING) {
    const isStale = Date.now() - existing.updatedAt.getTime() > STALE_GENERATION_MS;
    if (!isStale) throw new AiGenerationInProgressError("This explanation is currently generating.");
  }

  const claim = await prisma.aIExplanation.updateMany({
    where: { questionId, status: existing.status, updatedAt: existing.updatedAt },
    data: { status: AiGenerationStatus.GENERATING, retryCount: { increment: 1 }, promptVersion: EXPLANATION_PROMPT_VERSION },
  });
  if (claim.count !== 1) throw new AiGenerationInProgressError("Another regeneration just started — please try again in a moment.");

  if (existing.status === AiGenerationStatus.COMPLETED) {
    await prisma.aIExplanationVersion.create({
      data: {
        explanationId: existing.id,
        version: existing.version,
        content: existing.content as Prisma.InputJsonValue,
        model: existing.model,
        provider: existing.provider,
        promptVersion: existing.promptVersion,
        generatedAt: existing.generatedAt,
      },
    });
    await prisma.aIExplanation.update({ where: { questionId }, data: { version: { increment: 1 }, adminReviewedAt: null, adminReviewedById: null } });
  }

  const settings = await getAiSettings();
  const question = await loadCanonicalQuestion(questionId);
  return runAndPersist(questionId, question, settings);
}

/** Marks the current version of an explanation as admin-reviewed (spec §11/§12). */
export async function markExplanationReviewed(questionId: string, adminUserId: string) {
  return prisma.aIExplanation.update({
    where: { questionId },
    data: { adminReviewedAt: new Date(), adminReviewedById: adminUserId },
  });
}
