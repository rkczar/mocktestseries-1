import "server-only";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Prisma, type InstagramPost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { storageRootDir } from "@/lib/question-images";
import { WEBSITE_URL_DEFAULT, getStudioSettings } from "@/lib/instagram/config";
import { blockingIssues, warningCodes } from "@/lib/instagram/quality";
import { StudioError, issuesFor } from "@/lib/instagram/posts";
import { currentSourceHash } from "@/lib/instagram/snapshot";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { EXPECTED_INSTAGRAM_USERNAME, isExpired, isPermissionError, isRateLimit, isTokenError, publishingApi, type GraphFail, type GraphOk, type PublishingApi } from "@/lib/instagram/meta";
import { isStale, publishView, readJob, type PublishErrorCategory, type PublishFormat, type PublishJob, type PublishView } from "@/lib/instagram/publish-view";
import { SLIDE_HEIGHT, SLIDE_WIDTH, composeCaption, normalizeContent, normalizeDesign, type SeriesStats, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Direct publishing to Instagram (Instagram API with Instagram Login).
 *
 * Flow (only after a Master Admin's explicit "Confirm & Publish"):
 *   claim (READY/FAILED → PUBLISHING, atomic) → verify the token's account →
 *   quota → render immutable JPEG snapshots to a random, expiring public URL →
 *   item containers → carousel container → wait FINISHED → media_publish →
 *   permalink → PUBLISHED.
 *
 * Duplicate safety:
 *  - The claim is a conditional update (status + revision + igMediaId IS NULL),
 *    so a double click, a second tab or a second admin can't start a second job;
 *    the partial unique index allows one PUBLISHING post per question.
 *  - Every job step is written to `publishJob` with a compare-and-swap on the
 *    job's lease id, so a stale worker can't overwrite a newer one.
 *  - The stage PUBLISH_REQUESTED is stored BEFORE media_publish is called. From
 *    then on nothing creates new containers until Meta has been asked what
 *    happened (container status_code + the account's recent media). A container
 *    can only become one post, so retrying with the SAME container can't
 *    duplicate either.
 *  - FAILED always means "confirmed nothing was published". An unknown outcome
 *    stays PUBLISHING (stage UNKNOWN, not editable) until reconciled.
 *  - A worker killed by a restart leaves a stale heartbeat; reconciliation
 *    (read-only towards Meta) resolves it. Nothing ever re-publishes on its own.
 */

export { STALE_MS, isStale, publishView, type PublishErrorCategory, type PublishFormat, type PublishJob, type PublishStage, type PublishView } from "@/lib/instagram/publish-view";
export const PUBLISH_SETTING_KEY = "instagram.publishing";
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;
export const CAPTION_MAX = 2200;
export const HASHTAGS_MAX = 30;
const MAX_JPEG_BYTES = 8 * 1024 * 1024;
/** Public media URLs stop working after this (Meta containers expire after 24 h). */
const MEDIA_TTL_MS = 26 * 3_600_000;
const MEDIA_SUBDIR = "instagram-publish";
const TOKEN_RE = /^[a-f0-9]{48}$/;
const FILE_RE = /^slide-(\d{1,2})\.jpg$/;

// ---- Kill switch (Setting `instagram.publishing`) ------------------------------------------

export interface PublishingSwitch {
  enabled: boolean;
  updatedAt: string | null;
  updatedById: string | null;
}

export async function getPublishingSwitch(): Promise<PublishingSwitch> {
  const row = await prisma.setting.findUnique({ where: { key: PUBLISH_SETTING_KEY } });
  const v = (row?.value ?? {}) as Partial<PublishingSwitch>;
  return { enabled: v.enabled === true, updatedAt: v.updatedAt ?? null, updatedById: v.updatedById ?? null };
}

export async function setPublishingSwitch(enabled: boolean, actorId: string): Promise<PublishingSwitch> {
  const value: PublishingSwitch = { enabled, updatedAt: new Date().toISOString(), updatedById: actorId };
  await prisma.setting.upsert({ where: { key: PUBLISH_SETTING_KEY }, update: { value: value as object }, create: { key: PUBLISH_SETTING_KEY, value: value as object } });
  await prisma.auditLog.create({ data: { actorId, action: enabled ? "INSTAGRAM_PUBLISHING_ENABLED" : "INSTAGRAM_PUBLISHING_DISABLED", entityType: "Setting", entityId: PUBLISH_SETTING_KEY, metadata: { enabled } } });
  return value;
}

// ---- Job shape --------------------------------------------------------------------------------

const json = (v: unknown) => v as Prisma.InputJsonValue;
const nowIso = () => new Date().toISOString();

// ---- Immutable public media ---------------------------------------------------------------

function mediaRoot() {
  return path.join(storageRootDir(), MEDIA_SUBDIR);
}

/** Base URL Meta fetches the slides from. Production: the site itself; tests: a loopback server. */
export function mediaBaseUrl(): string {
  const raw = process.env.INSTAGRAM_MEDIA_BASE_URL?.trim();
  if (raw && (/^https:\/\/[a-z0-9.-]+$/i.test(raw) || /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw))) return raw;
  return WEBSITE_URL_DEFAULT;
}

export function mediaUrl(token: string, index: number): string {
  return `${mediaBaseUrl()}/api/instagram-media/${token}/slide-${index + 1}.jpg`;
}

interface MediaManifest {
  postId: string;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  count: number;
}

/** Public read used by app/api/instagram-media/[token]/[file]. Returns null for anything unknown or expired. */
export async function readPublishMedia(token: string, file: string): Promise<Buffer | null> {
  if (!TOKEN_RE.test(token)) return null;
  const m = FILE_RE.exec(file);
  if (!m) return null;
  const n = Number(m[1]);
  const dir = path.join(mediaRoot(), token);
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as MediaManifest;
    if (n < 1 || n > manifest.count || Date.parse(manifest.expiresAt) < Date.now()) return null;
    return await readFile(path.join(dir, `slide-${n}.jpg`));
  } catch {
    return null;
  }
}

async function writeMedia(postId: string, jobId: string, jpegs: Buffer[]): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  const dir = path.join(mediaRoot(), token);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  for (let i = 0; i < jpegs.length; i++) await writeFile(path.join(dir, `slide-${i + 1}.jpg`), jpegs[i], { flag: "wx" });
  const created = new Date();
  const manifest: MediaManifest = { postId, jobId, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + MEDIA_TTL_MS).toISOString(), count: jpegs.length };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
  return token;
}

