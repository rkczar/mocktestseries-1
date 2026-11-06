import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { getExamTaxonomy, type ExamTaxonomySubject } from "@/lib/exam-taxonomy";
import { buildTaxonomyIndex, classificationText, type ClassifierMemory, type TaxonomyIndex } from "@/lib/ai-import/taxonomy-classify";
import { headingKey, resolveHeadingSubject } from "@/lib/ai-import/section-subject";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { memoryBrief, mergePaperRules, paperOf, type MemoryPurpose, type PaperRule, type PaperRuleProposal } from "@/lib/ai-import/paper-memory";

/**
 * Exam-specific taxonomy reference of the AI Question Importer ("taxonomy memory"), one Setting row per exam
 * (no schema change, like the importer's format profiles):
 *
 *  - synonyms / alternative terms an administrator added for a subject or topic of the exam,
 *  - pairs of subjects an administrator marked as commonly confused,
 *  - administrator-CONFIRMED classifications (a correction in Review Exceptions with "remember" on) — the question's
 *    words and the ids chosen, with job, question, administrator and time,
 *  - administrator-confirmed heading aliases (a printed section heading → one subject of the exam) and format rules
 *    of the exam's papers (importer-reliability-2), each with its administrator, time and memory version,
 *  - a history of every change (who, when, which version, what), kept with the memory.
 *
 * Nothing the AI predicted is ever stored here as knowledge. Every entry is scoped to its exam and holds that exam's
 * own ids; when the exam's taxonomy changes (records unlinked, renamed, moved) the fingerprint changes and entries
 * whose ids are no longer part of it are dropped on the next refresh (and never used before that — the classifier
 * checks every id again). The classifier's term profiles also read reviewed Question Bank questions filed under the
 * exam's linked topics (canonical, published, not flagged for review, not AI variants) — as words only.
 */

export const TAXONOMY_MEMORY_PREFIX = "ai.importer.taxonomyMemory:";
const MAX_CORRECTIONS = 5000;

export interface MemorySynonym {
  id: string;
  term: string;
  subjectId: string | null;
  topicId: string | null;
  byId: string;
  at: string;
}
export interface MemoryConfusion {
  id: string;
  a: string;
  b: string;
  note: string | null;
  byId: string;
  at: string;
}
export interface MemoryCorrection {
  id: string;
  /** The question's words (stem, statements, options), at most 1,200 characters. */
  text: string;
  subjectId: string;
  topicId: string | null;
  subTopicId: string | null;
  jobId: string;
  questionId: string;
  byId: string;
  at: string;
  source: "admin correction" | "admin bulk correction";
  /**
   * Set when the example became active: the administrator ticked "Remember" AND approved the question with this
   * classification (Sprint A, 2026-11-06). Examples without it (saved before Sprint A) are never used by the classifier.
   */
  verifiedAt?: string;
  verifiedById?: string;
  evidence?: MemoryExampleEvidence;
  /** Set when an administrator re-activated a quarantined example after checking its approved question. */
  reactivatedAt?: string;
  reactivatedFromBatch?: string;
}
/** What the example was based on when it was proposed. */
export interface MemoryExampleEvidence {
  sourceNumber: number | null;
  pages: number[];
  /** The classification before the administrator's choice, and where it came from. */
  previous: { subjectId: string | null; topicId: string | null; subTopicId: string | null; source: string | null; confidence: number | null };
}
/** "Remember" ticked on a question that is not approved yet: never used until the question is approved unchanged. */
export interface MemoryProposedExample extends MemoryCorrection {
  status: "PROPOSED";
  proposedAt: string;
}
/** Kept, with its full record, but never used by the classifier or sent anywhere; re-activated only one by one. */
export interface MemoryQuarantinedExample extends MemoryCorrection {
  quarantinedAt: string;
  quarantinedById: string | null;
  reason: string;
  /** One quarantine operation (all entries moved together share it). */
  batch: string;
}
/** An example the classifier may use: active (in `corrections`) and verified by an approval. */
export const isActiveExample = (c: MemoryCorrection) => !!c.verifiedAt;
/** A printed section heading of this exam's papers that names one of its subjects ("PREVENTIVE & SOCIAL MEDICINE" → Community Medicine / PSM). */
export interface MemoryHeadingAlias {
  id: string;
  /** headingKey() of the printed heading. */
  heading: string;
  /** The heading as the administrator entered / saw it. */
  raw: string;
  subjectId: string;
  byId: string;
  at: string;
  /** Memory version that added it. */
  version: number;
  note: string | null;
}

/**
 * Format rules an administrator confirmed for this exam's papers:
 *  STATEMENT_CODE_SINGLE — "statements … select the answer using the code" questions are single-correct (one code option);
 *  ANSWER_LINE_MARK — a ✓ / ■ printed before the answer line is an annotation, never option text.
 */
