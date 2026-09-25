"use server";

import { prisma } from "@/lib/prisma";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getOrCreateExplanation, AiNotConfiguredError, AiGenerationInProgressError, type ExplanationContent } from "@/lib/ai-explanation";
import { getOrCreateExplanationVariant } from "@/lib/ai-explanation-variants";
import { EXPLANATION_VARIANTS } from "@/lib/ai-explanation-variants-catalog";
import { ensureQuestionVariants, getActiveVariants, getDefaultVariantTarget, InvalidVariantSourceError, type VariantView } from "@/lib/ai-variant";
import {
  getStoredAiExplanation,
  getStoredAiExplanationVariant,
  isAiGenerationRateLimited,
  hasInProgressAttemptForQuestion,
  hasUnreleasedResultForQuestion,
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
  const student = await requireStudentOrLogin();

  // Neither caller carries an attemptId, so this is the one place that can
  // catch "this question belongs to a test I'm still taking" regardless of
  // which surface asked — blocks both a fresh generation and a cache read.
  if (await hasInProgressAttemptForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI is available once you've submitted this test." };
  }
  if (await hasUnreleasedResultForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI unlocks when this test's result is released." };
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

    return {
      ok: true as const,
      content: explanation.content as unknown as ExplanationContent,
      remainingToday: quota.remainingToday,
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
  const student = await requireStudentOrLogin();

  if (!EXPLANATION_VARIANTS.some((v) => v.id === variantId)) {
    return { ok: false as const, error: "Unknown AI variant." };
  }

  if (await hasInProgressAttemptForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI is available once you've submitted this test." };
  }
  if (await hasUnreleasedResultForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI unlocks when this test's result is released." };
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
      isStale: variant.isStale,
    };
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { ok: false as const, error: error.message };
    if (error instanceof AiGenerationInProgressError) return { ok: false as const, error: error.message, retry: true as const };
    return { ok: false as const, error: error instanceof Error ? error.message : "Something went wrong generating this variant." };
  }
}

/**
 * Ask AI → AI Question Variants. Same gates as the explanation actions above
 * (post-submission only, result released, one daily-quota unit per source
 * question — reopening is free, the per-hour new-generation rate limit only
 * when a provider call is actually needed). Variants are global per source
 * question (lib/ai-variant.ts): existing ones are reused, only the missing
 * count is generated, and everything saved is already in the Question Bank.
 * All metadata (exam/subject/topic, codes, answers) is derived server-side
 * from the source row — the client supplies only the question id.
 */
export async function getQuestionVariantsAction(questionId: string) {
  const student = await requireStudentOrLogin();
  if (typeof questionId !== "string" || questionId.length === 0 || questionId.length > 64) {
    return { ok: false as const, error: "Unknown question." };
  }

  // Reachable only from a surface the student legitimately reviews: a
  // question from one of their SUBMITTED attempts, or one they saved.
  const [reviewed, saved] = await Promise.all([
    prisma.testAttemptQuestion.findFirst({ where: { questionId, attempt: { studentId: student.id, status: "SUBMITTED" } }, select: { id: true } }),
    prisma.savedQuestion.findUnique({ where: { studentId_questionId: { studentId: student.id, questionId } }, select: { id: true } }),
  ]);
  if (!reviewed && !saved) {
    return { ok: false as const, error: "AI Question Variants are available for questions from your submitted tests." };
  }
  if (await hasInProgressAttemptForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI is available once you've submitted this test." };
  }
  if (await hasUnreleasedResultForQuestion(student.id, questionId)) {
    return { ok: false as const, error: "Ask AI unlocks when this test's result is released." };
  }

  const quota = await checkAiAccessQuota(student.id, questionId);
  if (!quota.allowed) {
    return { ok: false as const, error: "Daily AI limit reached." };
  }

  const target = await getDefaultVariantTarget();
  const existing = await getActiveVariants(questionId);
  // A rate-limited student still gets whatever already exists; they just
  // can't trigger a new provider call until the window passes.
  const mayGenerate = existing.length < target && !(await isAiGenerationRateLimited(student.id));
  if (existing.length === 0 && !mayGenerate) {
    return { ok: false as const, error: "You've requested a lot of new AI content recently — please wait a bit and try again." };
  }

  try {
    const result = mayGenerate
      ? await ensureQuestionVariants(questionId, { target })
      : { variants: existing, requested: target, generatedNow: 0, providerCalls: 0, provider: "", model: "" };
    if (result.providerCalls > 0) {
      await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId, kind: "question-variants", generated: result.generatedNow });
    }
    await logAiAccess(student.id, questionId, { cacheHit: result.providerCalls === 0, provider: result.provider, model: result.model });

    return {
      ok: true as const,
      variants: result.variants satisfies VariantView[],
      requested: result.requested,
      generatedNow: result.generatedNow,
      remainingToday: quota.remainingToday,
    };
  } catch (error) {
    if (error instanceof AiGenerationInProgressError) return { ok: false as const, error: error.message, retry: true as const };
    if (error instanceof AiNotConfiguredError || error instanceof InvalidVariantSourceError) return { ok: false as const, error: error.message };
    console.error("getQuestionVariantsAction failed", error);
    return { ok: false as const, error: "We couldn't generate practice questions right now.", canRetry: true as const };
  }
}
