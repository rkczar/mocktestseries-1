"use server";

import { revalidatePath } from "next/cache";
import { studentSignOut } from "@/lib/auth-student";
import { requireStudent } from "@/lib/student-session";
import { markAnnouncementRead, markAllAnnouncementsRead } from "@/lib/notifications";

export async function studentLogoutAction() {
  await studentSignOut({ redirectTo: "/login" });
}

export async function markAnnouncementReadAction(announcementId: string) {
  const student = await requireStudent();
  await markAnnouncementRead(student.id, announcementId);
  revalidatePath("/student/dashboard");
}

export async function markAllAnnouncementsReadAction() {
  const student = await requireStudent();
  await markAllAnnouncementsRead(student.id);
  revalidatePath("/student/dashboard");
}
