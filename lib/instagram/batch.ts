import "server-only";
import crypto from "node:crypto";
import type { InstagramBatch, InstagramBatchItem, InstagramQueueState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStudioSettings } from "@/lib/instagram/config";
import { StudioError, applyChange, createDraft, getPostDto, type PostDto } from "@/lib/instagram/posts";
import { getPublishStatus, getPublishingSwitch, isPublishingConfigured, reconcilePublish, startPublish, type PublishJob } from "@/lib/instagram/publish";
import { defaultDesign, modeOfTemplate, TEMPLATE_KEYS, type TemplateKey } from "@/lib/instagram/types";

/**
 * Bulk Studio: one separate post per selected question, each with its own
 * design, diagram, trap, caption, review and approval (they are ordinary
 * InstagramPosts — the same editor, quality gate and publisher).
 *
 * Publishing queue (persistent, attended):
 *  - A Master Admin explicitly confirms the exact list of READY posts.
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
 * Only the design changes; content is untouched. Approved (Ready) posts are
 * skipped unless `includeReady` — changing them sends them back to Draft.
 */
export async function applyDesignToBatch(params: { batchId: string; target: "handwritten" | "professional" | "default" | TemplateKey; postIds?: string[]; includeReady: boolean; actorId: string }) {
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
    if (!["DRAFT", "READY", "FAILED"].includes(p.status)) {
      skipped.push(`${p.questionCode}: ${p.status.toLowerCase()}`);
      continue;
    }
    if (p.status !== "DRAFT" && !params.includeReady) {
      skipped.push(`${p.questionCode}: approved — not changed`);
      continue;
    }
    const template = pick(p.design.template);
    if (template === p.design.template) continue;
    await applyChange({ postId: p.id, expectedRevision: p.revision, design: { ...p.design, template }, note: `Bulk Studio: design → ${template}`, actorId: params.actorId, confirmReplaceApproved: params.includeReady });
    changed++;
  }
  return { changed, skipped };
}

// ---- Publishing queue -----------------------------------------------------------------------

async function setItem(id: string, data: Partial<Pick<InstagramBatchItem, "queueState" | "lastError" | "requestKey">>) {
  await prisma.instagramBatchItem.update({ where: { id }, data });
}

/** Explicit Master Admin confirmation of the exact posts to publish, in order. */
export async function confirmQueue(params: { batchId: string; postIds: string[]; actorId: string }) {
  const sw = await getPublishingSwitch();
  if (!sw.enabled) throw new StudioError("Direct publishing is turned off (Instagram → Settings). Nothing was queued.", "blocked");
  if (!isPublishingConfigured()) throw new StudioError("Instagram is not connected on the server. Nothing was queued.", "blocked");
  const view = await getBatchView(params.batchId);
  if (view.batch.status === "QUEUE_RUNNING") throw new StudioError("The queue is already running.");
  const chosen = view.items.filter((it) => params.postIds.includes(it.postId));
  if (!chosen.length) throw new StudioError("Choose at least one approved post.");
  const notReady = chosen.filter((it) => it.post?.status !== "READY");
  if (notReady.length) throw new StudioError(`Only approved (Ready) posts can be queued: ${notReady.map((i) => i.post?.questionCode ?? i.postId).join(", ")}.`);
  await prisma.$transaction(async (tx) => {
    for (const it of chosen) await tx.instagramBatchItem.update({ where: { id: it.id }, data: { queueState: "QUEUED", lastError: null, requestKey: null } });
    await tx.instagramBatch.update({ where: { id: params.batchId }, data: { status: "QUEUE_RUNNING", queueConfirmedById: params.actorId, queueConfirmedAt: new Date() } });
  });
  await audit(params.actorId, "INSTAGRAM_QUEUE_CONFIRMED", params.batchId, { posts: chosen.map((c) => c.postId) });
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
    const { job, existing } = await startPublish({ postId: next.postId, expectedRevision: post.revision, requestKey, format: "CAROUSEL", actorId: params.actorId });
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
  const post = await prisma.instagramPost.findUnique({ where: { id: it.postId }, select: { status: true } });
  if (post?.status !== "READY" && post?.status !== "FAILED") throw new StudioError("The post must be approved (Ready) or confirmed-failed to retry.");
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
