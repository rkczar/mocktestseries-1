"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import type { AttemptPolicy, MockTestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";

// Mock Test Builder mutations are gated by TEST_SERIES_MANAGE (MASTER_ADMIN
// only), not TESTS_MANAGE — Mock Tests are now part of the Test Series
// Control Center, which is spec'd as MASTER_ADMIN-mutate / FULL_ADMIN-read-
// only. Live Test keeps using TESTS_MANAGE unchanged; it's a separate
// feature (see lib/permissions.ts).

const optionalInt = z
  .union([z.literal(""), z.coerce.number().int().min(0).max(10000)])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

const detailsSchema = z.object({
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  durationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute."),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  accessType: z.enum(["FREE", "PAID"]),
  order: optionalInt,
  targetQuestionCount: optionalInt,
  coverageType: z.enum(["FULL_SYLLABUS", "PARTIAL_SYLLABUS", "SUBJECT_WISE"]).default("FULL_SYLLABUS"),
});

const mockTestSchema = detailsSchema.extend({
  examId: z.string().min(1, "Select an exam."),
  testSeriesId: z.string().optional(),
  availableFrom: z.string().optional(),
  attemptPolicy: z.enum(["SINGLE_ATTEMPT", "MULTIPLE_PRACTICE"]).default("MULTIPLE_PRACTICE"),
});

function readDetails(formData: FormData) {
  return {
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    durationMinutes: formData.get("durationMinutes"),
    negativeMarking: formData.get("negativeMarking"),
    instructions: formData.get("instructions") || undefined,
    accessType: formData.get("accessType"),
    order: formData.get("order") ?? undefined,
    targetQuestionCount: formData.get("targetQuestionCount") ?? undefined,
    coverageType: formData.get("coverageType") || undefined,
  };
}

/** Coverage ids are only kept when they belong to the test's exam (never trust posted ids). */
async function readCoverage(formData: FormData, examId: string, coverageType: string) {
  if (coverageType === "FULL_SYLLABUS") return { coverageSubjectIds: [] as string[], coverageTopicIds: [] as string[] };
  const subjectIds = formData.getAll("coverageSubjectIds").map(String);
  const topicIds = formData.getAll("coverageTopicIds").map(String);
  const [subjects, topics] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds }, examId }, select: { id: true } }),
    prisma.topic.findMany({ where: { id: { in: topicIds }, subject: { examId } }, select: { id: true } }),
  ]);
  const okS = new Set(subjects.map((s) => s.id));
  const okT = new Set(topics.map((t) => t.id));
  return { coverageSubjectIds: subjectIds.filter((id) => okS.has(id)), coverageTopicIds: topicIds.filter((id) => okT.has(id)) };
}

export interface MockTestFormState {
  error?: string;
  success?: boolean;
}

export async function createMockTestAction(_prev: MockTestFormState, formData: FormData): Promise<MockTestFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = mockTestSchema.safeParse({
    ...readDetails(formData),
    examId: formData.get("examId"),
    testSeriesId: formData.get("testSeriesId") || undefined,
    availableFrom: formData.get("availableFrom") || undefined,
    attemptPolicy: formData.get("attemptPolicy") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { testSeriesId, availableFrom, order, ...rest } = parsed.data;
  if (testSeriesId) {
    const series = await prisma.testSeries.findUnique({ where: { id: testSeriesId }, select: { examId: true } });
    if (!series || series.examId !== rest.examId) return { error: "That Test Series belongs to a different exam." };
  }
  const availableFromDate = availableFrom ? parseIstDateTimeLocal(availableFrom) : null;
  if (availableFrom && !availableFromDate) return { error: "Invalid available-from date/time." };

  // Default Test Number = next free number in the series.
  let testNumber = order;
  if (testNumber === null) {
    const last = testSeriesId
      ? await prisma.mockTest.findFirst({ where: { testSeriesId }, orderBy: { order: "desc" }, select: { order: true } })
      : null;
    testNumber = (last?.order ?? 0) + 1;
  }

  const coverage = await readCoverage(formData, rest.examId, rest.coverageType);
  const mockTest = await prisma.mockTest.create({
    data: { ...rest, ...coverage, order: testNumber, testSeriesId: testSeriesId || null, availableFrom: availableFromDate },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "MOCK_TEST_CREATED", entityType: "MockTest", entityId: mockTest.id },
  });

  revalidateMockSeriesSurfaces();
  // Straight into the new test's editor, where questions are assigned.
  redirect(`/admin/tests/mock/${mockTest.id}?created=1`);
}

