import "server-only";
import { LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import {
  AttemptSourceType,
  AttemptStatus,
  CustomModuleStatus,
  MockResultRelease,
  MockTestStatus,
  QuestionStatus,
  ReportType,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toIstDateString, istStartOfDay } from "@/lib/ist-time";
import { getAiSettings } from "@/lib/ai-settings";
import { attemptTitle } from "@/lib/attempt-title";
import { createDeletionRequest } from "@/lib/student-lifecycle";

/**
 * Every function here takes the authenticated studentId as a required
 * argument and threads it into the query as an ownership filter — there is
 * no code path in this module that reads or writes student-owned data
 * without it. Content reads (exams, mock tests, custom modules, questions)
 * are read-only from this side; Admin is the only writer.
 */

// Statuses visible to students. "Draft, Inactive and Archived must not
// appear in the normal student listing" — visible = PUBLISHED or ACTIVE.
const VISIBLE_CUSTOM_MODULE_STATUSES = [CustomModuleStatus.PUBLISHED, CustomModuleStatus.ACTIVE];

export async function logActivity(studentId: string, activity: string, metadata?: Record<string, unknown>) {
  await prisma.studentActivity.create({ data: { studentId, activity, metadata: metadata as never } });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getStudentProfile(studentId: string) {
  return prisma.student.findUnique({
    where: { id: studentId },
    include: { profile: true, oauthAccounts: { select: { provider: true } } },
  });
}

// ---------------------------------------------------------------------------
// Exams / My Exams
// ---------------------------------------------------------------------------

export async function getActiveExamsCatalog(studentId?: string) {
  const [exams, enrollments] = await Promise.all([
    prisma.exam.findMany({
      where: { isActive: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      include: {
        _count: {
          select: {
            previousYearPapers: true,
            mockTests: { where: { status: MockTestStatus.PUBLISHED } },
            customModules: { where: { status: { in: VISIBLE_CUSTOM_MODULE_STATUSES } } },
          },
        },
      },
    }),
    studentId ? prisma.studentExamEnrollment.findMany({ where: { studentId }, select: { examId: true } }) : Promise.resolve([]),
  ]);
  const enrolledIds = new Set(enrollments.map((e) => e.examId));
  return exams.map((exam) => ({ ...exam, isEnrolled: enrolledIds.has(exam.id) }));
}

// ---------------------------------------------------------------------------
// Exam enrollment ("My Exams")
//
// Additive: access to content is NOT gated on enrollment (free/demo behavior
// keeps working everywhere else) — this only gives a student a focused list
// and, later, a first-class dimension for paid-access gating (Step 7.5).
// ---------------------------------------------------------------------------

/** Server-side enrollment gate for anything scoped to a student-selected Active Exam. */
export async function isStudentEnrolledInExam(studentId: string, examId: string): Promise<boolean> {
  const row = await prisma.studentExamEnrollment.findUnique({ where: { studentId_examId: { studentId, examId } } });
  return row !== null;
}

export async function enrollInExam(studentId: string, examId: string) {
  await prisma.studentExamEnrollment.upsert({
    where: { studentId_examId: { studentId, examId } },
    update: {},
    create: { studentId, examId },
  });
  await logActivity(studentId, "EXAM_ENROLLED", { examId });
}

export async function unenrollFromExam(studentId: string, examId: string) {
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId, examId } });
  await logActivity(studentId, "EXAM_UNENROLLED", { examId });
}

export async function getEnrolledExams(studentId: string) {
  const enrollments = await prisma.studentExamEnrollment.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    include: { exam: true },
  });
  return enrollments.map((e) => e.exam);
}

export async function getExamDetailForStudent(examId: string) {
  const exam = await prisma.exam.findFirst({
    where: { id: examId, isActive: true },
    include: {
      subjects: {
        orderBy: [{ order: "asc" }, { name: "asc" }],
        include: { topics: { orderBy: [{ order: "asc" }, { name: "asc" }] } },
      },
      previousYearPapers: { where: { isActive: true }, orderBy: { year: "desc" } },
    },
  });
  if (!exam) return null;

  const [mockTests, customModules] = await Promise.all([
    prisma.mockTest.findMany({
      where: { examId, ...LIVE_MOCK_TEST_WHERE },
      orderBy: { order: "asc" },
      include: { _count: { select: { questions: { where: { question: { status: QuestionStatus.PUBLISHED } } } } } },
    }),
    prisma.customModule.findMany({
      where: { examId, status: { in: VISIBLE_CUSTOM_MODULE_STATUSES } },
      orderBy: { order: "asc" },
      include: { _count: { select: { questions: true } } },
    }),
  ]);

  return { exam, mockTests, customModules };
}

// ---------------------------------------------------------------------------
// Test Series / Mock Tests
// ---------------------------------------------------------------------------

/**
 * Scheduled Mock Test Series hub data. Buckets every PUBLISHED MockTest into
 * UPCOMING/AVAILABLE by DERIVED release state (lib/mock-test-schedule.ts),
 * never the raw persisted fields alone — the same "compute from server time"
 * discipline lib/live-test.ts already uses. A test with no availableFrom is
 * always AVAILABLE (legacy behavior preserved). Grouped by TestSeries for
 * the hub page; standalone tests are returned under a null-series group.
 */
