"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  BatchActionError,
  evaluateBatchPublish,
  markBatchQuestionsReviewed,
  publishBatchQuestions,
  recheckReviewFlags,
  type MarkReviewedResult,
  type ReviewCheck,
} from "@/lib/pyq-import-batches";
import type { BatchPublishPreview, BatchPublishResult } from "@/lib/pyq-import-batches-shared";

/**
 * Previous Year Paper → Import Batches. Every action re-validates on the
 * server (lib/pyq-import-batches.ts); the client selection is only a request.
 * Same permission as every other Question Bank mutation.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (actorId: string) => Promise<T>): Promise<Result<T>> {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    return { ok: true, data: await fn(session.user.id!) };
  } catch (err) {
    if (err instanceof BatchActionError) return { ok: false, error: err.message };
    if (err instanceof Error && err.name === "UnauthorizedError") return { ok: false, error: "You do not have permission to manage questions." };
    console.error("pyq batch action failed:", err);
    return { ok: false, error: "The action failed on the server. Nothing was changed." };
  }
}

function refresh(paperId: string) {
  revalidatePath("/admin/questions");
  revalidatePath(`/admin/exams/previous-year-papers/${paperId}`);
}

export async function previewBatchPublishAction(paperId: string, batchKey: string, ids: string[]): Promise<Result<BatchPublishPreview>> {
  return run(() => evaluateBatchPublish({ paperId, batchKey, ids }));
}

export async function publishBatchAction(paperId: string, batchKey: string, ids: string[], requestId: string): Promise<Result<BatchPublishResult>> {
  const r = await run((actorId) => publishBatchQuestions({ paperId, batchKey, ids, actorId, requestId }));
  if (r.ok && r.data.publishedCount > 0) refresh(paperId);
  return r;
}

export async function recheckReviewAction(paperId: string, batchKey: string, ids: string[]): Promise<Result<ReviewCheck[]>> {
  return run(() => recheckReviewFlags({ paperId, batchKey, ids }));
}

export async function markReviewedAction(paperId: string, batchKey: string, ids: string[]): Promise<Result<MarkReviewedResult>> {
  const r = await run((actorId) => markBatchQuestionsReviewed({ paperId, batchKey, ids, actorId }));
  if (r.ok && r.data.markedCount > 0) refresh(paperId);
  return r;
}
