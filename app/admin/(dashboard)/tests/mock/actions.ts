"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import type { MockResultRelease, MockTestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { examSubjectWhere, examTopicWhere } from "@/lib/exam-taxonomy";
import { requirePermission } from "@/lib/rbac";
import { AssignmentError, setMockSeriesAssignment } from "@/lib/test-series-assignment";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import { validateMockSchedule, type MockAvailabilityMode } from "@/lib/mock-test-schedule";
import { matchingQuestionIds, sanitizeBankFilters, searchQuestionBank, type BankPage } from "@/lib/mock-question-bank";
import { addQuestionsToMock, loadAssignment, removeQuestionsFromMock, replaceQuestionInMock, writeAssignment } from "@/lib/mock-test-questions";

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
/**
 * Step 2 — Mock Category / Coverage. A Subject Mock (coverageType
 * SUBJECT_WISE) names exactly ONE canonical Subject of the exam (topics, if
 * any, must belong to it); it is what groups the test under "Subject Mock
 * Tests → <Subject>" (lib/subject-mocks.ts). Full / Partial Syllabus are the
 * Full / General category.
 */
async function readCoverage(formData: FormData, examId: string, coverageType: string) {
  if (coverageType === "FULL_SYLLABUS") return { coverageSubjectIds: [] as string[], coverageTopicIds: [] as string[] };
  const subjectIds = formData.getAll("coverageSubjectIds").map(String);
  const topicIds = formData.getAll("coverageTopicIds").map(String);
  const [subjects, topics] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: subjectIds }, ...examSubjectWhere(examId) }, select: { id: true } }),
    prisma.topic.findMany({ where: { id: { in: topicIds }, ...examTopicWhere(examId) }, select: { id: true } }),
  ]);
  const okS = new Set(subjects.map((s) => s.id));
  const okT = new Set(topics.map((t) => t.id));
  const coverageSubjectIds = [...new Set(subjectIds.filter((id) => okS.has(id)))];
  let coverageTopicIds = topicIds.filter((id) => okT.has(id));
  if (coverageType === "SUBJECT_WISE") {
    if (coverageSubjectIds.length !== 1) return { error: "A Subject Mock needs exactly one subject — use Partial Syllabus for a test spanning several subjects." };
    const own = await prisma.topic.findMany({ where: { id: { in: coverageTopicIds }, subjectId: coverageSubjectIds[0] }, select: { id: true } });
    coverageTopicIds = own.map((t) => t.id);
  }
  return { coverageSubjectIds, coverageTopicIds };
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
  if ("error" in coverage) return { error: coverage.error };
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
  if ("error" in coverage) return { error: coverage.error };
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
const PROMO_TEXT_MAX = 160;

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
 *
 * Live CBT safe defaults: the save that turns a mock INTO a Fixed Window also
 * sets Single Attempt and "Result release: after the window closes", so an
 * early finisher can't see answers or retake inside the window. Only on that
 * transition — the admin may change either afterwards in Step 5, and
 * ordinary (non-window) mocks are never touched.
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
    select: { resultReleaseMode: true, resultReleaseAt: true, availableUntil: true },
  });
  if (!existing) return { error: "Mock test not found." };

  const availableFrom = mode === "AVAILABLE_NOW" ? null : from.value;
  const availableUntil = mode === "FIXED_WINDOW" ? until.value : null;
  const becomesLive = mode === "FIXED_WINDOW" && existing.availableUntil === null;
  const liveDefaults = becomesLive
    ? { attemptPolicy: "SINGLE_ATTEMPT" as const, resultReleaseMode: "AFTER_WINDOW" as const, resultReleaseAt: null }
    : {};
  const error = validateMockSchedule({
    mode,
    availableFrom,
    availableUntil,
    resultReleaseMode: becomesLive ? "AFTER_WINDOW" : existing.resultReleaseMode,
    resultReleaseAt: becomesLive ? null : existing.resultReleaseAt,
  });
  if (error) return { error };

  await prisma.mockTest.update({ where: { id: mockTestId }, data: { availableFrom, availableUntil, ...liveDefaults } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_SCHEDULE_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { mode, availableFrom, availableUntil, ...(becomesLive ? { liveDefaults: "SINGLE_ATTEMPT + AFTER_WINDOW" } : {}) },
    },
  });

  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

/**
 * Live CBT enrollment (lib/live-cbt.ts). Enrollment Enabled ON = a student
 * must enroll before starting; OFF = unchanged Mock Test behaviour. Open /
 * close are optional (blank open = open now, blank close = when the test
 * window closes). Existing enrollments are never deleted here.
 */