export async function getScheduledMockTestsForStudent(studentId: string) {
  const { deriveMockTestAvailability } = await import("@/lib/mock-test-schedule");

  const mockTests = await prisma.mockTest.findMany({
    where: LIVE_MOCK_TEST_WHERE,
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    // Students only ever receive PUBLISHED questions (startMockTestAttempt),
    // so the count they see is that number, not the admin's attached total.
    include: { exam: true, testSeries: true, _count: { select: { questions: { where: { question: { status: QuestionStatus.PUBLISHED } } } } } },
  });

  const bestAttempts = await prisma.testAttempt.groupBy({
    by: ["mockTestId"],
    where: { studentId, sourceType: AttemptSourceType.MOCK_TEST, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() },
    _max: { score: true },
  });
  const bestByMockTest = new Map(bestAttempts.map((b) => [b.mockTestId, b._max.score]));

  const attempts = await prisma.testAttempt.findMany({
    where: { studentId, sourceType: AttemptSourceType.MOCK_TEST },
    orderBy: { startedAt: "desc" },
    select: { mockTestId: true, id: true, status: true },
  });
  const latestByMockTest = new Map<string, { id: string; status: AttemptStatus }>();
  const submittedMockTestIds = new Set<string>();
  for (const a of attempts) {
    if (!a.mockTestId) continue;
    if (!latestByMockTest.has(a.mockTestId)) latestByMockTest.set(a.mockTestId, { id: a.id, status: a.status });
    if (a.status === AttemptStatus.SUBMITTED) submittedMockTestIds.add(a.mockTestId);
  }

  const now = new Date();
  const rows = mockTests.map((mockTest) => ({
    mockTest,
    availability: deriveMockTestAvailability(mockTest, now),
    bestScore: bestByMockTest.get(mockTest.id) ?? null,
    latestAttempt: latestByMockTest.get(mockTest.id) ?? null,
    hasSubmittedAttempt: submittedMockTestIds.has(mockTest.id),
  }));

  const groupMap = new Map<string, { series: (typeof mockTests)[number]["testSeries"]; tests: typeof rows }>();
  for (const row of rows) {
    const key = row.mockTest.testSeriesId ?? "__standalone__";
    if (!groupMap.has(key)) groupMap.set(key, { series: row.mockTest.testSeries, tests: [] });
    groupMap.get(key)!.tests.push(row);
  }

  return { groups: Array.from(groupMap.values()), all: rows };
}

export type ScheduledMockTestRow = Awaited<ReturnType<typeof getScheduledMockTestsForStudent>>["all"][number];

/**
 * Picks the single test to surface on the Dashboard's "Next Test" card:
 * an AVAILABLE test the student hasn't submitted yet (soonest by
 * availableFrom, nulls first since they've been open longest), else the
 * soonest UPCOMING test. Optionally scoped to one exam. Display-only — the
 * actual gate is startMockTestAttempt's server-side isMockTestAvailable
 * check, not anything derived here.
 */
export async function getNextScheduledTestForStudent(studentId: string, examId?: string | null) {
  const { all } = await getScheduledMockTestsForStudent(studentId);
  const candidates = examId ? all.filter((row) => row.mockTest.examId === examId) : all;

  const byAvailableFromAsc = (a: ScheduledMockTestRow, b: ScheduledMockTestRow) => {
    const at = a.mockTest.availableFrom?.getTime() ?? 0;
    const bt = b.mockTest.availableFrom?.getTime() ?? 0;
    return at - bt;
  };

  const available = candidates
    .filter((row) => (row.availability === "AVAILABLE" || row.availability === "LIVE_NOW") && !row.hasSubmittedAttempt)
    .sort(byAvailableFromAsc);
  if (available.length > 0) return available[0];

  const upcoming = candidates.filter((row) => row.availability === "UPCOMING").sort(byAvailableFromAsc);
  return upcoming[0] ?? null;
}

// ---------------------------------------------------------------------------
// Custom Modules
// ---------------------------------------------------------------------------

export async function getPublishedCustomModulesForStudent(studentId: string, examId?: string) {
  const modules = await prisma.customModule.findMany({
    where: { status: { in: VISIBLE_CUSTOM_MODULE_STATUSES }, examId: examId || undefined },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    include: { exam: true, _count: { select: { questions: true } } },
  });

  const bestAttempts = await prisma.testAttempt.groupBy({
    by: ["customModuleId"],
    where: { studentId, sourceType: AttemptSourceType.CUSTOM_MODULE, status: AttemptStatus.SUBMITTED },
    _max: { score: true },
  });
  const bestByModule = new Map(bestAttempts.map((b) => [b.customModuleId, b._max.score]));

  const latestAttempts = await prisma.testAttempt.findMany({
    where: { studentId, sourceType: AttemptSourceType.CUSTOM_MODULE },
    orderBy: { startedAt: "desc" },
    select: { customModuleId: true, id: true, status: true },
  });
  const latestByModule = new Map<string, { id: string; status: AttemptStatus }>();
  for (const a of latestAttempts) {
    if (a.customModuleId && !latestByModule.has(a.customModuleId)) {
      latestByModule.set(a.customModuleId, { id: a.id, status: a.status });
    }
  }

  return modules.map((m) => ({
    module: m,
    bestScore: bestByModule.get(m.id) ?? null,
    latestAttempt: latestByModule.get(m.id) ?? null,
  }));
}

