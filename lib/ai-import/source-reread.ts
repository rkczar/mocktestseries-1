import "server-only";
import { createHash } from "node:crypto";
import { AiImportFileRole, AiImportJobStatus, AiImportQuestionStatus, type AiImportFigure, type AiImportFile, type AiImportQuestion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { readDocx } from "@/lib/ai-import/docx";
import { vaultPath } from "@/lib/ai-import/vault";
import { docxFigureBytes, docxQuestions, saveQuestion, type StepContext } from "@/lib/ai-import/process";
import { effective, runPostProcessing } from "@/lib/ai-import/post";
import { candidateInstruction, numberSequenceProblems, questionFormats, type QuestionFormat } from "@/lib/ai-import/local-parse";
import { compareVersions, recordVersion, snapshotFigures } from "@/lib/ai-import/versions";
import { rejectQuestions } from "@/lib/ai-import/review";
import { settleJobStatus } from "@/lib/ai-import/summary";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { classifierContext } from "@/lib/ai-import/taxonomy-memory";
import { classifyPaper } from "@/lib/ai-import/taxonomy-classify";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { KEY_MIN_COVERAGE } from "@/lib/ai-import/keys";
import { sourceKeyOf, type ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Source re-read of an existing import (Review Exceptions → Source re-read): the ORIGINAL paper in the vault is read
 * again with the current local reader (Word files — free, no AI) and compared question by question with what is stored.
 *
 *  - preview (dry run): nothing is written. Totals per paper, every changed field, questions the source has but the
 *    import lost, stored questions the source does not have, official-key coverage and corrections, conflicts between
 *    a printed mark and the official key, free subject/topic proposals, the manual-review list and the AI cost.
 *  - apply (an administrator's choice per question, confirmed against the preview it saw): a changed question gets a
 *    PENDING re-read result — nothing is overwritten; the administrator takes it field by field in the question's
 *    review (the current version is kept in its history). A missing question is added as a new extracted question. A
 *    stored question the source does not have is rejected only when chosen (reversible: Restore). Nothing is
 *    approved, imported or published, and the Question Bank is never touched.
 *
 * Scanned papers cannot be re-read for free: the preview lists their out-of-sequence pages, instruction items and
 * missing numbers, with the AI cost of re-scanning those pages (estimated from this import's own recorded cost per
 * page); the re-scan itself is the existing per-question Re-scan, priced and confirmed there.
 */

const LOCKED: AiImportQuestionStatus[] = [AiImportQuestionStatus.IMPORTED, AiImportQuestionStatus.PUBLISHED];
const BUSY: AiImportJobStatus[] = [AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING, AiImportJobStatus.ANALYZING, AiImportJobStatus.QUEUED];
const REREAD_MODEL = "source re-read (local, no AI)";

export type RereadAction = "UNCHANGED" | "CHANGED" | "NEW" | "NOT_IN_SOURCE" | "LOCKED" | "PENDING_EXISTS";

export interface RereadItem {
  key: string;
  number: number | null;
  section: string;
  action: RereadAction;
  questionId: string | null;
  status: string | null;
  fields: { field: string; label: string; current: string; next: string }[];
  stem: string;
  printedAnswer: string[];
  /** Official key value for this number (as printed), and whether the stored official answer would change. */
  keyValue: string | null;
  storedOfficial: string[];
  keyCorrection: boolean;
  /** The source's own printed mark contradicts the official key (both shown; the key decides, an admin confirms). */
  markContradictsKey: boolean;
  formats: QuestionFormat[];
  subjectProposal: string | null;
  topicProposal: string | null;
  storedSubject: string | null;
  storedTopic: string | null;
  classification: "CLASSIFIED" | "SUBJECT_ONLY" | "UNCERTAIN" | "INSUFFICIENT_TEXT" | "NO_TAXONOMY" | null;
  review: string[];
}

export interface ScannedPlan {
  pages: number;
  suspectPages: { page: number; questions: number; reason: string }[];
  instructionItems: { questionId: string; label: string; page: number }[];
  missingNumbers: number[];
  perPageInr: number | null;
  estimateInr: number | null;
  basis: string;
}

export interface RereadFile {
  fileId: string;
  name: string;
  kind: string;
  sourceQuestions: number;
  stored: number;
  items: RereadItem[];
  scanned: ScannedPlan | null;
}

export interface RereadPreview {
  jobId: string;
  /** Identity of exactly what was shown: apply refuses when the source, the questions or the key changed since. */
  hash: string;
  at: string;
  files: RereadFile[];
  totals: { source: number; stored: number; unchanged: number; changed: number; new: number; notInSource: number; locked: number; pendingExists: number; keyCorrections: number; markConflicts: number; classificationChanges: number; unclassified: number; manualReview: number };
  key: { files: { name: string; status: string; entries: number; note: string | null }[]; expected: number | null; complete: boolean };
  costInr: number;
  notes: string[];
}

type QRow = AiImportQuestion & { figures: AiImportFigure[] };
const labelsOf = (raw: string) => [...new Set([...raw.toUpperCase().matchAll(/[A-D]/g)].map((m) => m[0]))];
const WITHDRAWN = /^(x|×|dropped|deleted|withdrawn|bonus|\*)$/i;

async function jobFor(jobId: string) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  return job;
}

/**
 * Official key values by number for one paper — from key files only (a key page inside the paper is not an official key)
 * and only from a COMPLETE reading (at least KEY_MIN_COVERAGE of the expected questions): a partial AI reading of a key
 * grid is no evidence for corrections.
 */
async function keyValues(jobId: string, paperFileId: string, keyFiles: AiImportFile[], expected: number | null): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const f of keyFiles.filter((k) => !k.paperFileId || k.paperFileId === paperFileId)) {
    const rows = await prisma.aiImportKeyEntry.findMany({ where: { jobId, keyFileId: f.id, section: "" }, orderBy: { createdAt: "asc" } });
    if (!expected || new Set(rows.map((r) => r.sourceNumber)).size < Math.ceil(expected * KEY_MIN_COVERAGE)) continue;
    for (const r of rows) out.set(r.sourceNumber, r.rawValue.trim());
  }
  return out;
}

