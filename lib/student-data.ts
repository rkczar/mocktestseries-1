import "server-only";
import {
  AttemptSourceType,
  AttemptStatus,
  CustomModuleStatus,
  DeletionRequestStatus,
  GrandTestStatus,
  MockTestStatus,
  QuestionStatus,
  StudentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

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

export async function getActiveExamsCatalog() {
  return prisma.exam.findMany({
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
  });
}

export async function getExamDetailForStudent(examId: string) {
  const exam = await prisma.exam.findFirst({
    where: { id: examId, isActive: true },
    include: {
      subjects: { orderBy: { order: "asc" }, include: { topics: { orderBy: { order: "asc" } } } },
      previousYearPapers: { where: { isActive: true }, orderBy: { year: "desc" } },
    },
  });
  if (!exam) return null;

  const [mockTests, customModules, grandTests] = await Promise.all([
    prisma.mockTest.findMany({
      where: { examId, status: MockTestStatus.PUBLISHED },
      orderBy: { order: "asc" },
      include: { _count: { select: { questions: true } } },
    }),
    prisma.customModule.findMany({
      where: { examId, status: { in: VISIBLE_CUSTOM_MODULE_STATUSES } },
      orderBy: { order: "asc" },
      include: { _count: { select: { questions: true } } },
    }),
    prisma.grandTest.findMany({
      where: { examId, status: GrandTestStatus.PUBLISHED },
      orderBy: { order: "asc" },
      select: { id: true, title: true, questionCount: true, durationMinutes: true },
    }),
  ]);

  return { exam, mockTests, customModules, grandTests };
}

// ---------------------------------------------------------------------------
// Test Series / Mock Tests
// ---------------------------------------------------------------------------

export async function getPublishedMockTestsForStudent(studentId: string) {
  const mockTests = await prisma.mockTest.findMany({
    where: { status: MockTestStatus.PUBLISHED },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    include: { exam: true, testSeries: true, _count: { select: { questions: true } } },
  });

  const bestAttempts = await prisma.testAttempt.groupBy({
    by: ["mockTestId"],
    where: { studentId, sourceType: AttemptSourceType.MOCK_TEST, status: AttemptStatus.SUBMITTED },
    _max: { score: true },
  });
  const bestByMockTest = new Map(bestAttempts.map((b) => [b.mockTestId, b._max.score]));

  const latestAttempts = await prisma.testAttempt.findMany({
    where: { studentId, sourceType: AttemptSourceType.MOCK_TEST },
    orderBy: { startedAt: "desc" },
    select: { mockTestId: true, id: true, status: true },
  });
  const latestByMockTest = new Map<string, { id: string; status: AttemptStatus }>();
  for (const a of latestAttempts) {
    if (a.mockTestId && !latestByMockTest.has(a.mockTestId)) {
      latestByMockTest.set(a.mockTestId, { id: a.id, status: a.status });
    }
  }

  return mockTests.map((mt) => ({
    mockTest: mt,
    bestScore: bestByMockTest.get(mt.id) ?? null,
    latestAttempt: latestByMockTest.get(mt.id) ?? null,
  }));
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
// Live Tests
// ---------------------------------------------------------------------------

/**
 * Every Live Test that's been locked (SCHEDULED or later — never a DRAFT
 * still being configured), bucketed into the four student-facing sections
 * by DERIVED state, not the raw persisted status (see lib/live-test.ts).
 * CANCELLED tests are omitted entirely — nothing useful for a student to do
 * with one.
 */
export async function getLiveTestsForStudent(studentId: string) {
  const { deriveLiveTestState } = await import("@/lib/live-test");

  const liveTests = await prisma.liveTest.findMany({
    where: { status: { not: "DRAFT" } },
    orderBy: { startAt: "asc" },
    include: { exam: true },
  });

  const attempts = await prisma.testAttempt.findMany({
    where: { studentId, sourceType: AttemptSourceType.LIVE_TEST, liveTestId: { in: liveTests.map((l) => l.id) } },
    select: { liveTestId: true, id: true, status: true, score: true, maxScore: true },
  });
  const attemptByLiveTest = new Map(attempts.map((a) => [a.liveTestId, a]));

  const now = new Date();
  const upcoming: typeof liveTests = [];
  const live: typeof liveTests = [];
  const completed: typeof liveTests = [];
  const resultsAvailable: typeof liveTests = [];

  for (const lt of liveTests) {
    const state = deriveLiveTestState(lt, now);
    if (state === "CANCELLED") continue;
    if (state === "SCHEDULED") upcoming.push(lt);
    else if (state === "LIVE") live.push(lt);
    else if (state === "RESULT_PUBLISHED") resultsAvailable.push(lt);
    else completed.push(lt); // ENDED, result not yet published
  }

  const withAttempt = (rows: typeof liveTests) => rows.map((lt) => ({ liveTest: lt, attempt: attemptByLiveTest.get(lt.id) ?? null }));

  return {
    upcoming: withAttempt(upcoming),
    live: withAttempt(live),
    completed: withAttempt(completed),
    resultsAvailable: withAttempt(resultsAvailable),
  };
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
  reportType: "WRONG_ANSWER" | "WRONG_OPTION" | "TYPO" | "DUPLICATE" | "OTHER",
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

// ---------------------------------------------------------------------------
// Profile / Account
// ---------------------------------------------------------------------------

export async function updateStudentProfile(studentId: string, data: { name: string; bio: string }) {
  await prisma.$transaction([
    prisma.student.update({ where: { id: studentId }, data: { name: data.name } }),
    prisma.studentProfile.upsert({
      where: { studentId },
      update: { bio: data.bio || null },
      create: { studentId, bio: data.bio || null },
    }),
  ]);
  await logActivity(studentId, "PROFILE_UPDATED");
}

/** Idempotent — returns the existing pending request instead of creating a duplicate. */
export async function requestAccountDeletion(studentId: string, reason: string | undefined) {
  const existing = await prisma.deletionRequest.findFirst({
    where: { studentId, status: DeletionRequestStatus.PENDING },
  });
  if (existing) return existing;

  const [request] = await prisma.$transaction([
    prisma.deletionRequest.create({ data: { studentId, reason: reason || null } }),
    prisma.student.update({ where: { id: studentId }, data: { status: StudentStatus.DELETION_REQUESTED } }),
  ]);
  await logActivity(studentId, "DELETION_REQUESTED");
  return request;
}

export async function getPendingDeletionRequest(studentId: string) {
  return prisma.deletionRequest.findFirst({
    where: { studentId, status: DeletionRequestStatus.PENDING },
  });
}