/**
 * A student-owned module is only visible to its creator here — the `OR`
 * clause is the whole enforcement point, mirroring startCustomModuleAttempt
 * in lib/test-attempt.ts. Shared access goes through the shareToken path
 * (getCustomModuleByShareToken) instead of this id-keyed lookup.
 */
export async function getCustomModuleDetailForStudent(moduleId: string, studentId: string) {
  const customModule = await prisma.customModule.findFirst({
    where: {
      id: moduleId,
      status: { in: VISIBLE_CUSTOM_MODULE_STATUSES },
      OR: [{ isStudentOwned: false }, { createdByStudentId: studentId }],
    },
    include: { exam: true, _count: { select: { questions: true } } },
  });
  if (!customModule) return null;

  const attempts = await prisma.testAttempt.findMany({
    where: { studentId, customModuleId: moduleId },
    orderBy: { startedAt: "desc" },
  });

  return { module: customModule, attempts };
}

/** "My Modules" — every Custom Module V2 the student built themselves, newest first. */
export async function getStudentOwnedCustomModules(studentId: string) {
  const modules = await prisma.customModule.findMany({
    where: { createdByStudentId: studentId, isStudentOwned: true },
    orderBy: { createdAt: "desc" },
    take: 50, // most recent — a student building many modules shouldn't make this list unbounded
    include: { exam: true, _count: { select: { questions: true } } },
  });

  const latestAttempts = await prisma.testAttempt.findMany({
    where: { studentId, sourceType: AttemptSourceType.CUSTOM_MODULE, customModuleId: { in: modules.map((m) => m.id) } },
    orderBy: { startedAt: "desc" },
    select: { customModuleId: true, id: true, status: true, score: true, maxScore: true },
  });
  const latestByModule = new Map<string, (typeof latestAttempts)[number]>();
  for (const a of latestAttempts) {
    if (a.customModuleId && !latestByModule.has(a.customModuleId)) latestByModule.set(a.customModuleId, a);
  }

  return modules.map((m) => ({ module: m, latestAttempt: latestByModule.get(m.id) ?? null }));
}

/** Looked up by the unguessable share token only — never by id — so a private module can't be reached by guessing. */
export async function getCustomModuleByShareToken(shareToken: string) {
  return prisma.customModule.findFirst({
    where: { shareToken, status: { in: VISIBLE_CUSTOM_MODULE_STATUSES } },
    include: { exam: true, _count: { select: { questions: true } } },
  });
}

/** Idempotent — returns the existing token if one was already generated, otherwise mints and persists a new opaque one. */
export async function ensureCustomModuleShareToken(moduleId: string, studentId: string) {
  const existing = await prisma.customModule.findFirst({
    where: { id: moduleId, createdByStudentId: studentId, isStudentOwned: true },
    select: { shareToken: true },
  });
  if (!existing) throw new Error("Module not found.");
  if (existing.shareToken) return existing.shareToken;

  const token = crypto.randomUUID().replace(/-/g, "");
  await prisma.customModule.update({ where: { id: moduleId }, data: { shareToken: token } });
  return token;
}

// ---------------------------------------------------------------------------
// Previous Year Papers
// ---------------------------------------------------------------------------

export async function getPreviousYearPaperForStudent(paperId: string, studentId: string) {
  const paper = await prisma.previousYearPaper.findFirst({
    where: { id: paperId, isActive: true },
    include: { exam: true, _count: { select: { questions: { where: { status: QuestionStatus.PUBLISHED } } } } },
  });
  if (!paper) return null;

  const attempts = await prisma.testAttempt.findMany({
    where: { studentId, previousYearPaperId: paperId },
    orderBy: { startedAt: "desc" },
  });

  return { paper, attempts };
}

// ---------------------------------------------------------------------------
// Subject Test (unified test engine — Step 3)
// ---------------------------------------------------------------------------

