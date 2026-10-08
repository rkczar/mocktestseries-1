"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import {
  checkCustomModuleDeletion,
  checkMockTestDeletion,
  deleteCustomModuleSafely,
  deleteMockTestSafely,
  type TestDeleteCheck,
  type TestDeleteResult,
} from "@/lib/test-deletion";

// Permanent test deletion is MASTER_ADMIN-only. The manage permission alone
// is already MASTER_ADMIN-only today (lib/permissions.ts); the explicit role
// check keeps it that way even if a future role is granted that key.
// Results are returned, never thrown, so the exact refusal reason reaches the
// admin (production masks thrown Server Action messages).

const NOT_ALLOWED = "Only the Master Admin can delete tests.";

async function requireMasterAdmin(permission: PermissionKey) {
  try {
    const session = await requirePermission(permission);
    return session.user.role === "MASTER_ADMIN" ? session : null;
  } catch (err) {
    if (err instanceof UnauthorizedError) return null;
    throw err;
  }
}

export type DeleteCheckResponse = { check: TestDeleteCheck } | { error: string };

export async function getMockTestDeleteCheckAction(mockTestId: string): Promise<DeleteCheckResponse> {
  if (!(await requireMasterAdmin(PERMISSIONS.TEST_SERIES_MANAGE))) return { error: NOT_ALLOWED };
  const check = await checkMockTestDeletion(prisma, mockTestId);
  return check ? { check } : { error: "This test no longer exists — it may already have been deleted." };
}

export async function deleteMockTestAction(mockTestId: string): Promise<TestDeleteResult> {
  const session = await requireMasterAdmin(PERMISSIONS.TEST_SERIES_MANAGE);
  if (!session) return { ok: false, reason: NOT_ALLOWED };
  const result = await deleteMockTestSafely(prisma, mockTestId);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: result.ok ? "MOCK_TEST_DELETED" : "MOCK_TEST_DELETE_BLOCKED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: result.ok ? { title: result.title } : { reason: result.reason },
    },
  });
  if (result.ok) revalidateMockSeriesSurfaces("/admin/tests", "/admin");
  return result;
}

export async function getCustomModuleDeleteCheckAction(moduleId: string): Promise<DeleteCheckResponse> {
  if (!(await requireMasterAdmin(PERMISSIONS.CUSTOM_MODULES_MANAGE))) return { error: NOT_ALLOWED };
  const check = await checkCustomModuleDeletion(prisma, moduleId);
  return check ? { check } : { error: "This module no longer exists — it may already have been deleted." };
}

export async function deleteCustomModuleAction(moduleId: string): Promise<TestDeleteResult> {
  const session = await requireMasterAdmin(PERMISSIONS.CUSTOM_MODULES_MANAGE);
  if (!session) return { ok: false, reason: NOT_ALLOWED };
  const result = await deleteCustomModuleSafely(prisma, moduleId);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: result.ok ? "CUSTOM_MODULE_DELETED" : "CUSTOM_MODULE_DELETE_BLOCKED",
      entityType: "CustomModule",
      entityId: moduleId,
      metadata: result.ok ? { title: result.title } : { reason: result.reason },
    },
  });
  if (result.ok) {
    revalidatePath("/admin/custom-modules");
    revalidatePath("/admin/tests");
    revalidatePath("/student/custom-module");
  }
  return result;
}
