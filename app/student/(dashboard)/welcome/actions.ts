"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStudentOrLogin } from "@/lib/student-session";
import { enrollInExam } from "@/lib/student-data";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";

/** Enroll in the chosen ACTIVE exam (no-op for an inactive one), make it the Active Exam, open the Dashboard. */
export async function chooseExamAction(examId: string) {
  const student = await requireStudentOrLogin();
  if (!(await enrollInExam(student.id, examId))) return { error: "This exam is not available right now." };
  (await cookies()).set(ACTIVE_EXAM_COOKIE, examId, { path: "/", maxAge: 31536000, sameSite: "lax" });
  revalidatePath("/student/exams");
  revalidatePath("/student/dashboard");
  redirect("/student/dashboard");
}
