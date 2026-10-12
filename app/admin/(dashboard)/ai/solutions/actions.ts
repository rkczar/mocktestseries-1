"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getOrCreateExplanation, regenerateExplanation, markExplanationReviewed, AiNotConfiguredError, AiGenerationInProgressError } from "@/lib/ai-explanation";
import { consumeQuote } from "@/lib/ai-engine/quote";

/**
 * Admin-triggered retry for a FAILED explanation. Reuses the exact same
 * getOrCreateExplanation an explanation panel calls — a FAILED row is always
 * reclaimable there (see lib/ai-explanation.ts#claimGeneration), so this is
 * genuinely the same code path, not a parallel implementation.
 */
export async function retryExplanationAction(questionId: string, quoteId?: string): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    // Paid admin AI action: needs the one-time quote approved in the AI Cost Preview.
    const q = await consumeQuote({ quoteId, actorId: session.user.id ?? "", feature: "explanation_admin", action: "explanation_admin", context: { questionId } });
    await getOrCreateExplanation(questionId, { feature: "explanation_admin", ctx: { actorId: session.user.id, quoteId: q.id, modelOverride: q.model } });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { error: error.message };
    if (error instanceof AiGenerationInProgressError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Retry failed." };
  }
  revalidatePath("/admin/ai/solutions");
  return {};
}

/**
 * Explicit admin regeneration (spec §11: never automatic just from opening
 * the page). Snapshots the outgoing version into AIExplanationVersion and
 * clears the review flag — see lib/ai-explanation.ts#regenerateExplanation.
 */
export async function regenerateExplanationAction(questionId: string, quoteId?: string): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    const q = await consumeQuote({ quoteId, actorId: session.user.id ?? "", feature: "explanation_admin", action: "explanation_admin", context: { questionId } });
    await regenerateExplanation(questionId, { feature: "explanation_admin", ctx: { actorId: session.user.id, quoteId: q.id, modelOverride: q.model } });
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { error: error.message };
    if (error instanceof AiGenerationInProgressError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Regeneration failed." };
  }
  revalidatePath("/admin/ai/solutions");
  return {};
}

export async function markReviewedAction(questionId: string): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  if (!session.user.id) throw new Error("Session is missing an admin id.");
  await markExplanationReviewed(questionId, session.user.id);
  revalidatePath("/admin/ai/solutions");
  return {};
}
