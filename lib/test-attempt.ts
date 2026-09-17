import "server-only";
import {
  AnswerStatus,
  AttemptSourceType,
  AttemptStatus,
  CustomModuleStatus,
  GrandTestStatus,
  MockTestStatus,
  QuestionStatus,
  TestType,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/student-data";
import { isExpired, elapsedSecondsFor, remainingSecondsFor } from "@/lib/attempt-timing";
import { selectPublishedQuestions, type QuestionSelectionFilters, InsufficientQuestionsError } from "@/lib/question-selection";

export { remainingSecondsFor, InsufficientQuestionsError };
export type { QuestionSelectionFilters } from "@/lib/question-selection";

export interface QuestionSnapshot {
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null }[];
  correctLabel: string;
}

export interface QuestionWithOptions {
  id: string;
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean }[];
}

/** Legacy source-grouping → production-facing test type, kept in one place. */
const TEST_TYPE_BY_SOURCE: Record<AttemptSourceType, TestType> = {
  [AttemptSourceType.MOCK_TEST]: TestType.FULL_MOCK,
  [AttemptSourceType.PREVIOUS_YEAR_PAPER]: TestType.PREVIOUS_YEAR_PAPER,
  [AttemptSourceType.CUSTOM_MODULE]: TestType.CUSTOM_MODULE,
  [AttemptSourceType.SUBJECT_TEST]: TestType.SUBJECT_TEST,
  [AttemptSourceType.GRAND_TEST]: TestType.GRAND_TEST,
};

function toSnapshot(question: QuestionWithOptions): QuestionSnapshot {
  return {
    code: question.code,
    text: question.text,
    imageUrl: question.imageUrl,
    difficulty: question.difficulty,
    options: question.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
    correctLabel: question.options.find((o) => o.isCorrect)?.label ?? "",
  };
}

/**
 * Create a TestAttempt from an already-resolved, fixed question set, then
 * freeze every question/option into TestAttemptQuestion.questionSnapshot and
 * seed an UNANSWERED Answer per question. The set is persisted verbatim at
 * start time and never re-resolved or reshuffled on resume. Also acts as a
 * guardrail so a test with no questions can never be started.
 */
async function createAttemptFromQuestions(params: {
  studentId: string;
  sourceType: AttemptSourceType;
  examId: string;
  mockTestId?: string;
  customModuleId?: string;
  previousYearPaperId?: string;
  grandTestId?: string;
  subjectId?: string;
  topicIds?: string[];
  selection?: Record<string, unknown> | null;
  testType?: TestType;
  durationMinutes: number;
  negativeMarking: number;
  questions: QuestionWithOptions[];
}) {
  if (params.questions.length === 0) {
    throw new Error("This test has no questions yet. Please try again later.");
  }

  const attempt = await prisma.testAttempt.create({
    data: {
      studentId: params.studentId,
      sourceType: params.sourceType,
      testType: params.testType ?? TEST_TYPE_BY_SOURCE[params.sourceType],
      examId: params.examId,
      mockTestId: params.mockTestId,
      customModuleId: params.customModuleId,
      previousYearPaperId: params.previousYearPaperId,
      grandTestId: params.grandTestId,
      subjectId: params.subjectId,
      topicIds: params.topicIds && params.topicIds.length > 0 ? params.topicIds : undefined,
      selection: (params.selection ?? undefined) as Prisma.InputJsonValue | undefined,
      durationMinutes: params.durationMinutes,
      negativeMarking: params.negativeMarking,
      totalQuestions: params.questions.length,
    },
  });

  await prisma.$transaction(
    params.questions.map((q, order) =>
      prisma.testAttemptQuestion.create({
        data: {
          attemptId: attempt.id,
          questionId: q.id,
          order,
          questionSnapshot: toSnapshot(q) as never,
          answer: {
            create: {
              attemptId: attempt.id,
              studentId: params.studentId,
              questionId: q.id,
              status: AnswerStatus.UNANSWERED,
            },
          },
        },
      })
    )
  );

  await logActivity(params.studentId, "TEST_STARTED", { attemptId: attempt.id, sourceType: params.sourceType });
  return attempt;
}

async function findResumableAttempt(studentId: string, where: Record<string, unknown>) {
  return prisma.testAttempt.findFirst({
    where: { studentId, status: AttemptStatus.IN_PROGRESS, ...where },
    orderBy: { startedAt: "desc" },
  });
}

export async function startMockTestAttempt(studentId: string, mockTestId: string) {
  const resumable = await findResumableAttempt(studentId, { mockTestId });
  if (resumable) return resumable;

  const mockTest = await prisma.mockTest.findFirst({
    where: { id: mockTestId, status: MockTestStatus.PUBLISHED },
    include: { questions: { orderBy: { order: "asc" }, include: { question: { include: { options: true } } } } },
  });
  if (!mockTest) throw new Error("This mock test is not available.");

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.MOCK_TEST,
    examId: mockTest.examId,
    mockTestId: mockTest.id,
    durationMinutes: mockTest.durationMinutes,
    negativeMarking: mockTest.negativeMarking,
    questions: mockTest.questions.map((mq) => mq.question as unknown as QuestionWithOptions),
  });
}