async function removeMedia(token: string | null) {
  if (!token || !TOKEN_RE.test(token)) return;
  await rm(path.join(mediaRoot(), token), { recursive: true, force: true }).catch(() => {});
}

/** Deletes expired media folders (best effort). */
export async function sweepExpiredMedia(): Promise<number> {
  let removed = 0;
  const root = mediaRoot();
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!TOKEN_RE.test(name)) continue;
    const dir = path.join(root, name);
    let expired = false;
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as MediaManifest;
      expired = Date.parse(manifest.expiresAt) < Date.now();
    } catch {
      const s = await stat(dir).catch(() => null);
      expired = !!s && Date.now() - s.mtimeMs > MEDIA_TTL_MS;
    }
    if (expired) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

// ---- Errors -------------------------------------------------------------------------------

const MEDIA_SUBCODES = new Set([2207003, 2207004, 2207005, 2207009, 2207013, 2207020, 2207023, 2207026, 2207052, 2207053, 2207057]);

export function classifyPublishFailure(f: GraphFail): { category: PublishErrorCategory; message: string } {
  if (f.kind === "timeout" || f.kind === "network") return { category: "UNAVAILABLE", message: `Instagram API unavailable: ${f.message}` };
  if (isExpired(f)) return { category: "TOKEN_EXPIRED", message: "The Instagram access token has expired. Install a new token (Admin → Instagram → Settings shows how), then retry." };
  if (isTokenError(f)) return { category: "TOKEN_INVALID", message: "Instagram rejected the access token (invalid or revoked). Install a new token, then retry." };
  if (f.subcode === 2207042) return { category: "QUOTA", message: "The Instagram publishing limit for the last 24 hours has been reached. Retry later." };
  if (isRateLimit(f)) return { category: "RATE_LIMIT", message: "Instagram's API rate limit was reached. Wait a few minutes, then retry." };
  if (isPermissionError(f)) return { category: "PERMISSION", message: "The token is missing the instagram_business_content_publish permission." };
  if ((f.subcode !== null && MEDIA_SUBCODES.has(f.subcode)) || f.code === 9004 || f.code === 36003 || f.code === 352) {
    return { category: "INVALID_MEDIA", message: `Instagram could not use the slide images: ${f.message}` };
  }
  if ((f.httpStatus ?? 0) >= 500 || f.code === 1 || f.code === 2 || f.subcode === 2207001) return { category: "UNAVAILABLE", message: `Instagram API is temporarily unavailable: ${f.message}` };
  return { category: "OTHER", message: `Instagram returned an error: ${f.message}` };
}

// ---- Persistence helpers ---------------------------------------------------------------------

/** Compare-and-swap write of the job (only while this lease still owns a PUBLISHING post). */
async function saveJob(postId: string, job: PublishJob, note?: string): Promise<boolean> {
  const next: PublishJob = { ...job, heartbeatAt: nowIso(), log: note ? [...job.log, { at: nowIso(), note }].slice(-40) : job.log };
  const n = await prisma.$executeRaw`
    UPDATE "InstagramPost" SET "publishJob" = ${JSON.stringify(next)}::jsonb, "updatedAt" = now()
    WHERE "id" = ${postId} AND "status" = 'PUBLISHING' AND "publishJob"->>'leaseId' = ${job.leaseId}`;
  if (n === 1) Object.assign(job, next);
  return n === 1;
}

async function audit(actorId: string, action: string, postId: string, metadata: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId, action, entityType: "InstagramPost", entityId: postId, metadata: json(metadata) } });
}

