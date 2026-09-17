"use server";

import { revalidatePath } from "next/cache";
import { requireStudent } from "@/lib/student-session";
import { enrollInExam, unenrollFromExam } from "@/lib/student-data";

export async function enrollExamAction(examId: string) {
  const student = await requireStudent();
  await enrollInExam(student.id, examId);
  revalidatePath("/student/exams");
  revalidatePath("/student/dashboard");
}

export async function unenrollExamAction(examId: string) {
  const student = await requireStudent();
  await unenrollFromExam(student.id, examId);
  revalidatePath("/student/exams");
  revalidatePath("/student/dashboard");
}
