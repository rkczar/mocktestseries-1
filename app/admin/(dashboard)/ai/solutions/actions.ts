"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getOrCreateExplanation, AiNotConfiguredError, AiGenerationInProgressError } from "@/lib/ai-explanation";

/**
 * Admin-triggered retry for a FAILED explanation. Reuses the exact same
 * getOrCreateExplanation an explanation panel calls — a FAILED row is always
 * reclaimable there (see lib/ai-explanation.ts#claimGeneration), so this is
 * genuinely the same code path, not a parallel implementation.
 */
export async function retryExplanationAction(questionId: string): Promise<{ error?: string }> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await getOrCreateExplanation(questionId);
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { error: error.message };
    if (error instanceof AiGenerationInProgressError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Retry failed." };
  }
  revalidatePath("/admin/ai/solutions");
  return {};
}
