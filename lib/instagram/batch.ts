import "server-only";
import crypto from "node:crypto";
import type { InstagramBatch, InstagramBatchItem, InstagramQueueState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStudioSettings } from "@/lib/instagram/config";
import { StudioError, applyChange, createDraft, getPostDto, type PostDto } from "@/lib/instagram/posts";
import { Prisma } from "@prisma/client";
import {
  assertAcknowledged,
  checkPublishable,
  getPublishStatus,
  getPublishingSwitch,
  isPublishingConfigured,
  readConfirmation,
  reconcilePublish,
  startPublish,
  type ConfirmationRecord,
  type PublishJob,
  type PublishPreflight,
} from "@/lib/instagram/publish";
import { defaultDesign, modeOfTemplate, TEMPLATE_KEYS, type TemplateKey } from "@/lib/instagram/types";

/**
 * Bulk Studio: one separate post per selected question, each with its own
 * design, diagram, trap and caption (they are ordinary InstagramPosts — the
 * same editor, quality gate and publisher).
 *
 * Publishing queue (persistent, attended):
 *  - A Master Admin selects completed drafts, reviews them together on one
 *    final screen and clicks "Confirm & Publish Selected" once. That single
 *    confirmation is recorded on each selected post for its exact revision and
 *    authorizes only those posts; editing a post afterwards clears it.
 *  - The queue advances one post at a time ONLY while that admin keeps the
 *    queue page open and the queue is RUNNING (the page calls advanceQueue);
 *    closing the page pauses it in effect. There is no background scheduler
 *    and nothing publishes unattended.
 *  - Each item's idempotency key is stored before its publish starts, and the
 *    existing publisher's atomic claim makes a repeat a no-op.
 *  - Any failure pauses the queue. A FAILED item (confirmed: nothing was
 *    published) can be retried; an UNCERTAIN one must be resolved with
 *    "Check Instagram status" first — it is never retried blindly.
 */

export const BATCH_MAX = 20;
/** Minimum gap between two queued publishes (Instagram rate limits; spreads posts out). */
export const QUEUE_SPACING_MS = Number(process.env.INSTAGRAM_QUEUE_SPACING_MS) >= 1000 ? Number(process.env.INSTAGRAM_QUEUE_SPACING_MS) : 90_000;

export interface BatchItemView {
  id: string;
  position: number;
  postId: string;
  questionId: string;
  queueState: InstagramQueueState;
  lastError: string | null;
  post: PostDto | null;
}

export interface BatchView {
  batch: Pick<InstagramBatch, "id" | "name" | "examId" | "status"> & { createdAt: string; queueConfirmedAt: string | null };
  items: BatchItemView[];
  nextAllowedAt: string | null;
}

async function audit(actorId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId, action, entityType: "InstagramBatch", entityId, metadata: metadata as object } });
}

