"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { QuestionDifficulty, QuestionSource, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { allocateQuestionCode, questionCodeScope, resolveQuestionCodeInput } from "@/lib/question-code";
import { flagExplanationStaleIfExists } from "@/lib/ai-explanation";

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

/**
 * Options may be text-only, image-only, or both — never neither. The
 * per-field `min(1)` requirement that used to force every option to have
 * text was dropped in favor of the cross-field check in `.superRefine`
 * below, now that QuestionOption.imageUrl is a real, user-facing field.
 */
const questionSchema = z
  .object({
    examId: z.string().min(1, "Select an exam."),
    examYear: z.string().optional().transform(val => val ? parseInt(val, 10) : undefined),
    subjectId: z.string().min(1, "Select a subject."),
    topicId: z.string().optional(),
    subTopicId: z.string().optional(),
    previousYearPaperId: z.string().optional(),
    source: z.nativeEnum(QuestionSource).optional(),
    text: z.string().trim().min(3, "Question text is required."),
    imageUrl: z.string().trim().optional().default(""),
    difficulty: z.nativeEnum(QuestionDifficulty),
    status: z.nativeEnum(QuestionStatus),
    optionA: z.string().trim().optional().default(""),
    optionAImageUrl: z.string().trim().optional().default(""),
    optionB: z.string().trim().optional().default(""),
    optionBImageUrl: z.string().trim().optional().default(""),
    optionC: z.string().trim().optional().default(""),
    optionCImageUrl: z.string().trim().optional().default(""),
    optionD: z.string().trim().optional().default(""),
    optionDImageUrl: z.string().trim().optional().default(""),
    correctOption: z.enum(OPTION_LABELS),
    reviewRequired: z.string().optional(),
    reviewReason: z.string().trim().max(500).optional().default(""),
  })
  .superRefine((data, ctx) => {
    const pairs: [(typeof OPTION_LABELS)[number], string, string][] = [
      ["A", data.optionA, data.optionAImageUrl],
      ["B", data.optionB, data.optionBImageUrl],
      ["C", data.optionC, data.optionCImageUrl],
      ["D", data.optionD, data.optionDImageUrl],
    ];
    for (const [label, text, imageUrl] of pairs) {
      if (!text.trim() && !imageUrl.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Option ${label} needs text, an image, or both.`,
          path: [`option${label}`],
        });
      }
    }
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
    optionA: formData.get("optionA") || "",
    optionAImageUrl: formData.get("optionAImageUrl") || "",
    optionB: formData.get("optionB") || "",
    optionBImageUrl: formData.get("optionBImageUrl") || "",
    optionC: formData.get("optionC") || "",
    optionCImageUrl: formData.get("optionCImageUrl") || "",
    optionD: formData.get("optionD") || "",
    optionDImageUrl: formData.get("optionDImageUrl") || "",
    correctOption: formData.get("correctOption"),
    reviewRequired: formData.get("reviewRequired") || undefined,
    reviewReason: formData.get("reviewReason") || undefined,
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
  const byLabel: Record<(typeof OPTION_LABELS)[number], { text: string; imageUrl: string | null }> = {
    A: { text: data.optionA, imageUrl: data.optionAImageUrl || null },
    B: { text: data.optionB, imageUrl: data.optionBImageUrl || null },
    C: { text: data.optionC, imageUrl: data.optionCImageUrl || null },
    D: { text: data.optionD, imageUrl: data.optionDImageUrl || null },
  };

  await db.questionOption.deleteMany({ where: { questionId } });
  await db.questionOption.createMany({
    data: OPTION_LABELS.map((label, order) => ({
      questionId,
      label,
      text: byLabel[label].text,
      imageUrl: byLabel[label].imageUrl,
      isCorrect: data.correctOption === label,
      order,
    })),
  });
}

/** True if the question text or any option's text/correctness actually changed — see updateQuestionAction's cache-staleness flag. */
function hasMaterialQuestionChange(
  before: { text: string; options: { label: string; text: string; isCorrect: boolean }[] },
  data: z.infer<typeof questionSchema>
): boolean {
  if (before.text.trim() !== data.text.trim()) return true;
  const byLabel: Record<string, { text: string; isCorrect: boolean }> = {
    A: { text: data.optionA, isCorrect: data.correctOption === "A" },
    B: { text: data.optionB, isCorrect: data.correctOption === "B" },
    C: { text: data.optionC, isCorrect: data.correctOption === "C" },
    D: { text: data.optionD, isCorrect: data.correctOption === "D" },
  };
  if (before.options.length !== OPTION_LABELS.length) return true;
  return before.options.some((o) => {
    const next = byLabel[o.label];
    return !next || next.text.trim() !== o.text.trim() || next.isCorrect !== o.isCorrect;
  });
}

export async function createQuestionAction(
  _prev: QuestionFormState,
  formData: FormData
): Promise<QuestionFormState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  const parsed = parseQuestionForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const {
    examId,
    examYear,
    subjectId,
    topicId,
    subTopicId,
    previousYearPaperId,
    source,
    text,
    imageUrl,
    difficulty,
    status,
    reviewRequired,
    reviewReason,
  } = parsed.data;

  const hierarchyError = await assertHierarchyConsistency(prisma, { examId, subjectId, topicId, subTopicId });
  if (hierarchyError) return { error: hierarchyError };

  const isReviewRequired = reviewRequired === "on";

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
        reviewRequired: isReviewRequired,
        reviewReason: isReviewRequired ? reviewReason || null : null,
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

  const {
    examId,
    examYear,
    subjectId,
    topicId,
    subTopicId,
    previousYearPaperId,
    source,
    text,
    imageUrl,
    difficulty,
    status,
    reviewRequired,
    reviewReason,
  } = parsed.data;

  const hierarchyError = await assertHierarchyConsistency(prisma, { examId, subjectId, topicId, subTopicId });
  if (hierarchyError) return { error: hierarchyError };

  const isReviewRequired = reviewRequired === "on";

  // Snapshot text/options BEFORE the update to detect a material change for
  // the AI explanation cache-staleness flag (see flagExplanationStaleIfExists)
  // — upsertOptions always deletes+recreates option rows on every save, so
  // comparing DB state after the write can't tell "changed" from "rewritten
  // unchanged".
  const before = await prisma.question.findUnique({
    where: { id: questionId },
    select: { text: true, options: { select: { label: true, text: true, isCorrect: true }, orderBy: { label: "asc" } } },
  });

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
        reviewRequired: isReviewRequired,
        reviewReason: isReviewRequired ? reviewReason || null : null,
      },
    });

    await upsertOptions(tx, questionId, parsed.data);

    await tx.auditLog.create({
      data: { actorId: session.user.id, action: "QUESTION_UPDATED", entityType: "Question", entityId: questionId },
    });
  });

  if (before && hasMaterialQuestionChange(before, parsed.data)) {
    await flagExplanationStaleIfExists(questionId);
  }

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
