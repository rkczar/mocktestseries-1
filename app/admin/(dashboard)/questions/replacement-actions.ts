"use server";

import { revalidatePath, updateTag } from "next/cache";
import { Prisma, QuestionSource, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { allocateQuestionCode, questionCodeScope } from "@/lib/question-code";
import { applyReplacement, previewReplacement, ReplacementError } from "@/lib/question-replacement/apply";
import { rollbackReplacement } from "@/lib/question-replacement/rollback";
import type { ReplacementSummary } from "@/lib/question-replacement/plan";

/**
 * Admin → Question → Retire / Replace (docs/QUESTION-RETIREMENT.md).
 * Preview: QUESTIONS_MANAGE. Apply and rollback change student attempts, so
 * they are MASTER_ADMIN only (same rule as permanent test deletion).
 */

/** Same fallback as the Question Bank form when neither exam nor paper has a year. */
function legacyQuestionCode() {
  return `Q-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

async function requireMasterAdmin() {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
  if (session.user.role !== "MASTER_ADMIN") throw new UnauthorizedError("Only the Master Admin can retire or replace questions.");
  return session;
}

function failure(error: unknown): { ok: false; error: string; details: string[] } {
  if (error instanceof ReplacementError) return { ok: false, error: error.message, details: error.details };
  if (error instanceof UnauthorizedError) return { ok: false, error: error.message, details: [] };
  console.error("[question-replacement]", error instanceof Error ? error.message : error);
  return { ok: false, error: "Something went wrong — nothing was changed.", details: [] };
}

/** Resolves a replacement typed as an id or a question code. */
async function resolveQuestionRef(ref: string | null): Promise<string | null> {
  const v = ref?.trim();
  if (!v) return null;
  const q = await prisma.question.findFirst({ where: { OR: [{ id: v }, { code: v }] }, select: { id: true } });
  if (!q) throw new ReplacementError(`No question with id or code "${v}".`);
  return q.id;
}

export interface PreviewReference {
  kind: string;
  title: string;
  studentOwned: boolean;
  position: number;
  action: "SWAP" | "SKIP" | "HOLD";
  note: string | null;
  questionCode: string;
}

export type PreviewResult =
  | {
      ok: true;
      newQuestionId: string | null;
      newQuestionCode: string | null;
      summary: ReplacementSummary;
      errors: string[];
      references: PreviewReference[];
      variants: string[];
    }
  | { ok: false; error: string; details: string[] };

export async function previewReplacementAction(oldQuestionId: string, replacementRef: string | null): Promise<PreviewResult> {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const newQuestionId = await resolveQuestionRef(replacementRef);
    const { plan, summary } = await previewReplacement([{ oldQuestionId, newQuestionId }]);
    const codes = new Map<string, string>([
      ...plan.pairs.map((p) => [p.old.id, p.old.code] as [string, string]),
      ...plan.variants.map((v) => [v.id, v.code] as [string, string]),
    ]);
    return {
      ok: true,
      newQuestionId,
      newQuestionCode: plan.pairs[0]?.new?.code ?? null,
      summary,
      errors: plan.errors,
      references: plan.references.map((r) => ({
        kind: r.containerKind,
        title: r.containerTitle,
        studentOwned: r.studentOwned,
        position: r.position,
        action: r.action,
        note: r.note,
        questionCode: codes.get(r.oldQuestionId) ?? r.oldQuestionId,
      })),
      variants: plan.variants.map((v) => v.code),
    };
  } catch (error) {
    return failure(error);
  }
}

function revalidateAfterChange(paperIds: (string | null)[]) {
  revalidatePath("/admin/questions");
  revalidatePath("/admin/exams/previous-year-papers");
  for (const id of paperIds) if (id) revalidatePath(`/admin/exams/previous-year-papers/${id}`);
  revalidatePath("/student/dashboard");
  revalidatePath("/exams/[slug]/previous-year-papers/[year]", "page");
  // Public cached aggregates that count published PYQ questions.
  updateTag("exam-pyq-insights");
  updateTag("exam-pyq-analysis-meta");
  updateTag("homepage-statistics");
}

export async function applyReplacementAction(input: {
  oldQuestionId: string;
  newQuestionId: string | null;
  reason: string;
  expectedHash: string;
  confirmCode: string;
}): Promise<{ ok: true; replacementId: string; attemptsInvalidated: number } | { ok: false; error: string; details: string[] }> {
  try {
    const session = await requireMasterAdmin();
    const old = await prisma.question.findUnique({ where: { id: input.oldQuestionId }, select: { code: true, previousYearPaperId: true } });
    if (!old) throw new ReplacementError("Question not found.");
    if (input.confirmCode.trim() !== old.code) throw new ReplacementError(`Type the question code ${old.code} to confirm.`);
    const result = await applyReplacement({
      pairs: [{ oldQuestionId: input.oldQuestionId, newQuestionId: input.newQuestionId }],
      reason: input.reason,
      actor: { adminId: session.user.id!, source: "ADMIN" },
      expectedHash: input.expectedHash,
    });
    revalidateAfterChange([old.previousYearPaperId]);
    return { ok: true, replacementId: result.replacementId, attemptsInvalidated: result.attemptsInvalidated };
  } catch (error) {
    return failure(error);
  }
}

export async function rollbackReplacementAction(replacementId: string): Promise<{ ok: true; message: string } | { ok: false; error: string; details: string[] }> {
  try {
    const session = await requireMasterAdmin();
    const items = await prisma.questionReplacementItem.findMany({ where: { replacementId }, select: { paperId: true } });
    const r = await rollbackReplacement(replacementId, { adminId: session.user.id!, source: "ADMIN" });
    revalidateAfterChange(items.map((i) => i.paperId));
    revalidatePath("/admin/questions/replacements");
    return {
      ok: true,
      message: `Rolled back: ${r.questionsRestored} question(s), ${r.rowsUnswapped} test row(s), ${r.containersRestored} test(s) back online, ${r.attemptsRestored} attempt(s) restored.${r.rowsNotUnswapped ? ` ${r.rowsNotUnswapped} row(s) had changed since and were left as they are.` : ""}`,
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Creates a DRAFT copy of a question to correct before replacing: same exam,
 * taxonomy, type, text, options, explanation and images. Not linked to any
 * paper (the replacement takes the old question's paper slot on apply).
 */
export async function createCorrectedCopyAction(oldQuestionId: string): Promise<{ ok: true; id: string; code: string } | { ok: false; error: string; details: string[] }> {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const created = await prisma.$transaction(async (tx) => {
      const q = await tx.question.findUnique({
        where: { id: oldQuestionId },
        include: { options: true, assets: true, exam: { select: { code: true } } },
      });
      if (!q) throw new ReplacementError("Question not found.");
      if (q.retiredAt) throw new ReplacementError("This question is already retired.");
      if (q.parentQuestionId) throw new ReplacementError("AI variants cannot be replaced — retire them with their original question.");
      const code = q.examYear !== null ? await allocateQuestionCode(tx, questionCodeScope(q.exam.code, q.examYear)) : legacyQuestionCode();
      const copy = await tx.question.create({
        data: {
          code,
          examId: q.examId,
          subjectId: q.subjectId,
          topicId: q.topicId,
          subTopicId: q.subTopicId,
          text: q.text,
          imageUrl: q.imageUrl,
          difficulty: q.difficulty,
          status: QuestionStatus.DRAFT,
          source: QuestionSource.QUESTION_BANK,
          examYear: q.examYear,
          contentFormat: q.contentFormat,
          explanation: q.explanation,
          questionType: q.questionType,
          matchSpec: q.matchSpec ?? Prisma.JsonNull,
          answerVerification: q.answerVerification,
          reviewRequired: false,
          options: { create: q.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl, isCorrect: o.isCorrect, order: o.order })) },
        },
      });
      if (q.assets.length) {
        await tx.questionAsset.createMany({
          data: q.assets.map((a) => ({
            questionId: copy.id,
            role: a.role,
            optionLabel: a.optionLabel,
            listKey: a.listKey,
            order: a.order,
            storageKey: a.storageKey,
            mime: a.mime,
            width: a.width,
            height: a.height,
            bytes: a.bytes,
            sha256: a.sha256,
            alt: a.alt,
            caption: a.caption,
            darkBacking: a.darkBacking,
          })),
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: session.user.id,
          action: "QUESTION_CORRECTION_DRAFT_CREATED",
          entityType: "Question",
          entityId: copy.id,
          metadata: { copiedFrom: q.id, copiedFromCode: q.code },
        },
      });
      return copy;
    });
    revalidatePath("/admin/questions");
    return { ok: true, id: created.id, code: created.code };
  } catch (error) {
    return failure(error);
  }
}
