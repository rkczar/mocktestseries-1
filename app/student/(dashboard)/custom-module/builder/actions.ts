"use server";

import { redirect } from "next/navigation";
import { AttemptAnswerMode, AttemptDurationMode, type QuestionDifficulty, type QuestionSource } from "@prisma/client";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import { prisma } from "@/lib/prisma";
import { startCustomModuleAttempt, startSharedCustomModuleAttempt, MAX_CUSTOM_DURATION_MINUTES } from "@/lib/test-attempt";
import { ensureCustomModuleShareToken, getSubjectTestSetup } from "@/lib/student-data";
import {
  selectPublishedQuestions,
  countPublishedQuestions,
  assertValidOwnershipChain,
  InsufficientQuestionsError,
  type QuestionSelectionFilters,
} from "@/lib/question-selection";

/** The student-facing duration choices (TestAttempt.durationMode, frozen at start). */
const STUDENT_DURATION_MODES = [AttemptDurationMode.PER_QUESTION, AttemptDurationMode.UNLIMITED, AttemptDurationMode.CUSTOM] as const;
const MAX_MODULE_QUESTIONS = 200;

export interface CustomModuleBuilderState {
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
 * Build (and immediately start) a student-owned Custom Module V2. The
 * question set is resolved exactly once here, through the same
 * selectPublishedQuestions service every other test type uses, then frozen
 * into CustomModuleQuestion — Start/refresh/resume never re-resolves it.
 */
export async function createCustomModuleAction(
  _prevState: CustomModuleBuilderState,
  formData: FormData
): Promise<CustomModuleBuilderState> {
  const student = await requireStudentOrLogin();

  const examId = str(formData, "examId");
  if (!examId) return { error: "Exam is required." };

  // Any whole number from 1 up to the platform maximum — the real limit is
  // the eligible pool, checked against the database below.
  const count = Number(str(formData, "count"));
  if (!Number.isInteger(count) || count < 1 || count > MAX_MODULE_QUESTIONS) {
    return { error: `Question count must be between 1 and ${MAX_MODULE_QUESTIONS}.` };
  }

  // Exactly three duration modes; default 1 minute per question.
  const durationModeRaw = str(formData, "durationMode") || AttemptDurationMode.PER_QUESTION;
  const durationMode = STUDENT_DURATION_MODES.find((m) => m === durationModeRaw);
  if (!durationMode) return { error: "Choose a valid time option." };
  let customMinutes: number | null = null;
  if (durationMode === AttemptDurationMode.CUSTOM) {
    customMinutes = Number(str(formData, "customMinutes"));
    if (!Number.isInteger(customMinutes) || customMinutes < 1 || customMinutes > MAX_CUSTOM_DURATION_MINUTES) {
      return { error: `Custom time must be a whole number of minutes between 1 and ${MAX_CUSTOM_DURATION_MINUTES}.` };
    }
  }
  const answerMode = str(formData, "answerMode") === AttemptAnswerMode.INSTANT ? AttemptAnswerMode.INSTANT : AttemptAnswerMode.EXAM;

  const subjectId = str(formData, "subjectId");
  const topicId = str(formData, "topicId");
  const sourceRaw = str(formData, "source");
  const difficulty = formData.getAll("difficulty").filter((v): v is string => typeof v === "string") as QuestionDifficulty[];

  // Sub-topic and My History filters were removed from the builder: they are
  // deliberately never read from the request any more.
  const filters: QuestionSelectionFilters = {
    examId,
    subjectId: subjectId || undefined,
    topicId: topicId || undefined,
    year: optionalInt(str(formData, "year")),
    source: (sourceRaw || undefined) as QuestionSource | undefined,
    difficulty: difficulty.length > 0 ? difficulty : undefined,
    studentId: student.id,
  };

  try {
    await assertValidOwnershipChain(filters);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid selection." };
  }

  let resolved: Awaited<ReturnType<typeof selectPublishedQuestions>>;
  try {
    resolved = await selectPublishedQuestions({ ...filters, count });
  } catch (error) {
    if (error instanceof InsufficientQuestionsError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Could not build this module." };
  }

  const title = buildModuleTitle(filters);

  const customModule = await prisma.customModule.create({
    data: {
      examId,
      title,
      selectionMode: "RULE_BASED",
      ruleConfig: filters as never,
      durationMode,
      durationMinutes: customMinutes,
      answerMode,
      accessType: "FREE",
      status: "ACTIVE",
      isStudentOwned: true,
      createdByStudentId: student.id,
    },
  });

  await prisma.customModuleQuestion.createMany({
    data: resolved.questions.map((q, order) => ({ customModuleId: customModule.id, questionId: q.id, order })),
  });

  let attempt: Awaited<ReturnType<typeof startCustomModuleAttempt>>;
  try {
    attempt = await startCustomModuleAttempt(student.id, customModule.id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Module created but could not be started." };
  }
  redirect(`/student/attempt/${attempt.id}`);
}

function buildModuleTitle(filters: QuestionSelectionFilters): string {
  const parts: string[] = [];
  if (filters.source === "PYQ") parts.push("PYQ");
  parts.push("Custom Practice");
  return parts.join(" · ").slice(0, 120);
}

/** Live "how many questions are in scope" count for the builder screen. */
export async function countCustomModuleQuestionsAction(filters: QuestionSelectionFilters): Promise<number> {
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

/** Subject/topic/sub-topic tree + available years for the exam the student just picked. */
export async function getExamSetupAction(examId: string) {
  await requireStudentOrLogin();
  const setup = await getSubjectTestSetup(examId);
  if (!setup) return null;
  return { subjects: setup.exam.subjects, years: setup.years };
}

/** Generates (if needed) and returns the student's share link token for one of their own modules. */
export async function shareCustomModuleAction(moduleId: string): Promise<{ token: string } | { error: string }> {
  const student = await requireStudentOrLogin();
  try {
    const token = await ensureCustomModuleShareToken(moduleId, student.id);
    return { token };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not generate a share link." };
  }
}

export async function startSharedCustomModuleAction(shareToken: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrPaywall(() => startSharedCustomModuleAttempt(student.id, shareToken));
  redirect(`/student/attempt/${attempt.id}`);
}
