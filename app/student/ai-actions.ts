"use server";

import { requireStudentOrLogin } from "@/lib/student-session";
import { getOrCreateExplanation, AiNotConfiguredError, AiGenerationInProgressError, type ExplanationContent } from "@/lib/ai-explanation";
import { getOrCreateExplanationVariant } from "@/lib/ai-explanation-variants";
import { EXPLANATION_VARIANTS } from "@/lib/ai-explanation-variants-catalog";
import { ensureQuestionVariants, getActiveVariants, getDefaultVariantTarget, InvalidVariantSourceError, type VariantView } from "@/lib/ai-variant";
import {
  getStoredAiExplanation,
  getStoredAiExplanationVariant,
  isAiGenerationRateLimited,
  getAnswerRevealStatus,
  type AnswerRevealStatus,
  logActivity,
  checkAiAccessQuota,
  logAiAccess,
  getAiAccessStatus,
  isQuestionReviewableInAttempt,
} from "@/lib/student-data";
import { prisma } from "@/lib/prisma";
import { AI_UNSUPPORTED_TYPE_MESSAGE } from "@/lib/question-types";
import { getPaymentModeForStudent } from "@/lib/payments/settings";
import { computeProductPrice } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";

const LOCKED_MESSAGES: Record<Exclude<AnswerRevealStatus, "REVEALABLE">, string> = {
  IN_PROGRESS: "Ask AI is available once you've submitted this test.",
  RESULT_HELD: "Ask AI unlocks when this test's result is released.",
  NO_ACCESS: "Ask AI is available for questions from your submitted tests.",
};

/**
 * Every Ask AI surface serves answer-revealing content, so each one goes
 * through the canonical answer-reveal rule (lib/student-data.ts
 * #getAnswerRevealStatus): the question must be in one of this student's
 * SUBMITTED attempts with a released answer key, and in no running or held
 * attempt. Any other question id — never attempted, draft, paid, another
 * test's — is refused before cache reads or provider calls.
 */
async function answerLockMessage(studentId: string, questionId: unknown, reviewAttemptId?: unknown): Promise<string | null> {
  if (typeof questionId !== "string" || questionId.length === 0 || questionId.length > 64) return LOCKED_MESSAGES.NO_ACCESS;
  // Opened from a submitted attempt's Review page: that page already shows
  // this question's answer, so a different running attempt containing the
  // same question must not lock it here (lib/student-data.ts
  // #isQuestionReviewableInAttempt re-checks ownership, SUBMITTED and release).
  if (
    typeof reviewAttemptId === "string" &&
    reviewAttemptId.length > 0 &&
    reviewAttemptId.length <= 64 &&
    (await isQuestionReviewableInAttempt(studentId, reviewAttemptId, questionId))
  ) {
    return null;
  }
  const status = await getAnswerRevealStatus(studentId, questionId);
  return status === "REVEALABLE" ? null : LOCKED_MESSAGES[status];
}

/**
 * Shared by every context that shows a question with an "Ask AI" button
 * (attempt review, Saved Questions) — the explanation is cached per Question,
 * not per attempt or per page, so one action serves all of them.
 */
