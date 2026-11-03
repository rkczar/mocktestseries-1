import "server-only";
import { Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { reviewTriggerWarnings } from "@/lib/bulk-import";
import { evaluatePublishEligibility } from "@/lib/question-publish-policy";
import { QUESTION_TYPES } from "@/lib/question-types";
import {
  BATCH_ACTION_MAX_IDS,
  MANUAL_BATCH,
  batchStatus,
  labelBatches,
  type BatchBlockCode,
  type BatchLabel,
  type BatchPublishItem,
  type BatchPublishPreview,
  type BatchPublishResult,
  type BatchStatus,
} from "@/lib/pyq-import-batches-shared";

/**
 * Previous Year Paper import batches (server side). See
 * lib/pyq-import-batches-shared.ts for the batch model and labels and
 * docs/QUESTION-RETIREMENT.md for the retirement rules this never weakens:
 *
 * - a retired question is never selectable, publishable or reviewable here;
 * - publishing reuses lib/question-publish-policy.ts (the rule every other
 *   publish path uses) and adds the paper/batch checks below;
 * - one batch, one paper: an id from another batch or paper is refused, never
 *   silently published;
 * - publish runs in ONE transaction under a per-paper advisory lock, re-checks
 *   every condition in its UPDATE, and replays (does nothing) when the same
 *   request id comes back — a double click can never publish twice.
 */

type Tx = Prisma.TransactionClient;
type Db = typeof prisma | Tx;

const AUDIT_ENTITY = "PyqImportBatch";
const PUBLISH_ACTION = "PYQ_BATCH_PUBLISH";
const REVIEW_ACTION = "PYQ_BATCH_MARK_REVIEWED";
const OPTION_LABELS = ["A", "B", "C", "D"] as const;

/** AuditLog.entityId of a batch: the run id, or "manual:<paperId>" for the manual group. */
export function batchEntityId(paperId: string, batchKey: string): string {
  return batchKey === MANUAL_BATCH ? `${MANUAL_BATCH}:${paperId}` : batchKey;
}

function batchWhere(paperId: string, batchKey: string): Prisma.QuestionWhereInput {
  return { previousYearPaperId: paperId, importBatchId: batchKey === MANUAL_BATCH ? null : batchKey };
}

const normText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// ---------------------------------------------------------------------------
// Review reason actually behind a flag
// ---------------------------------------------------------------------------

/**
 * question id → the import warning(s) that really flagged it for review.
 * Older imports stored the FIRST warning as reviewReason even when it was an
 * informational one ("Sub-topic not provided"), so the import row is the
 * source of truth when it exists.
 */
async function reviewTriggersFor(db: Db, questionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!questionIds.length) return out;
  const rows = await db.bulkImportRow.findMany({
    where: { questionId: { in: questionIds }, status: { in: ["SUCCESS", "REPLACED"] } },
    select: { questionId: true, warnings: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  for (const r of rows) {
    const warnings = Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
    const triggers = reviewTriggerWarnings(warnings);
    if (r.questionId && triggers.length) out.set(r.questionId, triggers);
  }
  return out;
}

function reviewDetail(triggers: string[] | undefined, stored: string | null): string {
  if (triggers?.length) return `Flagged at import: ${triggers.join(" · ")}`;
  return stored ? `Flagged for review: ${stored}` : "Flagged for review — review it, then mark it reviewed.";
}

// ---------------------------------------------------------------------------
// Batch overview for the paper page
// ---------------------------------------------------------------------------

export interface PaperBatchQuestion {
  id: string;
  code: string;
  number: number | null;
  batchKey: string;
  subject: string;
  topic: string | null;
  text: string;
  status: QuestionStatus;
  retired: boolean;
  reviewRequired: boolean;
  reviewDetail: string | null;
  noCorrectAnswer: boolean;
  hasImage: boolean;
}

export interface PaperBatchHistoryEntry {
  action: "PUBLISH" | "MARK_REVIEWED";
  at: string;
  actor: string | null;
  count: number;
  blocked: number;
}

export interface PaperBatch {
  key: string;
  ordinal: number | null;
  label: BatchLabel | null;
  isOriginal: boolean;
  status: BatchStatus;
  name: string;
  fileName: string | null;
  importedAt: string | null;
  importedBy: string | null;
  runStatus: string | null;
  aiJobIds: string[];
  counts: {
    extracted: number;
    linked: number;
    draft: number;
    published: number;
    retired: number;
    archived: number;
    reviewRequired: number;
    failed: number;
    rejected: number;
    rolledBack: number;
  };
  failedRows: { rowNumber: number; message: string }[];
  history: PaperBatchHistoryEntry[];
}

export interface PaperAiJob {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  expected: number | null;
  extracted: number;
  linked: number;
  runIds: string[];
}

export interface PaperBatchOverview {
  batches: PaperBatch[];
  aiJobs: PaperAiJob[];
  questions: PaperBatchQuestion[];
}

export async function loadPaperBatchOverview(paperId: string, db: Db = prisma): Promise<PaperBatchOverview> {
  const questions = await db.question.findMany({
    where: { previousYearPaperId: paperId },
    orderBy: [{ paperQuestionNumber: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      paperQuestionNumber: true,
      importBatchId: true,
      text: true,
      status: true,
      retiredAt: true,
      reviewRequired: true,
      reviewReason: true,
      imageUrl: true,
      subject: { select: { name: true } },
      topic: { select: { name: true } },
      options: { select: { isCorrect: true } },
    },
  });

  const runIdsFromQuestions = new Set(questions.map((q) => q.importBatchId).filter((x): x is string => !!x));
  const runs = await db.bulkImportRun.findMany({
    where: { OR: [{ id: { in: [...runIdsFromQuestions] } }, { previousYearPaperId: paperId }] },
    select: {
      id: true,
      label: true,
      filename: true,
      status: true,
      totalRows: true,
      createdAt: true,
      completedAt: true,
      adminUser: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const runIds = runs.map((r) => r.id);

  const [rowStats, rolledBack, removed, failedRows, aiLinks, triggers] = await Promise.all([
    runIds.length
      ? db.bulkImportRow.groupBy({ by: ["runId", "status"], where: { runId: { in: runIds }, removedFromImport: false }, _count: { _all: true } })
      : Promise.resolve([]),
    runIds.length
      ? db.bulkImportRow.groupBy({ by: ["runId"], where: { runId: { in: runIds }, rollbackAction: { not: null } }, _count: { _all: true } })
      : Promise.resolve([]),
    runIds.length
      ? db.bulkImportRow.groupBy({ by: ["runId"], where: { runId: { in: runIds }, removedFromImport: true }, _count: { _all: true } })
      : Promise.resolve([]),
    runIds.length
      ? db.bulkImportRow.findMany({
          where: { runId: { in: runIds }, status: "FAILED", removedFromImport: false },
          select: { runId: true, rowNumber: true, errorMessage: true, errors: true },
          orderBy: [{ runId: "asc" }, { rowNumber: "asc" }],
          take: 500,
        })
      : Promise.resolve([]),
    runIds.length
      ? db.aiImportQuestion.groupBy({ by: ["bulkImportRunId", "jobId"], where: { bulkImportRunId: { in: runIds } }, _count: { _all: true } })
      : Promise.resolve([]),
    reviewTriggersFor(
      db,
      questions.filter((q) => q.reviewRequired && !q.retiredAt).map((q) => q.id)
    ),
  ]);

  const history = await db.auditLog.findMany({
    where: { entityType: AUDIT_ENTITY, entityId: { in: [...runIds, batchEntityId(paperId, MANUAL_BATCH)] } },
    select: { action: true, entityId: true, createdAt: true, metadata: true, actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const aiJobLinks = new Map<string, Set<string>>();
  for (const l of aiLinks) {
    if (!l.bulkImportRunId) continue;
    const set = aiJobLinks.get(l.bulkImportRunId) ?? new Set<string>();
    set.add(l.jobId);
    aiJobLinks.set(l.bulkImportRunId, set);
  }
  const linkedJobIds = new Set([...aiJobLinks.values()].flatMap((s) => [...s]));

  const aiJobsRaw = await db.aiImportJob.findMany({
    where: { OR: [{ previousYearPaperId: paperId }, { id: { in: [...linkedJobIds] } }] },
    select: { id: true, title: true, status: true, createdAt: true, expectedQuestions: true, _count: { select: { questions: true } } },
    orderBy: { createdAt: "asc" },
  });
  const aiLinked = aiJobsRaw.length
    ? await db.aiImportQuestion.groupBy({ by: ["jobId"], where: { jobId: { in: aiJobsRaw.map((j) => j.id) }, questionId: { not: null } }, _count: { _all: true } })
    : [];

  // --- per-batch counts ------------------------------------------------------
  type Acc = PaperBatch["counts"];
  const empty = (): Acc => ({ extracted: 0, linked: 0, draft: 0, published: 0, retired: 0, archived: 0, reviewRequired: 0, failed: 0, rejected: 0, rolledBack: 0 });
  const counts = new Map<string, Acc>();
  const keyOf = (q: { importBatchId: string | null }) => q.importBatchId ?? MANUAL_BATCH;
  for (const q of questions) {
    const c = counts.get(keyOf(q)) ?? empty();
    c.linked++;
    if (q.retiredAt) c.retired++;
    else if (q.status === QuestionStatus.PUBLISHED) c.published++;
    else if (q.status === QuestionStatus.DRAFT) c.draft++;
    else c.archived++;
    if (q.reviewRequired && !q.retiredAt) c.reviewRequired++;
    counts.set(keyOf(q), c);
  }
  for (const r of runs) {
    const c = counts.get(r.id) ?? empty();
    c.extracted = r.totalRows;
    for (const s of rowStats) if (s.runId === r.id && s.status === "FAILED") c.failed += s._count._all;
    c.rolledBack = rolledBack.find((x) => x.runId === r.id)?._count._all ?? 0;
    c.rejected = (removed.find((x) => x.runId === r.id)?._count._all ?? 0) + c.rolledBack;
    counts.set(r.id, c);
  }

  const labels = labelBatches(runs.map((r) => ({ key: r.id, createdAt: r.createdAt, linked: counts.get(r.id)!.linked, active: counts.get(r.id)!.linked - counts.get(r.id)!.retired })));

  const historyFor = (entityId: string): PaperBatchHistoryEntry[] =>
    history
      .filter((h) => h.entityId === entityId)
      .map((h) => {
        const m = (h.metadata ?? {}) as { publishedCount?: number; markedCount?: number; blockedCount?: number };
        return {
          action: h.action === PUBLISH_ACTION ? ("PUBLISH" as const) : ("MARK_REVIEWED" as const),
          at: h.createdAt.toISOString(),
          actor: h.actor?.name ?? null,
          count: (h.action === PUBLISH_ACTION ? m.publishedCount : m.markedCount) ?? 0,
          blocked: m.blockedCount ?? 0,
        };
      });

  const batches: PaperBatch[] = runs.map((r, i) => {
    const c = counts.get(r.id)!;
    const l = labels.get(r.id)!;
    return {
      key: r.id,
      ordinal: i + 1,
      label: l.label,
      isOriginal: l.isOriginal,
      status: batchStatus({ linked: c.linked, retired: c.retired, published: c.published, draft: c.draft, rolledBack: c.rolledBack, runStatus: r.status }),
      name: r.label?.trim() || r.filename,
      fileName: r.filename,
      importedAt: (r.completedAt ?? r.createdAt).toISOString(),
      importedBy: r.adminUser?.name ?? null,
      runStatus: r.status,
      aiJobIds: [...(aiJobLinks.get(r.id) ?? [])],
      counts: c,
      failedRows: failedRows
        .filter((f) => f.runId === r.id)
        .map((f) => ({
          rowNumber: f.rowNumber,
          message: f.errorMessage ?? (Array.isArray(f.errors) ? (f.errors as unknown[]).filter((e) => typeof e === "string").join(" · ") : "") ?? "Failed",
        })),
      history: historyFor(r.id),
    };
  });

  const manual = counts.get(MANUAL_BATCH);
  if (manual) {
    batches.push({
      key: MANUAL_BATCH,
      ordinal: null,
      label: null,
      isOriginal: false,
      status: batchStatus({ linked: manual.linked, retired: manual.retired, published: manual.published, draft: manual.draft, rolledBack: 0, runStatus: null }),
      name: "Added without an import",
      fileName: null,
      importedAt: null,
      importedBy: null,
      runStatus: null,
      aiJobIds: [],
      counts: manual,
      failedRows: [],
      history: historyFor(batchEntityId(paperId, MANUAL_BATCH)),
    });
  }

  const aiJobs: PaperAiJob[] = aiJobsRaw.map((j) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    createdAt: j.createdAt.toISOString(),
    expected: j.expectedQuestions,
    extracted: j._count.questions,
    linked: aiLinked.find((x) => x.jobId === j.id)?._count._all ?? 0,
    runIds: [...aiJobLinks.entries()].filter(([, jobs]) => jobs.has(j.id)).map(([runId]) => runId),
  }));

  return {
    batches,
    aiJobs,
    questions: questions.map((q) => ({
      id: q.id,
      code: q.code,
      number: q.paperQuestionNumber,
      batchKey: keyOf(q),
      subject: q.subject.name,
      topic: q.topic?.name ?? null,
      text: q.text,
      status: q.status,
      retired: !!q.retiredAt,
      reviewRequired: q.reviewRequired && !q.retiredAt,
      reviewDetail: q.reviewRequired && !q.retiredAt ? reviewDetail(triggers.get(q.id), q.reviewReason) : null,
      noCorrectAnswer: !q.options.some((o) => o.isCorrect),
      hasImage: !!q.imageUrl,
    })),
  };
}

// ---------------------------------------------------------------------------
// Validation (preview) — the same function runs inside the publish transaction
// ---------------------------------------------------------------------------

export class BatchActionError extends Error {}

function checkIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !x)) throw new BatchActionError("Invalid question selection.");
  const unique = Array.from(new Set(ids as string[]));
  if (unique.length === 0) throw new BatchActionError("Select at least one question.");
  if (unique.length > BATCH_ACTION_MAX_IDS) throw new BatchActionError(`Too many questions selected (max ${BATCH_ACTION_MAX_IDS}).`);
  return unique;
}

async function assertBatchExists(db: Db, paperId: string, batchKey: string): Promise<{ examId: string }> {
  const paper = await db.previousYearPaper.findUnique({ where: { id: paperId }, select: { examId: true } });
  if (!paper) throw new BatchActionError("Paper not found.");
  if (batchKey !== MANUAL_BATCH) {
    const run = await db.bulkImportRun.findUnique({ where: { id: batchKey }, select: { id: true } });
    if (!run) throw new BatchActionError("Import batch not found.");
  }
  return paper;
}

/**
 * Server-side validation of every selected question for "publish from this
 * batch". Never mutates. Every refusal carries its exact reason.
 */
export async function evaluateBatchPublish(input: { paperId: string; batchKey: string; ids: unknown }, db: Db = prisma): Promise<BatchPublishPreview> {
  const ids = checkIds(input.ids);
  const { paperId, batchKey } = input;
  const paper = await assertBatchExists(db, paperId, batchKey);

  const rows = await db.question.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      code: true,
      paperQuestionNumber: true,
      previousYearPaperId: true,
      importBatchId: true,
      examId: true,
      subjectId: true,
      topicId: true,
      subTopicId: true,
      text: true,
      status: true,
      retiredAt: true,
      reviewRequired: true,
      reviewReason: true,
      questionType: true,
      parentQuestionId: true,
      options: { select: { label: true, text: true, imageUrl: true } },
      assets: { select: { role: true, optionLabel: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Shared policy (review flag, answer key, option content, images, retired).
  const core = await evaluatePublishEligibility(ids, db);
  const coreBlocked = new Map(core.blocked.map((b) => [b.id, b.reasons]));

  // Taxonomy links for the paper's exam.
  const subjectIds = [...new Set(rows.map((r) => r.subjectId))];
  const topicIds = [...new Set(rows.map((r) => r.topicId).filter((x): x is string => !!x))];
  const subTopicIds = [...new Set(rows.map((r) => r.subTopicId).filter((x): x is string => !!x))];
  const [subjectLinks, topicLinks, subTopicLinks, topics, subTopics] = await Promise.all([
    db.examSubject.findMany({ where: { examId: paper.examId, subjectId: { in: subjectIds }, isActive: true }, select: { subjectId: true } }),
    topicIds.length ? db.examTopic.findMany({ where: { examId: paper.examId, topicId: { in: topicIds }, isActive: true }, select: { topicId: true } }) : [],
    subTopicIds.length ? db.examSubTopic.findMany({ where: { examId: paper.examId, subTopicId: { in: subTopicIds }, isActive: true }, select: { subTopicId: true } }) : [],
    topicIds.length ? db.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, subjectId: true } }) : [],
    subTopicIds.length ? db.subTopic.findMany({ where: { id: { in: subTopicIds } }, select: { id: true, topicId: true } }) : [],
  ]);
  const linkedSubjects = new Set(subjectLinks.map((x) => x.subjectId));
  const linkedTopics = new Set(topicLinks.map((x) => x.topicId));
  const linkedSubTopics = new Set(subTopicLinks.map((x) => x.subTopicId));
  const topicSubject = new Map(topics.map((t) => [t.id, t.subjectId]));
  const subTopicTopic = new Map(subTopics.map((s) => [s.id, s.topicId]));

  // Duplicate state: a live published question of this paper with the same text or number.
  const published = await db.question.findMany({
    where: { previousYearPaperId: paperId, status: QuestionStatus.PUBLISHED, retiredAt: null, id: { notIn: ids } },
    select: { code: true, text: true, paperQuestionNumber: true },
  });
  const publishedByText = new Map(published.map((p) => [normText(p.text), p.code]));
  const publishedByNumber = new Map(published.filter((p) => p.paperQuestionNumber != null).map((p) => [p.paperQuestionNumber!, p.code]));
  const seenText = new Map<string, string>();

  const triggers = await reviewTriggersFor(db, rows.filter((r) => r.reviewRequired).map((r) => r.id));

  const out: BatchPublishPreview = { paperId, batchKey, requested: ids.length, eligible: [], alreadyPublished: [], blocked: [] };
  for (const id of ids) {
    const q = byId.get(id);
    if (!q) {
      out.blocked.push({ id, code: null, number: null, reasons: [{ code: "NOT_FOUND", detail: "Question not found." }] });
      continue;
    }
    const item: BatchPublishItem = { id, code: q.code, number: q.paperQuestionNumber, reasons: [] };
    const add = (code: BatchBlockCode, detail: string) => {
      if (!item.reasons.some((r) => r.code === code)) item.reasons.push({ code, detail });
    };

    // Scope: one paper, one batch — checked first, never overridden.
    if (q.previousYearPaperId !== paperId) add("NOT_IN_PAPER", "This question belongs to a different paper (or to none).");
    if ((q.importBatchId ?? MANUAL_BATCH) !== batchKey) add("NOT_IN_BATCH", "This question belongs to a different import batch.");
    if (q.retiredAt) add("RETIRED", "Retired questions can never be published again.");
    if (item.reasons.length) {
      out.blocked.push(item);
      continue;
    }
    if (q.status === QuestionStatus.PUBLISHED) {
      out.alreadyPublished.push(item);
      continue;
    }
    if (q.status === QuestionStatus.ARCHIVED) add("ARCHIVED", "Archived (not retired) — move it back to Draft in the Question Bank first.");
    if (q.parentQuestionId) add("AI_VARIANT", "AI variants are published from AI Variant review, not from a paper batch.");

    // 1. Question text.
    if (!q.text.trim()) add("QUESTION_TEXT", "Question text is empty.");
    // 2. All four options A–D, each with text or an image.
    const optionImages = new Set(q.assets.filter((a) => a.role === "OPTION" && a.optionLabel).map((a) => a.optionLabel!));
    const missing = OPTION_LABELS.filter((label) => {
      const o = q.options.find((x) => x.label === label);
      return !o || (!o.text.trim() && !o.imageUrl && !optionImages.has(label));
    });
    const extra = q.options.filter((o) => !(OPTION_LABELS as readonly string[]).includes(o.label)).map((o) => o.label);
    if (missing.length) add("OPTIONS", `Option${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing or empty.`);
    if (extra.length) add("OPTIONS", `Unexpected option label${extra.length > 1 ? "s" : ""} ${extra.join(", ")} (only A–D are supported).`);
    // 4. Supported type.
    if (!(QUESTION_TYPES as readonly string[]).includes(q.questionType)) add("QUESTION_TYPE", `Question type "${q.questionType}" is not supported.`);
    // 5. Exam / subject relationships.
    if (q.examId !== paper.examId) add("TAXONOMY", "The question belongs to a different exam than this paper.");
    else if (!linkedSubjects.has(q.subjectId)) add("TAXONOMY", "Its subject is not linked to this paper's exam.");
    else if (q.topicId && topicSubject.get(q.topicId) !== q.subjectId) add("TAXONOMY", "Its topic does not belong to its subject.");
    else if (q.topicId && !linkedTopics.has(q.topicId)) add("TAXONOMY", "Its topic is not linked to this paper's exam.");
    else if (q.subTopicId && (!q.topicId || subTopicTopic.get(q.subTopicId) !== q.topicId)) add("TAXONOMY", "Its sub-topic does not belong to its topic.");
    else if (q.subTopicId && !linkedSubTopics.has(q.subTopicId)) add("TAXONOMY", "Its sub-topic is not linked to this paper's exam.");
    // 3 / 6 / images: the shared publishing policy.
    for (const r of coreBlocked.get(id) ?? []) {
      if (r.code === "REVIEW_REQUIRED") add("REVIEW_REQUIRED", reviewDetail(triggers.get(id), q.reviewReason));
      else if (r.code === "ANSWER_KEY") add("ANSWER_KEY", r.detail);
      else if (r.code === "OPTIONS") add("OPTIONS", r.detail);
      else if (r.code === "IMAGE_MISSING") add("IMAGE_MISSING", r.detail);
      else if (r.code === "QUESTION_TEXT") add("QUESTION_TEXT", r.detail);
      else if (r.code === "RETIRED") add("RETIRED", r.detail);
      else add("DUPLICATE", r.detail);
    }
    // 9. Duplicate / invalid publishing state.
    const t = normText(q.text);
    if (t && publishedByText.has(t)) add("DUPLICATE", `Same text as published question ${publishedByText.get(t)} in this paper.`);
    else if (t && seenText.has(t)) add("DUPLICATE", `Same text as ${seenText.get(t)} in this selection.`);
    if (q.paperQuestionNumber != null && publishedByNumber.has(q.paperQuestionNumber)) {
      add("DUPLICATE", `Question number ${q.paperQuestionNumber} is already used by published question ${publishedByNumber.get(q.paperQuestionNumber)}.`);
    }
    if (t && !seenText.has(t)) seenText.set(t, q.code);

    if (item.reasons.length) out.blocked.push(item);
    else out.eligible.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function lockPaper(tx: Tx, paperId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pyq-batch:${paperId}`}))`;
}

/**
 * Publishes the eligible questions among `ids` (blocked ones stay DRAFT and
 * are returned with their reasons). One transaction: lock → re-validate →
 * conditional UPDATE → audit. If the UPDATE does not hit exactly the
 * re-validated set, everything rolls back.
 */
export async function publishBatchQuestions(input: {
  paperId: string;
  batchKey: string;
  ids: unknown;
  actorId: string;
  requestId?: string | null;
}): Promise<BatchPublishResult> {
  const requestId = typeof input.requestId === "string" && input.requestId.length <= 100 ? input.requestId : null;
  const entityId = batchEntityId(input.paperId, input.batchKey);

  return prisma.$transaction(
    async (tx) => {
      await lockPaper(tx, input.paperId);

      if (requestId) {
        const prior = await tx.auditLog.findFirst({
          where: { action: PUBLISH_ACTION, entityType: AUDIT_ENTITY, entityId, metadata: { path: ["requestId"], equals: requestId } },
          select: { metadata: true },
        });
        if (prior) {
          const m = prior.metadata as unknown as { result: BatchPublishResult };
          return { ...m.result, replayed: true };
        }
      }

      const preview = await evaluateBatchPublish({ paperId: input.paperId, batchKey: input.batchKey, ids: input.ids }, tx);
      const eligibleIds = preview.eligible.map((e) => e.id);
      let publishedCount = 0;
      if (eligibleIds.length) {
        const r = await tx.question.updateMany({
          where: {
            id: { in: eligibleIds },
            ...batchWhere(input.paperId, input.batchKey),
            status: QuestionStatus.DRAFT,
            retiredAt: null,
            reviewRequired: false,
            parentQuestionId: null,
          },
          data: { status: QuestionStatus.PUBLISHED },
        });
        if (r.count !== eligibleIds.length) {
          throw new BatchActionError("Some questions changed while publishing — nothing was published. Preview again.");
        }
        publishedCount = r.count;
      }

      const result: BatchPublishResult = {
        ...preview,
        publishedCount,
        published: preview.eligible.map((e) => ({ id: e.id, code: e.code })),
        replayed: false,
      };
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          action: PUBLISH_ACTION,
          entityType: AUDIT_ENTITY,
          entityId,
          metadata: {
            paperId: input.paperId,
            batchKey: input.batchKey,
            requestId,
            requested: preview.requested,
            publishedCount,
            alreadyPublishedCount: preview.alreadyPublished.length,
            blockedCount: preview.blocked.length,
            publishedIds: eligibleIds,
            blocked: preview.blocked.map((b) => ({ id: b.id, code: b.code, reasons: b.reasons })),
            result,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return result;
    },
    { timeout: 120_000, maxWait: 30_000 }
  );
}

// ---------------------------------------------------------------------------
// Mark reviewed (explicit, audited — never a side effect of publishing)
// ---------------------------------------------------------------------------

export interface MarkReviewedResult {
  markedCount: number;
  marked: { id: string; code: string; previousReason: string | null }[];
  skipped: { id: string; code: string | null; reason: string }[];
}

export async function markBatchQuestionsReviewed(input: { paperId: string; batchKey: string; ids: unknown; actorId: string }): Promise<MarkReviewedResult> {
  const ids = checkIds(input.ids);
  return prisma.$transaction(
    async (tx) => {
      await lockPaper(tx, input.paperId);
      await assertBatchExists(tx, input.paperId, input.batchKey);
      const rows = await tx.question.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, previousYearPaperId: true, importBatchId: true, retiredAt: true, reviewRequired: true, reviewReason: true, status: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const triggers = await reviewTriggersFor(tx, rows.map((r) => r.id));
      const marked: MarkReviewedResult["marked"] = [];
      const skipped: MarkReviewedResult["skipped"] = [];
      for (const id of ids) {
        const q = byId.get(id);
        if (!q) skipped.push({ id, code: null, reason: "Question not found." });
        else if (q.previousYearPaperId !== input.paperId) skipped.push({ id, code: q.code, reason: "Not in this paper." });
        else if ((q.importBatchId ?? MANUAL_BATCH) !== input.batchKey) skipped.push({ id, code: q.code, reason: "Not in this import batch." });
        else if (q.retiredAt) skipped.push({ id, code: q.code, reason: "Retired questions are read-only." });
        else if (q.status !== QuestionStatus.DRAFT) skipped.push({ id, code: q.code, reason: `Only Draft questions are reviewed here (this one is ${q.status}).` });
        else if (!q.reviewRequired) skipped.push({ id, code: q.code, reason: "Not flagged for review." });
        else marked.push({ id, code: q.code, previousReason: triggers.get(id)?.join(" · ") ?? q.reviewReason });
      }
      if (marked.length) {
        const r = await tx.question.updateMany({
          where: { id: { in: marked.map((m) => m.id) }, ...batchWhere(input.paperId, input.batchKey), retiredAt: null, reviewRequired: true, status: QuestionStatus.DRAFT },
          data: { reviewRequired: false, reviewReason: null },
        });
        if (r.count !== marked.length) throw new BatchActionError("Some questions changed meanwhile — nothing was changed. Try again.");
      }
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          action: REVIEW_ACTION,
          entityType: AUDIT_ENTITY,
          entityId: batchEntityId(input.paperId, input.batchKey),
          metadata: {
            paperId: input.paperId,
            batchKey: input.batchKey,
            markedCount: marked.length,
            blockedCount: skipped.length,
            marked,
            skipped,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return { markedCount: marked.length, marked, skipped };
    },
    { timeout: 60_000, maxWait: 30_000 }
  );
}
