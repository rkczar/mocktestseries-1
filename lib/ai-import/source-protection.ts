import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Phase 0 source protection (2026-11-26): an uploaded original paper or answer key is the permanent source record of
 * the Question Bank questions imported from it. While any such question or its source evidence exists, the original
 * is never physically deleted — not by Delete import, not by the Storage Manager, never automatically.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface SourceDependencies {
  /** Question Bank questions (that still exist) imported from these jobs. */
  questions: number;
  /** Source-evidence rows pointing at these files / jobs (original question crops, provenance). */
  evidence: number;
  /** Source-evidence rows whose official answer-key entry comes from these files. */
  keyEvidence: number;
  total: number;
  /** Distinct Question Bank questions behind the counts above (one question usually appears in several). */
  distinctQuestions: number;
}

export async function sourceDependencies(db: Db, ids: { fileIds: string[]; jobIds: string[] }): Promise<SourceDependencies> {
  const fileIds = [...new Set(ids.fileIds)];
  const jobIds = [...new Set(ids.jobIds)];
  if (!fileIds.length && !jobIds.length) return { questions: 0, evidence: 0, keyEvidence: 0, total: 0, distinctQuestions: 0 };
  // A Bulk Import that stored a question but died before linking it back leaves questionId null: count by run too.
  const linked = await db.aiImportQuestion.findMany({ where: { jobId: { in: jobIds }, OR: [{ questionId: { not: null } }, { bulkImportRunId: { not: null } }] }, select: { questionId: true, bulkImportRunId: true } });
  const qIds = [...new Set(linked.flatMap((l) => (l.questionId ? [l.questionId] : [])))];
  const runIds = [...new Set(linked.flatMap((l) => (l.bulkImportRunId ? [l.bulkImportRunId] : [])))];
  const [questions, evidence, keyEvidence] = await Promise.all([
    linked.length ? db.question.findMany({ where: { OR: [{ id: { in: qIds } }, { importBatchId: { in: runIds } }] }, select: { id: true } }) : [],
    db.questionSourceEvidence.findMany({ where: { OR: [{ fileId: { in: fileIds } }, { jobId: { in: jobIds } }] }, select: { questionId: true } }),
    db.questionSourceEvidence.findMany({ where: { keyFileId: { in: fileIds } }, select: { questionId: true } }),
  ]);
  const distinctQuestions = new Set([...questions.map((q) => q.id), ...evidence.map((e) => e.questionId), ...keyEvidence.map((e) => e.questionId)]).size;
  return { questions: questions.length, evidence: evidence.length, keyEvidence: keyEvidence.length, total: questions.length + evidence.length + keyEvidence.length, distinctQuestions };
}

/** One count (distinct questions) and what links them, e.g. "12 Question Bank question(s) depend on it (imported from it, source evidence)". */
export function dependencySummary(d: SourceDependencies): string {
  const kinds = [d.questions && "imported from it", d.evidence && "source evidence from its original paper", d.keyEvidence && "official answer-key evidence"].filter(Boolean);
  return `${d.distinctQuestions} Question Bank question(s) depend on it (${kinds.join(", ")})`;
}

/**
 * Of `files`, those whose stored original is protected: a dependency on the file itself, on its job, or on any
 * other upload sharing the same stored copy (same rule as Delete import / Storage Manager, batched for listings).
 */
export async function protectedFileIds(db: Db, files: { id: string; jobId: string; storageKey: string | null }[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const keys = [...new Set(files.flatMap((f) => (f.storageKey ? [f.storageKey] : [])))];
  const all = keys.length ? await db.aiImportFile.findMany({ where: { storageKey: { in: keys } }, select: { id: true, jobId: true, storageKey: true } }) : [];
  const rows = [...new Map([...files, ...all].map((f) => [f.id, f])).values()];
  const fileIds = rows.map((f) => f.id);
  const jobIds = [...new Set(rows.map((f) => f.jobId))];
  const [evidence, linked] = await Promise.all([
    db.questionSourceEvidence.findMany({ where: { OR: [{ fileId: { in: fileIds } }, { keyFileId: { in: fileIds } }, { jobId: { in: jobIds } }] }, select: { fileId: true, keyFileId: true, jobId: true } }),
    db.aiImportQuestion.findMany({ where: { jobId: { in: jobIds }, OR: [{ questionId: { not: null } }, { bulkImportRunId: { not: null } }] }, select: { jobId: true, questionId: true, bulkImportRunId: true } }),
  ]);
  const qIds = [...new Set(linked.flatMap((l) => (l.questionId ? [l.questionId] : [])))];
  const runIds = [...new Set(linked.flatMap((l) => (l.bulkImportRunId ? [l.bulkImportRunId] : [])))];
  const live = linked.length ? await db.question.findMany({ where: { OR: [{ id: { in: qIds } }, { importBatchId: { in: runIds } }] }, select: { id: true, importBatchId: true } }) : [];
  const liveIds = new Set(live.map((q) => q.id));
  const liveRuns = new Set(live.flatMap((q) => (q.importBatchId ? [q.importBatchId] : [])));
  const jobs = new Set([...evidence.flatMap((e) => (e.jobId ? [e.jobId] : [])), ...linked.filter((l) => (l.questionId && liveIds.has(l.questionId)) || (l.bulkImportRunId && liveRuns.has(l.bulkImportRunId))).map((l) => l.jobId)]);
  const direct = new Set(evidence.flatMap((e) => [e.fileId, e.keyFileId].filter((x): x is string => !!x)));
  const protKeys = new Set(rows.filter((f) => f.storageKey && (direct.has(f.id) || jobs.has(f.jobId))).map((f) => f.storageKey!));
  return new Set(files.filter((f) => f.storageKey && protKeys.has(f.storageKey)).map((f) => f.id));
}

/** Of `keys` (vault figure keys), those used as a stored source-evidence crop of any Question Bank question. */
export async function evidenceCropKeys(db: Db, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db.$queryRaw<{ key: string }[]>`
    SELECT c->>'key' AS key FROM "QuestionSourceEvidence" e, jsonb_array_elements(CASE WHEN jsonb_typeof(e."questionCrops") = 'array' THEN e."questionCrops" ELSE '[]'::jsonb END) c
     WHERE c->>'key' = ANY(${keys}::text[])
    UNION
    SELECT e."keyCrop"->>'key' FROM "QuestionSourceEvidence" e WHERE e."keyCrop"->>'key' = ANY(${keys}::text[])`;
  return new Set(rows.map((r) => r.key));
}