/** The dry run. Reads the vault and the database only; writes nothing. */
export async function sourceRereadPreview(jobId: string): Promise<RereadPreview> {
  const job = await jobFor(jobId);
  const files = await prisma.aiImportFile.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const papers = files.filter((f) => f.role === AiImportFileRole.PAPER && f.storageKey && !f.purgedAt);
  const keyFiles = files.filter((f) => f.role === AiImportFileRole.ANSWER_KEY);
  const rescanPending = new Set((await prisma.aiImportQuestionVersion.findMany({ where: { jobId, kind: "RESCAN", status: "PENDING" }, select: { questionId: true } })).map((v) => v.questionId));
  const taxonomy = await getExamTaxonomy(prisma, job.examId);
  const subjectName = new Map(taxonomy.map((s) => [s.id, s.name]));
  const topicName = new Map(taxonomy.flatMap((s) => s.topics.map((t) => [t.id, t.name] as const)));
  const cc = taxonomy.length ? await classifierContext(job.examId) : null;
  const settings = await getImporterSettings();
  const out: RereadFile[] = [];
  const notes: string[] = [];

  for (const file of papers) {
    const stored = (await prisma.aiImportQuestion.findMany({ where: { fileId: file.id }, include: { figures: true }, orderBy: { orderIndex: "asc" } })) as QRow[];
    const kind = (file.detected as { kind?: string } | null)?.kind ?? file.ext;
    if (kind !== "docx") {
      out.push({ fileId: file.id, name: file.originalName, kind, sourceQuestions: 0, stored: stored.length, items: [], scanned: await scannedPlan(job, file, stored) });
      continue;
    }
    const doc = await readDocx(vaultPath(file.storageKey!));
    const fresh = docxQuestions(doc);
    const keys = await keyValues(jobId, file.id, keyFiles, job.expectedQuestions);
    const byKey = new Map(stored.map((q) => [q.sourceKey, q]));
    const freshKeys = new Set(fresh.map((q) => sourceKeyOf(q)));
    const proposals = cc ? classifyPaper(cc.index, fresh, { allowedSubjects: fresh.map(() => (job.paperType === "SINGLE_SUBJECT" && job.subjectId ? [job.subjectId] : null)), topicMin: settings.verification.topicMinConfidence }).results : [];
    const items: RereadItem[] = [];
    fresh.forEach((q, i) => {
      const key = sourceKeyOf(q);
      const row = byKey.get(key);
      const current = row ? effective(row) : null;
      const figs = row ? snapshotFigures(row.figures) : [];
      const diffs = current ? compareVersions(current, figs, q, figs).filter((d) => !d.same) : [];
      const action: RereadAction = !row ? "NEW" : LOCKED.includes(row.status) ? "LOCKED" : rescanPending.has(row.id) ? "PENDING_EXISTS" : diffs.length ? "CHANGED" : "UNCHANGED";
      const kv = q.section === "" && q.number !== null ? (keys.get(q.number) ?? null) : null;
      const official = kv && !WITHDRAWN.test(kv) ? labelsOf(kv) : [];
      const storedOfficial = row?.officialAnswer ?? [];
      const keyCorrection = !!kv && (WITHDRAWN.test(kv) ? row?.answerStatus !== "WITHDRAWN" : official.join() !== [...storedOfficial].sort().join());
      const markContradictsKey = official.length > 0 && q.printedAnswer.length > 0 && !q.printedAnswer.every((l) => official.includes(l));
      const p = proposals[i];
      const review: string[] = [];
      if (markContradictsKey) review.push(`the source marks ${q.printedAnswer.join(", ")} but the official key says ${kv}`);
      if (kv && WITHDRAWN.test(kv)) review.push(`the official key marks it dropped (“${kv}”)`);
      if (!kv && keys.size) review.push("no official key entry for this number");
      if (q.options.length !== 4 || q.options.some((o) => !o.text.trim())) review.push(`${q.options.length} option(s) found`);
      if (p && p.status !== "CLASSIFIED") review.push(`subject/topic: ${p.status.toLowerCase().replace(/_/g, " ")}`);
      items.push({
        key,
        number: q.number,
        section: q.section,
        action,
        questionId: row?.id ?? null,
        status: row?.status ?? null,
        fields: diffs.map((d) => ({ field: d.field, label: d.label, current: d.current.slice(0, 400), next: d.rescan.slice(0, 400) })),
        stem: q.stem.slice(0, 200),
        printedAnswer: q.printedAnswer,
        keyValue: kv,
        storedOfficial,
        keyCorrection,
        markContradictsKey,
        formats: questionFormats(q),
        subjectProposal: p?.subjectId ? (subjectName.get(p.subjectId) ?? null) : null,
        topicProposal: p?.topicId ? (topicName.get(p.topicId) ?? null) : null,
        storedSubject: row?.subjectId ? (subjectName.get(row.subjectId) ?? null) : null,
        storedTopic: row?.topicId ? (topicName.get(row.topicId) ?? null) : null,
        classification: p?.status ?? null,
        review,
      });
    });
    for (const row of stored) {
      if (freshKeys.has(row.sourceKey)) continue;
      const e = effective(row);
      items.push({ key: row.sourceKey, number: e.number, section: e.section, action: LOCKED.includes(row.status) ? "LOCKED" : row.status === AiImportQuestionStatus.REJECTED ? "UNCHANGED" : "NOT_IN_SOURCE", questionId: row.id, status: row.status, fields: [], stem: e.stem.slice(0, 200), printedAnswer: e.printedAnswer, keyValue: null, storedOfficial: row.officialAnswer, keyCorrection: false, markContradictsKey: false, formats: [], subjectProposal: null, topicProposal: null, storedSubject: row.subjectId ? (subjectName.get(row.subjectId) ?? null) : null, storedTopic: row.topicId ? (topicName.get(row.topicId) ?? null) : null, classification: null, review: row.status === AiImportQuestionStatus.REJECTED ? [] : ["stored, but the source document has no question with this number — reject it if it is not a question"] });
    }
    out.push({ fileId: file.id, name: file.originalName, kind, sourceQuestions: fresh.length, stored: stored.length, items, scanned: null });
  }

  const all = out.flatMap((f) => f.items);
  const count = (a: RereadAction) => all.filter((x) => x.action === a).length;
  const expected = job.expectedQuestions ?? null;
  const keyStatus = keyFiles.map((f) => ({ name: f.originalName, status: f.status, entries: 0, note: f.errorMessage }));
  for (const [i, f] of keyFiles.entries()) keyStatus[i].entries = new Set((await prisma.aiImportKeyEntry.findMany({ where: { jobId, keyFileId: f.id }, select: { sourceNumber: true } })).map((r) => r.sourceNumber)).size;
  const keyComplete = !!expected && keyStatus.some((k) => k.entries >= Math.ceil(expected * KEY_MIN_COVERAGE));
  if (keyFiles.length && !keyComplete) notes.push(`The official answer key is incomplete (${keyStatus.map((k) => `${k.name}: ${k.entries} entr${k.entries === 1 ? "y" : "ies"}`).join("; ")}${expected ? ` of ${expected}` : ""}). The re-read does not read keys: use Retry to read the key again (AI, priced first) or enter the answers by hand — questions without an official answer stay unverified.`);
  if (out.some((f) => f.scanned)) notes.push("Scanned pages cannot be re-read for free. Their re-scan is the existing per-question Re-scan (AI), priced and confirmed there; the estimate below uses this import's own recorded cost per page.");
  const costInr = out.reduce((a, f) => a + (f.scanned?.estimateInr ?? 0), 0);
  const fingerprint = JSON.stringify({ files: out.map((f) => ({ id: f.fileId, items: f.items.map((x) => [x.key, x.action, x.questionId, x.fields.map((d) => [d.field, d.next]), x.keyValue]) })), keys: keyStatus.map((k) => [k.name, k.entries]) });
  return {
    jobId,
    hash: createHash("sha256").update(fingerprint).digest("hex").slice(0, 32),
    at: new Date().toISOString(),
    files: out,
    totals: {
      source: out.reduce((a, f) => a + f.sourceQuestions, 0),
      stored: out.reduce((a, f) => a + f.stored, 0),
      unchanged: count("UNCHANGED"),
      changed: count("CHANGED"),
      new: count("NEW"),
      notInSource: count("NOT_IN_SOURCE"),
      locked: count("LOCKED"),
      pendingExists: count("PENDING_EXISTS"),
      keyCorrections: all.filter((x) => x.keyCorrection).length,
      markConflicts: all.filter((x) => x.markContradictsKey).length,
      classificationChanges: all.filter((x) => x.questionId && x.subjectProposal && x.subjectProposal !== x.storedSubject).length,
      unclassified: all.filter((x) => x.classification && x.classification !== "CLASSIFIED").length,
      manualReview: all.filter((x) => x.review.length).length,
    },
    key: { files: keyStatus, expected, complete: keyComplete || !keyFiles.length },
    costInr: Math.round(costInr * 100) / 100,
    notes,
  };
}