const CUSTOM_MODULE_QUESTIONS_INCLUDE = {
  questions: { orderBy: { order: "asc" as const }, include: { question: { include: { options: true } } } },
};

type CustomModuleWithQuestions = Awaited<
  ReturnType<typeof prisma.customModule.findFirstOrThrow<{ include: typeof CUSTOM_MODULE_QUESTIONS_INCLUDE }>>
>;

async function startFromCustomModuleRow(studentId: string, customModule: CustomModuleWithQuestions) {
  const resumable = await findResumableAttempt(studentId, { customModuleId: customModule.id });
  if (resumable) return resumable;

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.CUSTOM_MODULE,
    examId: customModule.examId,
    customModuleId: customModule.id,
    durationMinutes: customModule.durationMinutes ?? 30,
    negativeMarking: customModule.negativeMarking,
    questions: customModule.questions.map((mq) => mq.question as unknown as QuestionWithOptions),
  });
}

/**
 * A student-owned Custom Module V2 (isStudentOwned) is private to its
 * creator through this path — the `OR` clause is the entire enforcement
 * point, so a student can never start another student's private module just
 * by guessing/enumerating its id. Sharing is handled separately, by
 * shareToken, never by id (see startSharedCustomModuleAttempt).
 */
export async function startCustomModuleAttempt(studentId: string, moduleId: string) {
  const customModule = await prisma.customModule.findFirst({
    where: {
      id: moduleId,
      status: { in: [CustomModuleStatus.PUBLISHED, CustomModuleStatus.ACTIVE] },
      OR: [{ isStudentOwned: false }, { createdByStudentId: studentId }],
    },
    include: CUSTOM_MODULE_QUESTIONS_INCLUDE,
  });
  if (!customModule) throw new Error("This custom module is not available.");
  return startFromCustomModuleRow(studentId, customModule);
}

/**
 * Start (or resume) an attempt against a module the student reached via its
 * unguessable share link rather than ownership — the token itself is the
 * authorization, so any signed-in student holding it may start their own
 * independent attempt against the same fixed question set.
 */
export async function startSharedCustomModuleAttempt(studentId: string, shareToken: string) {
  const customModule = await prisma.customModule.findFirst({
    where: { shareToken, status: { in: [CustomModuleStatus.PUBLISHED, CustomModuleStatus.ACTIVE] } },
    include: CUSTOM_MODULE_QUESTIONS_INCLUDE,
  });
  if (!customModule) throw new Error("This shared module link is invalid or no longer available.");
  return startFromCustomModuleRow(studentId, customModule);
}

/**
 * Generate (or resume) a GRAND_TEST attempt from a Grand Test's already
 * publish-time-resolved, immutable GrandTestQuestion set. Every student who
 * starts the same Grand Test gets the exact same question set/order — the
 * blueprint is resolved once at publish, never per-student and never here.
 */
export async function startGrandTestAttempt(studentId: string, grandTestId: string) {
  const resumable = await findResumableAttempt(studentId, { grandTestId });
  if (resumable) return resumable;

  const grandTest = await prisma.grandTest.findFirst({
    where: { id: grandTestId, status: GrandTestStatus.PUBLISHED },
    include: { questions: { orderBy: { order: "asc" }, include: { question: { include: { options: true } } } } },
  });
  if (!grandTest) throw new Error("This grand test is not available.");

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.GRAND_TEST,
    testType: TestType.GRAND_TEST,
    examId: grandTest.examId,
    grandTestId: grandTest.id,
    durationMinutes: grandTest.durationMinutes,
    negativeMarking: grandTest.negativeMarking,
    questions: grandTest.questions.map((gq) => gq.question as unknown as QuestionWithOptions),
  });
}

export async function startPreviousYearPaperAttempt(studentId: string, paperId: string) {
  const resumable = await findResumableAttempt(studentId, { previousYearPaperId: paperId });
  if (resumable) return resumable;

  const paper = await prisma.previousYearPaper.findFirst({
    where: { id: paperId, isActive: true },
    include: { exam: true },
  });
  if (!paper) throw new Error("This paper is not available.");

  const questions = await prisma.question.findMany({
    where: { previousYearPaperId: paperId, status: QuestionStatus.PUBLISHED },
    include: { options: true },
  });

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.PREVIOUS_YEAR_PAPER,
    examId: paper.examId,
    previousYearPaperId: paper.id,
    durationMinutes: paper.exam.durationMinutes ?? 60,
    negativeMarking: paper.exam.negativeMarking ?? 0,
    questions: questions as unknown as QuestionWithOptions[],
  });
}

export interface SubjectTestSelection extends QuestionSelectionFilters {
  durationMinutes: number;
  count: number;
}

