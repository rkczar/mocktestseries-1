"use server";

import { redirect } from "next/navigation";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import {
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startCustomModuleAttempt,
  startGrandTestAttempt,
} from "@/lib/test-attempt";

export async function startMockTestFromExamAction(mockTestId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrPaywall(() => startMockTestAttempt(student.id, mockTestId));
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startGrandTestFromExamAction(grandTestId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrPaywall(() => startGrandTestAttempt(student.id, grandTestId));
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startPaperFromExamAction(paperId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrPaywall(() => startPreviousYearPaperAttempt(student.id, paperId));
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startCustomModuleFromExamAction(moduleId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrPaywall(() => startCustomModuleAttempt(student.id, moduleId));
  redirect(`/student/attempt/${attempt.id}`);
}
