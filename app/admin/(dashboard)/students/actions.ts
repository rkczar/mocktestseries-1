"use server";

import { revalidatePath } from "next/cache";
import { DeletionRequestStatus, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

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
  const request = await prisma.deletionRequest.update({
    where: { id: requestId },
    data: { status: DeletionRequestStatus.REJECTED, reviewedAt: new Date(), reviewedByAdminId: session.user.id },
  });

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