/** Catalog for /student/subject-test — every active exam with a subject count. */
export async function getSubjectTestExams() {
  return prisma.exam.findMany({
    where: { isActive: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    include: { _count: { select: { subjects: true } } },
  });
}

/**
 * Everything the subject-test builder screen needs, scoped to one exam:
 * subject/topic/sub-topic hierarchy and the distinct years that have any
 * PUBLISHED question under this exam. Question counts per selection are left
 * to the live `countPublishedQuestions` calls on the form's server action so
 * the numbers always reflect the current question bank.
 */
export async function getSubjectTestSetup(examId: string) {
  const exam = await prisma.exam.findFirst({
    where: { id: examId, isActive: true },
    select: {
      id: true,
      name: true,
      instructions: true,
      durationMinutes: true,
      negativeMarking: true,
      subjects: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          name: true,
          topics: {
            orderBy: { order: "asc" },
            select: { id: true, name: true, subTopics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
          },
        },
      },
    },
  });
  if (!exam) return null;

  const years = await prisma.question.groupBy({
    by: ["examYear"],
    where: { examId, status: QuestionStatus.PUBLISHED, examYear: { not: null } },
    _count: { _all: true },
    orderBy: { examYear: "desc" },
  });

  return { exam, years: years.map((y) => y.examYear as number).filter((y): y is number => y !== null) };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getStudentAttemptHistory(
  studentId: string,
  filters: { examId?: string; sourceType?: AttemptSourceType } = {}
) {
  return prisma.testAttempt.findMany({
    where: {
      studentId,
      examId: filters.examId || undefined,
      sourceType: filters.sourceType || undefined,
    },
    orderBy: { startedAt: "desc" },
    include: { exam: true, mockTest: true, customModule: true, previousYearPaper: true, subject: true },
  });
}

/**
 * Ownership-checked attempt fetch — returns null (never another student's
 * row) if not owned by studentId. Also the request-time reconciliation point
 * (Step 5.6): if the attempt is still IN_PROGRESS but its effective window
 * has closed, it's finalized here before being returned, so every page that
 * reads an attempt (run/result/review) always sees settled, consistent
 * state — never a stale IN_PROGRESS row past its own deadline.
 */
export async function getOwnedAttempt(attemptId: string, studentId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, studentId },
    include: {
      exam: true,
      mockTest: true,
      customModule: true,
      previousYearPaper: true,
      subject: true,
      grandTest: true,
      liveTest: true,
      questions: { orderBy: { order: "asc" }, include: { answer: true } },
    },
  });
  if (!attempt) return null;

  const { finalizeIfExpired } = await import("@/lib/test-attempt");
  if (await finalizeIfExpired(attempt)) {
    return getOwnedAttempt(attemptId, studentId);
  }
  return attempt;
}

/**
 * Prisma `where` fragment excluding SUBMITTED Mock Test attempts whose
 * result is not yet released (lib/mock-test-schedule.ts#isMockResultReleased,
 * expressed as a query). Spread into every student-facing score aggregate
 * (dashboard averages, analytics, weak topics, best score) so a held result
 * can't leak through a derived number before its release time. Attempts
 * with no Mock Test are unaffected.
 */
export function resultReleasedAttemptWhere(now: Date = new Date()) {
  return {
    NOT: {
      mockTest: {
        is: {
          OR: [
            { resultReleaseMode: MockResultRelease.CUSTOM_DATE, resultReleaseAt: { gt: now } },
            { resultReleaseMode: MockResultRelease.AFTER_WINDOW, availableUntil: { gt: now } },
          ],
        },
      },
    },
  } satisfies Prisma.TestAttemptWhereInput;
}

/**
 * True if this student has a SUBMITTED Mock Test attempt containing this
 * question whose result is still held. Ask AI is keyed by question (not
 * attempt), so like hasInProgressAttemptForQuestion below this is the one
 * check every surface shares.
 */
export async function hasUnreleasedResultForQuestion(studentId: string, questionId: string, now: Date = new Date()): Promise<boolean> {
  const held = await prisma.testAttemptQuestion.findFirst({
    where: {
      questionId,
      attempt: { studentId, status: AttemptStatus.SUBMITTED, mockTest: resultReleasedAttemptWhere(now).NOT.mockTest },
    },
    select: { id: true },
  });
  return held !== null;
}

/**
 * True if this student currently has an IN_PROGRESS attempt that includes
 * this question. Ask AI (lib/ai-explanation.ts via app/student/ai-actions.ts)
 * is shared by both the (post-submission) Review page and Saved Questions —
 * neither of which carries an attemptId — so this is the one check that
 * correctly blocks getting the AI explanation for a question that's part of
 * a test the student is still actively taking, regardless of which surface
 * they request it from (a student can Save a question mid-attempt, then open
 * Saved Questions in another tab).
 */
export async function hasInProgressAttemptForQuestion(studentId: string, questionId: string): Promise<boolean> {
  const blocking = await prisma.testAttemptQuestion.findFirst({
    where: { questionId, attempt: { studentId, status: AttemptStatus.IN_PROGRESS } },
    select: { id: true },
  });
  return blocking !== null;
}

// ---------------------------------------------------------------------------
// Saved Questions
// ---------------------------------------------------------------------------

export async function getSavedQuestions(studentId: string) {
  return prisma.savedQuestion.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    include: { question: { include: { exam: true, subject: true, topic: true, options: true } } },
  });
}

export async function isQuestionSaved(studentId: string, questionId: string) {
  const row = await prisma.savedQuestion.findUnique({ where: { studentId_questionId: { studentId, questionId } } });
  return Boolean(row);
}

/** Bulk-checks which of `questionIds` the student has saved — one query instead of N. */
export async function getSavedQuestionIdSet(studentId: string, questionIds: string[]) {
  if (questionIds.length === 0) return new Set<string>();
  const rows = await prisma.savedQuestion.findMany({
    where: { studentId, questionId: { in: questionIds } },
    select: { questionId: true },
  });
  return new Set(rows.map((r) => r.questionId));
}

