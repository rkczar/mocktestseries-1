"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { approveStudentDeletion, rejectStudentDeletion, DeletionLifecycleError } from "@/lib/student-lifecycle";

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

export interface DeletionReviewResult {
  ok: boolean;
  error?: string;
}

async function reviewDeletion(
  requestId: string,
  run: (requestId: string, admin: { id: string; name: string | null | undefined }) => Promise<unknown>
): Promise<DeletionReviewResult> {
  const session = await requirePermission(PERMISSIONS.STUDENT_DELETION_MANAGE);
  if (!session.user.id) throw new UnauthorizedError("Not signed in");
  try {
    await run(requestId, { id: session.user.id, name: session.user.name });
  } catch (error) {
    if (error instanceof DeletionLifecycleError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/admin/students/deletion-requests");
  revalidatePath("/admin/students");
  return { ok: true };
}

/** MASTER_ADMIN-only; the whole lifecycle lives in lib/student-lifecycle.ts. */
export async function approveDeletionRequestAction(requestId: string) {
  return reviewDeletion(requestId, approveStudentDeletion);
}

export async function rejectDeletionRequestAction(requestId: string) {
  return reviewDeletion(requestId, rejectStudentDeletion);
}