export const FORMAT_RULES = {
  STATEMENT_CODE_SINGLE: "Statement-code questions (\"select the answer using the code\") are single-correct",
  ANSWER_LINE_MARK: "A ✓ / ■ mark before the printed answer line is an annotation, not option text",
} as const;
export type FormatRuleCode = keyof typeof FORMAT_RULES;
export interface MemoryFormatRule {
  id: string;
  rule: FormatRuleCode;
  byId: string;
  at: string;
  version: number;
  note: string | null;
}

/** One change of the memory (append-only, newest last; the audit log has the same entry). */
export interface MemoryHistoryEntry {
  version: number;
  at: string;
  byId: string | null;
  action: string;
  detail: string;
}
const MAX_HISTORY = 500;

export interface ExamTaxonomyMemory {
  examId: string;
  version: number;
  taxonomyFingerprint: string;
  synonyms: MemorySynonym[];
  confusions: MemoryConfusion[];
  corrections: MemoryCorrection[];
  /** Examples waiting for their question's approval (kept outside `corrections`, so an older release ignores them). */
  proposedCorrections?: MemoryProposedExample[];
  /** Quarantined examples (kept outside `corrections`, so an older release — a rollback — never uses them either). */
  quarantinedCorrections?: MemoryQuarantinedExample[];
  headingAliases?: MemoryHeadingAlias[];
  formatRules?: MemoryFormatRule[];
  /** Paper-format memory (lib/ai-import/paper-memory.ts): evidence-backed rules, PROPOSED until an administrator confirms. */
  paperRules?: PaperRule[];
  history?: MemoryHistoryEntry[];
  /** Entries dropped by the last refresh because their ids left the exam's taxonomy. */
  lastRefresh: { at: string; dropped: number; fingerprint: string } | null;
  updatedAt: string;
}

/** Fingerprint of an exam's taxonomy (ids, names and hierarchy): any change makes stored references re-checked. */
export function taxonomyFingerprint(taxonomy: ExamTaxonomySubject[]): string {
  const body = taxonomy.map((s) => [s.id, s.name, s.topics.map((t) => [t.id, t.name, t.subTopics.map((st) => [st.id, st.name])])]);
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
}

const emptyMemory = (examId: string, fingerprint: string): ExamTaxonomyMemory => ({ examId, version: 0, taxonomyFingerprint: fingerprint, synonyms: [], confusions: [], corrections: [], headingAliases: [], formatRules: [], paperRules: [], history: [], lastRefresh: null, updatedAt: new Date(0).toISOString() });

export async function loadExamMemory(examId: string): Promise<ExamTaxonomyMemory | null> {
  const row = await prisma.setting.findUnique({ where: { key: `${TAXONOMY_MEMORY_PREFIX}${examId}` } });
  const v = row?.value as Partial<ExamTaxonomyMemory> | null | undefined;
  if (!v || typeof v !== "object" || v.examId !== examId) return null;
  return { ...emptyMemory(examId, v.taxonomyFingerprint ?? ""), ...v, synonyms: Array.isArray(v.synonyms) ? v.synonyms : [], confusions: Array.isArray(v.confusions) ? v.confusions : [], corrections: Array.isArray(v.corrections) ? v.corrections : [], proposedCorrections: Array.isArray(v.proposedCorrections) ? v.proposedCorrections : [], quarantinedCorrections: Array.isArray(v.quarantinedCorrections) ? v.quarantinedCorrections : [], headingAliases: Array.isArray(v.headingAliases) ? v.headingAliases : [], formatRules: Array.isArray(v.formatRules) ? v.formatRules : [], paperRules: Array.isArray(v.paperRules) ? v.paperRules : [], history: Array.isArray(v.history) ? v.history : [] } as ExamTaxonomyMemory;
}