/**
 * Records a confirmed publication. Truth wins: applied for PUBLISHING or FAILED
 * (a slow worker may learn of success after a reconcile), never twice.
 */
async function markPublished(postId: string, job: PublishJob, mediaId: string | null, permalink: string | null, note: string): Promise<boolean> {
  const final: PublishJob = { ...job, stage: "PUBLISHED", mediaId, finishedAt: nowIso(), heartbeatAt: nowIso(), error: null, log: [...job.log, { at: nowIso(), note }].slice(-40) };
  const res = await prisma.instagramPost.updateMany({
    where: { id: postId, status: { in: ["PUBLISHING", "FAILED"] }, igMediaId: null },
    data: {
      status: "PUBLISHED",
      igMediaId: mediaId,
      igPermalink: permalink,
      publishedAt: new Date(),
      publishError: mediaId ? null : "Published on Instagram, but the post ID could not be matched automatically. Check the account.",
      publishJob: json(final),
    },
  });
  if (res.count === 1) {
    await audit(job.actorId, "INSTAGRAM_PUBLISHED", postId, { jobId: job.jobId, mediaId, permalink, format: job.format, slides: job.slideCount });
    await removeMedia(job.mediaToken);
  }
  return res.count === 1;
}

/** Records a failure that is confirmed to have published nothing (safe to retry). */
async function markFailed(postId: string, job: PublishJob, error: NonNullable<PublishJob["error"]>, note: string): Promise<boolean> {
  const final: PublishJob = { ...job, stage: "FAILED", finishedAt: nowIso(), heartbeatAt: nowIso(), error, log: [...job.log, { at: nowIso(), note }].slice(-40) };
  const n = await prisma.$executeRaw`
    UPDATE "InstagramPost" SET "status" = 'FAILED', "publishError" = ${error.message.slice(0, 500)}, "publishJob" = ${JSON.stringify(final)}::jsonb, "updatedAt" = now()
    WHERE "id" = ${postId} AND "status" = 'PUBLISHING' AND "publishJob"->>'leaseId' = ${job.leaseId}`;
  if (n === 1) {
    Object.assign(job, final);
    await audit(job.actorId, "INSTAGRAM_PUBLISH_FAILED", postId, { jobId: job.jobId, category: error.category, code: error.code, subcode: error.subcode, stage: note });
    // Meta has already copied the images into any FINISHED container, so the public copies can go.
    await removeMedia(job.mediaToken);
  }
  return n === 1;
}

/** Outcome unknown (Meta unreachable right after media_publish): stay PUBLISHING + not editable until reconciled. */
async function markUnknown(postId: string, job: PublishJob, message: string): Promise<void> {
  job.stage = "UNKNOWN";
  job.error = { category: "UNAVAILABLE", message, code: null, subcode: null };
  await saveJob(postId, job, "Outcome unknown — waiting for a status check");
  await prisma.instagramPost.updateMany({ where: { id: postId, status: "PUBLISHING" }, data: { publishError: message } });
}

// ---- Start (claim) ---------------------------------------------------------------------------

export interface StartPublishInput {
  postId: string;
  expectedRevision: number;
  requestKey: string;
  format: PublishFormat;
  actorId: string;
}

export interface PublishPreflight {
  caption: string;
  slideCount: number;
  username: string;
}