export async function getExplanationAction(questionId: string, reviewAttemptId?: string) {
  const student = await requireStudentOrLogin();

  // Neither caller carries an attemptId, so this is the one place that can
  // catch an unreviewed, still-running or held question regardless of which
  // surface asked — blocks both a fresh generation and a cache read.
  const locked = await answerLockMessage(student.id, questionId, reviewAttemptId);
  if (locked) return { ok: false as const, error: locked };
  const unsupported = await aiUnsupportedTypeMessage(questionId);
  if (unsupported) return { ok: false as const, error: unsupported };

  // Daily AI ACCESS quota (spec: student access ≠ provider call) — checked
  // before cache/generation so an exhausted student never reaches the
  // provider, and reopening an already-counted question today is always free.
  const quota = await checkAiAccessQuota(student.id, questionId);
  if (!quota.allowed) {
    return { ok: false as const, error: "Daily AI limit reached.", limitReached: true as const };
  }

  const cached = await getStoredAiExplanation(questionId);
  const isNewGeneration = cached?.status !== "COMPLETED";

  if (isNewGeneration && (await isAiGenerationRateLimited(student.id))) {
    return { ok: false as const, error: "You've requested a lot of new AI explanations recently — please wait a bit and try again." };
  }

  try {
    const explanation = await getOrCreateExplanation(questionId);
    if (isNewGeneration) await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId });
    await logAiAccess(student.id, questionId, { cacheHit: !isNewGeneration, provider: explanation.provider, model: explanation.model, feature: "EXPLANATION" });

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
export async function getExplanationVariantAction(questionId: string, variantId: string, reviewAttemptId?: string) {
  const student = await requireStudentOrLogin();

  if (!EXPLANATION_VARIANTS.some((v) => v.id === variantId)) {
    return { ok: false as const, error: "Unknown AI variant." };
  }

  const locked = await answerLockMessage(student.id, questionId, reviewAttemptId);
  if (locked) return { ok: false as const, error: locked };
  const unsupported = await aiUnsupportedTypeMessage(questionId);
  if (unsupported) return { ok: false as const, error: unsupported };

  const quota = await checkAiAccessQuota(student.id, questionId);
  if (!quota.allowed) {
    return { ok: false as const, error: "Daily AI limit reached.", limitReached: true as const };
  }

  const cached = await getStoredAiExplanationVariant(questionId, variantId);
  const isNewGeneration = cached?.status !== "COMPLETED";

  if (isNewGeneration && (await isAiGenerationRateLimited(student.id))) {
    return { ok: false as const, error: "You've requested a lot of new AI explanations recently — please wait a bit and try again." };
  }

  try {
    const variant = await getOrCreateExplanationVariant(questionId, variantId);
    if (isNewGeneration) await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId, variantId });
    await logAiAccess(student.id, questionId, { cacheHit: !isNewGeneration, provider: variant.provider, model: variant.model, feature: `EXPLANATION_VARIANT:${variantId}` });

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
export async function getQuestionVariantsAction(questionId: string, reviewAttemptId?: string) {
  const student = await requireStudentOrLogin();
  if (typeof questionId !== "string" || questionId.length === 0 || questionId.length > 64) {
    return { ok: false as const, error: "Unknown question." };
  }

  // Reachable only for a question the student legitimately reviews (the
  // canonical answer-reveal rule — saved-only or never-attempted ids fail).
  const locked = await answerLockMessage(student.id, questionId, reviewAttemptId);
  if (locked) return { ok: false as const, error: locked };
  const unsupported = await aiUnsupportedTypeMessage(questionId);
  if (unsupported) return { ok: false as const, error: unsupported };

  const quota = await checkAiAccessQuota(student.id, questionId);
  if (!quota.allowed) {
    return { ok: false as const, error: "Daily AI limit reached.", limitReached: true as const };
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
    await logAiAccess(student.id, questionId, { cacheHit: result.providerCalls === 0, provider: result.provider, model: result.model, feature: "QUESTION_VARIANTS" });

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

/**
 * The AI usage label + upgrade CTA next to the Ask AI buttons. Read-only:
 * remaining credits come from the same server ledger checkAiAccessQuota
 * enforces (lib/student-data.ts#getAiAccessStatus), so nothing here can
 * grant or consume access — every Ask AI action still re-checks on its own.
 * The upgrade target is the existing Plans → Checkout flow; the price shown
 * is the cheapest active PAID product priced by the one pricing function
 * (computeProductPrice — checkout re-prices server-side anyway), and only
 * while purchases are actually open (payment mode PAID).
 */
export async function getAiUsageStatusAction() {
  const student = await requireStudentOrLogin();
  const [status, mode] = await Promise.all([getAiAccessStatus(student.id), getPaymentModeForStudent(student.id)]);

  let upgrade: { href: string; priceLabel: string | null } | null = null;
  if (!status.paidPlan) {
    upgrade = { href: "/student/plans", priceLabel: null };
    if (mode === "PAID") {
      const now = new Date();
      const products = await prisma.product.findMany({ where: { isActive: true, isVisible: true, accessType: "PAID" } });
      const cheapest = products
        .map((p) => ({ code: p.code, price: computeProductPrice(p, now) }))
        .filter((p) => !p.price.isFree && p.price.pricePaise > 0)
        .sort((a, b) => a.price.pricePaise - b.price.pricePaise)[0];
      if (cheapest) upgrade = { href: `/student/checkout/${encodeURIComponent(cheapest.code)}`, priceLabel: formatInr(cheapest.price.pricePaise) };
    }
  }

  return {
    ok: true as const,
    /** null = unlimited for this student's plan. */
    remainingToday: status.remainingToday,
    subscription: status.remainingToday === null ? ("unlimited" as const) : status.paidPlan ? ("paid" as const) : ("free" as const),
    /** Upgrade copy may promise "Unlimited AI" only when the paid plan really is unlimited. */
    paidPlanUnlimited: status.paidPlanUnlimited,
    upgrade,
  };
}

/**
 * NEET Phase 4: Ask AI models one correct option, so a MULTIPLE_CORRECT or
 * MATCH_THE_FOLLOWING question is refused before quota or cache (a cached
 * explanation from before a type change would claim a single answer).
 */
async function aiUnsupportedTypeMessage(questionId: string): Promise<string | null> {
  const row = await prisma.question.findUnique({ where: { id: questionId }, select: { questionType: true } });
  return row && row.questionType !== "SINGLE_CORRECT" ? AI_UNSUPPORTED_TYPE_MESSAGE : null;
}
