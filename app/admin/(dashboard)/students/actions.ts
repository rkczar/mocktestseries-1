"use server";

import { revalidatePath } from "next/cache";
import { DeletionRequestStatus, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

export interface StudentNameActionState {
  error?: string;
  success?: string;
}

/**
 * The only path that may ever change a Student's account name after
 * registration. Students cannot rename themselves (app/student/(dashboard)/profile/actions.ts
 * never accepts a name field at all) — this exists for Admin/MASTER_ADMIN to
 * correct spelling or legal-name mistakes, and every change is audited with
 * the old/new value so repeated or unauthorized renames are traceable.
 */
export async function correctStudentNameAction(
  studentId: string,
  _prev: StudentNameActionState,
  formData: FormData
): Promise<StudentNameActionState> {
  const session = await requirePermission(PERMISSIONS.STUDENTS_MANAGE);
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Name must be at least 2 characters." };

  const existing = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, select: { name: true } });
  if (existing.name === name) return { success: "No change." };

  await prisma.student.update({ where: { id: studentId }, data: { name } });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_NAME_CORRECTED",
      entityType: "Student",
      entityId: studentId,
      metadata: { oldName: existing.name, newName: name },
    },
  });

  revalidatePath(`/admin/students/${studentId}`);
  return { success: "Name updated." };
}

export async function approveDeletionRequestAction(requestId: string) {
  const session = await requirePermission(PERMISSIONS.STUDENTS_MANAGE);

  const request = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: requestId } });

  await prisma.$transaction([
    prisma.student.update({
      where: { id: request.studentId },
      data: {
        name: "Deleted Student",
        email: null,
        mobile: null,
        passwordHash: null,
        status: StudentStatus.DELETED,
      },
    }),
    prisma.deletionRequest.update({
      where: { id: requestId },
      data: { status: DeletionRequestStatus.APPROVED, reviewedAt: new Date(), reviewedByAdminId: session.user.id },
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_DELETION_APPROVED",
      entityType: "Student",
      entityId: request.studentId,
    },
  });

  revalidatePath("/admin/students/deletion-requests");
  revalidatePath("/admin/students");
}

export async function rejectDeletionRequestAction(requestId: string) {
  const session = await requirePermission(PERMISSIONS.STUDENTS_MANAGE);
  const existing = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: requestId } });

  const [request] = await prisma.$transaction([
    prisma.deletionRequest.update({
      where: { id: requestId },
      data: { status: DeletionRequestStatus.REJECTED, reviewedAt: new Date(), reviewedByAdminId: session.user.id },
    }),
    prisma.student.updateMany({
      where: { id: existing.studentId, status: StudentStatus.DELETION_REQUESTED },
      data: { status: StudentStatus.ACTIVE },
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_DELETION_REJECTED",
      entityType: "Student",
      entityId: request.studentId,
    },
  });

  revalidatePath("/admin/students/deletion-requests");
}
