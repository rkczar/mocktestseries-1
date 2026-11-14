"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { approveStudentDeletion, rejectStudentDeletion, createAdminDeletionRequest, DeletionLifecycleError } from "@/lib/student-lifecycle";
import { StudentStatus } from "@prisma/client";

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
  revalidatePath("/admin/students/deletion-requests/[id]", "page");
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

export interface StudentDeletionPreview {
  id: string;
  studentCode: string;
  name: string;
  mobile: string | null;
  email: string | null;
  createdAt: string;
  status: StudentStatus;
  exams: string[];
  activeAccess: string[];
  paidOrders: number;
  paidTotalPaise: number;
  pendingRequest: boolean;
}

/** What the confirmation dialog shows before an admin deletes a student. MASTER_ADMIN only (STUDENT_DELETION_MANAGE). */
export async function getStudentDeletionPreviewAction(studentDbId: string): Promise<{ ok: true; preview: StudentDeletionPreview } | { ok: false; error: string }> {
  await requirePermission(PERMISSIONS.STUDENT_DELETION_MANAGE);
  const now = new Date();
  const s = await prisma.student.findUnique({
    where: { id: String(studentDbId) },
    select: {
      id: true,
      studentId: true,
      name: true,
      mobile: true,
      email: true,
      createdAt: true,
      status: true,
      examEnrollments: { select: { exam: { select: { name: true } } } },
      entitlements: {
        where: { status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { product: { select: { name: true } }, expiresAt: true },
      },
      deletionRequests: { where: { status: "PENDING" }, select: { id: true } },
    },
  });
  if (!s || s.status === StudentStatus.DELETED) return { ok: false, error: "This student was not found or is already deleted." };
  const paid = await prisma.paymentOrder.aggregate({ where: { studentId: s.id, status: "PAID" }, _count: { _all: true }, _sum: { amountPaise: true } });
  return {
    ok: true,
    preview: {
      id: s.id,
      studentCode: s.studentId,
      name: s.name,
      mobile: s.mobile,
      email: s.email,
      createdAt: s.createdAt.toISOString(),
      status: s.status,
      exams: s.examEnrollments.map((e) => e.exam.name),
      activeAccess: s.entitlements.map((e) => `${e.product.name}${e.expiresAt ? ` (until ${e.expiresAt.toISOString().slice(0, 10)})` : ""}`),
      paidOrders: paid._count._all,
      paidTotalPaise: paid._sum.amountPaise ?? 0,
      pendingRequest: s.deletionRequests.length > 0,
    },
  };
}

/**
 * Admin → Students: delete a student account. Uses the existing workflow end to end — files (or reuses) a request in
 * the Deletion Requests queue, then approves it with approveStudentDeletion (snapshot, anonymize, release email/mobile
 * so the number can register again, revoke sessions/Google link, keep attempts/payments/invoices). MASTER_ADMIN only;
 * the admin must type the exact Student ID, so a mis-click on another row can never delete it.
 */
export async function adminDeleteStudentAction(studentDbId: string, typedCode: string, reason: string): Promise<DeletionReviewResult> {
  const session = await requirePermission(PERMISSIONS.STUDENT_DELETION_MANAGE);
  if (!session.user.id) throw new UnauthorizedError("Not signed in");
  const why = String(reason ?? "").trim();
  if (why.length < 3) return { ok: false, error: "Enter a short reason (kept in the deletion record)." };
  const student = await prisma.student.findUnique({ where: { id: String(studentDbId) }, select: { id: true, studentId: true, status: true } });
  if (!student || student.status === StudentStatus.DELETED) return { ok: false, error: "This student was not found or is already deleted." };
  if (String(typedCode ?? "").trim().toUpperCase() !== student.studentId.toUpperCase()) {
    return { ok: false, error: `Type the Student ID ${student.studentId} exactly to confirm.` };
  }
  const admin = { id: session.user.id, name: session.user.name };
  try {
    const request = await createAdminDeletionRequest(student.id, admin, why);
    await approveStudentDeletion(request.id, admin);
  } catch (error) {
    if (error instanceof DeletionLifecycleError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/admin/students");
  revalidatePath("/admin/students/[id]", "page");
  revalidatePath("/admin/students/deletion-requests");
  revalidatePath("/admin/students/deleted");
  return { ok: true };
}
