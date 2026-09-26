"use server";

import { redirect } from "next/navigation";
import { AttemptAnswerMode, AttemptDurationMode, type QuestionDifficulty, type QuestionSource } from "@prisma/client";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startSubjectTestAttempt, MAX_CUSTOM_DURATION_MINUTES, type SubjectTestSelection } from "@/lib/test-attempt";
import {
  countPublishedQuestions,
  InsufficientQuestionsError,
  NoQuestionsAvailableError,
  type QuestionSelectionFilters,
} from "@/lib/question-selection";

const SOURCES: QuestionSource[] = ["QUESTION_BANK", "PYQ"];
const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;

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

/** The student-facing time choices — the same three as Custom Module (UniversalTestSetup). */
const STUDENT_DURATION_MODES = [AttemptDurationMode.PER_QUESTION, AttemptDurationMode.UNLIMITED, AttemptDurationMode.CUSTOM] as const;
const MAX_SUBJECT_TEST_QUESTIONS = 200;

/**
 * Start a subject test from UniversalTestSetup. Every filter is re-read from
 * the request and every value is re-validated here — the client can only ever
 * submit filter choices, never question ids. The effective question count
 * (min(requested, eligible pool)) and the empty-pool refusal are both decided
 * inside startSubjectTestAttempt via selectPublishedQuestions — never here.
 * Time mode and answer mode are frozen onto the attempt at creation.
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
  if (!Number.isInteger(count) || count < 1 || count > MAX_SUBJECT_TEST_QUESTIONS) {
    return { error: `Question count must be between 1 and ${MAX_SUBJECT_TEST_QUESTIONS}.` };
  }

  const durationModeRaw = str(formData, "durationMode") || AttemptDurationMode.PER_QUESTION;
  const durationMode = STUDENT_DURATION_MODES.find((m) => m === durationModeRaw);
  if (!durationMode) return { error: "Choose a valid time option." };
  let customMinutes: number | undefined;
  if (durationMode === AttemptDurationMode.CUSTOM) {
    customMinutes = Number(str(formData, "customMinutes"));
    if (!Number.isInteger(customMinutes) || customMinutes < 1 || customMinutes > MAX_CUSTOM_DURATION_MINUTES) {
      return { error: `Custom time must be a whole number of minutes between 1 and ${MAX_CUSTOM_DURATION_MINUTES}.` };
    }
  }
  const answerMode = str(formData, "answerMode") === AttemptAnswerMode.INSTANT ? AttemptAnswerMode.INSTANT : AttemptAnswerMode.EXAM;

  const topicId = str(formData, "topicId");
  const sourceRaw = str(formData, "source");
  const source = SOURCES.find((v) => v === sourceRaw);
  const difficulty = formData
    .getAll("difficulty")
    .filter((v): v is QuestionDifficulty => typeof v === "string" && (DIFFICULTIES as readonly string[]).includes(v));

  const selection: SubjectTestSelection = {
    examId,
    subjectId,
    year: optionalInt(str(formData, "year")),
    topicId: topicId || undefined,
    source,
    difficulty: difficulty.length > 0 ? difficulty : undefined,
    count,
    durationMode,
    customMinutes,
    durationMinutes: customMinutes ?? 0, // the engine derives the frozen minutes from durationMode
    answerMode,
  };

  // redirect() throws NEXT_REDIRECT — call it OUTSIDE the try so the catch
  // below never swallows the control-flow exception (per Next.js docs).
  let attempt: Awaited<ReturnType<typeof startSubjectTestAttempt>>;
  try {
    attempt = await startSubjectTestAttempt(student.id, selection);
  } catch (error) {
    if (error instanceof InsufficientQuestionsError || error instanceof NoQuestionsAvailableError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Something went wrong starting the test." };
  }
  redirect(`/student/attempt/${attempt.id}`);
}

/** Live "how many questions are in scope" count for the setup screen — only the setup's own filters are honoured. */
export async function countAvailableQuestionsAction(filters: QuestionSelectionFilters): Promise<number> {
  await requireStudentOrLogin();
  return countPublishedQuestions({
    examId: filters.examId,
    subjectId: filters.subjectId,
    topicId: filters.topicId,
    year: filters.year,
    source: filters.source,
    difficulty: filters.difficulty,
  });
}
