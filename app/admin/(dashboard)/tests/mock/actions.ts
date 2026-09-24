"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import type { MockResultRelease, MockTestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import { validateMockSchedule, type MockAvailabilityMode } from "@/lib/mock-test-schedule";

// Every Mock Test mutation is gated by TEST_SERIES_MANAGE (MASTER_ADMIN
// only). FULL_ADMIN can open every page read-only; each action below
// refuses it server-side regardless of what the UI shows.

const optionalInt = z
  .union([z.literal(""), z.coerce.number().int().min(0).max(10000)])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

/** Step 1 (Basic Details) + Step 2 (Coverage). Access lives in Step 5. */
const detailsSchema = z.object({
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  durationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute."),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  order: optionalInt,
  targetQuestionCount: optionalInt,
  coverageType: z.enum(["FULL_SYLLABUS", "PARTIAL_SYLLABUS", "SUBJECT_WISE"]).default("FULL_SYLLABUS"),
});

const mockTestSchema = detailsSchema.extend({
  examId: z.string().min(1, "Select an exam."),
  testSeriesId: z.string().optional(),
  accessType: z.enum(["FREE", "PAID"]),
});

function readDetails(formData: FormData) {
  return {
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    durationMinutes: formData.get("durationMinutes"),
    negativeMarking: formData.get("negativeMarking"),
    instructions: formData.get("instructions") || undefined,
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

/**
 * The single create path for a Mock Test, whether reached from Admin → Tests
 * → Mock Tests → Create Mock Test or from a Test Series' "Add Mock Test" —
 * both land on /admin/tests/mock/new. Creates a DRAFT and opens its editor
 * at Step 3 (Questions).
 */
export async function createMockTestAction(_prev: MockTestFormState, formData: FormData): Promise<MockTestFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = mockTestSchema.safeParse({
    ...readDetails(formData),
    examId: formData.get("examId"),
    testSeriesId: formData.get("testSeriesId") || undefined,
    accessType: formData.get("accessType") || "PAID",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { testSeriesId, order, ...rest } = parsed.data;
  if (testSeriesId) {
    const series = await prisma.testSeries.findUnique({ where: { id: testSeriesId }, select: { examId: true } });
    if (!series || series.examId !== rest.examId) return { error: "That Test Series belongs to a different exam." };
  }

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
    data: { ...rest, ...coverage, order: testNumber, testSeriesId: testSeriesId || null },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "MOCK_TEST_CREATED", entityType: "MockTest", entityId: mockTest.id },
  });

  revalidateMockSeriesSurfaces();
  redirect(`/admin/tests/mock/${mockTest.id}?created=1#questions`);
}

/** Step 1 + Step 2: details and coverage. */
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
    data: { actorId: session.user.id, action: "MOCK_TEST_UPDATED", entityType: "MockTest", entityId: mockTestId, metadata: { coverageType: rest.coverageType } },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

/**
 * Step 6: publish/unpublish/archive. Publishing needs at least one
 * PUBLISHED question — students are only ever served published questions,
 * so a test holding only Draft imports would still be empty to them.
 */