/** Out-of-sequence pages, instruction items and missing numbers of an AI-read (scanned) paper, with the re-scan cost. */
async function scannedPlan(job: { id: string; expectedQuestions: number | null }, file: AiImportFile, stored: QRow[]): Promise<ScannedPlan> {
  const live = stored.filter((q) => q.status !== AiImportQuestionStatus.REJECTED);
  const seq = numberSequenceProblems(live.filter((q) => /^AI/.test(effective(q).method ?? "") && !candidateInstruction(effective(q))).map((q) => ({ id: q.id, page: effective(q).pages[0] ?? 0, section: effective(q).section, number: effective(q).number })));
  const pages = new Map<number, { questions: number; reason: string }>();
  for (const q of live) {
    const why = seq.get(q.id);
    if (!why) continue;
    const p = effective(q).pages[0] ?? 0;
    pages.set(p, { questions: (pages.get(p)?.questions ?? 0) + 1, reason: why });
  }
  const instructionItems = live.filter((q) => candidateInstruction(effective(q))).map((q) => ({ questionId: q.id, label: q.sourceLabel, page: effective(q).pages[0] ?? 0 }));
  const numbers = new Set(live.filter((q) => effective(q).section === "" && !candidateInstruction(effective(q))).map((q) => effective(q).number));
  const expected = job.expectedQuestions ?? file.pageCount ?? 0;
  const missingNumbers = job.expectedQuestions ? Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !numbers.has(n)) : [];
  // Cost per page from this import's own recorded page reads (extraction + independent read), never a guess.
  const calls = await prisma.aiImportAiCall.findMany({ where: { jobId: job.id, task: { in: ["extract", "verify"] }, pageId: { not: null } }, select: { pageId: true, costInr: true, estCostInr: true } });
  const perPage = new Map<string, number>();
  for (const c of calls) perPage.set(c.pageId!, (perPage.get(c.pageId!) ?? 0) + (c.costInr ?? c.estCostInr ?? 0));
  const perPageInr = perPage.size ? [...perPage.values()].reduce((a, b) => a + b, 0) / perPage.size : null;
  const n = pages.size;
  return {
    pages: file.pageCount ?? 0,
    suspectPages: [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([page, v]) => ({ page, ...v })),
    instructionItems,
    missingNumbers,
    perPageInr: perPageInr === null ? null : Math.round(perPageInr * 100) / 100,
    estimateInr: perPageInr === null ? null : Math.round(perPageInr * n * 100) / 100,
    basis: perPageInr === null ? "no recorded page reads to estimate from" : `${n} page(s) × ₹${perPageInr.toFixed(2)} (this import's average recorded cost per page read, extraction + independent read)`,
  };
}