export async function toggleSavedQuestion(studentId: string, questionId: string) {
  const existing = await prisma.savedQuestion.findUnique({ where: { studentId_questionId: { studentId, questionId } } });
  if (existing) {
    await prisma.savedQuestion.delete({ where: { id: existing.id } });
    return false;
  }
  await prisma.savedQuestion.create({ data: { studentId, questionId } });
  await logActivity(studentId, "QUESTION_SAVED", { questionId });
  return true;
}

// ---------------------------------------------------------------------------
// Reported Questions
// ---------------------------------------------------------------------------

export async function reportQuestion(
  studentId: string,
  questionId: string,
  reportType: ReportType,
  message: string | undefined,
  attemptId?: string,
  customModuleId?: string
) {
  await prisma.reportedQuestion.create({
    data: { studentId, questionId, reportType, message, attemptId, customModuleId },
  });
  await logActivity(studentId, "QUESTION_REPORTED", { questionId, reportType });
}

// ---------------------------------------------------------------------------
// AI Explanation
// ---------------------------------------------------------------------------

export async function getStoredAiExplanation(questionId: string) {
  return prisma.aIExplanation.findUnique({ where: { questionId } });
}

export async function getStoredAiExplanationVariant(questionId: string, variantId: string) {
  return prisma.aIExplanationVariant.findUnique({ where: { questionId_variantId: { questionId, variantId } } });
}

const AI_RATE_LIMIT_WINDOW_MS = 60 * 60_000;
const AI_RATE_LIMIT_MAX_NEW_GENERATIONS = 30;

/**
 * Sensible per-student cost control (Step 6.4) on DISTINCT, UNCACHED AI
 * generations only — a cache hit is a cheap DB read and is never rate
 * limited. Reuses the existing StudentActivity log rather than a new table:
 * every genuinely new generation is logged as AI_EXPLANATION_GENERATED, and
 * this counts how many a student triggered in the last hour.
 */
export async function isAiGenerationRateLimited(studentId: string): Promise<boolean> {
  const count = await prisma.studentActivity.count({
    where: { studentId, activity: "AI_EXPLANATION_GENERATED", createdAt: { gte: new Date(Date.now() - AI_RATE_LIMIT_WINDOW_MS) } },
  });
  return count >= AI_RATE_LIMIT_MAX_NEW_GENERATIONS;
}

/** Active (started, unexpired, unrevoked) entitlement to any active PAID product — the "Complete / paid plan" test for AI quotas. */
export async function hasPaidAiPlan(studentId: string, now: Date = new Date()): Promise<boolean> {
  const count = await prisma.studentEntitlement.count({
    where: {
      studentId,
      status: "ACTIVE",
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      product: { accessType: "PAID", isActive: true },
    },
  });
  return count > 0;
}

export interface AiAccessQuota {
  allowed: boolean;
  limit: number;
  /** Distinct questions already counted against today's limit, BEFORE this check. Re-opening one of these costs nothing. */
  usedToday: number;
  remainingToday: number;
  alreadyViewedToday: boolean;
}

/**
 * Student-facing daily AI access entitlement (spec: "STUDENT AI ACCESS ≠
 * PROVIDER API CALL"). Counts DISTINCT questions the student has opened
 * Ask AI on today (IST), from the same StudentActivity log
 * isAiGenerationRateLimited reads — re-opening an already-counted question
 * is free; a new distinct question consumes one credit, whether served from
 * cache or freshly generated. Plan is decided server-side from the
 * entitlement DB (hasPaidAiPlan): a student holding any active entitlement
 * to a PAID product gets `paidDailyLimit` (null = unlimited), everyone else
 * `freeDailyLimit`. AI Explanations, Examiner Traps and AI Trap/Similar
 * questions are all served through this one quota.
 */
export async function checkAiAccessQuota(studentId: string, questionId: string): Promise<AiAccessQuota> {
  const [settings, paidPlan] = await Promise.all([getAiSettings(), hasPaidAiPlan(studentId)]);
  const limit = paidPlan ? settings.paidDailyLimit : settings.freeDailyLimit;
  const todayStart = istStartOfDay(new Date());

  const viewedToday = await prisma.studentActivity.findMany({
    where: { studentId, activity: "AI_EXPLANATION_VIEWED", createdAt: { gte: todayStart } },
    select: { metadata: true },
  });
  const distinctQuestionIds = new Set(
    viewedToday.map((a) => (a.metadata as { questionId?: string } | null)?.questionId).filter((id): id is string => Boolean(id))
  );
  const alreadyViewedToday = distinctQuestionIds.has(questionId);
  const usedToday = distinctQuestionIds.size;

  if (limit === null || alreadyViewedToday || usedToday < limit) {
    return { allowed: true, limit: limit ?? Infinity, usedToday, remainingToday: limit === null ? Infinity : Math.max(0, limit - usedToday - (alreadyViewedToday ? 0 : 1)), alreadyViewedToday };
  }
  return { allowed: false, limit, usedToday, remainingToday: 0, alreadyViewedToday: false };
}