export async function setMockTestStatusAction(mockTestId: string, status: MockTestStatus): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  if (status === "PUBLISHED") {
    const count = await prisma.mockTestQuestion.count({ where: { mockTestId, question: { status: "PUBLISHED" } } });
    if (count === 0) return { error: "Add at least one published question before publishing — an empty test can't be attempted." };
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

const AVAILABILITY_MODES: MockAvailabilityMode[] = ["AVAILABLE_NOW", "SCHEDULED_RELEASE", "FIXED_WINDOW"];
const RESULT_MODES: MockResultRelease[] = ["IMMEDIATE", "AFTER_WINDOW", "CUSTOM_DATE"];

function readIst(formData: FormData, key: string): { value: Date | null; invalid: boolean } {
  const raw = ((formData.get(key) as string | null) ?? "").trim();
  if (!raw) return { value: null, invalid: false };
  const value = parseIstDateTimeLocal(raw);
  return { value, invalid: value === null };
}

/**
 * Step 4: availability mode. The mode is not stored — it is expressed
 * entirely through availableFrom/availableUntil (see
 * lib/mock-test-schedule.ts), so Available Now clears both and Scheduled
 * Release clears the end. A result release of "after window closes" is only
 * valid with a Fixed Window; switching away from one refuses rather than
 * silently leaving results locked on a window that no longer exists.
 */
export async function updateMockTestScheduleAction(mockTestId: string, _prev: ScheduleFormState, formData: FormData): Promise<ScheduleFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const mode = formData.get("availabilityMode") as MockAvailabilityMode;
  if (!AVAILABILITY_MODES.includes(mode)) return { error: "Choose an availability mode." };
  const from = readIst(formData, "availableFrom");
  const until = readIst(formData, "availableUntil");
  if (from.invalid || until.invalid) return { error: "Invalid date/time." };

  const existing = await prisma.mockTest.findUnique({
    where: { id: mockTestId },
    select: { resultReleaseMode: true, resultReleaseAt: true },
  });
  if (!existing) return { error: "Mock test not found." };

  const availableFrom = mode === "AVAILABLE_NOW" ? null : from.value;
  const availableUntil = mode === "FIXED_WINDOW" ? until.value : null;
  const error = validateMockSchedule({ mode, availableFrom, availableUntil, ...existing });
  if (error) return { error };

  await prisma.mockTest.update({ where: { id: mockTestId }, data: { availableFrom, availableUntil } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_SCHEDULE_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { mode, availableFrom, availableUntil },
    },
  });

  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

/** Step 5: FREE/PAID access, attempt policy, result release and leaderboard. */
export async function updateMockTestAccessAction(mockTestId: string, _prev: ScheduleFormState, formData: FormData): Promise<ScheduleFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const accessType = formData.get("accessType");
  const attemptPolicy = formData.get("attemptPolicy");
  const resultReleaseMode = formData.get("resultReleaseMode") as MockResultRelease;
  if (accessType !== "FREE" && accessType !== "PAID") return { error: "Invalid access type." };
  if (attemptPolicy !== "SINGLE_ATTEMPT" && attemptPolicy !== "MULTIPLE_PRACTICE") return { error: "Invalid attempt policy." };
  if (!RESULT_MODES.includes(resultReleaseMode)) return { error: "Choose when results are released." };
  const releaseAt = readIst(formData, "resultReleaseAt");
  if (releaseAt.invalid) return { error: "Invalid result release date/time." };

  const existing = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { availableFrom: true, availableUntil: true } });
  if (!existing) return { error: "Mock test not found." };
  const resultReleaseAt = resultReleaseMode === "CUSTOM_DATE" ? releaseAt.value : null;
  const mode: MockAvailabilityMode = existing.availableUntil ? "FIXED_WINDOW" : existing.availableFrom ? "SCHEDULED_RELEASE" : "AVAILABLE_NOW";
  const error = validateMockSchedule({ mode, ...existing, resultReleaseMode, resultReleaseAt });
  if (error) return { error };

  const leaderboardEnabled = formData.get("leaderboardEnabled") === "on";
  await prisma.mockTest.update({
    where: { id: mockTestId },
    data: { accessType, attemptPolicy, resultReleaseMode, resultReleaseAt, leaderboardEnabled },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_ACCESS_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { accessType, attemptPolicy, resultReleaseMode, resultReleaseAt, leaderboardEnabled },
    },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Step 3 — Questions. Every assignment references a canonical Question Bank
// row (MockTestQuestion is only {mockTestId, questionId, order}); nothing
// here ever copies question content. Each action re-reads the current
// assignment server-side and rewrites a dense 0..n-1 order, so concurrent
// edits and stale client lists can never produce duplicate slots.
// ---------------------------------------------------------------------------

export interface QuestionOpResult {
  error?: string;
  added?: number;
  skipped?: number;
}

const idList = z.array(z.string().min(1).max(64)).max(2000);

async function loadAssignment(mockTestId: string) {
  const mockTest = await prisma.mockTest.findUnique({
    where: { id: mockTestId },
    select: { id: true, examId: true, status: true, questions: { orderBy: { order: "asc" }, select: { questionId: true } } },
  });
  return mockTest ? { ...mockTest, ids: mockTest.questions.map((q) => q.questionId) } : null;
}

/** Replaces the whole ordered assignment in one transaction. */
async function writeAssignment(mockTestId: string, ids: string[]) {
  await prisma.$transaction([
    prisma.mockTestQuestion.deleteMany({ where: { mockTestId } }),
    prisma.mockTestQuestion.createMany({ data: ids.map((questionId, order) => ({ mockTestId, questionId, order })) }),
  ]);
}

async function audit(actorId: string | undefined, mockTestId: string, op: string, metadata: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: { actorId, action: "MOCK_TEST_QUESTIONS_UPDATED", entityType: "MockTest", entityId: mockTestId, metadata: { op, ...metadata } },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
}

/** Only non-archived questions of the test's own exam can be attached (Question.examId == MockTest.examId). */
async function sameExamIds(examId: string, ids: string[]) {
  const rows = await prisma.question.findMany({ where: { id: { in: ids }, examId, status: { not: "ARCHIVED" } }, select: { id: true } });
  const ok = new Set(rows.map((r) => r.id));
  return ids.filter((id) => ok.has(id));
}

/** Add From Question Bank: appends in the order given, skipping anything already in the test. */
export async function addMockTestQuestionsAction(mockTestId: string, questionIds: string[]): Promise<QuestionOpResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = idList.safeParse(questionIds);
  if (!parsed.success) return { error: "Invalid selection." };
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." };
  const have = new Set(current.ids);
  const wanted = [...new Set(parsed.data)].filter((id) => !have.has(id));
  const valid = await sameExamIds(current.examId, wanted);
  if (valid.length > 0) await writeAssignment(mockTestId, [...current.ids, ...valid]);
  await audit(session.user.id, mockTestId, "ADD", { added: valid.length, rejected: wanted.length - valid.length });
  return { added: valid.length, skipped: parsed.data.length - valid.length };
}

