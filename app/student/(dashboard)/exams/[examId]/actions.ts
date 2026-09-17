"use server";

import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import {
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startCustomModuleAttempt,
  startGrandTestAttempt,
} from "@/lib/test-attempt";

export async function startMockTestFromExamAction(mockTestId: string) {
  const student = await requireStudent();
  const attempt = await startMockTestAttempt(student.id, mockTestId);
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startGrandTestFromExamAction(grandTestId: string) {
  const student = await requireStudent();
  const attempt = await startGrandTestAttempt(student.id, grandTestId);
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startPaperFromExamAction(paperId: string) {
  const student = await requireStudent();
  const attempt = await startPreviousYearPaperAttempt(student.id, paperId);
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startCustomModuleFromExamAction(moduleId: string) {
  const student = await requireStudent();
  const attempt = await startCustomModuleAttempt(student.id, moduleId);
  redirect(`/student/attempt/${attempt.id}`);
}