async function saveExamMemory(mem: ExamTaxonomyMemory, actorId: string | null, action: string, metadata: Record<string, unknown>): Promise<ExamTaxonomyMemory> {
  const at = new Date().toISOString();
  const entry: MemoryHistoryEntry = { version: mem.version + 1, at, byId: actorId, action, detail: JSON.stringify(metadata).slice(0, 400) };
  const next = { ...mem, version: mem.version + 1, updatedAt: at, history: [...(mem.history ?? []), entry].slice(-MAX_HISTORY) };
  const value = JSON.stringify(next);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${`${TAXONOMY_MEMORY_PREFIX}${mem.examId}`}, ${value}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ${value}::jsonb, "updatedAt" = now()`);
  if (actorId) await prisma.auditLog.create({ data: { actorId, action, entityType: "AiImportTaxonomyMemory", entityId: mem.examId, metadata: metadata as Prisma.InputJsonValue } });
  cache.delete(mem.examId);
  return next;
}

/** Only entries whose ids are (still) part of the exam's taxonomy, with the hierarchy intact. */
export function validEntries(mem: ExamTaxonomyMemory, taxonomy: ExamTaxonomySubject[]): Pick<ExamTaxonomyMemory, "synonyms" | "confusions" | "corrections"> & { headingAliases: MemoryHeadingAlias[]; formatRules: MemoryFormatRule[] } {
  const subjects = new Map(taxonomy.map((s) => [s.id, s]));
  const topicSubject = new Map(taxonomy.flatMap((s) => s.topics.map((t) => [t.id, s.id] as const)));
  const subTopicTopic = new Map(taxonomy.flatMap((s) => s.topics.flatMap((t) => t.subTopics.map((st) => [st.id, t.id] as const))));
  return {
    synonyms: mem.synonyms.filter((x) => x.term.trim() && (x.topicId ? topicSubject.has(x.topicId) && (!x.subjectId || topicSubject.get(x.topicId) === x.subjectId) : !!x.subjectId && subjects.has(x.subjectId))),
    confusions: mem.confusions.filter((x) => subjects.has(x.a) && subjects.has(x.b) && x.a !== x.b),
    corrections: mem.corrections.filter((x) => subjects.has(x.subjectId) && (!x.topicId || topicSubject.get(x.topicId) === x.subjectId) && (!x.subTopicId || (!!x.topicId && subTopicTopic.get(x.subTopicId) === x.topicId))),
    headingAliases: (mem.headingAliases ?? []).filter((x) => x.heading && subjects.has(x.subjectId)),
    formatRules: (mem.formatRules ?? []).filter((x) => x.rule in FORMAT_RULES),
  };
}

/** Drops entries that left the exam's taxonomy and records the new fingerprint (only writes when something changed). */
export async function refreshExamMemory(examId: string, taxonomy?: ExamTaxonomySubject[]): Promise<{ memory: ExamTaxonomyMemory | null; dropped: number }> {
  const mem = await loadExamMemory(examId);
  if (!mem) return { memory: null, dropped: 0 };
  const tax = taxonomy ?? (await getExamTaxonomy(prisma, examId));
  const fp = taxonomyFingerprint(tax);
  if (mem.taxonomyFingerprint === fp) return { memory: mem, dropped: 0 };
  const valid = validEntries(mem, tax);
  const dropped = mem.synonyms.length - valid.synonyms.length + (mem.confusions.length - valid.confusions.length) + (mem.corrections.length - valid.corrections.length) + ((mem.headingAliases ?? []).length - valid.headingAliases.length);
  const saved = await saveExamMemory({ ...mem, ...valid, taxonomyFingerprint: fp, lastRefresh: { at: new Date().toISOString(), dropped, fingerprint: fp } }, null, "AI_IMPORT_TAXONOMY_MEMORY_REFRESHED", { dropped });
  return { memory: saved, dropped };
}

// ---- Classifier context (cached per exam) -----------------------------------------------------------------

export interface ClassifierContext {
  examId: string;
  taxonomy: ExamTaxonomySubject[];
  index: TaxonomyIndex;
  fingerprint: string;
  memory: ExamTaxonomyMemory | null;
  /** Reviewed Question Bank questions used as topic evidence. */
  evidenceQuestions: number;
  /** Entries of the memory dropped by this load's refresh (taxonomy changed). */
  droppedOnRefresh: number;
}

const cache = new Map<string, { key: string; at: number; ctx: ClassifierContext }>();
const CACHE_MS = 10 * 60 * 1000;

/**
 * Reviewed Question Bank questions under the exam's linked topics: canonical (not AI variants), published, filed
 * consistently (the question's subject is the topic's subject), and not flagged for a subject / topic problem. A
 * review flag about something else (difficulty default, "Sub-topic not provided") does not make the topic doubtful.
 */
export const TAXONOMY_DOUBT = /\b(subject|topic)\b/i;
export const evidenceUsable = (r: { reviewRequired: boolean; reviewReason: string | null }) => !r.reviewRequired || !TAXONOMY_DOUBT.test((r.reviewReason ?? "").replace(/sub-?topic not provided/gi, ""));
async function loadEvidence(taxonomy: ExamTaxonomySubject[]): Promise<{ topicId: string; text: string }[]> {
  const topicIds = taxonomy.flatMap((s) => s.topics.map((t) => t.id));
  if (!topicIds.length) return [];
  const subjectOf = new Map(taxonomy.flatMap((s) => s.topics.map((t) => [t.id, s.id] as const)));
  const rows = await prisma.question.findMany({
    where: { status: "PUBLISHED", parentQuestionId: null, OR: [{ aiVariantType: null }, { aiVariantType: "CANONICAL" }], topicId: { in: topicIds } },
    select: { topicId: true, subjectId: true, text: true, reviewRequired: true, reviewReason: true, options: { select: { text: true }, orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: 40_000,
  });
  return rows.filter((r) => r.topicId && subjectOf.get(r.topicId) === r.subjectId && evidenceUsable(r)).map((r) => ({ topicId: r.topicId!, text: `${r.text}\n${r.options.map((o) => o.text).join("\n")}` }));
}

export async function classifierContext(examId: string): Promise<ClassifierContext> {
  const taxonomy = await getExamTaxonomy(prisma, examId);
  const fingerprint = taxonomyFingerprint(taxonomy);
  const { memory, dropped } = await refreshExamMemory(examId, taxonomy);
  const published = await prisma.question.aggregate({ where: { status: "PUBLISHED" }, _count: { _all: true }, _max: { updatedAt: true } });
  const key = `${fingerprint}|${memory?.version ?? 0}|${published._count._all}|${published._max.updatedAt?.toISOString() ?? ""}`;
  const hit = cache.get(examId);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return { ...hit.ctx, droppedOnRefresh: dropped };
  const evidence = await loadEvidence(taxonomy);
  const valid = memory ? validEntries(memory, taxonomy) : null;
  // Only active, approval-verified examples (Sprint A): proposed and quarantined ones are stored apart and never read here.
  const mem: ClassifierMemory | null = valid ? { synonyms: valid.synonyms, confusions: valid.confusions, corrections: valid.corrections.filter(isActiveExample) } : null;
  const ctx: ClassifierContext = { examId, taxonomy, index: buildTaxonomyIndex(taxonomy, evidence, mem), fingerprint, memory, evidenceQuestions: evidence.length, droppedOnRefresh: dropped };
  cache.set(examId, { key, at: Date.now(), ctx });
  return ctx;
}

// ---- Administrator changes ----------------------------------------------------------------------------------

async function current(examId: string): Promise<{ mem: ExamTaxonomyMemory & { headingAliases: MemoryHeadingAlias[]; formatRules: MemoryFormatRule[] }; taxonomy: ExamTaxonomySubject[] }> {
  const taxonomy = await getExamTaxonomy(prisma, examId);
  const fp = taxonomyFingerprint(taxonomy);
  const mem = (await loadExamMemory(examId)) ?? emptyMemory(examId, fp);
  return { mem: { ...mem, ...validEntries(mem, taxonomy), taxonomyFingerprint: fp }, taxonomy };
}

/**
 * "Remember as a confirmed example" on one imported question: stored as a PROPOSED example (replacing an earlier proposal
 * of the same question). It is used only after the administrator APPROVES the question with this same classification
 * (promoteExamples). Questions with too little text are not stored. Never called for an AI or local-classifier result.
 */
export async function rememberCorrection(input: { examId: string; jobId: string; questionId: string; e: ExtractedQuestion; subjectId: string; topicId: string | null; subTopicId: string | null; actorId: string; bulk: boolean; evidence?: MemoryExampleEvidence }): Promise<boolean> {
  const text = classificationText(input.e).replace(/⟦IMG:[^⟧]*⟧/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
  if (text.split(" ").length < 4) return false;
  const { mem, taxonomy } = await current(input.examId);
  const s = taxonomy.find((x) => x.id === input.subjectId);
  if (!s || (input.topicId && !s.topics.some((t) => t.id === input.topicId))) return false;
  const at = new Date().toISOString();
  const entry: MemoryProposedExample = { id: randomBytes(6).toString("hex"), text, subjectId: input.subjectId, topicId: input.topicId, subTopicId: input.subTopicId, jobId: input.jobId, questionId: input.questionId, byId: input.actorId, at, source: input.bulk ? "admin bulk correction" : "admin correction", ...(input.evidence ? { evidence: input.evidence } : {}), status: "PROPOSED", proposedAt: at };
  const proposed = [...(mem.proposedCorrections ?? []).filter((c) => c.questionId !== input.questionId), entry].slice(-MAX_CORRECTIONS);
  await saveExamMemory({ ...mem, proposedCorrections: proposed }, input.actorId, "AI_IMPORT_TAXONOMY_EXAMPLE_PROPOSED", { questionId: input.questionId, jobId: input.jobId, subjectId: input.subjectId, topicId: input.topicId, subTopicId: input.subTopicId });
  return true;
}

/**
 * After an approval: each PROPOSED example of these questions becomes active (verified) when its question is approved
 * now with exactly the proposed classification; a proposal whose question was re-classified since stays proposed.
 */
export async function promoteExamples(examId: string, questions: { id: string; approvedById: string | null; subjectId: string | null; topicId: string | null; subTopicId: string | null }[], actorId: string): Promise<number> {
  const mem = await loadExamMemory(examId);
  if (!mem?.proposedCorrections?.length) return 0;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const at = new Date().toISOString();
  const promoted: MemoryCorrection[] = [];
  const keep: MemoryProposedExample[] = [];
  for (const p of mem.proposedCorrections) {
    const q = byId.get(p.questionId);
    if (q && q.approvedById && q.subjectId === p.subjectId && (q.topicId ?? null) === p.topicId && (q.subTopicId ?? null) === p.subTopicId) {
      const { status: _s, proposedAt: _p, ...base } = p;
      void _s;
      void _p;
      promoted.push({ ...base, verifiedAt: at, verifiedById: q.approvedById });
    } else keep.push(p);
  }
  if (!promoted.length) return 0;
  const ids = new Set(promoted.map((c) => c.questionId));
  const corrections = [...mem.corrections.filter((c) => !ids.has(c.questionId)), ...promoted].slice(-MAX_CORRECTIONS);
  await saveExamMemory({ ...mem, corrections, proposedCorrections: keep }, actorId, "AI_IMPORT_TAXONOMY_EXAMPLE_VERIFIED", { examples: promoted.map((c) => ({ id: c.id, questionId: c.questionId, subjectId: c.subjectId, topicId: c.topicId })) });
  return promoted.length;
}

/** After a rejection: proposals of these questions are quarantined (kept, never used), with the reason. */
export async function quarantineProposals(examId: string, questionIds: string[], actorId: string, reason: string): Promise<number> {
  const mem = await loadExamMemory(examId);
  const gone = (mem?.proposedCorrections ?? []).filter((p) => questionIds.includes(p.questionId));
  if (!mem || !gone.length) return 0;
  const at = new Date().toISOString();
  const batch = `reject-${randomBytes(4).toString("hex")}`;
  const moved: MemoryQuarantinedExample[] = gone.map(({ status: _s, proposedAt: _p, ...c }) => (void _s, void _p, { ...c, quarantinedAt: at, quarantinedById: actorId, reason, batch }));
  await saveExamMemory({ ...mem, proposedCorrections: mem.proposedCorrections!.filter((p) => !questionIds.includes(p.questionId)), quarantinedCorrections: [...(mem.quarantinedCorrections ?? []), ...moved] }, actorId, "AI_IMPORT_TAXONOMY_EXAMPLES_QUARANTINED", { batch, reason, count: moved.length, ids: moved.map((c) => c.id) });
  return moved.length;
}

export interface QuarantineReport {
  examId: string;
  batch: string;
  dryRun: boolean;
  before: { active: number; proposed: number; quarantined: number };
  after: { active: number; proposed: number; quarantined: number };
  moved: { id: string; questionId: string; jobId: string; subjectId: string; topicId: string | null; subTopicId: string | null; at: string; source: string }[];
}

/**
 * Quarantines EVERY active example of an exam (owner approval 2, 2026-11-06: the 108 CMS examples saved by a checkbox that
 * was on by default). Nothing is deleted: each entry is moved with its full record (text, ids, job, question,
 * administrator, time) into `quarantinedCorrections` with the reason, actor, time and one batch id; the history and the
 * audit log record the operation and every id. Quarantined examples are never read by the classifier or any AI request
 * and are never re-activated automatically. `dryRun` reports what would move and writes nothing.
 */
export async function quarantineExamples(examId: string, actorId: string, reason: string, opts: { dryRun?: boolean } = {}): Promise<QuarantineReport> {
  if (reason.trim().length < 10) throw new ImportJobError("Give the reason for the quarantine (at least a few words).");
  const mem = await loadExamMemory(examId);
  if (!mem) throw new ImportJobError("Nothing is stored for this exam.");
  const at = new Date().toISOString();
  const batch = `q-${at.slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const before = { active: mem.corrections.length, proposed: mem.proposedCorrections?.length ?? 0, quarantined: mem.quarantinedCorrections?.length ?? 0 };
  const moved: MemoryQuarantinedExample[] = mem.corrections.map((c) => ({ ...c, quarantinedAt: at, quarantinedById: actorId, reason: reason.trim().slice(0, 300), batch }));
  const report: QuarantineReport = {
    examId,
    batch,
    dryRun: !!opts.dryRun,
    before,
    after: { active: 0, proposed: before.proposed, quarantined: before.quarantined + moved.length },
    moved: moved.map((c) => ({ id: c.id, questionId: c.questionId, jobId: c.jobId, subjectId: c.subjectId, topicId: c.topicId, subTopicId: c.subTopicId, at: c.at, source: c.source })),
  };
  if (opts.dryRun || !moved.length) return report;
  await saveExamMemory({ ...mem, corrections: [], quarantinedCorrections: [...(mem.quarantinedCorrections ?? []), ...moved] }, actorId, "AI_IMPORT_TAXONOMY_EXAMPLES_QUARANTINED", { batch, reason: reason.trim().slice(0, 300), count: moved.length, ids: moved.map((c) => c.id) });
  return report;
}

/**
 * Re-activates ONE quarantined example, only when it can be verified now: its import question still exists, an
 * administrator has approved it (or it is in the Question Bank), and its current subject / topic / subtopic are exactly
 * the example's. Anything else is refused with the reason; the entry stays quarantined.
 */
export async function reactivateExample(examId: string, id: string, actorId: string): Promise<MemoryCorrection> {
  const mem = await loadExamMemory(examId);
  const entry = mem?.quarantinedCorrections?.find((c) => c.id === id);
  if (!mem || !entry) throw new ImportJobError("That quarantined example no longer exists.");
  const q = await prisma.aiImportQuestion.findUnique({ where: { id: entry.questionId }, select: { approvedById: true, status: true, subjectId: true, topicId: true, subTopicId: true, job: { select: { examId: true } } } });
  if (!q) throw new ImportJobError("Its question no longer exists (the import was deleted), so the example cannot be verified — it stays quarantined.");
  if (q.job.examId !== examId) throw new ImportJobError("Its question belongs to another exam — it stays quarantined.");
  if (!q.approvedById && q.status !== "IMPORTED" && q.status !== "PUBLISHED") throw new ImportJobError("Its question is not approved — approve the question with this classification first; the example stays quarantined.");
  if (q.subjectId !== entry.subjectId || (q.topicId ?? null) !== entry.topicId || (q.subTopicId ?? null) !== entry.subTopicId) throw new ImportJobError("The question's approved subject / topic differs from the example's — it stays quarantined.");
  const { quarantinedAt: _a, quarantinedById: _b, reason: _r, batch, ...base } = entry;
  void _a;
  void _b;
  void _r;
  const at = new Date().toISOString();
  const active: MemoryCorrection = { ...base, verifiedAt: at, verifiedById: actorId, reactivatedAt: at, reactivatedFromBatch: batch };
  await saveExamMemory({ ...mem, corrections: [...mem.corrections.filter((c) => c.questionId !== entry.questionId), active], quarantinedCorrections: mem.quarantinedCorrections!.filter((c) => c.id !== id) }, actorId, "AI_IMPORT_TAXONOMY_EXAMPLE_REACTIVATED", { id, questionId: entry.questionId, batch });
  return active;
}

export async function addSynonym(examId: string, actorId: string, term: string, subjectId: string | null, topicId: string | null): Promise<void> {
  const clean = term.replace(/\s+/g, " ").trim().slice(0, 120);
  if (clean.length < 2) throw new ImportJobError("Enter the term.");
  const { mem, taxonomy } = await current(examId);
  const topicSubject = taxonomy.flatMap((s) => s.topics.map((t) => [t.id, s.id] as const)).find(([t]) => t === topicId)?.[1];
  if (topicId && !topicSubject) throw new ImportJobError("That topic is not part of this exam.");
  if (!topicId && (!subjectId || !taxonomy.some((s) => s.id === subjectId))) throw new ImportJobError("Choose a subject or topic of this exam.");
  if (mem.synonyms.some((x) => x.term.toLowerCase() === clean.toLowerCase() && x.topicId === topicId && x.subjectId === (topicSubject ?? subjectId))) throw new ImportJobError("That term is already listed.");
  const entry: MemorySynonym = { id: randomBytes(6).toString("hex"), term: clean, subjectId: topicSubject ?? subjectId, topicId, byId: actorId, at: new Date().toISOString() };
  await saveExamMemory({ ...mem, synonyms: [...mem.synonyms, entry] }, actorId, "AI_IMPORT_TAXONOMY_SYNONYM_ADDED", { term: clean, subjectId: entry.subjectId, topicId });
}

export async function addConfusion(examId: string, actorId: string, a: string, b: string, note: string): Promise<void> {
  const { mem, taxonomy } = await current(examId);
  if (a === b || !taxonomy.some((s) => s.id === a) || !taxonomy.some((s) => s.id === b)) throw new ImportJobError("Choose two different subjects of this exam.");
  if (mem.confusions.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))) throw new ImportJobError("That pair is already listed.");
  const entry: MemoryConfusion = { id: randomBytes(6).toString("hex"), a, b, note: note.trim().slice(0, 200) || null, byId: actorId, at: new Date().toISOString() };
  await saveExamMemory({ ...mem, confusions: [...mem.confusions, entry] }, actorId, "AI_IMPORT_TAXONOMY_CONFUSION_ADDED", { a, b });
}