function captionChecks(caption: string) {
  if (caption.length > CAPTION_MAX) throw new StudioError(`The caption with hashtags is ${caption.length} characters; Instagram allows ${CAPTION_MAX}.`);
  const tags = caption.match(/#[A-Za-z0-9_]+/g) ?? [];
  if (tags.length > HASHTAGS_MAX) throw new StudioError(`Instagram allows at most ${HASHTAGS_MAX} hashtags.`);
}

/** Every server-side condition for publishing. Throws StudioError with the reason. */
async function assertPublishable(post: InstagramPost, expectedRevision: number, format: PublishFormat): Promise<PublishPreflight> {
  if (post.supersededAt) throw new StudioError("This is an older version and can't be published.");
  if (post.igMediaId || post.status === "PUBLISHED") throw new StudioError("This post is already published on Instagram.", "conflict");
  if (post.status === "PUBLISHING") throw new StudioError("This post is already being published.", "conflict");
  if (post.status !== "READY" && post.status !== "FAILED") throw new StudioError("Only an approved (Ready) post can be published. Review it and Mark Ready first.", "blocked");
  if (post.revision !== expectedRevision) throw new StudioError("This post was changed in another window. Reload it first.", "conflict");
  const review = (post.review ?? {}) as { revision?: number; acknowledged?: string[] };
  if (!post.reviewedAt || !post.reviewedById || review.revision !== post.revision) {
    throw new StudioError("This exact version has not been approved. Review it and Mark Ready first.", "blocked");
  }
  const settings = await getStudioSettings();
  const issues = issuesFor(post, await currentSourceHash(post.questionId), settings);
  const blocked = blockingIssues(issues);
  if (blocked.length) throw new StudioError(`Publishing blocked: ${blocked[0].message}`, "blocked");
  const unacked = warningCodes(issues).filter((c) => !(review.acknowledged ?? []).includes(c));
  if (unacked.length) throw new StudioError("New review warnings appeared since approval. Send it back to Draft and review again.", "blocked");

  const design = normalizeDesign(post.design);
  const slideCount = format === "IMAGE" ? 1 : design.modules.length;
  if (format === "CAROUSEL" && (slideCount < CAROUSEL_MIN || slideCount > CAROUSEL_MAX)) throw new StudioError(`A carousel needs ${CAROUSEL_MIN}–${CAROUSEL_MAX} slides.`);
  const caption = composeCaption(normalizeContent(post.content));
  captionChecks(caption);
  return { caption, slideCount, username: EXPECTED_INSTAGRAM_USERNAME };
}

/** Read-only check shown in the confirmation dialog. */
export async function publishPreflight(postId: string, expectedRevision: number, format: PublishFormat): Promise<PublishPreflight & { enabled: boolean; configured: boolean }> {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  const pre = await assertPublishable(post, expectedRevision, format);
  const [sw] = await Promise.all([getPublishingSwitch()]);
  return { ...pre, enabled: sw.enabled, configured: publishingApi() !== null };
}

/**
 * Atomically claims the post for one publish job. Returns the job to run, or
 * `existing: true` when this exact request (same requestKey) already started
 * one — a re-sent click never starts a second job.
 */
export async function startPublish(input: StartPublishInput): Promise<{ job: PublishJob; existing: boolean }> {
  const sw = await getPublishingSwitch();
  if (!sw.enabled) throw new StudioError("Direct publishing is turned off (Admin → Instagram → Settings).", "blocked");
  if (!publishingApi()) throw new StudioError("No Instagram access token / user ID is installed on the server.", "blocked");

  const post = await prisma.instagramPost.findUnique({ where: { id: input.postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  const prev = readJob(post.publishJob);
  if (post.status === "PUBLISHING" && prev?.requestKey === input.requestKey) return { job: prev, existing: true };
  const pre = await assertPublishable(post, input.expectedRevision, input.format);

  // A FAILED job whose carousel container is still usable is published with that SAME container (it can only become one post).
  const reuse = post.status === "FAILED" && prev && prev.containerId && prev.revision === post.revision && prev.format === input.format && prev.caption === pre.caption && Date.now() - Date.parse(prev.startedAt) < 20 * 3_600_000;
  const job: PublishJob = {
    jobId: crypto.randomUUID(),
    requestKey: input.requestKey,
    leaseId: crypto.randomUUID(),
    format: input.format,
    revision: post.revision,
    actorId: input.actorId,
    stage: "PREPARING",
    slideCount: pre.slideCount,
    caption: pre.caption,
    mediaToken: null,
    childIds: reuse ? prev!.childIds : [],
    containerId: reuse ? prev!.containerId : null,
    mediaId: null,
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    publishRequestedAt: null,
    finishedAt: null,
    error: null,
    log: [{ at: nowIso(), note: reuse ? "Retry confirmed — reusing the prepared Instagram container" : "Publish confirmed by admin" }],
  };
  try {
    const res = await prisma.instagramPost.updateMany({
      where: { id: post.id, status: post.status, revision: post.revision, igMediaId: null, supersededAt: null },
      data: { status: "PUBLISHING", publishError: null, publishJob: json(job), updatedById: input.actorId },
    });
    if (res.count !== 1) {
      const now = await prisma.instagramPost.findUnique({ where: { id: post.id } });
      const nowJob = readJob(now?.publishJob);
      if (now?.status === "PUBLISHING" && nowJob?.requestKey === input.requestKey) return { job: nowJob, existing: true };
      throw new StudioError(now?.status === "PUBLISHING" ? "This post is already being published." : "This post changed in the meantime. Reload it first.", "conflict");
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new StudioError("Another version of this question is being published right now.", "conflict");
    throw e;
  }
  await audit(input.actorId, "INSTAGRAM_PUBLISH_STARTED", post.id, { jobId: job.jobId, format: job.format, slides: job.slideCount, revision: job.revision, reuseContainer: !!reuse });
  return { job, existing: false };
}

// ---- Worker -----------------------------------------------------------------------------------

function pollIntervals(): number[] {
  const base = Number(process.env.INSTAGRAM_PUBLISH_POLL_MS);
  const unit = Number.isFinite(base) && base > 0 && base <= 10_000 ? base : 3_000;
  // ~5 minutes in total with the default unit (Meta: check about once a minute, at most 5 minutes; images are usually instant).
  return [unit / 3, unit, unit, unit * 2, unit * 3, unit * 5, unit * 10, unit * 20, unit * 20, unit * 20, unit * 20];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StatusCode = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED" | "UNKNOWN";

async function readStatus(api: PublishingApi, id: string): Promise<{ code: StatusCode; fail: GraphFail | null; detail: string | null }> {
  const r = await api.containerStatus(id);
  if (!r.ok) return { code: "UNKNOWN", fail: r, detail: null };
  const code = String(r.body.status_code ?? "").toUpperCase();
  const known = ["FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED", "PUBLISHED"].includes(code) ? (code as StatusCode) : "UNKNOWN";
  return { code: known, fail: null, detail: typeof r.body.status === "string" ? r.body.status.slice(0, 200) : null };
}

/** Waits until a container is FINISHED (or PUBLISHED). Heartbeats every round. */
async function waitFinished(postId: string, job: PublishJob, api: PublishingApi, id: string): Promise<{ ok: true; code: "FINISHED" | "PUBLISHED" } | { ok: false; error: NonNullable<PublishJob["error"]> } | { ok: false; lost: true }> {
  let lastFail: GraphFail | null = null;
  for (const wait of [0, ...pollIntervals()]) {
    if (wait) await sleep(wait);
    const s = await readStatus(api, id);
    if (s.code === "FINISHED" || s.code === "PUBLISHED") return { ok: true, code: s.code };
    if (s.code === "ERROR") return { ok: false, error: { category: "PROCESSING", message: `Instagram could not process the media${s.detail ? `: ${s.detail}` : "."}`, code: null, subcode: null } };
    if (s.code === "EXPIRED") return { ok: false, error: { category: "PROCESSING", message: "The Instagram container expired before publishing.", code: null, subcode: null } };
    lastFail = s.fail;
    if (s.fail && s.fail.kind === "http" && !isRateLimit(s.fail) && (s.fail.httpStatus ?? 0) < 500) {
      const c = classifyPublishFailure(s.fail);
      return { ok: false, error: { ...c, code: s.fail.code, subcode: s.fail.subcode } };
    }
    if (!(await saveJob(postId, job))) return { ok: false, lost: true };
  }
  const c = lastFail ? classifyPublishFailure(lastFail) : { category: "PROCESSING" as const, message: "Instagram did not finish processing the media within 5 minutes." };
  return { ok: false, error: { ...c, code: lastFail?.code ?? null, subcode: lastFail?.subcode ?? null } };
}

const normCaption = (s: string) => s.replace(/\s+/g, " ").trim();

/** Looks for this job's post among the account's recent media (caption + time). */
async function findPublishedMedia(api: PublishingApi, userId: string, job: PublishJob): Promise<{ found: { id: string; permalink: string | null } | null; checked: boolean }> {
  const r = await api.recentMedia(userId);
  if (!r.ok) return { found: null, checked: false };
  const rows = Array.isArray(r.body.data) ? (r.body.data as Record<string, unknown>[]) : [];
  const since = Date.parse(job.startedAt) - 10 * 60_000;
  const want = normCaption(job.caption);
  for (const m of rows) {
    const ts = Date.parse(String(m.timestamp ?? "")) || 0;
    if (typeof m.id === "string" && typeof m.caption === "string" && normCaption(m.caption) === want && ts >= since) {
      return { found: { id: m.id, permalink: typeof m.permalink === "string" ? m.permalink : null }, checked: true };
    }
  }
  return { found: null, checked: true };
}

async function permalinkOf(api: PublishingApi, mediaId: string): Promise<string | null> {
  const r = await api.mediaInfo(mediaId);
  if (!r.ok) return null;
  const p = r.body.permalink;
  return typeof p === "string" && /^https:\/\/(www\.)?instagram\.com\//.test(p) ? p : null;
}

function idOf(r: GraphOk): string | null {
  const id = r.body.id;
  const s = typeof id === "string" ? id : typeof id === "number" ? String(id) : "";
  return /^\d{5,30}$/.test(s) ? s : null;
}

async function loadRenderInput(postId: string) {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) throw new Error("post vanished");
  const settings = await getStudioSettings();
  return {
    post,
    input: {
      snapshot: post.sourceSnapshot as unknown as SourceSnapshot,
      content: normalizeContent(post.content),
      design: normalizeDesign(post.design),
      series: post.series,
      seriesStats: (post.seriesStats as SeriesStats | null) ?? null,
      questionNumber: post.questionNumber,
      questionNumberVerified: post.questionNumberVerified,
      settings,
    },
  };
}

/** Renders + validates the JPEGs Meta will fetch. */
async function renderSlides(postId: string, job: PublishJob): Promise<Buffer[]> {
  const { post, input } = await loadRenderInput(postId);
  if (post.revision !== job.revision) throw new Error("revision changed during publish");
  const out: Buffer[] = [];
  for (let i = 0; i < job.slideCount; i++) {
    const jpeg = await renderSlideJpeg(input, i);
    const meta = await sharp(jpeg).metadata();
    if (meta.format !== "jpeg" || meta.width !== SLIDE_WIDTH || meta.height !== SLIDE_HEIGHT || jpeg.length > MAX_JPEG_BYTES) {
      throw new StudioError(`Slide ${i + 1} is not a valid ${SLIDE_WIDTH}×${SLIDE_HEIGHT} JPEG under 8 MB.`);
    }
    out.push(jpeg);
  }
  return out;
}

/**
 * Runs (or continues) a claimed job to PUBLISHED / FAILED / UNKNOWN. Never
 * throws. `api` is injectable for tests; production uses the server token.
 */
export async function runPublishJob(postId: string, leaseId: string, apiOverride?: PublishingApi | null): Promise<PublishView> {
  const row = await prisma.instagramPost.findUnique({ where: { id: postId } });
  const job = readJob(row?.publishJob);
  if (!row || !job || row.status !== "PUBLISHING" || job.leaseId !== leaseId) return row ? publishView(row) : publishView({ status: "FAILED", publishJob: null, igMediaId: null, igPermalink: null, publishedAt: null, publishError: "Post not found" });
  const api = apiOverride === undefined ? publishingApi() : apiOverride;
  const fail = async (error: NonNullable<PublishJob["error"]>, note: string) => {
    await markFailed(postId, job, error, note);
  };
  try {
    await sweepExpiredMedia().catch(() => 0);
    if (!api) {
      await fail({ category: "NOT_CONFIGURED", message: "No Instagram access token / user ID is installed on the server.", code: null, subcode: null }, "Not configured");
      return finalView(postId);
    }

    // 1. The token must still belong to the pinned account.
    const acct = await api.verifyAccount();
    if (!acct.ok) {
      const c = acct.fail ? classifyPublishFailure(acct.fail) : { category: "WRONG_ACCOUNT" as const, message: acct.message };
      await fail({ ...c, code: acct.fail?.code ?? null, subcode: acct.fail?.subcode ?? null }, "Account check failed");
      return finalView(postId);
    }
    const userId = acct.target.userId;
    if (!(await saveJob(postId, job, `Account verified: @${acct.target.username}`))) return finalView(postId);

    // 2. Quota.
    const q = await api.quota(userId);
    if (q.ok) {
      const row0 = (Array.isArray(q.body.data) ? q.body.data[0] : null) as { quota_usage?: unknown; config?: { quota_total?: unknown } } | null;
      const usage = typeof row0?.quota_usage === "number" ? row0.quota_usage : 0;
      const total = typeof row0?.config?.quota_total === "number" ? row0.config.quota_total : null;
      if (total !== null && usage >= total) {
        await fail({ category: "QUOTA", message: `The Instagram publishing limit is used up (${usage}/${total} in 24 h). Retry later.`, code: null, subcode: null }, "Quota exhausted");
        return finalView(postId);
      }
    } else if (q.kind === "http" && (isTokenError(q) || isPermissionError(q))) {
      const c = classifyPublishFailure(q);
      await fail({ ...c, code: q.code, subcode: q.subcode }, "Quota check failed");
      return finalView(postId);
    }

    // 3. Reusing a container from a failed attempt: ask Meta what it is now.
    if (job.containerId) {
      const s = await readStatus(api, job.containerId);
      if (s.code === "PUBLISHED") {
        const m = await findPublishedMedia(api, userId, job);
        await markPublished(postId, job, m.found?.id ?? null, m.found?.permalink ?? null, "Container was already published — recorded, not published again");
        return finalView(postId);
      }
      if (s.code !== "FINISHED") {
        job.containerId = null;
        job.childIds = [];
        if (!(await saveJob(postId, job, `Previous container not usable (${s.code}) — preparing new media`))) return finalView(postId);
      }
    }

    if (!job.containerId) {
      // 4. Immutable media snapshot at a random, expiring public URL.
      let jpegs: Buffer[];
      try {
        jpegs = await renderSlides(postId, job);
      } catch (e) {
        const message = e instanceof StudioError ? e.message : "The slides could not be rendered.";
        if (!(e instanceof StudioError)) console.error("[instagram-publish] render", (e as Error)?.message);
        await fail({ category: "INVALID_MEDIA", message, code: null, subcode: null }, "Render failed");
        return finalView(postId);
      }
      job.mediaToken = await writeMedia(postId, job.jobId, jpegs);
      job.stage = "MEDIA_READY";
      if (!(await saveJob(postId, job, `${jpegs.length} slide image(s) prepared`))) return finalView(postId);

      // 5. Containers.
      job.stage = "CONTAINERS";
      if (job.format === "IMAGE") {
        const r = await api.createImageContainer(userId, mediaUrl(job.mediaToken, 0), { caption: job.caption });
        if (!r.ok || !idOf(r)) {
          const f = r.ok ? null : r;
          await fail(f ? { ...classifyPublishFailure(f), code: f.code, subcode: f.subcode } : { category: "OTHER", message: "Instagram returned no container id.", code: null, subcode: null }, "Image container failed");
          return finalView(postId);
        }
        job.containerId = idOf(r);
        if (!(await saveJob(postId, job, "Image container created"))) return finalView(postId);
      } else {
        for (let i = 0; i < job.slideCount; i++) {
          const r = await api.createImageContainer(userId, mediaUrl(job.mediaToken, i), { carouselItem: true });
          if (!r.ok || !idOf(r)) {
            const f = r.ok ? null : r;
            await fail(f ? { ...classifyPublishFailure(f), code: f.code, subcode: f.subcode } : { category: "OTHER", message: "Instagram returned no container id.", code: null, subcode: null }, `Slide ${i + 1} container failed`);
            return finalView(postId);
          }
          job.childIds = [...job.childIds, idOf(r)!];
          if (!(await saveJob(postId, job, `Slide ${i + 1} uploaded`))) return finalView(postId);
        }
        job.stage = "PROCESSING";
        for (const [i, child] of job.childIds.entries()) {
          const w = await waitFinished(postId, job, api, child);
          if (!w.ok) {
            if ("lost" in w) return finalView(postId);
            await fail(w.error, `Slide ${i + 1} processing failed`);
            return finalView(postId);
          }
        }
        const c = await api.createCarouselContainer(userId, job.childIds, job.caption);
        if (!c.ok || !idOf(c)) {
          const f = c.ok ? null : c;
          await fail(f ? { ...classifyPublishFailure(f), code: f.code, subcode: f.subcode } : { category: "OTHER", message: "Instagram returned no carousel id.", code: null, subcode: null }, "Carousel container failed");
          return finalView(postId);
        }
        job.containerId = idOf(c);
        if (!(await saveJob(postId, job, "Carousel container created"))) return finalView(postId);
      }

      job.stage = "PROCESSING";
      const w = await waitFinished(postId, job, api, job.containerId!);
      if (!w.ok) {
        if ("lost" in w) return finalView(postId);
        await fail(w.error, "Container processing failed");
        return finalView(postId);
      }
      if (w.code === "PUBLISHED") {
        const m = await findPublishedMedia(api, userId, job);
        await markPublished(postId, job, m.found?.id ?? null, m.found?.permalink ?? null, "Container already published — recorded");
        return finalView(postId);
      }
    }

    // 6. Publish. The stage is stored first so an interrupted call is never repeated blindly.
    job.stage = "PUBLISH_REQUESTED";
    job.publishRequestedAt = nowIso();
    if (!(await saveJob(postId, job, "Publishing…"))) return finalView(postId);
    const p = await api.publishContainer(userId, job.containerId!);
    const mediaId = p.ok ? idOf(p) : null;
    if (mediaId) {
      const permalink = await permalinkOf(api, mediaId);
      await markPublished(postId, job, mediaId, permalink, "Published");
      return finalView(postId);
    }
    // No clear answer: find out what actually happened before deciding anything.
    await settle(postId, job, api, userId, p.ok ? null : p);
    return finalView(postId);
  } catch (e) {
    console.error("[instagram-publish] job error", (e as Error)?.message);
    const cur = await prisma.instagramPost.findUnique({ where: { id: postId } });
    const curJob = readJob(cur?.publishJob);
    if (cur?.status === "PUBLISHING" && curJob?.leaseId === leaseId) {
      if (curJob.stage === "PUBLISH_REQUESTED" || curJob.stage === "UNKNOWN") await markUnknown(postId, curJob, "The publish step was interrupted. Use “Check status” before doing anything else.");
      else await markFailed(postId, curJob, { category: "OTHER", message: "Publishing stopped because of a server error. Nothing was published — you can retry.", code: null, subcode: null }, "Server error before publishing");
    }
    return finalView(postId);
  }
}

/** After an unclear media_publish: container status + recent media decide; never publishes. */
async function settle(postId: string, job: PublishJob, api: PublishingApi, userId: string, fail: GraphFail | null): Promise<void> {
  const tries = fail && (fail.kind === "timeout" || fail.kind === "network" || (fail.httpStatus ?? 0) >= 500) ? 3 : 1;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(pollIntervals()[1] ?? 3_000);
    const s = await readStatus(api, job.containerId!);
    if (s.code === "PUBLISHED") {
      const m = await findPublishedMedia(api, userId, job);
      const permalink = m.found ? (m.found.permalink ?? (await permalinkOf(api, m.found.id))) : null;
      await markPublished(postId, job, m.found?.id ?? null, permalink, "Confirmed published by container status");
      return;
    }
    if (s.code === "FINISHED" || s.code === "ERROR" || s.code === "EXPIRED") {
      const m = await findPublishedMedia(api, userId, job);
      if (m.found) {
        await markPublished(postId, job, m.found.id, m.found.permalink ?? (await permalinkOf(api, m.found.id)), "Found on the account");
        return;
      }
      if (m.checked) {
        const c = fail ? classifyPublishFailure(fail) : { category: "OTHER" as const, message: "Instagram did not confirm the publication." };
        const keep = s.code === "FINISHED" ? "" : ` (container ${s.code.toLowerCase()})`;
        await markFailed(postId, job, { ...c, message: `${c.message} Nothing was published${keep} — you can retry safely.`, code: fail?.code ?? null, subcode: fail?.subcode ?? null }, "Publish not completed (verified)");
        if (s.code !== "FINISHED") await clearContainer(postId);
        return;
      }
    }
  }
  await markUnknown(postId, job, "Instagram did not confirm whether the post went live. Use “Check status” — do not retry until it is resolved.");
}

/** A dead container can't be reused on retry. */
async function clearContainer(postId: string) {
  const row = await prisma.instagramPost.findUnique({ where: { id: postId } });
  const job = readJob(row?.publishJob);
  if (!row || !job || row.status !== "FAILED") return;
  await prisma.instagramPost.updateMany({ where: { id: postId, status: "FAILED" }, data: { publishJob: json({ ...job, containerId: null, childIds: [] }) } });
}

async function finalView(postId: string): Promise<PublishView> {
  const row = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!row) return publishView({ status: "FAILED", publishJob: null, igMediaId: null, igPermalink: null, publishedAt: null, publishError: "Post not found" });
  return publishView(row);
}

// ---- Status + reconciliation ---------------------------------------------------------------

/**
 * Resolves a PUBLISHING post whose worker died or whose outcome is unknown.
 * Read-only towards Meta: it asks what happened and records it; it never
 * creates containers or publishes. Also fills a missing permalink.
 */
export async function reconcilePublish(postId: string, actorId: string, apiOverride?: PublishingApi | null): Promise<PublishView> {
  const row = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!row) throw new StudioError("This post no longer exists.", "not-found");
  const api = apiOverride === undefined ? publishingApi() : apiOverride;
  const job = readJob(row.publishJob);

  if (row.status === "PUBLISHED") {
    if (row.igMediaId && !row.igPermalink && api) {
      const permalink = await permalinkOf(api, row.igMediaId);
      if (permalink) await prisma.instagramPost.updateMany({ where: { id: postId, status: "PUBLISHED", igPermalink: null }, data: { igPermalink: permalink } });
    }
    return finalView(postId);
  }
  if (row.status !== "PUBLISHING") return publishView(row);
  if (job && job.stage !== "UNKNOWN" && !isStale(job)) return publishView(row); // a live worker owns it

  // Take over the lease (CAS) so a zombie worker can't write afterwards.
  const taken: PublishJob = job
    ? { ...job, leaseId: crypto.randomUUID() }
    : ({ jobId: "legacy", requestKey: "", leaseId: crypto.randomUUID(), format: "CAROUSEL", revision: row.revision, actorId, stage: "UNKNOWN", slideCount: 0, caption: composeCaption(normalizeContent(row.content)), mediaToken: null, childIds: [], containerId: null, mediaId: null, startedAt: row.updatedAt.toISOString(), heartbeatAt: nowIso(), publishRequestedAt: null, finishedAt: null, error: null, log: [] } as PublishJob);
  const n = await prisma.$executeRaw`
    UPDATE "InstagramPost" SET "publishJob" = ${JSON.stringify({ ...taken, heartbeatAt: nowIso(), log: [...taken.log, { at: nowIso(), note: "Status check started" }].slice(-40) })}::jsonb
    WHERE "id" = ${postId} AND "status" = 'PUBLISHING' AND ("publishJob" IS NULL OR "publishJob"->>'leaseId' = ${job?.leaseId ?? ""})`;
  if (n !== 1) return finalView(postId);
  taken.heartbeatAt = nowIso();
  await audit(actorId, "INSTAGRAM_PUBLISH_RECONCILE", postId, { jobId: taken.jobId, stage: taken.stage });

  // media_publish was never called → nothing can have been published.
  if (taken.stage !== "PUBLISH_REQUESTED" && taken.stage !== "UNKNOWN") {
    await markFailed(postId, taken, { category: "INTERRUPTED", message: "Publishing was interrupted (server restart) before anything was sent for publication. Nothing was published — you can retry.", code: null, subcode: null }, "Interrupted before publish (verified)");
    return finalView(postId);
  }
  if (!api) {
    await markUnknown(postId, taken, "Can't check Instagram: no token installed. The outcome is still unknown.");
    return finalView(postId);
  }
  const acct = await api.verifyAccount();
  if (!acct.ok || !taken.containerId) {
    if (acct.ok && !taken.containerId) {
      // No container recorded: only the account's recent media can tell.
      const m = await findPublishedMedia(api, acct.target.userId, taken);
      if (m.found) await markPublished(postId, taken, m.found.id, m.found.permalink ?? (await permalinkOf(api, m.found.id)), "Found on the account");
      else if (m.checked) await markFailed(postId, taken, { category: "INTERRUPTED", message: "No matching post was found on Instagram. Nothing was published — you can retry.", code: null, subcode: null }, "Not found on the account (verified)");
      else await markUnknown(postId, taken, "Instagram could not be reached. The outcome is still unknown — check again later.");
      return finalView(postId);
    }
    await markUnknown(postId, taken, `Instagram could not be checked (${acct.ok ? "no container" : acct.message}). The outcome is still unknown.`);
    return finalView(postId);
  }
  await settle(postId, taken, api, acct.target.userId, null);
  return finalView(postId);
}

/** Status for the editor's polling. A dead worker is reconciled automatically (read-only). */
export async function getPublishStatus(postId: string, actorId: string, apiOverride?: PublishingApi | null): Promise<PublishView> {
  const row = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!row) throw new StudioError("This post no longer exists.", "not-found");
  if (row.status === "PUBLISHING" && isStale(readJob(row.publishJob))) return reconcilePublish(postId, actorId, apiOverride);
  return publishView(row);
}
