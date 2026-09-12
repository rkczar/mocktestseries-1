"use server";

import { revalidatePath } from "next/cache";
import type { ReportType } from "@prisma/client";
import { requireStudent } from "@/lib/student-session";
import { toggleSavedQuestion, reportQuestion } from "@/lib/student-data";

export async function unsaveQuestionAction(questionId: string) {
  const student = await requireStudent();
  await toggleSavedQuestion(student.id, questionId);
  revalidatePath("/student/saved");
}

export async function reportSavedQuestionAction(questionId: string, reportType: ReportType, message: string) {
  const student = await requireStudent();
  await reportQuestion(student.id, questionId, reportType, message || undefined);
}