/** Removes one synonym / confusion / stored example (the audit log keeps what was removed). */
export async function removeMemoryEntry(examId: string, actorId: string, kind: "synonym" | "confusion" | "correction" | "headingAlias" | "formatRule" | "paperRule", id: string): Promise<void> {
  const mem = await loadExamMemory(examId);
  if (!mem) throw new ImportJobError("Nothing is stored for this exam.");
  const aliases = mem.headingAliases ?? [];
  const rules = mem.formatRules ?? [];
  const paperRules = mem.paperRules ?? [];
  const list = kind === "synonym" ? mem.synonyms : kind === "confusion" ? mem.confusions : kind === "correction" ? mem.corrections : kind === "headingAlias" ? aliases : kind === "paperRule" ? paperRules : rules;
  const gone = (list as { id: string }[]).find((x) => x.id === id);
  if (!gone) throw new ImportJobError("That entry no longer exists.");
  const next = { ...mem, synonyms: kind === "synonym" ? mem.synonyms.filter((x) => x.id !== id) : mem.synonyms, confusions: kind === "confusion" ? mem.confusions.filter((x) => x.id !== id) : mem.confusions, corrections: kind === "correction" ? mem.corrections.filter((x) => x.id !== id) : mem.corrections, headingAliases: kind === "headingAlias" ? aliases.filter((x) => x.id !== id) : aliases, formatRules: kind === "formatRule" ? rules.filter((x) => x.id !== id) : rules, paperRules: kind === "paperRule" ? paperRules.filter((x) => x.id !== id) : paperRules };
  await saveExamMemory(next, actorId, "AI_IMPORT_TAXONOMY_MEMORY_REMOVED", { kind, entry: gone as unknown as Prisma.InputJsonValue });
}

