"use server";

import { redirect } from "next/navigation";
import { AttemptAnswerMode, AttemptDurationMode, type QuestionDifficulty, type QuestionSource } from "@prisma/client";
import { requireStudentOrLogin } from "@/lib/student-session";
import { parseAttemptConfigForm, PRACTICE_TIME_MODES } from "@/lib/attempt-config";
import { startSubjectTestAttempt, type SubjectTestSelection } from "@/lib/test-attempt";
import {
  countPublishedQuestions,
  InsufficientQuestionsError,
  NoQuestionsAvailableError,
  type QuestionSelectionFilters,
} from "@/lib/question-selection";
import { isExamLive } from "@/lib/exam-live";

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

  // Time + answer review: the one shared parser (lib/attempt-config.ts).
  const parsedConfig = parseAttemptConfigForm(formData, PRACTICE_TIME_MODES, "PER_QUESTION");
  if (!parsedConfig.ok) return { error: parsedConfig.error };
  const durationMode = AttemptDurationMode[parsedConfig.config.durationMode];
  const customMinutes = parsedConfig.config.customMinutes;
  const answerMode = AttemptAnswerMode[parsedConfig.config.answerMode];

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
  if (!(await isExamLive(filters.examId))) return 0;
  return countPublishedQuestions({
    examId: filters.examId,
    subjectId: filters.subjectId,
    topicId: filters.topicId,
    year: filters.year,
    source: filters.source,
    difficulty: filters.difficulty,
  });
}