/** Logs a successful Ask AI access (cached or freshly generated) — the quota ledger checkAiAccessQuota reads, and the "views" side of Admin AI Usage's views/cache-hits/provider-calls split. */
export async function logAiAccess(studentId: string, questionId: string, opts: { cacheHit: boolean; provider: string; model: string }) {
  await logActivity(studentId, "AI_EXPLANATION_VIEWED", { questionId, ...opts });
}

// ---------------------------------------------------------------------------
// Profile / Account
// ---------------------------------------------------------------------------

/**
 * Students may only ever change their own bio here — the account `name` is
 * intentionally excluded from this data shape so a student can never rename
 * themselves through this path, no matter what a caller passes in. Only an
 * authorized Admin (Admin -> Students -> Student Profile, PERMISSIONS.STUDENTS_MANAGE)
 * may correct a student's name, via correctStudentNameAction.
 */
export async function updateStudentProfile(studentId: string, data: { bio: string }) {
  await prisma.studentProfile.upsert({
    where: { studentId },
    update: { bio: data.bio || null },
    create: { studentId, bio: data.bio || null },
  });
  await logActivity(studentId, "PROFILE_UPDATED");
}

/**
 * Delegates to the canonical lifecycle (lib/student-lifecycle.ts). Throws
 * DeletionLifecycleError if a request is already pending or the account is
 * no longer active — a duplicate is rejected, never silently merged.
 */
export async function requestAccountDeletion(studentId: string, reason: string | undefined) {
  return createDeletionRequest(studentId, reason);
}

/** Most recent request of any status — lets the profile show PENDING or a past REJECTED outcome. */
export async function getLatestDeletionRequest(studentId: string) {
  return prisma.deletionRequest.findFirst({
    where: { studentId },
    orderBy: { requestedAt: "desc" },
    select: { status: true, requestedAt: true, reviewedAt: true },
  });
}

// ---------------------------------------------------------------------------
// Dashboard (Step 7.6) — every figure here is a real, server-side aggregate
// against this student's own rows. No hardcoded/demo values.
// ---------------------------------------------------------------------------

const DASHBOARD_ATTEMPT_INCLUDE = {
  exam: true,
  mockTest: true,
  customModule: true,
  previousYearPaper: true,
  grandTest: true,
  liveTest: true,
  subject: true,
} as const;

