"use server";

import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import {
  getExamScopedDashboardMetrics,
  getExamSubjectsOverview,
  getNextScheduledTestForStudent,
  isStudentEnrolledInExam,
} from "@/lib/student-data";
import { startSubjectTestAttempt, type SubjectTestSelection } from "@/lib/test-attempt";
import { InsufficientQuestionsError } from "@/lib/question-selection";
import { toDashboardMetricsView } from "./metrics-view";

export interface TestOnTheGoFormState {
  error?: string;
}

/**
 * Data needed to redraw the Dashboard after the student switches their
 * Active Exam — enrollment is re-checked here (never trusted from the
 * client), so a tampered request can never scope the dashboard to an exam
 * the student isn't enrolled in.
 */
export async function getActiveExamDashboardDataAction(examId: string) {
  const student = await requireStudent();
  const enrolled = await isStudentEnrolledInExam(student.id, examId);
  if (!enrolled) throw new Error("You are not enrolled in this exam.");

  const [rawMetrics, subjects, nextTestRow] = await Promise.all([
    getExamScopedDashboardMetrics(student.id, examId),
    getExamSubjectsOverview(examId),
    getNextScheduledTestForStudent(student.id, examId),
  ]);
  const nextTest = nextTestRow
    ? {
        mockTestId: nextTestRow.mockTest.id,
        title: nextTestRow.mockTest.title,
        examName: nextTestRow.mockTest.exam.name,
        availability: nextTestRow.availability,
        availableFrom: nextTestRow.mockTest.availableFrom ? nextTestRow.mockTest.availableFrom.toISOString() : null,
      }
    : null;
  return { metrics: toDashboardMetricsView(rawMetrics), subjects, nextTest };
}

function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Test on the Go (Section 4/5/7): starts a normal SUBJECT_TEST attempt
 * through the exact same canonical engine the /student/subject-test builder
 * uses (startSubjectTestAttempt → selectPublishedQuestions →
 * TestAttempt/TestAttemptQuestion/Test Player/Result/Review) — the only
 * difference is duration is never asked for, it's always exactly
 * `count` minutes (Section 5), and the exam is always the student's Active
 * Exam rather than a re-picked one.
 */
export async function startTestOnTheGoAction(
  _prevState: TestOnTheGoFormState,
  formData: FormData
): Promise<TestOnTheGoFormState> {
  const student = await requireStudent();

  const examId = str(formData, "examId");
  const subjectId = str(formData, "subjectId");
  if (!examId || !subjectId) return { error: "Select a subject to start." };

  const enrolled = await isStudentEnrolledInExam(student.id, examId);
  if (!enrolled) return { error: "You are not enrolled in this exam." };

  const count = Number(str(formData, "count"));
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return { error: "Question count must be between 1 and 200." };
  }

  const selection: SubjectTestSelection = {
    examId,
    subjectId,
    count,
    durationMinutes: count, // 1 question = 1 minute, always — never asked for (Section 5)
  };

  let attempt: Awaited<ReturnType<typeof startSubjectTestAttempt>>;
  try {
    attempt = await startSubjectTestAttempt(student.id, selection);
  } catch (error) {
    if (error instanceof InsufficientQuestionsError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Something went wrong starting the test." };
  }
  redirect(`/student/attempt/${attempt.id}`);
}
