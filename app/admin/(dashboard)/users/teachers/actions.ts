"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { TeacherStatus } from "@prisma/client";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { assignExam, createTeacher, revokeAssignment, setTeacherMobile, setTeacherStatus, type ManageResult } from "@/lib/teacher/manage";
import { approveRequest, rejectRequest } from "@/lib/teacher/approvals";

/**
 * Admin → Users & Access → Teachers (Phase A). Teacher accounts and exam
 * assignments: TEACHERS_MANAGE. Approval decisions: TEACHER_APPROVALS_MANAGE
 * and the MASTER_ADMIN role itself. Both keys are MASTER_ADMIN-only
 * (lib/permissions.ts); FULL_ADMIN can view, never act.
 */

export type TeacherFormState = { ok?: string; error?: string };

async function manage(): Promise<string> {
  const s = await requirePermission(PERMISSIONS.TEACHERS_MANAGE);
  if (!s.user.id) throw new UnauthorizedError("Not signed in");
  return s.user.id;
}

function done(r: ManageResult): TeacherFormState {
  revalidatePath("/admin/users");
  revalidatePath("/admin/users/teachers");
  return r.ok ? { ok: r.message } : { error: r.error };
}

export async function createTeacherAction(_prev: TeacherFormState, fd: FormData): Promise<TeacherFormState> {
  const actor = await manage();
  return done(
    await createTeacher(actor, {
      name: String(fd.get("name") ?? ""),
      username: String(fd.get("username") ?? ""),
      email: String(fd.get("email") ?? ""),
      password: String(fd.get("password") ?? ""),
      mobile: String(fd.get("mobile") ?? ""),
      examIds: fd.getAll("examIds").map(String),
      status: fd.get("status") === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
    })
  );
}

export async function setTeacherMobileAction(teacherId: string, _prev: TeacherFormState, fd: FormData): Promise<TeacherFormState> {
  const actor = await manage();
  return done(await setTeacherMobile(actor, teacherId, String(fd.get("mobile") ?? "")));
}

export async function setTeacherStatusAction(teacherId: string, status: TeacherStatus): Promise<TeacherFormState> {
  const actor = await manage();
  return done(await setTeacherStatus(actor, teacherId, status));
}

export async function assignExamAction(teacherId: string, _prev: TeacherFormState, fd: FormData): Promise<TeacherFormState> {
  const actor = await manage();
  return done(await assignExam(actor, teacherId, String(fd.get("examId") ?? "")));
}

export async function revokeAssignmentAction(assignmentId: string): Promise<TeacherFormState> {
  const actor = await manage();
  return done(await revokeAssignment(actor, assignmentId));
}

async function approver(): Promise<string> {
  const s = await requirePermission(PERMISSIONS.TEACHER_APPROVALS_MANAGE);
  if (s.user.role !== "MASTER_ADMIN" || !s.user.id) throw new UnauthorizedError("Only the Master Admin can decide teacher requests.");
  return s.user.id;
}

function backToRequest(id: string, r: { ok: true; message: string } | { ok: false; error: string }): never {
  revalidatePath("/admin/users/teachers/approvals");
  revalidatePath("/admin");
  redirect(`/admin/users/teachers/approvals/${encodeURIComponent(id)}?${new URLSearchParams(r.ok ? { ok: r.message } : { err: r.error })}`);
}

export async function approveTeacherRequestAction(fd: FormData) {
  const actor = await approver();
  const id = String(fd.get("requestId") ?? "");
  backToRequest(id, await approveRequest(actor, id, fd.get("note")));
}

export async function rejectTeacherRequestAction(fd: FormData) {
  const actor = await approver();
  const id = String(fd.get("requestId") ?? "");
  backToRequest(id, await rejectRequest(actor, id, fd.get("note")));
}