export async function removeMockTestQuestionsAction(mockTestId: string, questionIds: string[]): Promise<QuestionOpResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = idList.safeParse(questionIds);
  if (!parsed.success) return { error: "Invalid selection." };
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." };
  const drop = new Set(parsed.data);
  const next = current.ids.filter((id) => !drop.has(id));
  if (current.status === "PUBLISHED" && next.length === 0) {
    return { error: "A published test must keep at least one question. Unpublish it first to remove every question." };
  }
  await writeAssignment(mockTestId, next);
  await audit(session.user.id, mockTestId, "REMOVE", { removed: current.ids.length - next.length });
  return {};
}

/** Reorder: the posted list must be exactly the current set (no adds/drops smuggled through a reorder). */
export async function reorderMockTestQuestionsAction(mockTestId: string, orderedIds: string[]): Promise<QuestionOpResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = idList.safeParse(orderedIds);
  if (!parsed.success) return { error: "Invalid order." };
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." };
  const posted = parsed.data;
  const same = posted.length === current.ids.length && new Set(posted).size === posted.length && posted.every((id) => current.ids.includes(id));
  if (!same) return { error: "The question list changed since you loaded it — reload and try again." };
  await writeAssignment(mockTestId, posted);
  await audit(session.user.id, mockTestId, "REORDER", { count: posted.length });
  return {};
}

/** Replace: swaps one question for another in the same slot. */
export async function replaceMockTestQuestionAction(mockTestId: string, oldId: string, newId: string): Promise<QuestionOpResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." };
  const slot = current.ids.indexOf(oldId);
  if (slot === -1) return { error: "That question is no longer in this test — reload and try again." };
  if (current.ids.includes(newId)) return { error: "The replacement is already in this test." };
  const [valid] = await sameExamIds(current.examId, [newId]);
  if (!valid) return { error: "The replacement must be a non-archived question from this test's exam." };
  const next = [...current.ids];
  next[slot] = newId;
  await writeAssignment(mockTestId, next);
  await audit(session.user.id, mockTestId, "REPLACE", { oldId, newId, slot: slot + 1 });
  return {};
}
