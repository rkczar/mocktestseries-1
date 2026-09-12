import "server-only";
import {
  AnswerStatus,
  AttemptSourceType,
  AttemptStatus,
  CustomModuleStatus,
  MockTestStatus,
  QuestionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/student-data";

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

async function createAttemptFromQuestions(params: {
  studentId: string;
  sourceType: AttemptSourceType;
  examId: string;
  mockTestId?: string;
  customModuleId?: string;
  previousYearPaperId?: string;
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
      examId: params.examId,
      mockTestId: params.mockTestId,
      customModuleId: params.customModuleId,
      previousYearPaperId: params.previousYearPaperId,
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
    questions: mockTest.questions.map((mq) => mq.question),
  });
}

export async function startCustomModuleAttempt(studentId: string, moduleId: string) {
  const resumable = await findResumableAttempt(studentId, { customModuleId: moduleId });
  if (resumable) return resumable;

  const customModule = await prisma.customModule.findFirst({
    where: { id: moduleId, status: { in: [CustomModuleStatus.PUBLISHED, CustomModuleStatus.ACTIVE] } },
    include: { questions: { orderBy: { order: "asc" }, include: { question: { include: { options: true } } } } },
  });
  if (!customModule) throw new Error("This custom module is not available.");

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.CUSTOM_MODULE,
    examId: customModule.examId,
    customModuleId: customModule.id,
    durationMinutes: customModule.durationMinutes ?? 30,
    negativeMarking: customModule.negativeMarking,
    questions: customModule.questions.map((mq) => mq.question),
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
    questions,
  });
}

export function remainingSecondsFor(attempt: { durationMinutes: number; startedAt: Date }) {
  const elapsedSeconds = Math.floor((Date.now() - attempt.startedAt.getTime()) / 1000);
  return Math.max(attempt.durationMinutes * 60 - elapsedSeconds, 0);
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
  const timeTakenSeconds = Math.round((Date.now() - attempt.startedAt.getTime()) / 1000);

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
