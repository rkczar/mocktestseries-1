"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { approveRecoveryRequest, rejectRecoveryRequest, AccountRecoveryError } from "@/lib/account-recovery";

export interface RecoveryReviewResult {
  ok: boolean;
  error?: string;
}

/** MASTER_ADMIN-only. Approve moves ONLY the mobile number (lib/account-recovery.ts). */
export async function approveRecoveryRequestAction(requestId: string, notes: string): Promise<RecoveryReviewResult> {
  const session = await requirePermission(PERMISSIONS.ACCOUNT_RECOVERY_MANAGE);
  if (!session.user.id) throw new UnauthorizedError("Not signed in");
  try {
    await approveRecoveryRequest(requestId, { id: session.user.id, name: session.user.name }, notes);
  } catch (error) {
    if (error instanceof AccountRecoveryError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/admin/students");
  revalidatePath("/admin/students/account-recovery/[id]", "page");
  return { ok: true };
}

export async function rejectRecoveryRequestAction(requestId: string, notes: string): Promise<RecoveryReviewResult> {
  const session = await requirePermission(PERMISSIONS.ACCOUNT_RECOVERY_MANAGE);
  if (!session.user.id) throw new UnauthorizedError("Not signed in");
  try {
    await rejectRecoveryRequest(requestId, { id: session.user.id, name: session.user.name }, notes);
  } catch (error) {
    if (error instanceof AccountRecoveryError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/admin/students");
  revalidatePath("/admin/students/account-recovery/[id]", "page");
  return { ok: true };
}
