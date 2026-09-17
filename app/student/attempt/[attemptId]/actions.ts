"use server";

import { redirect } from "next/navigation";
import type { ReportType } from "@prisma/client";
import { requireStudent } from "@/lib/student-session";
import { saveAnswer, submitAttempt } from "@/lib/test-attempt";
import { toggleSavedQuestion, reportQuestion } from "@/lib/student-data";

export async function saveAnswerAction(
  attemptId: string,
  questionId: string,
  selectedOptionLabel: string | null,
  markForReview: boolean
) {
  const student = await requireStudent();
  await saveAnswer(attemptId, student.id, questionId, selectedOptionLabel, markForReview);
}

export async function submitAttemptAction(attemptId: string) {
  const student = await requireStudent();
  await submitAttempt(attemptId, student.id);
  redirect(`/student/attempt/${attemptId}/result`);
}

export async function toggleSaveQuestionAction(questionId: string) {
  const student = await requireStudent();
  await toggleSavedQuestion(student.id, questionId);
}

export async function reportAttemptQuestionAction(
  attemptId: string,
  questionId: string,
  reportType: ReportType,
  message: string
) {
  const student = await requireStudent();
  await reportQuestion(student.id, questionId, reportType, message || undefined, attemptId);
}

