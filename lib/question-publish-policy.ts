import "server-only";
import { QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { mediaStorage } from "@/lib/media-storage";
import { correctCountIssue, toQuestionType } from "@/lib/question-types";

/**
 * Publishing eligibility — ONE rule for every path that turns a question
 * PUBLISHED (All Questions bulk Publish, the question form, the status
 * select, a Standard bulk import that asks for PUBLISHED, and the AI
 * Question Importer's bulk publish).
 *
 * A question may BECOME published only when:
 *  1. it is not flagged for review (`reviewRequired = false`) — clearing the
 *     flag is an explicit, audited admin action ("Mark reviewed"), never a
 *     side effect of publishing;
 *  2. its answer key is valid for its type (exactly one correct option for
 *     single-correct / Match the Following, at least two for multiple-correct);
 *  3. it has at least two options, each with text or an image;
 *  4. every image it references still exists in media storage.
 *
 * Questions that are ALREADY published are left alone (no retroactive
 * unpublishing). A batch is never all-or-nothing: eligible questions are
 * published, the rest are returned with their reasons.
 */

export const PUBLISH_BLOCK_REASONS = {
  REVIEW_REQUIRED: "Flagged for review",
  ANSWER_KEY: "Answer key invalid",
  OPTIONS: "Options incomplete",
  IMAGE_MISSING: "Image file missing",
  NOT_FOUND: "Question not found",
} as const;
export type PublishBlockCode = keyof typeof PUBLISH_BLOCK_REASONS;

export interface PublishBlock {
  id: string;
  code: string | null;
  reasons: { code: PublishBlockCode; detail: string }[];
}

export interface PublishEligibility {
  /** Not yet published and passes every rule. */
  eligible: string[];
  alreadyPublished: string[];
  blocked: PublishBlock[];
}

type Db = Pick<Prisma.TransactionClient, "question">;

const SELECT = {
  id: true,
  code: true,
  status: true,
  reviewRequired: true,
  reviewReason: true,
  questionType: true,
  imageUrl: true,
  options: { select: { label: true, text: true, isCorrect: true, imageUrl: true } },
  assets: { select: { role: true, optionLabel: true, storageKey: true } },
} satisfies Prisma.QuestionSelect;

type Row = Prisma.QuestionGetPayload<{ select: typeof SELECT }>;

/** Pure rules for one loaded question (image existence is checked separately). */
export function structuralPublishIssues(q: Pick<Row, "reviewRequired" | "reviewReason" | "questionType" | "options" | "assets">): PublishBlock["reasons"] {
  const reasons: PublishBlock["reasons"] = [];
  if (q.reviewRequired) {
    reasons.push({ code: "REVIEW_REQUIRED", detail: q.reviewReason ? `Flagged for review: ${q.reviewReason}` : "Flagged for review — mark it reviewed first." });
  }
  const optionImages = new Set(q.assets.filter((a) => a.role === "OPTION" && a.optionLabel).map((a) => a.optionLabel!));
  const usable = q.options.filter((o) => o.text.trim() !== "" || o.imageUrl || optionImages.has(o.label));
  if (q.options.length < 2 || usable.length < q.options.length) {
    reasons.push({ code: "OPTIONS", detail: q.options.length < 2 ? "Fewer than two options." : "An option has neither text nor an image." });
  }
  const keyIssue = correctCountIssue(toQuestionType(q.questionType), q.options.filter((o) => o.isCorrect).length, q.options.length);
  if (keyIssue) reasons.push({ code: "ANSWER_KEY", detail: keyIssue });
  return reasons;
}

/** Evaluates publish eligibility for a set of question ids (any status). */
export async function evaluatePublishEligibility(ids: string[], db: Db = prisma): Promise<PublishEligibility> {
  const unique = Array.from(new Set(ids));
  const rows: Row[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    rows.push(...(await db.question.findMany({ where: { id: { in: unique.slice(i, i + 500) } }, select: SELECT })));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const storage = mediaStorage();
  const out: PublishEligibility = { eligible: [], alreadyPublished: [], blocked: [] };

  for (const id of unique) {
    const q = byId.get(id);
    if (!q) {
      out.blocked.push({ id, code: null, reasons: [{ code: "NOT_FOUND", detail: "Question not found." }] });
      continue;
    }
    if (q.status === QuestionStatus.PUBLISHED) {
      out.alreadyPublished.push(id);
      continue;
    }
    const reasons = structuralPublishIssues(q);
    for (const a of q.assets) {
      if (!(await storage.exists(a.storageKey).catch(() => false))) {
        reasons.push({ code: "IMAGE_MISSING", detail: `${a.role === "OPTION" ? `Option ${a.optionLabel} image` : a.role === "QUESTION" ? "Question image" : `${a.role.toLowerCase()} image`} is missing from storage.` });
        break;
      }
    }
    if (reasons.length) out.blocked.push({ id, code: q.code, reasons });
    else out.eligible.push(id);
  }
  return out;
}

/** Short human summary of blocked questions, grouped by reason ("3 flagged for review, 1 answer key invalid"). */
export function summarizeBlocks(blocked: PublishBlock[]): string {
  const counts = new Map<PublishBlockCode, number>();
  for (const b of blocked) for (const r of new Set(b.reasons.map((x) => x.code))) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([code, n]) => `${n} ${PUBLISH_BLOCK_REASONS[code].toLowerCase()}`).join(", ");
}

export interface PublishResult extends PublishEligibility {
  publishedCount: number;
}

/**
 * Publishes the eligible questions among `ids` (server-side gate). The update
 * re-checks `reviewRequired = false` in its WHERE clause, so a question that
 * gets flagged between evaluation and update is never published.
 */
export async function publishQuestions(input: { ids: string[]; actorId: string; source: string }): Promise<PublishResult> {
  const evaluation = await evaluatePublishEligibility(input.ids);
  let publishedCount = 0;
  for (let i = 0; i < evaluation.eligible.length; i += 500) {
    const chunk = evaluation.eligible.slice(i, i + 500);
    const r = await prisma.question.updateMany({
      where: { id: { in: chunk }, reviewRequired: false, status: { not: QuestionStatus.PUBLISHED } },
      data: { status: QuestionStatus.PUBLISHED },
    });
    publishedCount += r.count;
  }
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: "QUESTION_BULK_PUBLISH",
      entityType: "Question",
      entityId: null,
      metadata: {
        source: input.source,
        requested: input.ids.length,
        published: publishedCount,
        ids: evaluation.eligible,
        alreadyPublished: evaluation.alreadyPublished.length,
        blocked: evaluation.blocked.map((b) => ({ id: b.id, reasons: b.reasons.map((r) => r.code) })),
      },
    },
  });
  return { ...evaluation, publishedCount };
}

/** Single-question gate for the form / status select: null = may publish, else the refusal message. */
export async function publishRefusal(questionId: string): Promise<string | null> {
  const e = await evaluatePublishEligibility([questionId]);
  const b = e.blocked[0];
  if (!b) return null;
  return `Cannot publish: ${b.reasons.map((r) => r.detail).join(" ")}`;
}
