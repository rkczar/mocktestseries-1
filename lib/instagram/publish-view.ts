import type { InstagramPost } from "@prisma/client";

/**
 * Publish job state shapes + the status view shown in the editor (no I/O).
 * See lib/instagram/publish.ts for the job itself.
 */

/** A worker that hasn't written a heartbeat for this long is presumed dead (longest single Meta call is 45 s). */
export const STALE_MS = 3 * 60_000;

export type PublishFormat = "CAROUSEL" | "IMAGE";
export type PublishStage = "PREPARING" | "MEDIA_READY" | "CONTAINERS" | "PROCESSING" | "PUBLISH_REQUESTED" | "PUBLISHED" | "FAILED" | "UNKNOWN";
export type PublishErrorCategory =
  | "TOKEN_EXPIRED"
  | "TOKEN_INVALID"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "QUOTA"
  | "INVALID_MEDIA"
  | "PROCESSING"
  | "UNAVAILABLE"
  | "WRONG_ACCOUNT"
  | "NOT_CONFIGURED"
  | "INTERRUPTED"
  | "OTHER";

export interface PublishJob {
  jobId: string;
  requestKey: string;
  leaseId: string;
  format: PublishFormat;
  revision: number;
  actorId: string;
  stage: PublishStage;
  slideCount: number;
  caption: string;
  mediaToken: string | null;
  childIds: string[];
  containerId: string | null;
  mediaId: string | null;
  startedAt: string;
  heartbeatAt: string;
  publishRequestedAt: string | null;
  finishedAt: string | null;
  error: { category: PublishErrorCategory; message: string; code: number | null; subcode: number | null } | null;
  /** Steps for the admin (no secrets). */
  log: { at: string; note: string }[];
}

export interface PublishView {
  status: InstagramPost["status"];
  stage: PublishStage | null;
  format: PublishFormat | null;
  slideCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  stale: boolean;
  igMediaId: string | null;
  igPermalink: string | null;
  publishedAt: string | null;
  publishError: string | null;
  errorCategory: PublishErrorCategory | null;
  /** FAILED and the failure was confirmed to have published nothing. */
  canRetry: boolean;
  /** PUBLISHING with an unknown outcome or a dead worker: "Check status" is offered. */
  needsReconcile: boolean;
  log: { at: string; note: string }[];
}

export function readJob(raw: unknown): PublishJob | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as PublishJob;
  return typeof j.jobId === "string" && typeof j.leaseId === "string" ? j : null;
}

export function isStale(job: PublishJob | null, now = Date.now()): boolean {
  return !!job && now - Date.parse(job.heartbeatAt) > STALE_MS;
}

export function publishView(post: Pick<InstagramPost, "status" | "publishJob" | "igMediaId" | "igPermalink" | "publishedAt" | "publishError">): PublishView {
  const job = readJob(post.publishJob);
  const stale = post.status === "PUBLISHING" && isStale(job);
  return {
    status: post.status,
    stage: job?.stage ?? null,
    format: job?.format ?? null,
    slideCount: job?.slideCount ?? null,
    startedAt: job?.startedAt ?? null,
    finishedAt: job?.finishedAt ?? null,
    stale,
    igMediaId: post.igMediaId,
    igPermalink: post.igPermalink,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    publishError: post.publishError,
    errorCategory: job?.error?.category ?? null,
    canRetry: post.status === "FAILED",
    needsReconcile: post.status === "PUBLISHING" && (stale || job?.stage === "UNKNOWN" || !job),
    log: (job?.log ?? []).slice(-20),
  };
}

