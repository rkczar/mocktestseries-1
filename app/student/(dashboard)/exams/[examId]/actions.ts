"use server";

import { redirect } from "next/navigation";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrExplain } from "@/lib/payments/paywall";
import {
  startMockTestAttempt,
  startPreviousYearPaperAttempt,
  startCustomModuleAttempt,
} from "@/lib/test-attempt";

export async function startMockTestFromExamAction(mockTestId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrExplain(() => startMockTestAttempt(student.id, mockTestId), { route: "exams/[examId]", studentId: student.id, contentId: mockTestId });
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startPaperFromExamAction(paperId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrExplain(() => startPreviousYearPaperAttempt(student.id, paperId), { route: "exams/[examId]", studentId: student.id, contentId: paperId });
  redirect(`/student/attempt/${attempt.id}`);
}

export async function startCustomModuleFromExamAction(moduleId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrExplain(() => startCustomModuleAttempt(student.id, moduleId), { route: "exams/[examId]", studentId: student.id, contentId: moduleId });
  redirect(`/student/attempt/${attempt.id}`);
}
