"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { REVIEW_CATEGORIES, type ReviewCategory } from "@/lib/question-source/review";

type Result = { ok: true } | { ok: false; error: string };

/** "Mark reviewed": the administrator checked the question against its source; clears the review flag (audited). */
export async function markQuestionReviewedAction(questionId: string, note: string): Promise<Result> {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    if (typeof questionId !== "string" || !questionId) return { ok: false, error: "Question not found." };
    const q = await prisma.question.findUnique({ where: { id: questionId }, select: { reviewRequired: true, reviewReason: true } });
    if (!q) return { ok: false, error: "Question not found." };
    const text = (typeof note === "string" ? note : "").trim().slice(0, 300);
    await prisma.$transaction([
      prisma.question.update({ where: { id: questionId }, data: { reviewRequired: false, reviewReason: `REVIEWED ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC${text ? ` — ${text}` : ""}` } }),
      prisma.auditLog.create({ data: { actorId: session.user.id, action: "QUESTION_REVIEWED", entityType: "Question", entityId: questionId, metadata: { before: q.reviewReason, note: text || null } } }),
    ]);
    revalidatePath(`/admin/questions/preview/${questionId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof UnauthorizedError ? e.message : "Could not save." };
  }
}

/** Flags a question for review with one category (audited). */
export async function flagQuestionReviewAction(questionId: string, category: ReviewCategory, note: string): Promise<Result> {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    if (!REVIEW_CATEGORIES.includes(category)) return { ok: false, error: "Choose a review category." };
    const q = await prisma.question.findUnique({ where: { id: questionId }, select: { reviewReason: true } });
    if (!q) return { ok: false, error: "Question not found." };
    const reason = `${category} — ${(typeof note === "string" ? note : "").trim().slice(0, 400) || "flagged by an administrator"}`;
    await prisma.$transaction([
      prisma.question.update({ where: { id: questionId }, data: { reviewRequired: true, reviewReason: reason } }),
      prisma.auditLog.create({ data: { actorId: session.user.id, action: "QUESTION_FLAGGED_FOR_REVIEW", entityType: "Question", entityId: questionId, metadata: { before: q.reviewReason, category } } }),
    ]);
    revalidatePath(`/admin/questions/preview/${questionId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof UnauthorizedError ? e.message : "Could not save." };
  }
}
