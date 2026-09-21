"use server";

import { revalidatePath } from "next/cache";
import type { AiVariantType } from "@prisma/client";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { generateVariant, retryFailedVariant, publishVariant } from "@/lib/ai-variant";
import { AiNotConfiguredError } from "@/lib/ai-explanation";

export interface VariantActionState {
  error?: string;
  success?: boolean;
}

export async function generateVariantAction(
  parentQuestionId: string,
  variantType: AiVariantType,
  _prev: VariantActionState,
  _formData: FormData
): Promise<VariantActionState> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await generateVariant(parentQuestionId, variantType);
  } catch (error) {
    return { error: describeError(error) };
  }
  revalidatePath(`/admin/ai/variants/${parentQuestionId}`);
  revalidatePath("/admin/ai/variants");
  return { success: true };
}

export async function retryVariantAction(
  variantId: string,
  parentQuestionId: string,
  _prev: VariantActionState,
  _formData: FormData
): Promise<VariantActionState> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await retryFailedVariant(variantId);
  } catch (error) {
    return { error: describeError(error) };
  }
  revalidatePath(`/admin/ai/variants/${parentQuestionId}`);
  return { success: true };
}

export async function publishVariantAction(
  variantId: string,
  parentQuestionId: string,
  _prev: VariantActionState,
  _formData: FormData
): Promise<VariantActionState> {
  await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  try {
    await publishVariant(variantId);
  } catch (error) {
    return { error: describeError(error) };
  }
  revalidatePath(`/admin/ai/variants/${parentQuestionId}`);
  revalidatePath("/admin/ai/variants");
  return { success: true };
}

function describeError(error: unknown): string {
  if (error instanceof AiNotConfiguredError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}
