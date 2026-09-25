"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ensureQuestionVariants, archiveVariant, publishVariant, MAX_VARIANTS_PER_QUESTION } from "@/lib/ai-variant";
import { AiNotConfiguredError } from "@/lib/ai-explanation";

/**
 * Admin quality control for AI Question Variants. Normal variants are
 * generated and saved automatically from Ask AI (lib/ai-variant.ts
 * ensureQuestionVariants) — nothing here is a required approval step.
 */

export interface VariantActionState {
  error?: string;
  success?: string;
}

function revalidate(parentQuestionId: string) {
  revalidatePath(`/admin/ai/variants/${parentQuestionId}`);
  revalidatePath("/admin/ai/variants");
}

/** Fills any free/failed slots up to 5 through the same validated, deduplicated path Ask AI uses. */
export async function generateMissingVariantsAction(parentQuestionId: string, _prev: VariantActionState, _formData: FormData): Promise<VariantActionState> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    const result = await ensureQuestionVariants(parentQuestionId, { target: MAX_VARIANTS_PER_QUESTION });
    revalidate(parentQuestionId);
    return {
      success:
        result.providerCalls === 0
          ? "Nothing to generate — no free slots."
          : `Saved ${result.generatedNow} new variant(s); rejected ${result.rejectedDuplicate} duplicate and ${result.rejectedInvalid} invalid candidate(s).`,
    };
  } catch (error) {
    return { error: describeError(error) };
  }
}

export async function archiveVariantAction(variantId: string, parentQuestionId: string, _prev: VariantActionState, _formData: FormData): Promise<VariantActionState> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await archiveVariant(variantId);
  } catch (error) {
    return { error: describeError(error) };
  }
  revalidate(parentQuestionId);
  return { success: "Archived." };
}

export async function publishVariantAction(variantId: string, parentQuestionId: string, _prev: VariantActionState, _formData: FormData): Promise<VariantActionState> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await publishVariant(variantId);
  } catch (error) {
    return { error: describeError(error) };
  }
  revalidate(parentQuestionId);
  return { success: "Restored to Question Bank." };
}

function describeError(error: unknown): string {
  if (error instanceof AiNotConfiguredError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}
