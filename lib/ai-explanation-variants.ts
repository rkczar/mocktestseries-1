import "server-only";
import { AiGenerationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateWithAi, isAiGenerationConfigured, AiNotConfiguredError, type AiGenerationResult } from "@/lib/ai-provider";
import { getAiSettings, type AiSettings } from "@/lib/ai-settings";
import { AiGenerationInProgressError, STALE_GENERATION_MS, validateExplanationContent, isTruncatedOrMalformedJson, type ExplanationContent, type QuestionForExplanation } from "@/lib/ai-explanation";
import { EXPLANATION_VARIANTS, getVariantDef, type ExplanationVariantDef } from "@/lib/ai-explanation-variants-catalog";

export { EXPLANATION_VARIANTS, getVariantDef, type ExplanationVariantDef };

/**
 * Generation/caching for the alternate-tone/style explanations defined in
 * lib/ai-explanation-variants-catalog.ts ("AI Variants"), separate from the
 * single default AIExplanation. Global per (question, variant) cache: the
 * first student to request a given question+variant pays the generation
 * cost, every student after reads the same cached row, mirroring
 * lib/ai-explanation.ts's cache semantics.
 */

function buildVariantPrompt(question: QuestionForExplanation, settings: AiSettings, variant: ExplanationVariantDef): string {
  const optionsText = question.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  const sections = ['- "concept": why the correct option is right (under 60 words)'];
  if (settings.generateOptionAnalysis) {
    sections.push(
      '- "optionAnalysis": an object with one key per INCORRECT option label, each value a short reason that option is wrong (under 40 words)'
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
    sections.push('- "trapWords": an array of specific words this question hinges on — empty array if none are relevant');
  }
  sections.push('- "examinerVariation": one short sentence on how an examiner could plausibly change this question (empty string if not applicable)');

  return `You are an expert exam tutor helping a student understand a multiple-choice question. ${variant.instruction} The stored correct answer is canonical and must never be second-guessed — if you believe it is wrong, still explain it as correct but note the discrepancy in "examinerVariation" prefixed with "CONFLICT:".

Question:
${question.text}

Options:
${optionsText}

The correct answer is ${question.correctLabel}.

Respond with ONLY a JSON object (no markdown fences) with these keys:
${sections.join("\n")}

Keep the tone encouraging and exam-focused. Never fabricate citations or references.`;
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

async function runAndPersist(questionId: string, variant: ExplanationVariantDef, question: QuestionForExplanation, settings: AiSettings) {
  const key = { questionId_variantId: { questionId, variantId: variant.id } };
  try {
    const result: AiGenerationResult = await generateWithAi(buildVariantPrompt(question, settings, variant), { temperature: 0.4, maxOutputTokens: 1400 });
    if (isTruncatedOrMalformedJson(result.text)) {
      throw new Error("AI returned truncated or malformed JSON (likely hit the output token limit) — please retry.");
    }
    const content = validateExplanationContent(result.text);
    return await prisma.aIExplanationVariant.update({
      where: key,
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
    await prisma.aIExplanationVariant.update({
      where: key,
      data: { status: AiGenerationStatus.FAILED, errorMessage: error instanceof Error ? error.message : "Generation failed." },
    });
    throw error;
  }
}

/**
 * Same claim-then-generate concurrency pattern as
 * lib/ai-explanation.ts#claimGeneration: the unique (questionId, variantId)
 * constraint means only the first concurrent `create` can win, everyone else
 * catches the P2002 and reads back whatever the winner produces. A stuck
 * GENERATING row older than STALE_GENERATION_MS is reclaimable.
 */
async function claimVariantGeneration(
  questionId: string,
  variantId: string,
  existing: { status: AiGenerationStatus; updatedAt: Date } | null
): Promise<boolean> {
  if (!existing) {
    try {
      await prisma.aIExplanationVariant.create({
        data: { questionId, variantId, status: AiGenerationStatus.GENERATING, content: {} as unknown as Prisma.InputJsonValue, model: "", provider: "" },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  const isStale = existing.status !== AiGenerationStatus.COMPLETED && Date.now() - existing.updatedAt.getTime() > STALE_GENERATION_MS;
  if (existing.status !== AiGenerationStatus.FAILED && !isStale) return false;

  const claim = await prisma.aIExplanationVariant.updateMany({
    where: { questionId, variantId, status: existing.status, updatedAt: existing.updatedAt },
    data: { status: AiGenerationStatus.GENERATING },
  });
  return claim.count === 1;
}

/**
 * Global cache read/generate for one (question, variant) pair — never
 * regenerates once a COMPLETED row exists, so a second request for the same
 * question+variant (from the same student or a different one) is a pure
 * cache read with zero provider calls, per the owner's explicit requirement.
 */
export async function getOrCreateExplanationVariant(questionId: string, variantId: string) {
  const variant = getVariantDef(variantId);
  if (!variant) throw new Error("Unknown AI variant.");

  const existing = await prisma.aIExplanationVariant.findUnique({ where: { questionId_variantId: { questionId, variantId } } });
  if (existing?.status === AiGenerationStatus.COMPLETED) return existing;

  if (!(await isAiGenerationConfigured())) {
    throw new AiNotConfiguredError("AI explanations aren't configured yet. An admin needs to add a provider API key under AI → Settings.");
  }

  const settings = await getAiSettings();
  const owned = await claimVariantGeneration(questionId, variantId, existing);
  if (!owned) {
    throw new AiGenerationInProgressError("This variant is being generated — please try again in a few seconds.");
  }

  const question = await loadCanonicalQuestion(questionId);
  return runAndPersist(questionId, variant, question, settings);
}

export type { ExplanationContent };
