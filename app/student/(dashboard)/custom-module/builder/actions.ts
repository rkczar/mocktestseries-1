"use server";

import { redirect } from "next/navigation";
import type { QuestionDifficulty, QuestionSource } from "@prisma/client";
import { requireStudent } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import { prisma } from "@/lib/prisma";
import { startCustomModuleAttempt, startSharedCustomModuleAttempt } from "@/lib/test-attempt";
import { ensureCustomModuleShareToken, getSubjectTestSetup } from "@/lib/student-data";
import {
  selectPublishedQuestions,
  countPublishedQuestions,
  assertValidOwnershipChain,
  InsufficientQuestionsError,
  type QuestionSelectionFilters,
  type AttemptFilterMode,
} from "@/lib/question-selection";

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
  const student = await requireStudent();

  const examId = str(formData, "examId");
  if (!examId) return { error: "Exam is required." };

  const count = Number(str(formData, "count"));
  if (!Number.isInteger(count) || count < 1 || count > 200) return { error: "Question count must be between 1 and 200." };

  const durationRaw = str(formData, "durationMinutes");
  const durationMinutes = durationRaw ? Number(durationRaw) : undefined;
  if (durationRaw && (!Number.isInteger(durationMinutes) || (durationMinutes as number) < 1 || (durationMinutes as number) > 300)) {
    return { error: "Duration must be between 1 and 300 minutes." };
  }

  const subjectId = str(formData, "subjectId");
  const topicId = str(formData, "topicId");
  const subTopicId = str(formData, "subTopicId");
  const sourceRaw = str(formData, "source");
  const attemptFilterRaw = str(formData, "attemptFilter");
  const difficulty = formData.getAll("difficulty").filter((v): v is string => typeof v === "string") as QuestionDifficulty[];

  const filters: QuestionSelectionFilters = {
    examId,
    subjectId: subjectId || undefined,
    topicId: topicId || undefined,
    subTopicId: subTopicId || undefined,
    year: optionalInt(str(formData, "year")),
    source: (sourceRaw || undefined) as QuestionSource | undefined,
    difficulty: difficulty.length > 0 ? difficulty : undefined,
    studentId: student.id,
    attemptFilter: (attemptFilterRaw || undefined) as AttemptFilterMode | undefined,
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
      durationMinutes: durationMinutes ?? null,
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
  if (filters.attemptFilter === "SAVED") parts.push("Saved");
  if (filters.attemptFilter === "INCORRECT") parts.push("Incorrect");
  if (filters.attemptFilter === "UNATTEMPTED") parts.push("Unattempted");
  if (filters.source === "PYQ") parts.push("PYQ");
  parts.push("Custom Practice");
  return parts.join(" · ").slice(0, 120);
}

/** Live "how many questions are in scope" count for the builder screen. */
export async function countCustomModuleQuestionsAction(filters: QuestionSelectionFilters): Promise<number> {
  const student = await requireStudent();
  return countPublishedQuestions({ ...filters, studentId: student.id });
}

/** Subject/topic/sub-topic tree + available years for the exam the student just picked. */
export async function getExamSetupAction(examId: string) {
  await requireStudent();
  const setup = await getSubjectTestSetup(examId);
  if (!setup) return null;
  return { subjects: setup.exam.subjects, years: setup.years };
}

/** Generates (if needed) and returns the student's share link token for one of their own modules. */
export async function shareCustomModuleAction(moduleId: string): Promise<{ token: string } | { error: string }> {
  const student = await requireStudent();
  try {
    const token = await ensureCustomModuleShareToken(moduleId, student.id);
    return { token };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not generate a share link." };
  }
}

export async function startSharedCustomModuleAction(shareToken: string) {
  const student = await requireStudent();
  const attempt = await startOrPaywall(() => startSharedCustomModuleAttempt(student.id, shareToken));
  redirect(`/student/attempt/${attempt.id}`);
}
