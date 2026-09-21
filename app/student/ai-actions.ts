"use server";

import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/student-session";
import { getAiSettings } from "@/lib/ai-settings";
import { getOrCreateExplanation, AiNotConfiguredError, AiGenerationInProgressError, type ExplanationContent } from "@/lib/ai-explanation";
import { getOrCreateExplanationVariant } from "@/lib/ai-explanation-variants";
import { EXPLANATION_VARIANTS } from "@/lib/ai-explanation-variants-catalog";
import {
  getStoredAiExplanation,
  getStoredAiExplanationVariant,
  isAiGenerationRateLimited,
  hasInProgressAttemptForQuestion,
  logActivity,
  checkAiAccessQuota,
  logAiAccess,
} from "@/lib/student-data";

/**
 * Shared by every context that shows a question with an "Ask AI" button
 * (attempt review, Saved Questions) — the explanation is cached per Question,
 * not per attempt or per page, so one action serves all of them.
 */
export async function getExplanationAction(questionId: string) {
  const student = await requireStudent();

  // Neither caller carries an attemptId, so this is the one place that can
  // catch "this question belongs to a test I'm still taking" regardless of
  // which surface asked — blocks both a fresh generation and a cache read.
  if (await hasInProgressAttemptForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI is available once you've submitted this test." };
  }

  // Daily AI ACCESS quota (spec: student access ≠ provider call) — checked
  // before cache/generation so an exhausted student never reaches the
  // provider, and reopening an already-counted question today is always free.
  const quota = await checkAiAccessQuota(student.id, questionId);
  if (!quota.allowed) {
    return { ok: false as const, error: "Daily AI limit reached." };
  }

  const cached = await getStoredAiExplanation(questionId);
  const isNewGeneration = cached?.status !== "COMPLETED";

  if (isNewGeneration && (await isAiGenerationRateLimited(student.id))) {
    return { ok: false as const, error: "You've requested a lot of new AI explanations recently — please wait a bit and try again." };
  }

  try {
    const explanation = await getOrCreateExplanation(questionId);
    if (isNewGeneration) await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId });
    await logAiAccess(student.id, questionId, { cacheHit: !isNewGeneration, provider: explanation.provider, model: explanation.model });

    // Related practice questions (spec §6): existing AI01-05 variants for this
    // canonical question, display-only here — publishing one into the real
    // Question Bank is a separate, explicit admin action (lib/ai-variant.ts
    // publishVariant), never automatic. Count is admin-configurable
    // (ai.settings.maxRelatedQuestions) but never exceeds 5 server-side,
    // regardless of what's stored, since only 5 AI variant slots ever exist.
    const { maxRelatedQuestions } = await getAiSettings();
    const relatedTake = Math.min(5, Math.max(0, maxRelatedQuestions));
    const relatedQuestions = relatedTake === 0
      ? []
      : await prisma.question.findMany({
          where: { parentQuestionId: questionId, aiGenerationStatus: "COMPLETED" },
          orderBy: { aiSlot: "asc" },
          select: { id: true, code: true, text: true, aiVariantType: true },
          take: relatedTake,
        });

    return {
      ok: true as const,
      content: explanation.content as unknown as ExplanationContent,
      remainingToday: quota.remainingToday,
      relatedQuestions,
      // The question changed after this explanation was generated (spec:
      // cache staleness) — still served, just flagged so the student knows.
      isStale: explanation.isStale,
    };
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { ok: false as const, error: error.message };
    if (error instanceof AiGenerationInProgressError) return { ok: false as const, error: error.message, retry: true as const };
    return { ok: false as const, error: error instanceof Error ? error.message : "Something went wrong generating the explanation." };
  }
}

/**
 * Alternate-tone "AI Variant" of the explanation above — same auth/in-progress
 * -attempt/quota/rate-limit gates, reused verbatim, only the cache/generation
 * target differs (lib/ai-explanation-variants.ts, keyed by question+variant
 * instead of just question).
 */
export async function getExplanationVariantAction(questionId: string, variantId: string) {
  const student = await requireStudent();

  if (!EXPLANATION_VARIANTS.some((v) => v.id === variantId)) {
    return { ok: false as const, error: "Unknown AI variant." };
  }

  if (await hasInProgressAttemptForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI is available once you've submitted this test." };
  }

  const quota = await checkAiAccessQuota(student.id, questionId);
  if (!quota.allowed) {
    return { ok: false as const, error: "Daily AI limit reached." };
  }

  const cached = await getStoredAiExplanationVariant(questionId, variantId);
  const isNewGeneration = cached?.status !== "COMPLETED";

  if (isNewGeneration && (await isAiGenerationRateLimited(student.id))) {
    return { ok: false as const, error: "You've requested a lot of new AI explanations recently — please wait a bit and try again." };
  }

  try {
    const variant = await getOrCreateExplanationVariant(questionId, variantId);
    if (isNewGeneration) await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId, variantId });
    await logAiAccess(student.id, questionId, { cacheHit: !isNewGeneration, provider: variant.provider, model: variant.model });

    return {
      ok: true as const,
      content: variant.content as unknown as ExplanationContent,
      remainingToday: quota.remainingToday,
    };
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { ok: false as const, error: error.message };
    if (error instanceof AiGenerationInProgressError) return { ok: false as const, error: error.message, retry: true as const };
    return { ok: false as const, error: error instanceof Error ? error.message : "Something went wrong generating this variant." };
  }
}
