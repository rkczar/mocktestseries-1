"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ensureQuestionVariants, archiveVariant, publishVariant, MAX_VARIANTS_PER_QUESTION } from "@/lib/ai-variant";
import { AiNotConfiguredError } from "@/lib/ai-explanation";
import { consumeQuote } from "@/lib/ai-engine/quote";
import { prisma } from "@/lib/prisma";

/**
 * Admin review of AI Question Variants. Variants are generated from Ask AI
 * (lib/ai-variant.ts ensureQuestionVariants) and saved as drafts that need
 * review; publishing one here is the administrator's review decision.
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
export async function generateMissingVariantsAction(parentQuestionId: string, _prev: VariantActionState, formData: FormData): Promise<VariantActionState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    // Paid admin AI action: needs the one-time quote approved in the AI Cost Preview.
    const q = await consumeQuote({ quoteId: formData.get("quoteId"), actorId: session.user.id ?? "", feature: "variant_admin", action: "variant_admin", context: { questionId: parentQuestionId } });
    const result = await ensureQuestionVariants(parentQuestionId, { target: MAX_VARIANTS_PER_QUESTION, feature: "variant_admin", ctx: { actorId: session.user.id, quoteId: q.id, modelOverride: q.model } });
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
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await publishVariant(variantId);
  } catch (error) {
    return { error: describeError(error) };
  }
  await prisma.auditLog.create({ data: { actorId: session.user.id ?? null, action: "AI_VARIANT_PUBLISHED", entityType: "Question", entityId: variantId, metadata: { parentQuestionId } } });
  revalidate(parentQuestionId);
  return { success: "Reviewed and published to the Question Bank." };
}

function describeError(error: unknown): string {
  if (error instanceof AiNotConfiguredError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}
