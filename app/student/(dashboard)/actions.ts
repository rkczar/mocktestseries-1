"use server";

import { revalidatePath } from "next/cache";
import { studentSignOut } from "@/lib/auth-student";
import { requireStudentOrLogin } from "@/lib/student-session";
import { markAnnouncementRead, markAllAnnouncementsRead, dismissAnnouncementForStudent } from "@/lib/notifications";

export async function studentLogoutAction() {
  await studentSignOut({ redirectTo: "/login" });
}

export async function markAnnouncementReadAction(announcementId: string) {
  const student = await requireStudentOrLogin();
  await markAnnouncementRead(student.id, announcementId);
  revalidatePath("/student/dashboard");
}

export async function markAllAnnouncementsReadAction() {
  const student = await requireStudentOrLogin();
  await markAllAnnouncementsRead(student.id);
  revalidatePath("/student/dashboard");
}

/** Hides a Dashboard announcement for the signed-in student only. */
export async function dismissAnnouncementAction(announcementId: string) {
  const student = await requireStudentOrLogin();
  if (typeof announcementId !== "string" || !announcementId) return;
  await dismissAnnouncementForStudent(student.id, announcementId);
  revalidatePath("/student/dashboard");
}