export interface RereadChoice {
  /** CHANGED items (by key) that get a PENDING re-read result. */
  pending: string[];
  /** NEW items (by key) added as extracted questions. */
  add: string[];
  /** NOT_IN_SOURCE stored questions (by id) to reject (reversible). */
  reject: string[];
}

/** Applies the administrator's per-question choice — only when the preview it saw is still current. */
export async function applySourceReread(input: { jobId: string; actorId: string; hash: string; choice: RereadChoice }): Promise<{ pending: number; added: number; rejected: number }> {
  const job = await jobFor(input.jobId);
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("The import is busy or cancelled — try again when it has finished.");
  const preview = await sourceRereadPreview(input.jobId);
  if (preview.hash !== input.hash) throw new ImportJobError("The source, the questions or the answer key changed since this preview — open the preview again and check it before applying.");
  const items = preview.files.flatMap((f) => f.items.map((x) => ({ ...x, fileId: f.fileId })));
  const pick = (keys: string[], action: RereadAction) => keys.map((k) => items.find((x) => x.key === k && x.action === action)).filter((x): x is (typeof items)[number] => !!x);
  const pending = pick([...new Set(input.choice.pending)], "CHANGED");
  const add = pick([...new Set(input.choice.add)], "NEW");
  const reject = [...new Set(input.choice.reject)].map((id) => items.find((x) => x.questionId === id && x.action === "NOT_IN_SOURCE")).filter((x): x is (typeof items)[number] => !!x);
  if (!pending.length && !add.length && !reject.length) throw new ImportJobError("Choose at least one question.");

  const files = new Map<string, { file: AiImportFile; fresh: Map<string, ExtractedQuestion>; bytes: ReturnType<typeof docxFigureBytes> }>();
  for (const fileId of new Set([...pending, ...add].map((x) => x.fileId))) {
    const file = await prisma.aiImportFile.findUniqueOrThrow({ where: { id: fileId } });
    const doc = await readDocx(vaultPath(file.storageKey!));
    files.set(fileId, { file, fresh: new Map(docxQuestions(doc).map((q) => [sourceKeyOf(q), q])), bytes: docxFigureBytes(doc) });
  }
  for (const x of pending) {
    const q = files.get(x.fileId)!.fresh.get(x.key)!;
    const row = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: x.questionId! }, include: { figures: true } });
    await prisma.aiImportQuestionVersion.updateMany({ where: { questionId: row.id, kind: "RESCAN", status: "PENDING" }, data: { status: "DISCARDED", decidedAt: new Date(), note: "Replaced by a newer re-read." } });
    // The current figures are the version's figures: the re-read changes text, never figures.
    await recordVersion({ questionId: row.id, jobId: job.id, kind: "RESCAN", status: "PENDING", data: { ...q, figures: (effective(row).figures ?? []) }, figures: snapshotFigures(row.figures), model: REREAD_MODEL, actorId: input.actorId, note: `Source re-read of ${files.get(x.fileId)!.file.originalName} (local, no AI): ${x.fields.map((f) => f.label).join(", ")} differ. Nothing was changed — compare and choose what to keep.` });
  }
  const ctx: StepContext = { job, settings: { ...(await getImporterSettings()), aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true };
  const addedIds: string[] = [];
  for (const x of add) {
    const f = files.get(x.fileId)!;
    const q = f.fresh.get(x.key)!;
    q.notes = [...(q.notes ?? []), "Added by the source re-read: the earlier extraction of this paper lost this question."];
    const after = await prisma.aiImportQuestion.findFirst({ where: { fileId: f.file.id, sourceNumber: { lt: q.number ?? 0 } }, orderBy: { orderIndex: "desc" }, select: { orderIndex: true } });
    await saveQuestion(ctx, f.file, q, after?.orderIndex ?? 0, f.bytes, 1, { model: REREAD_MODEL });
    const row = await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: f.file.id, sourceKey: x.key } }, select: { id: true } });
    if (row) addedIds.push(row.id);
  }
  if (reject.length) await rejectQuestions(reject.map((x) => x.questionId!), input.actorId, "Not in the source document (source re-read): the earlier extraction read a statement / list line as a question.");
  // The deterministic checks (key matching, structure, free classification) for the added questions only — no AI.
  if (addedIds.length) await runPostProcessing(ctx, new Set(addedIds));
  await settleJobStatus(job.id);
  await logEvent(job.id, "SOURCE_REREAD_APPLIED", `Source re-read (local, no AI): ${pending.length} pending result(s) to review, ${add.length} missing question(s) added, ${reject.length} question(s) not in the source rejected. Nothing was approved or published.`, { hash: input.hash, pending: pending.map((x) => x.key), added: add.map((x) => x.key), rejected: reject.map((x) => x.questionId) }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_SOURCE_REREAD", entityType: "AiImportJob", entityId: job.id, metadata: { pending: pending.length, added: add.length, rejected: reject.length, hash: input.hash } } });
  return { pending: pending.length, added: add.length, rejected: reject.length };
}
