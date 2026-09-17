"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { QuestionDifficulty, QuestionSource, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { allocateQuestionCode, questionCodeScope, resolveQuestionCodeInput } from "@/lib/question-code";

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

const questionSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  examYear: z.string().optional().transform(val => val ? parseInt(val, 10) : undefined),
  subjectId: z.string().min(1, "Select a subject."),
  topicId: z.string().optional(),
  subTopicId: z.string().optional(),
  previousYearPaperId: z.string().optional(),
  source: z.nativeEnum(QuestionSource).optional(),
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

/**
 * Legacy random code — kept only as a fallback for the no-year edge case
 * (exam and linked paper both lack a year, so a canonical code can't be
 * built). New questions with a resolvable year get canonical codes via
 * lib/question-code.ts. Remove once the Question Bank UI requires a year.
 */
function legacyQuestionCode() {
  return `Q-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function parseQuestionForm(formData: FormData) {
  return questionSchema.safeParse({
    examId: formData.get("examId"),
    examYear: formData.get("examYear") || undefined,
    subjectId: formData.get("subjectId"),
    topicId: formData.get("topicId") || undefined,
    subTopicId: formData.get("subTopicId") || undefined,
    previousYearPaperId: formData.get("previousYearPaperId") || undefined,
    source: formData.get("source") || undefined,
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

type HierarchyDb = Pick<Prisma.TransactionClient, "subject" | "topic" | "subTopic">;

/**
 * Server-side guard against cross-exam hierarchy corruption (e.g. a question
 * for one exam referencing a Subject/Topic/SubTopic that belongs to another
 * exam). Bulk Import already enforces this via chained lookups; this mirrors
 * that check for the single-question create/edit path, which previously
 * trusted client-side dropdown filtering only.
 */
async function assertHierarchyConsistency(
  db: HierarchyDb,
  params: { examId: string; subjectId: string; topicId?: string | null; subTopicId?: string | null }
): Promise<string | null> {
  const subject = await db.subject.findUnique({ where: { id: params.subjectId }, select: { examId: true } });
  if (!subject) return "Selected subject was not found.";
  if (subject.examId !== params.examId) return "Selected subject does not belong to the selected exam.";

  if (params.topicId) {
    const topic = await db.topic.findUnique({ where: { id: params.topicId }, select: { subjectId: true } });
    if (!topic) return "Selected topic was not found.";
    if (topic.subjectId !== params.subjectId) return "Selected topic does not belong to the selected subject.";
  }

  if (params.subTopicId) {
    const subTopic = await db.subTopic.findUnique({ where: { id: params.subTopicId }, select: { topicId: true } });
    if (!subTopic) return "Selected sub-topic was not found.";
    if (!params.topicId || subTopic.topicId !== params.topicId) {
      return "Selected sub-topic does not belong to the selected topic.";
    }
  }

  return null;
}

async function upsertOptions(
  db: Pick<Prisma.TransactionClient, "questionOption">,
  questionId: string,
  data: z.infer<typeof questionSchema>
) {
  const textByLabel: Record<(typeof OPTION_LABELS)[number], string> = {
    A: data.optionA,
    B: data.optionB,
    C: data.optionC,
    D: data.optionD,
  };

  await db.questionOption.deleteMany({ where: { questionId } });
  await db.questionOption.createMany({
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

  const { examId, examYear, subjectId, topicId, subTopicId, previousYearPaperId, source, text, imageUrl, difficulty, status } =
    parsed.data;

  const hierarchyError = await assertHierarchyConsistency(prisma, { examId, subjectId, topicId, subTopicId });
  if (hierarchyError) return { error: hierarchyError };

  await prisma.$transaction(async (tx) => {
    const { examCode, examYear: resolvedYear } = await resolveQuestionCodeInput(tx, {
      examId,
      previousYearPaperId: previousYearPaperId || null,
    });

    // Use provided examYear if available, otherwise use resolved year
    const finalYear = examYear ?? resolvedYear;

    const code =
      finalYear !== null ? await allocateQuestionCode(tx, questionCodeScope(examCode, finalYear)) : legacyQuestionCode();

    const created = await tx.question.create({
      data: {
        code,
        examId,
        subjectId,
        topicId: topicId || null,
        subTopicId: subTopicId || null,
        previousYearPaperId: previousYearPaperId || null,
        text,
        imageUrl: imageUrl || null,
        difficulty,
        status,
        source: source || (previousYearPaperId ? QuestionSource.PYQ : QuestionSource.QUESTION_BANK),
        examYear: finalYear,
      },
    });

    await upsertOptions(tx, created.id, parsed.data);

    await tx.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "QUESTION_CREATED",
        entityType: "Question",
        entityId: created.id,
        metadata: { code: created.code },
      },
    });

    return created;
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

  const { examId, examYear, subjectId, topicId, subTopicId, previousYearPaperId, source, text, imageUrl, difficulty, status } =
    parsed.data;

  const hierarchyError = await assertHierarchyConsistency(prisma, { examId, subjectId, topicId, subTopicId });
  if (hierarchyError) return { error: hierarchyError };

  await prisma.$transaction(async (tx) => {
    const existing = await tx.question.findUnique({
      where: { id: questionId },
      select: { examYear: true }
    });

    await tx.question.update({
      where: { id: questionId },
      data: {
        examId,
        examYear: examYear ?? existing?.examYear ?? null,
        subjectId,
        topicId: topicId || null,
        subTopicId: subTopicId || null,
        previousYearPaperId: previousYearPaperId || null,
        source: source || (previousYearPaperId ? QuestionSource.PYQ : QuestionSource.QUESTION_BANK),
        text,
        imageUrl: imageUrl || null,
        difficulty,
        status,
      },
    });

    await upsertOptions(tx, questionId, parsed.data);

    await tx.auditLog.create({
      data: { actorId: session.user.id, action: "QUESTION_UPDATED", entityType: "Question", entityId: questionId },
    });
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
