"use server";

import { revalidatePath } from "next/cache";
import { requireStudentOrLogin } from "@/lib/student-session";
import { enrollInExam, unenrollFromExam } from "@/lib/student-data";

export async function enrollExamAction(examId: string) {
  const student = await requireStudentOrLogin();
  // Inactive (draft) exams are refused inside enrollInExam — no write, no error leak.
  await enrollInExam(student.id, examId);
  revalidatePath("/student/exams");
  revalidatePath("/student/dashboard");
}

export async function unenrollExamAction(examId: string) {
  const student = await requireStudentOrLogin();
  await unenrollFromExam(student.id, examId);
  revalidatePath("/student/exams");
  revalidatePath("/student/dashboard");
}