// ---- Heading aliases and format rules (importer-reliability-2) ---------------------------------------------------

/** What a printed heading resolves to for this exam right now (subject names, then confirmed aliases, then one unique subject). */
export async function headingResolver(examId: string): Promise<(heading: string | null | undefined) => { subjectId: string; via: string } | null> {
  const taxonomy = await getExamTaxonomy(prisma, examId);
  const mem = await loadExamMemory(examId);
  const aliases = mem ? validEntries(mem, taxonomy).headingAliases : [];
  const subjects = taxonomy.map((s) => ({ id: s.id, name: s.name }));
  return (heading) => resolveHeadingSubject(heading, subjects, aliases);
}

/** The format rules confirmed for this exam. */
export async function examFormatRules(examId: string): Promise<Set<FormatRuleCode>> {
  const mem = await loadExamMemory(examId);
  return new Set((mem?.formatRules ?? []).filter((x) => x.rule in FORMAT_RULES).map((x) => x.rule));
}

/**
 * Stores an administrator-confirmed heading alias. The subject must be one of the exam's own (active) subjects; an
 * alias that the subject names already settle is refused as unnecessary only when it would map elsewhere.
 */
export async function addHeadingAlias(examId: string, actorId: string, heading: string, subjectId: string, note: string | null = null): Promise<MemoryHeadingAlias> {
  const key = headingKey(heading);
  if (key.length < 3) throw new ImportJobError("Enter the heading as printed (e.g. PREVENTIVE & SOCIAL MEDICINE).");
  const { mem, taxonomy } = await current(examId);
  const subject = taxonomy.find((s) => s.id === subjectId);
  if (!subject) throw new ImportJobError("Choose a subject of this exam (only the exam's own subjects can be mapped).");
  const byName = resolveHeadingSubject(heading, taxonomy.map((s) => ({ id: s.id, name: s.name })), []);
  if (byName && byName.subjectId !== subjectId) throw new ImportJobError(`“${heading}” already names ${taxonomy.find((s) => s.id === byName.subjectId)?.name}; it cannot be mapped to ${subject.name}.`);
  if (mem.headingAliases.some((x) => x.heading === key)) throw new ImportJobError("That heading is already mapped — remove it first to change it.");
  const entry: MemoryHeadingAlias = { id: randomBytes(6).toString("hex"), heading: key, raw: heading.replace(/\s+/g, " ").trim().slice(0, 120), subjectId, byId: actorId, at: new Date().toISOString(), version: mem.version + 1, note: note?.trim().slice(0, 200) || null };
  await saveExamMemory({ ...mem, headingAliases: [...mem.headingAliases, entry] }, actorId, "AI_IMPORT_TAXONOMY_HEADING_ALIAS_ADDED", { heading: entry.raw, key, subjectId, subject: subject.name });
  return entry;
}

