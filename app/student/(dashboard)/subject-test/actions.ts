"use server";

import { redirect } from "next/navigation";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startSubjectTestAttempt, type SubjectTestSelection } from "@/lib/test-attempt";
import {
  countPublishedQuestions,
  InsufficientQuestionsError,
  type QuestionSelectionFilters,
} from "@/lib/question-selection";

export interface SubjectTestFormState {
  error?: string;
}

function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalInt(raw: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Start a subject test from the builder form. Every filter is re-read from the
 * server and every value is re-validated here — the client can only ever
 * submit filter choices, never question ids. The definitive "enough questions"
 * check happens inside startSubjectTestAttempt via selectPublishedQuestions.
 */
export async function startSubjectTestAction(
  _prevState: SubjectTestFormState,
  formData: FormData
): Promise<SubjectTestFormState> {
  const student = await requireStudentOrLogin();

  const examId = str(formData, "examId");
  const subjectId = str(formData, "subjectId");
  if (!examId) return { error: "Exam is required." };
  if (!subjectId) return { error: "Please choose a subject to practice." };

  const count = Number(str(formData, "count"));
  const durationMinutes = Number(str(formData, "durationMinutes"));
  if (!Number.isInteger(count) || count < 1) return { error: "Question count must be at least 1." };
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 300) {
    return { error: "Duration must be between 1 and 300 minutes." };
  }

  const topicId = str(formData, "topicId");
  const subTopicId = str(formData, "subTopicId");

  const selection: SubjectTestSelection = {
    examId,
    subjectId,
    year: optionalInt(str(formData, "year")),
    topicId: topicId || undefined,
    subTopicId: subTopicId || undefined,
    count,
    durationMinutes,
  };

  // redirect() throws NEXT_REDIRECT — call it OUTSIDE the try so the catch
  // below never swallows the control-flow exception (per Next.js docs).
  let attempt: Awaited<ReturnType<typeof startSubjectTestAttempt>>;
  try {
    attempt = await startSubjectTestAttempt(student.id, selection);
  } catch (error) {
    if (error instanceof InsufficientQuestionsError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Something went wrong starting the test." };
  }
  redirect(`/student/attempt/${attempt.id}`);
}

/** Live "how many questions are in scope" count for the builder screen. */
export async function countAvailableQuestionsAction(filters: QuestionSelectionFilters): Promise<number> {
  await requireStudentOrLogin();
  return countPublishedQuestions(filters);
}