export async function createBatch(params: { name: string; examId: string | null; questionIds: string[]; template: TemplateKey | "default"; perQuestion?: Record<string, TemplateKey>; actorId: string }) {
  const ids = [...new Set(params.questionIds)];
  if (ids.length === 0) throw new StudioError("Select at least one question.");
  if (ids.length > BATCH_MAX) throw new StudioError(`A batch can have at most ${BATCH_MAX} questions.`);
  const name = params.name.trim().slice(0, 80) || `Batch ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const settings = await getStudioSettings();
  const results: { questionId: string; postId: string | null; error?: string; existed?: boolean }[] = [];
  for (const qid of ids) {
    const t = params.perQuestion?.[qid] ?? (params.template === "default" ? settings.defaultTemplate : params.template);
    try {
      const { post, existed } = await createDraft({ questionId: qid, series: "PYQ", stats: null, actorId: params.actorId, design: defaultDesign(t, settings.defaultSlideCount) });
      results.push({ questionId: qid, postId: post.id, existed });
    } catch (e) {
      results.push({ questionId: qid, postId: null, error: e instanceof StudioError ? e.message : "Could not create the draft." });
    }
  }
  const ok = results.filter((r) => r.postId);
  if (!ok.length) throw new StudioError(`No drafts could be created: ${results.map((r) => r.error).filter(Boolean)[0] ?? "unknown error"}`);
  const batch = await prisma.instagramBatch.create({
    data: {
      name,
      examId: params.examId,
      createdById: params.actorId,
      items: { create: ok.map((r, i) => ({ postId: r.postId!, questionId: r.questionId, position: i + 1 })) },
    },
  });
  await audit(params.actorId, "INSTAGRAM_BATCH_CREATED", batch.id, { posts: ok.length, failed: results.length - ok.length });
  return { batchId: batch.id, results };
}

export async function listBatches() {
  const rows = await prisma.instagramBatch.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { _count: { select: { items: true } } } });
  return rows.map((b) => ({ id: b.id, name: b.name, status: b.status, createdAt: b.createdAt.toISOString(), items: b._count.items }));
}

async function lastPublishedAt(batchId: string): Promise<Date | null> {
  const done = await prisma.instagramBatchItem.findFirst({ where: { batchId, queueState: { in: ["DONE", "PUBLISHING"] } }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
  return done?.updatedAt ?? null;
}

export async function getBatchView(batchId: string): Promise<BatchView> {
  const b = await prisma.instagramBatch.findUnique({ where: { id: batchId }, include: { items: { orderBy: { position: "asc" } } } });
  if (!b) throw new StudioError("Batch not found.", "not-found");
  const items: BatchItemView[] = [];
  for (const it of b.items) {
    let post: PostDto | null = null;
    try {
      post = await getPostDto(it.postId);
    } catch {
      post = null;
    }
    items.push({ id: it.id, position: it.position, postId: it.postId, questionId: it.questionId, queueState: it.queueState, lastError: it.lastError, post });
  }
  const last = await lastPublishedAt(batchId);
  return {
    batch: { id: b.id, name: b.name, examId: b.examId, status: b.status, createdAt: b.createdAt.toISOString(), queueConfirmedAt: b.queueConfirmedAt?.toISOString() ?? null },
    items,
    nextAllowedAt: last ? new Date(last.getTime() + QUEUE_SPACING_MS).toISOString() : null,
  };
}

/**
 * "Apply Handwritten / Professional / Default to All" (or to the given posts).
 * Only the design changes; content is untouched. Posts waiting in (or going
 * through) the publishing queue are skipped — a change would void their
 * confirmation.
 */
export async function applyDesignToBatch(params: { batchId: string; target: "handwritten" | "professional" | "default" | TemplateKey; postIds?: string[]; actorId: string }) {
  const view = await getBatchView(params.batchId);
  const settings = await getStudioSettings();
  const pick = (current: TemplateKey): TemplateKey => {
    if ((TEMPLATE_KEYS as readonly string[]).includes(params.target)) return params.target as TemplateKey;
    if (params.target === "default") return settings.defaultTemplate;
    if (modeOfTemplate(current) === params.target) return current;
    if (params.target === "handwritten") return "hw-doctor";
    return modeOfTemplate(settings.defaultTemplate) === "professional" ? settings.defaultTemplate : "minimal-infographic";
  };
  let changed = 0;
  const skipped: string[] = [];
  for (const it of view.items) {
    if (params.postIds && !params.postIds.includes(it.postId)) continue;
    const p = it.post;
    if (!p || !p.isCurrent) continue;
    if (p.status !== "DRAFT" && p.status !== "FAILED") {
      skipped.push(`${p.questionCode}: ${p.status.toLowerCase()}`);
      continue;
    }
    if (it.queueState === "QUEUED" || it.queueState === "PUBLISHING" || it.queueState === "UNCERTAIN") {
      skipped.push(`${p.questionCode}: in the publishing queue`);
      continue;
    }
    const template = pick(p.design.template);
    if (template === p.design.template) continue;
    await applyChange({ postId: p.id, expectedRevision: p.revision, design: { ...p.design, template }, note: `Bulk Studio: design → ${template}`, actorId: params.actorId });
    changed++;
  }
  return { changed, skipped };
}

// ---- Publishing queue -----------------------------------------------------------------------

async function setItem(id: string, data: Partial<Pick<InstagramBatchItem, "queueState" | "lastError" | "requestKey">>) {
  await prisma.instagramBatchItem.update({ where: { id }, data });
}

export interface BulkPreflightItem {
  postId: string;
  questionCode: string;
  revision: number;
  pre: PublishPreflight | null;
  error: string | null;
}

/** Read-only: what the final review screen shows for each selected post (re-checks every publish condition). */
export async function bulkPreflight(params: { batchId: string; postIds: string[] }): Promise<BulkPreflightItem[]> {
  const view = await getBatchView(params.batchId);
  const chosen = view.items.filter((it) => params.postIds.includes(it.postId));
  const out: BulkPreflightItem[] = [];
  for (const it of chosen) {
    const row = await prisma.instagramPost.findUnique({ where: { id: it.postId } });
    if (!row) {
      out.push({ postId: it.postId, questionCode: it.post?.questionCode ?? it.postId, revision: 0, pre: null, error: "The post no longer exists." });
      continue;
    }
    try {
      out.push({ postId: row.id, questionCode: row.questionCode, revision: row.revision, pre: await checkPublishable(row, row.revision, "CAROUSEL"), error: null });
    } catch (e) {
      out.push({ postId: row.id, questionCode: row.questionCode, revision: row.revision, pre: null, error: e instanceof StudioError ? e.message : "Can't be published." });
    }
  }
  return out;
}

/**
 * "Confirm & Publish Selected": the single Master Admin confirmation for the
 * exact posts (and revisions) shown on the final review screen. Every post is
 * re-checked; if any can't be published, nothing is queued. The confirmation
 * is stored on each post (review / reviewedAt / reviewedById) for its exact
 * revision, and the queue then publishes them one at a time.
 */
export async function confirmQueue(params: { batchId: string; items: { postId: string; revision: number; acknowledged: string[] }[]; actorId: string }) {
  const sw = await getPublishingSwitch();
  if (!sw.enabled) throw new StudioError("Direct publishing is turned off (Instagram → Settings). Nothing was queued.", "blocked");
  if (!isPublishingConfigured()) throw new StudioError("Instagram is not connected on the server. Nothing was queued.", "blocked");
  const view = await getBatchView(params.batchId);
  if (view.batch.status === "QUEUE_RUNNING" || view.batch.status === "QUEUE_PAUSED") throw new StudioError("The queue is already active. Stop it before confirming new posts.");
  const wanted = new Map(params.items.map((i) => [i.postId, i]));
  const chosen = view.items.filter((it) => wanted.has(it.postId));
  if (!chosen.length) throw new StudioError("Select at least one completed draft.");
  if (chosen.length !== wanted.size) throw new StudioError("Some selected posts are not in this batch. Reload the page.");

  const records: { itemId: string; postId: string; revision: number; record: ConfirmationRecord }[] = [];
  const problems: string[] = [];
  for (const it of chosen) {
    const sel = wanted.get(it.postId)!;
    const row = await prisma.instagramPost.findUnique({ where: { id: it.postId } });
    if (!row) {
      problems.push(`${it.post?.questionCode ?? it.postId}: the post no longer exists`);
      continue;
    }
    try {
      const pre = await checkPublishable(row, sel.revision, "CAROUSEL");
      assertAcknowledged(pre, sel.acknowledged);
      records.push({
        itemId: it.id,
        postId: row.id,
        revision: row.revision,
        record: { revision: row.revision, acknowledged: pre.warnings.map((w) => w.code), checklist: pre.checklist.map((c) => c.key), via: "bulk", batchId: params.batchId, at: new Date().toISOString() },
      });
    } catch (e) {
      problems.push(`${row.questionCode}: ${e instanceof StudioError ? e.message : "can't be published"}`);
    }
  }
  if (problems.length) throw new StudioError(`Nothing was queued. ${problems.join(" · ")}`, "blocked");

  await prisma.$transaction(async (tx) => {
    for (const r of records) {
      const res = await tx.instagramPost.updateMany({
        where: { id: r.postId, revision: r.revision, status: { in: ["DRAFT", "READY", "FAILED"] }, supersededAt: null, igMediaId: null },
        data: { reviewedAt: new Date(), reviewedById: params.actorId, review: r.record as unknown as Prisma.InputJsonValue },
      });
      if (res.count !== 1) throw new StudioError("A selected post changed while confirming. Nothing was queued — review again.", "conflict");
      await tx.instagramBatchItem.update({ where: { id: r.itemId }, data: { queueState: "QUEUED", lastError: null, requestKey: null } });
    }
    await tx.instagramBatch.update({ where: { id: params.batchId }, data: { status: "QUEUE_RUNNING", queueConfirmedById: params.actorId, queueConfirmedAt: new Date() } });
  });
  await audit(params.actorId, "INSTAGRAM_QUEUE_CONFIRMED", params.batchId, { posts: records.map((r) => ({ postId: r.postId, revision: r.revision, acknowledged: r.record.acknowledged })) });
  return getBatchView(params.batchId);
}

export async function setQueueStatus(params: { batchId: string; action: "pause" | "resume" | "stop"; actorId: string }) {
  const b = await prisma.instagramBatch.findUnique({ where: { id: params.batchId } });
  if (!b) throw new StudioError("Batch not found.", "not-found");
  if (params.action === "pause") {
    if (b.status !== "QUEUE_RUNNING") throw new StudioError("The queue is not running.");
    await prisma.instagramBatch.update({ where: { id: b.id }, data: { status: "QUEUE_PAUSED" } });
  } else if (params.action === "resume") {
    if (b.status !== "QUEUE_PAUSED") throw new StudioError("Only a paused queue can be resumed.");
    const uncertain = await prisma.instagramBatchItem.count({ where: { batchId: b.id, queueState: "UNCERTAIN" } });
    if (uncertain) throw new StudioError("Resolve the post with an unclear result first (Check Instagram status).");
    const sw = await getPublishingSwitch();
    if (!sw.enabled) throw new StudioError("Direct publishing is turned off.", "blocked");
    await prisma.instagramBatch.update({ where: { id: b.id }, data: { status: "QUEUE_RUNNING" } });
  } else {
    await prisma.$transaction([
      prisma.instagramBatchItem.updateMany({ where: { batchId: b.id, queueState: "QUEUED" }, data: { queueState: "SKIPPED" } }),
      prisma.instagramBatch.update({ where: { id: b.id }, data: { status: "QUEUE_STOPPED" } }),
    ]);
  }
  await audit(params.actorId, `INSTAGRAM_QUEUE_${params.action.toUpperCase()}`, b.id, {});
  return getBatchView(b.id);
}

async function pause(batchId: string) {
  await prisma.instagramBatch.updateMany({ where: { id: batchId, status: "QUEUE_RUNNING" }, data: { status: "QUEUE_PAUSED" } });
}

/**
 * One step of an attended queue. Returns the job to run in the background
 * (the caller runs it with after()), if a new publish was started.
 */
export async function advanceQueue(params: { batchId: string; actorId: string }): Promise<{ view: BatchView; started: { postId: string; job: PublishJob } | null }> {
  const b = await prisma.instagramBatch.findUnique({ where: { id: params.batchId }, include: { items: { orderBy: { position: "asc" } } } });
  if (!b) throw new StudioError("Batch not found.", "not-found");
  if (b.status !== "QUEUE_RUNNING") return { view: await getBatchView(b.id), started: null };

  // 1. Settle the item that is publishing.
  const active = b.items.find((i) => i.queueState === "PUBLISHING");
  if (active) {
    const v = await getPublishStatus(active.postId, params.actorId);
    if (v.status === "PUBLISHED") await setItem(active.id, { queueState: "DONE", lastError: null });
    else if (v.status === "FAILED") {
      await setItem(active.id, { queueState: "FAILED", lastError: v.publishError ?? "Publishing failed — nothing was published." });
      await pause(b.id);
    } else if (v.needsReconcile) {
      await setItem(active.id, { queueState: "UNCERTAIN", lastError: v.publishError ?? "Instagram did not confirm the result. Check Instagram status." });
      await pause(b.id);
    }
    return { view: await getBatchView(b.id), started: null };
  }

  // 2. Start the next queued post, respecting the spacing.
  const next = b.items.find((i) => i.queueState === "QUEUED");
  if (!next) {
    await prisma.instagramBatch.updateMany({ where: { id: b.id, status: "QUEUE_RUNNING" }, data: { status: "COMPLETE" } });
    return { view: await getBatchView(b.id), started: null };
  }
  const last = await lastPublishedAt(b.id);
  if (last && Date.now() - last.getTime() < QUEUE_SPACING_MS) return { view: await getBatchView(b.id), started: null };

  const requestKey = next.requestKey ?? crypto.randomUUID();
  if (!next.requestKey) await setItem(next.id, { requestKey });
  const post = await prisma.instagramPost.findUnique({ where: { id: next.postId }, select: { revision: true, status: true } });
  if (!post) {
    await setItem(next.id, { queueState: "SKIPPED", lastError: "The post no longer exists." });
    return { view: await getBatchView(b.id), started: null };
  }
  if (post.status === "PUBLISHED") {
    await setItem(next.id, { queueState: "DONE", lastError: null });
    return { view: await getBatchView(b.id), started: null };
  }
  try {
    const { job, existing } = await startPublish({ postId: next.postId, expectedRevision: post.revision, requestKey, format: "CAROUSEL", actorId: params.actorId, confirmation: { via: "bulk", batchId: b.id } });
    await setItem(next.id, { queueState: "PUBLISHING", lastError: null });
    return { view: await getBatchView(b.id), started: existing ? null : { postId: next.postId, job } };
  } catch (e) {
    // The claim failed, so nothing was sent to Instagram for this post.
    await setItem(next.id, { queueState: "FAILED", lastError: e instanceof StudioError ? e.message : "Could not start publishing." });
    await pause(b.id);
    return { view: await getBatchView(b.id), started: null };
  }
}

/** Retry a FAILED item (only when Instagram confirmed nothing was published). */
export async function retryItem(params: { batchId: string; itemId: string; actorId: string }) {
  const it = await prisma.instagramBatchItem.findFirst({ where: { id: params.itemId, batchId: params.batchId } });
  if (!it) throw new StudioError("Item not found.");
  if (it.queueState !== "FAILED") throw new StudioError("Only a failed item can be retried.");
  const post = await prisma.instagramPost.findUnique({ where: { id: it.postId }, select: { status: true, revision: true, reviewedAt: true, review: true } });
  if (!post || !["DRAFT", "READY", "FAILED"].includes(post.status)) throw new StudioError("Only an unpublished post (nothing went live) can be retried.");
  const onFile = readConfirmation(post.review);
  if (!post.reviewedAt || onFile?.via !== "bulk" || onFile.batchId !== params.batchId || onFile.revision !== post.revision) {
    throw new StudioError("This post changed after it was confirmed. Select it again and use Confirm & Publish Selected.");
  }
  await setItem(it.id, { queueState: "QUEUED", lastError: null, requestKey: null });
  await audit(params.actorId, "INSTAGRAM_QUEUE_RETRY", params.batchId, { postId: it.postId });
  return getBatchView(params.batchId);
}

/** "Check Instagram status" for an item: read-only reconciliation with Instagram. */
export async function checkItemStatus(params: { batchId: string; itemId: string; actorId: string }) {
  const it = await prisma.instagramBatchItem.findFirst({ where: { id: params.itemId, batchId: params.batchId } });
  if (!it) throw new StudioError("Item not found.");
  const v = await reconcilePublish(it.postId, params.actorId);
  if (v.status === "PUBLISHED") await setItem(it.id, { queueState: "DONE", lastError: null });
  else if (v.status === "FAILED") await setItem(it.id, { queueState: "FAILED", lastError: v.publishError ?? "Confirmed: nothing was published." });
  else if (v.status === "PUBLISHING" && v.needsReconcile) await setItem(it.id, { queueState: "UNCERTAIN", lastError: v.publishError ?? "Still unclear — check again later." });
  return getBatchView(params.batchId);
}