export async function addFormatRule(examId: string, actorId: string, rule: FormatRuleCode, note: string | null = null): Promise<void> {
  if (!(rule in FORMAT_RULES)) throw new ImportJobError("Unknown format rule.");
  const { mem } = await current(examId);
  if (mem.formatRules.some((x) => x.rule === rule)) throw new ImportJobError("That rule is already confirmed for this exam.");
  const entry: MemoryFormatRule = { id: randomBytes(6).toString("hex"), rule, byId: actorId, at: new Date().toISOString(), version: mem.version + 1, note: note?.trim().slice(0, 200) || null };
  await saveExamMemory({ ...mem, formatRules: [...mem.formatRules, entry] }, actorId, "AI_IMPORT_TAXONOMY_FORMAT_RULE_ADDED", { rule });
}

// ---- Paper-format memory (lib/ai-import/paper-memory.ts) ------------------------------------------------------------

/** The paper this import is ("PAPER II"), from its Previous Year Paper, else its title. */
export async function paperIdentity(job: { title: string; previousYearPaperId: string | null }): Promise<string | null> {
  const pyp = job.previousYearPaperId ? await prisma.previousYearPaper.findUnique({ where: { id: job.previousYearPaperId }, select: { title: true } }) : null;
  return paperOf(pyp?.title) ?? paperOf(job.title);
}

