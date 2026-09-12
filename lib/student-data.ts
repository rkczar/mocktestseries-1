import "server-only";
import {
  AttemptSourceType,
  AttemptStatus,
  CustomModuleStatus,
  DeletionRequestStatus,
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

  const [mockTests, customModules] = await Promise.all([
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
  ]);

  return { exam, mockTests, customModules };
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

export async function getCustomModuleDetailForStudent(moduleId: string, studentId: string) {
  const customModule = await prisma.customModule.findFirst({
    where: { id: moduleId, status: { in: VISIBLE_CUSTOM_MODULE_STATUSES } },
    include: { exam: true, _count: { select: { questions: true } } },
  });
  if (!customModule) return null;

  const attempts = await prisma.testAttempt.findMany({
    where: { studentId, customModuleId: moduleId },
    orderBy: { startedAt: "desc" },
  });

  return { module: customModule, attempts };
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
    include: { exam: true, mockTest: true, customModule: true, previousYearPaper: true },
  });
}

/** Ownership-checked attempt fetch — returns null (never another student's row) if not owned by studentId. */
export async function getOwnedAttempt(attemptId: string, studentId: string) {
  return prisma.testAttempt.findFirst({
    where: { id: attemptId, studentId },
    include: {
      exam: true,
      mockTest: true,
      customModule: true,
      previousYearPaper: true,
      questions: { orderBy: { order: "asc" }, include: { answer: true } },
    },
  });
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