/** Consecutive-day study streak in IST, walking back from today until a day with no activity is hit. */
async function computeStudyStreak(studentId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 24 * 60 * 60_000); // 60 days is more than enough to find any real gap
  const activity = await prisma.studentActivity.findMany({
    where: { studentId, createdAt: { gte: since } },
    select: { createdAt: true },
  });
  if (activity.length === 0) return 0;

  const activeDays = new Set(activity.map((a) => toIstDateString(a.createdAt)));
  let streak = 0;
  const cursor = new Date();
  for (;;) {
    const dayKey = toIstDateString(cursor);
    if (!activeDays.has(dayKey)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * Subjects belonging to one exam, each with its real PUBLISHED question count
 * — one groupBy query for every subject's count, never N+1 per-subject
 * queries. Backs both the Dashboard's "Subjects in <Active Exam>" section and
 * the Test on the Go subject picker.
 */
export async function getExamSubjectsOverview(examId: string) {
  const subjects = await prisma.subject.findMany({
    where: { examId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  if (subjects.length === 0) return [];

  const counts = await prisma.question.groupBy({
    by: ["subjectId"],
    where: { examId, subjectId: { in: subjects.map((s) => s.id) }, status: QuestionStatus.PUBLISHED },
    _count: { _all: true },
  });
  const countBySubject = new Map(counts.map((c) => [c.subjectId, c._count._all]));

  return subjects.map((s) => ({ id: s.id, name: s.name, questionCount: countBySubject.get(s.id) ?? 0 }));
}

/** Total saved questions for a student, optionally scoped to one exam. */
export async function getSavedQuestionsCount(studentId: string, examId?: string) {
  return prisma.savedQuestion.count({ where: { studentId, question: examId ? { examId } : undefined } });
}

export async function getDashboardMetrics(studentId: string) {
  const startOfTodayIst = parseIstDayStartAsUtc(new Date());

  const [mcqSolvedToday, distinctAttemptedRows, testsCompleted, avgScoreAgg, recentAttempt, inProgress, studyStreak, upcomingExam] =
    await Promise.all([
      prisma.answer.count({ where: { studentId, status: { not: "UNANSWERED" }, answeredAt: { gte: startOfTodayIst } } }),
      prisma.answer.findMany({ where: { studentId, status: { not: "UNANSWERED" } }, select: { questionId: true }, distinct: ["questionId"] }),
      prisma.testAttempt.count({ where: { studentId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() } }),
      prisma.testAttempt.aggregate({ where: { studentId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() }, _avg: { score: true } }),
      prisma.testAttempt.findFirst({
        where: { studentId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() },
        orderBy: { submittedAt: "desc" },
        include: DASHBOARD_ATTEMPT_INCLUDE,
      }),
      prisma.testAttempt.findFirst({
        where: { studentId, status: AttemptStatus.IN_PROGRESS },
        orderBy: { startedAt: "desc" },
        include: DASHBOARD_ATTEMPT_INCLUDE,
      }),
      computeStudyStreak(studentId),
      getUpcomingExamForStudent(studentId),
    ]);

  const weakTopics = await getWeakTopics(studentId, 5);
  const savedQuestionsCount = await getSavedQuestionsCount(studentId);

  return {
    mcqSolvedToday,
    questionsAttempted: distinctAttemptedRows.length,
    testsCompleted,
    averageScore: avgScoreAgg._avg.score,
    studyStreak,
    upcomingExam: upcomingExam
      ? { id: upcomingExam.id, name: upcomingExam.name, daysLeft: daysUntil(upcomingExam.upcomingDate) }
      : null,
    recentTest: recentAttempt ? { id: recentAttempt.id, title: attemptTitle(recentAttempt), score: recentAttempt.score, maxScore: recentAttempt.maxScore } : null,
    inProgress,
    weakTopics,
    savedQuestionsCount,
  };
}

/**
 * Same shape as getDashboardMetrics, scoped to one Active Exam — every
 * TestAttempt row carries a mandatory examId (schema.prisma), and Answer is
 * scoped through its attempt relation, so every figure here reflects only
 * this exam's own attempts/answers. Study streak is intentionally excluded —
 * it's a daily-activity concept that doesn't fragment sensibly per exam, so
 * the Dashboard keeps showing it as a single global, clearly-labelled tile.
 */
export async function getExamScopedDashboardMetrics(studentId: string, examId: string) {
  const startOfTodayIst = parseIstDayStartAsUtc(new Date());

  const [mcqSolvedToday, distinctAttemptedRows, testsCompleted, avgScoreAgg, recentAttempt, inProgress, exam] =
    await Promise.all([
      prisma.answer.count({
        where: { studentId, status: { not: "UNANSWERED" }, answeredAt: { gte: startOfTodayIst }, attempt: { examId } },
      }),
      prisma.answer.findMany({
        where: { studentId, status: { not: "UNANSWERED" }, attempt: { examId } },
        select: { questionId: true },
        distinct: ["questionId"],
      }),
      prisma.testAttempt.count({ where: { studentId, examId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() } }),
      prisma.testAttempt.aggregate({ where: { studentId, examId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() }, _avg: { score: true } }),
      prisma.testAttempt.findFirst({
        where: { studentId, examId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() },
        orderBy: { submittedAt: "desc" },
        include: DASHBOARD_ATTEMPT_INCLUDE,
      }),
      prisma.testAttempt.findFirst({
        where: { studentId, examId, status: AttemptStatus.IN_PROGRESS },
        orderBy: { startedAt: "desc" },
        include: DASHBOARD_ATTEMPT_INCLUDE,
      }),
      prisma.exam.findUnique({ where: { id: examId }, select: { id: true, name: true, isUpcoming: true, upcomingDate: true } }),
    ]);

  const weakTopics = await getWeakTopics(studentId, 5, 500, examId);
  const savedQuestionsCount = await getSavedQuestionsCount(studentId, examId);

  return {
    examId,
    examName: exam?.name ?? "",
    mcqSolvedToday,
    questionsAttempted: distinctAttemptedRows.length,
    testsCompleted,
    averageScore: avgScoreAgg._avg.score,
    upcomingExam:
      exam?.isUpcoming && exam.upcomingDate ? { id: exam.id, name: exam.name, daysLeft: daysUntil(exam.upcomingDate) } : null,
    recentTest: recentAttempt
      ? { id: recentAttempt.id, title: attemptTitle(recentAttempt), score: recentAttempt.score, maxScore: recentAttempt.maxScore }
      : null,
    inProgress,
    weakTopics,
    savedQuestionsCount,
  };
}

function parseIstDayStartAsUtc(now: Date): Date {
  const istDateStr = toIstDateString(now); // "YYYY-MM-DD" in IST
  return new Date(`${istDateStr}T00:00:00+05:30`);
}

function daysUntil(date: Date | null): number | null {
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60_000)));
}

/** Nearest upcoming exam among the student's enrolled exams; falls back to any upcoming exam if they haven't enrolled in one yet. */
export async function getUpcomingExamForStudent(studentId: string) {
  const enrolled = await prisma.studentExamEnrollment.findMany({ where: { studentId }, select: { examId: true } });
  const examIds = enrolled.map((e) => e.examId);

  if (examIds.length > 0) {
    const enrolledUpcoming = await prisma.exam.findFirst({
      where: { isActive: true, isUpcoming: true, upcomingDate: { not: null, gte: new Date() }, id: { in: examIds } },
      orderBy: { upcomingDate: "asc" },
    });
    if (enrolledUpcoming) return enrolledUpcoming;
  }

  return prisma.exam.findFirst({
    where: { isActive: true, isUpcoming: true, upcomingDate: { not: null, gte: new Date() } },
    orderBy: { upcomingDate: "asc" },
  });
}

/**
 * Topics with the most incorrect answers, bounded to a recent window of this
 * student's own wrong answers (never the whole bank) — a small, indexed
 * query plus in-memory aggregation over at most `sampleSize` rows, not a
 * huge client-side dataset.
 */
export async function getWeakTopics(studentId: string, limit = 5, sampleSize = 500, examId?: string) {
  const wrongAnswers = await prisma.answer.findMany({
    where: { studentId, isCorrect: false, attempt: { ...(examId ? { examId } : {}), ...resultReleasedAttemptWhere() } },
    select: { questionId: true },
    orderBy: { id: "desc" },
    take: sampleSize,
  });
  if (wrongAnswers.length === 0) return [];

  const countByQuestion = new Map<string, number>();
  for (const a of wrongAnswers) countByQuestion.set(a.questionId, (countByQuestion.get(a.questionId) ?? 0) + 1);

  const questions = await prisma.question.findMany({
    where: { id: { in: [...countByQuestion.keys()] } },
    select: { id: true, topicId: true, topic: { select: { name: true } } },
  });

  const countByTopic = new Map<string, { name: string; count: number }>();
  for (const q of questions) {
    if (!q.topicId || !q.topic) continue;
    const add = countByQuestion.get(q.id) ?? 0;
    const existing = countByTopic.get(q.topicId);
    countByTopic.set(q.topicId, { name: q.topic.name, count: (existing?.count ?? 0) + add });
  }

  return [...countByTopic.entries()]
    .map(([topicId, v]) => ({ topicId, name: v.name, incorrectCount: v.count }))
    .sort((a, b) => b.incorrectCount - a.incorrectCount)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Analytics (Step 7.7) — server-side aggregation from attempts/answers.
// ---------------------------------------------------------------------------

export async function getStudentAnalytics(studentId: string) {
  const [totals, byExam, bySubject, submittedAttempts] = await Promise.all([
    prisma.answer.groupBy({ by: ["status"], where: { studentId }, _count: { _all: true } }),
    prisma.testAttempt.groupBy({
      by: ["examId"],
      where: { studentId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() },
      _avg: { score: true },
      _count: { _all: true },
    }),
    prisma.testAttempt.groupBy({
      by: ["subjectId"],
      where: { studentId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere(), subjectId: { not: null } },
      _avg: { score: true },
      _count: { _all: true },
    }),
    prisma.testAttempt.findMany({
      where: { studentId, status: AttemptStatus.SUBMITTED, ...resultReleasedAttemptWhere() },
      orderBy: { submittedAt: "desc" },
      take: 100, // most recent 100 — a long test history shouldn't ship an unbounded list to the client
      select: { submittedAt: true, score: true, maxScore: true, testType: true },
    }),
  ]);
  submittedAttempts.reverse(); // oldest-first for the on-page history/chart

  const correctByStatus = Object.fromEntries(totals.map((t) => [t.status, t._count._all]));
  const attempted = (correctByStatus.ANSWERED ?? 0) + (correctByStatus.ANSWERED_AND_MARKED ?? 0);
  const unattempted = (correctByStatus.UNANSWERED ?? 0) + (correctByStatus.MARKED_FOR_REVIEW ?? 0);

  const correctIncorrect = await prisma.answer.groupBy({
    by: ["isCorrect"],
    where: { studentId, isCorrect: { not: null } },
    _count: { _all: true },
  });
  const correct = correctIncorrect.find((c) => c.isCorrect === true)?._count._all ?? 0;
  const incorrect = correctIncorrect.find((c) => c.isCorrect === false)?._count._all ?? 0;
  const accuracy = correct + incorrect > 0 ? (correct / (correct + incorrect)) * 100 : null;

  const examIds = byExam.map((e) => e.examId);
  const subjectIds = bySubject.map((s) => s.subjectId).filter((s): s is string => s !== null);
  const [exams, subjects] = await Promise.all([
    prisma.exam.findMany({ where: { id: { in: examIds } }, select: { id: true, name: true } }),
    prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
  ]);
  const examNameById = new Map(exams.map((e) => [e.id, e.name]));
  const subjectNameById = new Map(subjects.map((s) => [s.id, s.name]));

  return {
    attempted,
    unattempted,
    correct,
    incorrect,
    accuracy,
    examPerformance: byExam.map((e) => ({ examId: e.examId, name: examNameById.get(e.examId) ?? "—", attempts: e._count._all, averageScore: e._avg.score })),
    subjectPerformance: bySubject.map((s) => ({
      subjectId: s.subjectId as string,
      name: subjectNameById.get(s.subjectId as string) ?? "—",
      attempts: s._count._all,
      averageScore: s._avg.score,
    })),
    weakTopics: await getWeakTopics(studentId, 8),
    performanceOverTime: submittedAttempts.map((a) => ({
      date: a.submittedAt,
      score: a.score,
      maxScore: a.maxScore,
      percentage: a.maxScore ? Math.round(((a.score ?? 0) / a.maxScore) * 100) : null,
      testType: a.testType,
    })),
  };
}
