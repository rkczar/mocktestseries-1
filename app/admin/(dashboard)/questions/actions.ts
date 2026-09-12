"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { QuestionDifficulty, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

const questionSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  subjectId: z.string().min(1, "Select a subject."),
  topicId: z.string().optional(),
  subTopicId: z.string().optional(),
  previousYearPaperId: z.string().optional(),
  text: z.string().trim().min(3, "Question text is required."),
  imageUrl: z.string().trim().optional(),
  difficulty: z.nativeEnum(QuestionDifficulty),
  status: z.nativeEnum(QuestionStatus),
  optionA: z.string().trim().min(1, "Option A is required."),
  optionB: z.string().trim().min(1, "Option B is required."),
  optionC: z.string().trim().min(1, "Option C is required."),
  optionD: z.string().trim().min(1, "Option D is required."),
  correctOption: z.enum(OPTION_LABELS),
});

export interface QuestionFormState {
  error?: string;
  success?: boolean;
}

function generateQuestionCode() {
  return `Q-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function parseQuestionForm(formData: FormData) {
  return questionSchema.safeParse({
    examId: formData.get("examId"),
    subjectId: formData.get("subjectId"),
    topicId: formData.get("topicId") || undefined,
    subTopicId: formData.get("subTopicId") || undefined,
    previousYearPaperId: formData.get("previousYearPaperId") || undefined,
    text: formData.get("text"),
    imageUrl: formData.get("imageUrl") || undefined,
    difficulty: formData.get("difficulty"),
    status: formData.get("status"),
    optionA: formData.get("optionA"),
    optionB: formData.get("optionB"),
    optionC: formData.get("optionC"),
    optionD: formData.get("optionD"),
    correctOption: formData.get("correctOption"),
  });
}

async function upsertOptions(questionId: string, data: z.infer<typeof questionSchema>) {
  const textByLabel: Record<(typeof OPTION_LABELS)[number], string> = {
    A: data.optionA,
    B: data.optionB,
    C: data.optionC,
    D: data.optionD,
  };

  await prisma.questionOption.deleteMany({ where: { questionId } });
  await prisma.questionOption.createMany({
    data: OPTION_LABELS.map((label, order) => ({
      questionId,
      label,
      text: textByLabel[label],
      isCorrect: data.correctOption === label,
      order,
    })),
  });
}

export async function createQuestionAction(
  _prev: QuestionFormState,
  formData: FormData
): Promise<QuestionFormState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  const parsed = parseQuestionForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { examId, subjectId, topicId, subTopicId, previousYearPaperId, text, imageUrl, difficulty, status } =
    parsed.data;

  const question = await prisma.question.create({
    data: {
      code: generateQuestionCode(),
      examId,
      subjectId,
      topicId: topicId || null,
      subTopicId: subTopicId || null,
      previousYearPaperId: previousYearPaperId || null,
      text,
      imageUrl: imageUrl || null,
      difficulty,
      status,
    },
  });

  await upsertOptions(question.id, parsed.data);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "QUESTION_CREATED",
      entityType: "Question",
      entityId: question.id,
      metadata: { code: question.code },
    },
  });

  revalidatePath("/admin/questions");
  return { success: true };
}

export async function updateQuestionAction(
  questionId: string,
  _prev: QuestionFormState,
  formData: FormData
): Promise<QuestionFormState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  const parsed = parseQuestionForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { examId, subjectId, topicId, subTopicId, previousYearPaperId, text, imageUrl, difficulty, status } =
    parsed.data;

  await prisma.question.update({
    where: { id: questionId },
    data: {
      examId,
      subjectId,
      topicId: topicId || null,
      subTopicId: subTopicId || null,
      previousYearPaperId: previousYearPaperId || null,
      text,
      imageUrl: imageUrl || null,
      difficulty,
      status,
    },
  });

  await upsertOptions(questionId, parsed.data);

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "QUESTION_UPDATED", entityType: "Question", entityId: questionId },
  });

  revalidatePath("/admin/questions");
  revalidatePath(`/admin/questions/add?id=${questionId}`);
  return { success: true };
}

export async function setQuestionStatusAction(questionId: string, status: QuestionStatus) {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  await prisma.question.update({ where: { id: questionId }, data: { status } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "QUESTION_STATUS_CHANGED",
      entityType: "Question",
      entityId: questionId,
      metadata: { status },
    },
  });
  revalidatePath("/admin/questions");
}
