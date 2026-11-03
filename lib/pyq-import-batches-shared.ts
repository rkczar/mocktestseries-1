/**
 * Previous Year Paper import batches — pure rules and shared types (safe for
 * client components). The server side lives in lib/pyq-import-batches.ts.
 *
 * A batch is an existing BulkImportRun (Question.importBatchId). The AI
 * Question Importer also writes through a BulkImportRun (lib/ai-import/adapter.ts),
 * so one record identifies every import. Questions that never came from an
 * import (added by hand / from the Question Bank) form the "manual" group.
 * Batch identity is NEVER guessed from question codes or creation order.
 */

export const MANUAL_BATCH = "manual";

export type BatchLabel = "ORIGINAL IMPORT" | "NEW IMPORT" | "CORRECTED IMPORT" | "PREVIOUS IMPORT" | "RETIRED IMPORT";

export type BatchStatus =
  | "RETIRED"
  | "DRAFT"
  | "PUBLISHED"
  | "PARTIALLY PUBLISHED"
  | "ARCHIVED"
  | "ROLLED BACK"
  | "NOT IMPORTED"
  | "FAILED";

export interface BatchLabelInput {
  key: string;
  createdAt: Date;
  /** Questions of this paper linked to the batch now. */
  linked: number;
  /** Linked and not retired. */
  active: number;
}

/**
 * Labels every import batch of one paper from its real links and timestamps:
 * - linked to no question now (rolled back / never imported) → PREVIOUS IMPORT;
 * - every linked question retired → RETIRED IMPORT;
 * - the newest batch with live questions → CORRECTED IMPORT when an older batch
 *   of this paper was retired, ORIGINAL IMPORT when it is the first batch, else NEW IMPORT;
 * - any other batch with live questions → ORIGINAL IMPORT (if first) or PREVIOUS IMPORT.
 * `isOriginal` marks the first batch that ever linked questions to the paper.
 */
export function labelBatches(batches: BatchLabelInput[]): Map<string, { label: BatchLabel; isOriginal: boolean }> {
  const sorted = [...batches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key));
  const withLinks = sorted.filter((b) => b.linked > 0);
  const originalKey = withLinks[0]?.key;
  const latestActiveKey = withLinks.filter((b) => b.active > 0).at(-1)?.key;
  const out = new Map<string, { label: BatchLabel; isOriginal: boolean }>();
  for (const b of sorted) {
    let label: BatchLabel;
    if (b.linked === 0) label = "PREVIOUS IMPORT";
    else if (b.active === 0) label = "RETIRED IMPORT";
    else if (b.key === latestActiveKey) {
      const retiredBefore = withLinks.some((o) => o.active === 0 && o.createdAt.getTime() <= b.createdAt.getTime() && o.key !== b.key);
      label = retiredBefore ? "CORRECTED IMPORT" : b.key === originalKey ? "ORIGINAL IMPORT" : "NEW IMPORT";
    } else label = b.key === originalKey ? "ORIGINAL IMPORT" : "PREVIOUS IMPORT";
    out.set(b.key, { label, isOriginal: b.key === originalKey });
  }
  return out;
}

const STAGING_RUN_STATUSES = new Set(["PENDING", "UPLOADED", "VALIDATING", "READY"]);

/** One status for a batch, from its question counts (never from the run's own status alone). */
export function batchStatus(c: {
  linked: number;
  retired: number;
  published: number;
  draft: number;
  rolledBack: number;
  runStatus: string | null;
}): BatchStatus {
  if (c.linked === 0) {
    if (c.rolledBack > 0) return "ROLLED BACK";
    if (c.runStatus && STAGING_RUN_STATUSES.has(c.runStatus)) return "NOT IMPORTED";
    return "FAILED";
  }
  const active = c.linked - c.retired;
  if (active === 0) return "RETIRED";
  if (c.published === active) return "PUBLISHED";
  if (c.published === 0) return c.draft > 0 ? "DRAFT" : "ARCHIVED";
  return "PARTIALLY PUBLISHED";
}

/** Why a selected question cannot be published from a batch (server-side codes). */
export const BATCH_BLOCK_REASONS = {
  NOT_FOUND: "Question not found",
  NOT_IN_PAPER: "Not in this paper",
  NOT_IN_BATCH: "Not in this import batch",
  RETIRED: "Retired question",
  ARCHIVED: "Archived (not retired)",
  AI_VARIANT: "AI variant",
  QUESTION_TEXT: "Question text missing",
  OPTIONS: "Options incomplete",
  ANSWER_KEY: "Correct answer invalid",
  QUESTION_TYPE: "Unsupported question type",
  TAXONOMY: "Subject / exam link invalid",
  REVIEW_REQUIRED: "Review required",
  IMAGE_MISSING: "Image file missing",
  DUPLICATE: "Duplicate / invalid publishing state",
  NUMBER: "Paper question number missing",
} as const;
export type BatchBlockCode = keyof typeof BATCH_BLOCK_REASONS;

export interface BatchPublishItem {
  id: string;
  code: string | null;
  number: number | null;
  reasons: { code: BatchBlockCode; detail: string }[];
}

export interface BatchPublishPreview {
  paperId: string;
  batchKey: string;
  requested: number;
  eligible: BatchPublishItem[];
  alreadyPublished: BatchPublishItem[];
  blocked: BatchPublishItem[];
}

export interface BatchPublishResult extends BatchPublishPreview {
  publishedCount: number;
  published: { id: string; code: string | null }[];
  /** True when this exact request (requestId) had already run — nothing was done twice. */
  replayed: boolean;
}

/** Max questions one preview / publish / review call accepts. */
export const BATCH_ACTION_MAX_IDS = 1000;