/**
 * Generate (or resume) a SUBJECT_TEST attempt.
 *
 * The question set is resolved on the server from validated filters, then
 * frozen into the attempt at start. If the student already has an IN_PROGRESS
 * subject test for the same subject, that attempt is returned untouched —
 * resume never re-selects or re-shuffles. `durationMinutes` is authoritative
 * for the server-side window (see lib/attempt-timing.ts).
 */
export async function startSubjectTestAttempt(studentId: string, selection: SubjectTestSelection) {
  const resumable = await findResumableAttempt(studentId, { testType: TestType.SUBJECT_TEST, subjectId: selection.subjectId });
  if (resumable) return resumable;
  if (!selection.subjectId) throw new Error("A subject is required to start a subject test.");
  if (!selection.examId) throw new Error("An exam is required to start a subject test.");

  const { questions } = await selectPublishedQuestions({
    examId: selection.examId,
    year: selection.year,
    subjectId: selection.subjectId,
    topicId: selection.topicId,
    subTopicId: selection.subTopicId,
    source: selection.source,
    difficulty: selection.difficulty,
    count: selection.count,
  });

  const subject = await prisma.subject.findUnique({ where: { id: selection.subjectId }, select: { name: true } });

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.SUBJECT_TEST,
    examId: selection.examId,
    subjectId: selection.subjectId,
    topicIds: selection.topicId ? [selection.topicId] : undefined,
    selection: {
      year: selection.year ?? null,
      source: selection.source ?? null,
      difficulty: selection.difficulty ?? null,
      subTopicIds: selection.subTopicId ? [selection.subTopicId] : null,
      subjects: [{ id: selection.subjectId, name: subject?.name ?? null }],
    },
    durationMinutes: selection.durationMinutes,
    negativeMarking: 0,
    questions: questions as unknown as QuestionWithOptions[],
  });
}

export async function saveAnswer(
  attemptId: string,
  studentId: string,
  questionId: string,
  selectedOptionLabel: string | null,
  markForReview: boolean
) {
  const attempt = await prisma.testAttempt.findFirst({ where: { id: attemptId, studentId, status: AttemptStatus.IN_PROGRESS } });
  if (!attempt) throw new Error("This attempt is not available for editing.");

  if (isExpired(attempt)) {
    throw new Error("Time is up — this test has ended and answers can no longer be changed.");
  }

  const attemptQuestion = await prisma.testAttemptQuestion.findFirst({ where: { attemptId, questionId } });
  if (!attemptQuestion) throw new Error("Question does not belong to this attempt.");

  const status: AnswerStatus = selectedOptionLabel
    ? markForReview
      ? AnswerStatus.ANSWERED_AND_MARKED
      : AnswerStatus.ANSWERED
    : markForReview
      ? AnswerStatus.MARKED_FOR_REVIEW
      : AnswerStatus.UNANSWERED;

  await prisma.answer.update({
    where: { attemptQuestionId: attemptQuestion.id },
    data: { selectedOptionLabel, status, answeredAt: selectedOptionLabel ? new Date() : null },
  });
}

export async function submitAttempt(attemptId: string, studentId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, studentId },
    include: { questions: { include: { answer: true } } },
  });
  if (!attempt) throw new Error("Attempt not found.");
  if (attempt.status === AttemptStatus.SUBMITTED) return attempt;

  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  const updates = attempt.questions.map((tq) => {
    const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
    const answer = tq.answer;
    const selected = answer?.selectedOptionLabel ?? null;
    let isCorrect: boolean | null = null;

    if (!selected) {
      unansweredCount += 1;
    } else if (selected === snapshot.correctLabel) {
      isCorrect = true;
      correctCount += 1;
    } else {
      isCorrect = false;
      incorrectCount += 1;
    }

    return answer
      ? prisma.answer.update({ where: { id: answer.id }, data: { isCorrect } })
      : prisma.answer.create({
          data: { attemptId, attemptQuestionId: tq.id, studentId, questionId: tq.questionId, isCorrect, status: AnswerStatus.UNANSWERED },
        });
  });

  const score = correctCount * 1 - incorrectCount * attempt.negativeMarking;
  const maxScore = attempt.totalQuestions;
  // Late submits stay valid, but the reported time can never exceed the window:
  // answers could not have been changed after effectiveEnd, so capping is honest.
  const timeTakenSeconds = elapsedSecondsFor(attempt);

  await prisma.$transaction([
    ...updates,
    prisma.testAttempt.update({
      where: { id: attemptId },
      data: {
        status: AttemptStatus.SUBMITTED,
        submittedAt: new Date(),
        correctCount,
        incorrectCount,
        unansweredCount,
        score,
        maxScore,
        timeTakenSeconds,
      },
    }),
  ]);

  await logActivity(studentId, "TEST_SUBMITTED", { attemptId, score, maxScore });

  return prisma.testAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}