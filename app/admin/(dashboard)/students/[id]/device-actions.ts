"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  DeviceActionError,
  logoutAllStudentSessions,
  resetStudentDeviceLimit,
  revokeStudentDevice,
  revokeStudentSession,
} from "@/lib/student-devices";

/**
 * Admin → Students → Student → Device Access. STUDENTS_MANAGE only. Every
 * action records a DeviceSecurityEvent naming the acting admin (and an
 * AuditLog row); nothing here deletes history. Student sessions only —
 * admin sessions live in a separate Auth.js instance and are never touched.
 */

export interface AdminDeviceActionResult {
  error?: string;
  success?: string;
}

async function requireStudentsManage() {
  return requirePermission(PERMISSIONS.STUDENTS_MANAGE);
}

function adminIdOf(
  session: Awaited<ReturnType<typeof requireStudentsManage>>,
): string {
  if (!session.user.id) throw new UnauthorizedError("Not signed in");
  return session.user.id;
}

async function run(
  adminId: string,
  studentId: string,
  action: string,
  fn: (adminId: string) => Promise<unknown>,
  metadata: Record<string, string> = {},
): Promise<AdminDeviceActionResult> {
  try {
    await fn(adminId);
  } catch (error) {
    if (error instanceof DeviceActionError) return { error: error.message };
    throw error;
  }
  await prisma.auditLog.create({
    data: {
      actorId: adminId,
      action,
      entityType: "Student",
      entityId: studentId,
      metadata,
    },
  });
  revalidatePath(`/admin/students/${studentId}`);
  revalidatePath("/admin/monitoring/authentication");
  revalidatePath("/admin/security");
  return { success: "Done." };
}

export async function adminRevokeDeviceAction(
  studentId: string,
  deviceId: string,
) {
  const session = await requireStudentsManage();
  return run(
    adminIdOf(session),
    studentId,
    "STUDENT_DEVICE_REVOKED",
    (adminId) =>
      revokeStudentDevice(studentId, deviceId, { adminId }, "ADMIN_REVOKED"),
    {
      deviceId,
    },
  );
}

export async function adminLogoutSessionAction(
  studentId: string,
  sessionRowId: string,
) {
  const session = await requireStudentsManage();
  return run(
    adminIdOf(session),
    studentId,
    "STUDENT_SESSION_REVOKED",
    (adminId) =>
      revokeStudentSession(
        studentId,
        sessionRowId,
        { adminId },
        "ADMIN_LOGOUT",
      ),
    { sessionId: sessionRowId },
  );
}

export async function adminLogoutAllAction(studentId: string) {
  const session = await requireStudentsManage();
  return run(adminIdOf(session), studentId, "STUDENT_LOGOUT_ALL", (adminId) =>
    logoutAllStudentSessions(
      studentId,
      { adminId },
      { reason: "ADMIN_LOGOUT_ALL" },
    ),
  );
}

/** Audited inside resetStudentDeviceLimit (same transaction), so no second AuditLog row here. */
export async function adminResetDeviceLimitAction(
  studentId: string,
): Promise<AdminDeviceActionResult> {
  const adminId = adminIdOf(await requireStudentsManage());
  try {
    const { devicesRevoked } = await resetStudentDeviceLimit(
      studentId,
      adminId,
    );
    revalidatePath(`/admin/students/${studentId}`);
    revalidatePath("/admin/monitoring/authentication");
    revalidatePath("/admin/security");
    return {
      success: `Device limit reset. ${devicesRevoked} device(s) revoked.`,
    };
  } catch (error) {
    if (error instanceof DeviceActionError) return { error: error.message };
    throw error;
  }
}
