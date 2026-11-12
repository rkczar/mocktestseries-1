"use server";

import { revalidatePath } from "next/cache";
import { Prisma, QuestionSource, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { allocateQuestionCode, questionCodeScope, resolveQuestionCodeInput } from "@/lib/question-code";
import { flagExplanationStaleIfExists } from "@/lib/ai-explanation";
import { publishRefusal } from "@/lib/question-publish-policy";
import {
  assertHierarchyConsistency,
  hasMaterialQuestionChange,
  legacyQuestionCode,
  matchSpecFromForm,
  orphanListImages,
  parseQuestionForm,
  publishAfterSave,
  PublishRefusedError,
  upsertOptions,
} from "@/lib/question-form-core";

export interface QuestionFormState {
  error?: string;
  success?: boolean;
}

const WITHDRAWN_ONLY_KEPT = "WITHDRAWN is set only by the AI importer (Add to paper as WITHDRAWN); choose another status.";

export async function createQuestionAction(
  _prev: QuestionFormState,
  formData: FormData
): Promise<QuestionFormState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  const parsed = parseQuestionForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  if (parsed.data.status === "WITHDRAWN") return { error: WITHDRAWN_ONLY_KEPT };

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
    excludeFromPractice,
    excludeFromPracticeReason,
  } = parsed.data;

  const hierarchyError = await assertHierarchyConsistency(prisma, { examId, subjectId, topicId, subTopicId });
  if (hierarchyError) return { error: hierarchyError };
  const match = await matchSpecFromForm(parsed.data, null);
  if (match.error) return { error: match.error };

  const isReviewRequired = reviewRequired === "on";
  // Publishing policy (lib/question-publish-policy.ts): a question flagged for
  // review is never published — clear the flag first.
  if (status === QuestionStatus.PUBLISHED && isReviewRequired) {
    return { error: "A question flagged for review can't be published. Untick Review Required (after reviewing it) or save it as Draft." };
  }

  const publishNow = status === QuestionStatus.PUBLISHED;
  try {
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
        status: publishNow ? QuestionStatus.DRAFT : status,
        source: source || (previousYearPaperId ? QuestionSource.PYQ : QuestionSource.QUESTION_BANK),
        examYear: finalYear,
        reviewRequired: isReviewRequired,
        reviewReason: isReviewRequired ? reviewReason || null : null,
        excludeFromPractice: excludeFromPractice === "on",
        excludeFromPracticeReason: excludeFromPractice === "on" ? excludeFromPracticeReason || null : null,
        questionType: parsed.data.questionType,
        matchSpec: match.spec ? (match.spec as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });

    await upsertOptions(tx, created.id, parsed.data);
    if (publishNow) await publishAfterSave(tx, created.id);

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
  } catch (err) {
    if (err instanceof PublishRefusedError) return { error: `${err.message} Save it as Draft, or fix it first.` };
    throw err;
  }

  revalidatePath("/admin/questions");
  return { success: true };
}

// Retired questions are read-only (docs/QUESTION-RETIREMENT.md): never edited,
// never re-published. Rollback of the replacement is the only way back.
const RETIRED_READ_ONLY = "This question is retired and read-only. Edit its replacement instead.";
async function isRetiredQuestion(questionId: string): Promise<boolean> {
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { retiredAt: true } });
  return !!q?.retiredAt;
}

export async function updateQuestionAction(
  questionId: string,
  _prev: QuestionFormState,
  formData: FormData
): Promise<QuestionFormState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  if (await isRetiredQuestion(questionId)) return { error: RETIRED_READ_ONLY };
  const parsed = parseQuestionForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  // WITHDRAWN is set only by the importer's Master Admin action (audited); the form can keep it, never newly set it.
  if (parsed.data.status === "WITHDRAWN" && (await prisma.question.findUnique({ where: { id: questionId }, select: { status: true } }))?.status !== "WITHDRAWN") return { error: WITHDRAWN_ONLY_KEPT };

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
    excludeFromPractice,
    excludeFromPracticeReason,
  } = parsed.data;

  const hierarchyError = await assertHierarchyConsistency(prisma, { examId, subjectId, topicId, subTopicId });
  if (hierarchyError) return { error: hierarchyError };
  const match = await matchSpecFromForm(parsed.data, questionId);
  if (match.error) return { error: match.error };
  const orphans = await orphanListImages(questionId, match.spec);
  if (orphans.length) return { error: `Remove the list image for ${orphans[0]} first (its entry is no longer in the list).` };

  const isReviewRequired = reviewRequired === "on";

  // Snapshot text/options BEFORE the update to detect a material change for
  // the AI explanation cache-staleness flag (see flagExplanationStaleIfExists)
  // — upsertOptions always deletes+recreates option rows on every save, so
  // comparing DB state after the write can't tell "changed" from "rewritten
  // unchanged".
  const before = await prisma.question.findUnique({
    where: { id: questionId },
    select: { text: true, questionType: true, status: true, options: { select: { label: true, text: true, isCorrect: true }, orderBy: { label: "asc" } } },
  });

  // Publishing policy (lib/question-publish-policy.ts): only the transition
  // INTO Published is gated, so editing an already-published question keeps working.
  if (status === QuestionStatus.PUBLISHED && before?.status !== QuestionStatus.PUBLISHED && isReviewRequired) {
    return { error: "A question flagged for review can't be published. Untick Review Required (after reviewing it) or save it as Draft." };
  }

  // Only the transition INTO Published runs the full policy (no retroactive unpublishing).
  const publishNow = !!before && status === QuestionStatus.PUBLISHED && before.status !== QuestionStatus.PUBLISHED;
  try {
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
        status: publishNow ? before!.status : status,
        reviewRequired: isReviewRequired,
        reviewReason: isReviewRequired ? reviewReason || null : null,
        excludeFromPractice: excludeFromPractice === "on",
        excludeFromPracticeReason: excludeFromPractice === "on" ? excludeFromPracticeReason || null : null,
        questionType: parsed.data.questionType,
        matchSpec: match.spec ? (match.spec as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });

    await upsertOptions(tx, questionId, parsed.data);
    if (publishNow) await publishAfterSave(tx, questionId);

    await tx.auditLog.create({
      data: { actorId: session.user.id, action: "QUESTION_UPDATED", entityType: "Question", entityId: questionId },
    });
  });
  } catch (err) {
    if (err instanceof PublishRefusedError) return { error: `${err.message} Nothing was saved — save it as Draft, or fix it first.` };
    throw err;
  }

  if (before && hasMaterialQuestionChange(before, parsed.data)) {
    await flagExplanationStaleIfExists(questionId);
  }

  revalidatePath("/admin/questions");
  revalidatePath(`/admin/questions/add?id=${questionId}`);
  return { success: true };
}

export async function setQuestionStatusAction(questionId: string, status: QuestionStatus): Promise<{ error?: string } | void> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  if (await isRetiredQuestion(questionId)) return { error: RETIRED_READ_ONLY };
  if (status === QuestionStatus.PUBLISHED) {
    const refusal = await publishRefusal(questionId);
    if (refusal) return { error: refusal };
  }
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