/** One import's paper and its exam's paper rules (callers use only the confirmed ones that apply — paper-memory.ts). */
export async function jobPaperMemory(job: { examId: string; title: string; previousYearPaperId: string | null }): Promise<{ paper: string | null; rules: PaperRule[] }> {
  return { paper: await paperIdentity(job), rules: await examPaperRules(job.examId) };
}

/** The confirmed-memory text for one kind of AI request of this import ("" when nothing confirmed applies). */
export async function jobMemoryBrief(job: { examId: string; title: string; previousYearPaperId: string | null }, purpose: MemoryPurpose): Promise<string> {
  const { paper, rules } = await jobPaperMemory(job);
  return memoryBrief(rules, paper, purpose);
}

/** All paper-format rules of the exam (proposed, confirmed and rejected). */
export async function examPaperRules(examId: string): Promise<PaperRule[]> {
  return (await loadExamMemory(examId))?.paperRules ?? [];
}

/** Stores rules learned from one import as PROPOSED (or as new evidence of a rule already stored). Nothing is applied. */
export async function savePaperRuleProposals(examId: string, actorId: string, jobId: string, proposals: PaperRuleProposal[]): Promise<{ added: number; updated: number; contradicted: number }> {
  const { mem } = await current(examId);
  const r = mergePaperRules(mem.paperRules ?? [], proposals, new Date().toISOString(), () => randomBytes(6).toString("hex"));
  await saveExamMemory({ ...mem, paperRules: r.rules }, actorId, "AI_IMPORT_PAPER_MEMORY_LEARNED", { jobId, proposals: proposals.length, added: r.added, updated: r.updated, contradicted: r.contradicted });
  return { added: r.added, updated: r.updated, contradicted: r.contradicted };
}

