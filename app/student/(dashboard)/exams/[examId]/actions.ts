"use server";

import { redirect } from "next/navigation";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrExplain } from "@/lib/payments/paywall";
import { startCustomModuleAttempt } from "@/lib/test-attempt";

/**
 * Mock Test / Previous Year Paper Start: never creates the attempt here. The
 * canonical start page (/student/attempt/resume) resumes a running attempt
 * or shows the Pre-Test Setup first, behind the same entitlement, Platform
 * Controls and availability gates.
 */
export async function startMockTestFromExamAction(mockTestId: string) {
  await requireStudentOrLogin();
  redirect(`/student/attempt/resume?mockTest=${encodeURIComponent(mockTestId)}`);
}

export async function startPaperFromExamAction(paperId: string) {
  await requireStudentOrLogin();
  redirect(`/student/attempt/resume?paper=${encodeURIComponent(paperId)}`);
}

export async function startCustomModuleFromExamAction(moduleId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrExplain(() => startCustomModuleAttempt(student.id, moduleId), { route: "exams/[examId]", studentId: student.id, contentId: moduleId });
  redirect(`/student/attempt/${attempt.id}`);
}