/** Edits a Mock Test's details + coverage from its detail page. Publication is changed separately (setMockTestStatusAction). */
export async function updateMockTestDetailsAction(mockTestId: string, _prev: MockTestFormState, formData: FormData): Promise<MockTestFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = detailsSchema.safeParse(readDetails(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const existing = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { examId: true, order: true } });
  if (!existing) return { error: "Mock test not found." };

  const { order, ...rest } = parsed.data;
  const coverage = await readCoverage(formData, existing.examId, rest.coverageType);
  await prisma.mockTest.update({
    where: { id: mockTestId },
    data: { ...rest, ...coverage, order: order ?? existing.order, description: rest.description ?? null, instructions: rest.instructions ?? null },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "MOCK_TEST_UPDATED", entityType: "MockTest", entityId: mockTestId, metadata: { coverageType: rest.coverageType, accessType: rest.accessType } },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

export async function setMockTestStatusAction(mockTestId: string, status: MockTestStatus): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  if (status === "PUBLISHED") {
    const count = await prisma.mockTestQuestion.count({ where: { mockTestId } });
    if (count === 0) return { error: "Add questions before publishing — an empty test can't be attempted." };
  }
  await prisma.mockTest.update({ where: { id: mockTestId }, data: { status } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_STATUS_CHANGED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { status },
    },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return {};
}

export interface ScheduleFormState {
  error?: string;
  success?: boolean;
}

/** Edits a Mock Test's release schedule + attempt policy from the detail page (Schedule & Policy card). */
export async function updateMockTestScheduleAction(
  mockTestId: string,
  _prev: ScheduleFormState,
  formData: FormData
): Promise<ScheduleFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const availableFromRaw = (formData.get("availableFrom") as string | null) || "";
  const attemptPolicy = formData.get("attemptPolicy") as AttemptPolicy;
  if (attemptPolicy !== "SINGLE_ATTEMPT" && attemptPolicy !== "MULTIPLE_PRACTICE") {
    return { error: "Invalid attempt policy." };
  }
  const availableFrom = availableFromRaw ? parseIstDateTimeLocal(availableFromRaw) : null;
  if (availableFromRaw && !availableFrom) return { error: "Invalid available-from date/time." };

  await prisma.mockTest.update({ where: { id: mockTestId }, data: { availableFrom, attemptPolicy } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_SCHEDULE_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { availableFrom, attemptPolicy },
    },
  });

  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

export interface QuestionSyncState {
  error?: string;
  success?: boolean;
  count?: number;
}

/**
 * Replaces the test's ordered question list. `questionIds` arrive in display
 * order (the picker's reorder controls); only PUBLISHED questions of the
 * test's own exam are accepted, so a crafted form can't attach anything else.
 */
export async function syncMockTestQuestionsAction(mockTestId: string, _prev: QuestionSyncState, formData: FormData): Promise<QuestionSyncState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const mockTest = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { examId: true, status: true } });
  if (!mockTest) return { error: "Mock test not found." };
  const posted = [...new Set(formData.getAll("questionIds").map(String))];
  const valid = await prisma.question.findMany({
    where: { id: { in: posted }, examId: mockTest.examId, status: "PUBLISHED" },
    select: { id: true },
  });
  const ok = new Set(valid.map((q) => q.id));
  const questionIds = posted.filter((id) => ok.has(id));
  if (mockTest.status === "PUBLISHED" && questionIds.length === 0) {
    return { error: "A published test must keep at least one question. Unpublish it first to clear all questions." };
  }

  await prisma.$transaction([
    prisma.mockTestQuestion.deleteMany({ where: { mockTestId } }),
    prisma.mockTestQuestion.createMany({
      data: questionIds.map((questionId, order) => ({ mockTestId, questionId, order })),
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_QUESTIONS_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { count: questionIds.length, rejected: posted.length - questionIds.length },
    },
  });

  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true, count: questionIds.length };
}