/** An administrator confirms or rejects one rule (a confirmed rule is used as a check; a rejected one never). */
export async function decidePaperRule(examId: string, actorId: string, id: string, decision: "CONFIRMED" | "REJECTED", note: string | null): Promise<PaperRule> {
  const { mem } = await current(examId);
  const rule = (mem.paperRules ?? []).find((x) => x.id === id);
  if (!rule) throw new ImportJobError("That rule no longer exists.");
  if (decision === "CONFIRMED" && rule.contradictedBy) throw new ImportJobError("Newer evidence contradicts this rule — review both versions and reject the wrong one first.");
  const next: PaperRule = { ...rule, status: decision, decidedById: actorId, decidedAt: new Date().toISOString(), note: note?.trim().slice(0, 300) || null };
  // A rejected value no longer contradicts the other rules of its kind and paper.
  const rules = (mem.paperRules ?? []).map((x) => (x.id === id ? next : decision === "REJECTED" && x.contradictedBy === rule.key && x.paper === rule.paper && x.kind === rule.kind ? { ...x, contradictedBy: null } : x));
  await saveExamMemory({ ...mem, paperRules: rules }, actorId, decision === "CONFIRMED" ? "AI_IMPORT_PAPER_RULE_CONFIRMED" : "AI_IMPORT_PAPER_RULE_REJECTED", { id, kind: rule.kind, scope: rule.scope, paper: rule.paper, key: rule.key });
  return next;
}