export async function updateMockTestEnrollmentAction(mockTestId: string, _prev: ScheduleFormState, formData: FormData): Promise<ScheduleFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const enrollmentEnabled = formData.get("enrollmentEnabled") === "on";
  const showEnrolledCount = formData.get("showEnrolledCount") === "on";
  // Live CBT promotion (lib/live-cbt.ts): only ever applied to a published Fixed Window test.
  const promoteOnDashboard = formData.get("promoteOnDashboard") === "on";
  const allowSharing = formData.get("allowSharing") === "on";
  const promoText = String(formData.get("promoText") ?? "").replace(/\s+/g, " ").trim() || null;
  if (promoText && promoText.length > PROMO_TEXT_MAX) return { error: `Promotional description must be ${PROMO_TEXT_MAX} characters or fewer.` };
  const opens = readIst(formData, "enrollmentOpensAt");
  const closes = readIst(formData, "enrollmentClosesAt");
  if (opens.invalid || closes.invalid) return { error: "Invalid enrollment date/time." };
  if (opens.value && closes.value && closes.value.getTime() <= opens.value.getTime()) return { error: "Enrollment must close after it opens." };
  const existing = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { availableUntil: true } });
  if (!existing) return { error: "Mock test not found." };
  if (closes.value && existing.availableUntil && closes.value.getTime() > existing.availableUntil.getTime()) {
    return { error: "Enrollment can't close after the test window ends." };
  }

  const data = { enrollmentEnabled, showEnrolledCount, enrollmentOpensAt: opens.value, enrollmentClosesAt: closes.value, promoteOnDashboard, allowSharing, promoText };
  await prisma.mockTest.update({ where: { id: mockTestId }, data });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "MOCK_TEST_ENROLLMENT_UPDATED", entityType: "MockTest", entityId: mockTestId, metadata: data },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`, `/student/test-series/${mockTestId}`, `/live-cbt/${mockTestId}`);
  return { success: true };
}

/** Step 5: FREE/PAID access, attempt policy and result release. The leaderboard switch lives in ranking-actions.ts. */
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

  await prisma.mockTest.update({
    where: { id: mockTestId },
    data: { accessType, attemptPolicy, resultReleaseMode, resultReleaseAt },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_ACCESS_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { accessType, attemptPolicy, resultReleaseMode, resultReleaseAt },
    },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Step 3 — Questions. Membership only (lib/mock-test-questions.ts): these
// actions authorize + audit; they never copy, update or reclassify a Question.
// ---------------------------------------------------------------------------

export interface QuestionOpResult {
  error?: string;
  added?: number;
  skipped?: number;
}

const idList = z.array(z.string().min(1).max(64)).max(2000);

async function audit(actorId: string | undefined, mockTestId: string, op: string, metadata: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: { actorId, action: "MOCK_TEST_QUESTIONS_UPDATED", entityType: "MockTest", entityId: mockTestId, metadata: { op, ...metadata } },
  });
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
}

/** Add From Question Bank search — server-side filtered + paginated over the whole central bank. */
export async function searchMockQuestionBankAction(mockTestId: string, filters: unknown, page: number): Promise<BankPage | { error: string }> {
  await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const exists = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { id: true } });
  if (!exists) return { error: "Mock test not found." };
  return searchQuestionBank(sanitizeBankFilters(filters), typeof page === "number" ? page : 1);
}

/** "Select all filtered" — the ids matching the current filters (capped). */
export async function matchingMockQuestionIdsAction(mockTestId: string, filters: unknown): Promise<{ ids: string[] } | { error: string }> {
  await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const exists = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { id: true } });
  if (!exists) return { error: "Mock test not found." };
  return { ids: await matchingQuestionIds({ ...sanitizeBankFilters(filters), excludeMockTestId: mockTestId }) };
}

/** Add From Question Bank: appends in the order given — any exam; reference only (lib/mock-test-questions.ts). */
export async function addMockTestQuestionsAction(mockTestId: string, questionIds: string[]): Promise<QuestionOpResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = idList.safeParse(questionIds);
  if (!parsed.success) return { error: "Invalid selection." };
  const result = await addQuestionsToMock(mockTestId, parsed.data);
  if ("error" in result) return { error: result.error };
  await audit(session.user.id, mockTestId, "ADD", { added: result.added, crossExam: result.crossExam, rejected: result.rejected });
  return { added: result.added, skipped: result.skipped };
}

export async function removeMockTestQuestionsAction(mockTestId: string, questionIds: string[]): Promise<QuestionOpResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = idList.safeParse(questionIds);
  if (!parsed.success) return { error: "Invalid selection." };
  const result = await removeQuestionsFromMock(mockTestId, parsed.data);
  if ("error" in result) return { error: result.error };
  await audit(session.user.id, mockTestId, "REMOVE", { removed: result.removed });
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
  const result = await replaceQuestionInMock(mockTestId, oldId, newId);
  if ("error" in result) return { error: result.error };
  await audit(session.user.id, mockTestId, "REPLACE", { oldId, newId, slot: result.slot });
  return {};
}

/**
 * Test Series / Course Assignment card. "Standalone" clears testSeriesId;
 * "Assign" requires an explicit series of the mock's own exam. Access is
 * inherited through that series' Product — never granted per mock.
 */
export async function setMockSeriesAssignmentAction(mockTestId: string, _prev: MockTestFormState, formData: FormData): Promise<MockTestFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const mode = String(formData.get("assignment") ?? "");
  const seriesId = String(formData.get("testSeriesId") ?? "").trim();
  if (mode !== "STANDALONE" && mode !== "SERIES") return { error: "Choose Standalone or a Test Series." };
  if (mode === "SERIES" && !seriesId) return { error: "Select the Test Series to assign." };
  try {
    await prisma.$transaction((tx) =>
      setMockSeriesAssignment(tx, { mockTestId, seriesId: mode === "SERIES" ? seriesId : null, actorId: session.user.id })
    );
  } catch (e) {
    if (e instanceof AssignmentError) return { error: e.message };
    throw e;
  }
  revalidateMockSeriesSurfaces(`/admin/tests/mock/${mockTestId}`);
  return { success: true };
}
