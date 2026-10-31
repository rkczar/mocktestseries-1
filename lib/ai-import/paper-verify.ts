import "server-only";
import { readFile } from "node:fs/promises";
import { AiImportJobStatus, AiImportQuestionStatus, Prisma, type AiImportFigure, type AiImportFile, type AiImportQuestion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { parseImportFile } from "@/lib/bulk-import";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { ISSUE_DEFS, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { kickWorker } from "@/lib/ai-import/kick";
import { effective, runPostProcessing } from "@/lib/ai-import/post";
import { ANNOTATION_TAIL, blockToQuestion, explanationIsHeading, mergedAnswerIn, splitQuestions, statementCodeQuestion, stripAnnotationTail } from "@/lib/ai-import/local-parse";
import { applyFormatProfile } from "@/lib/ai-import/format-profile";
import { referenceStatus, type ReferenceStatus } from "@/lib/ai-import/reference-status";
import { classifyUserText, decideClassification, taxonomyCodes } from "@/lib/ai-import/taxonomy-check";
import { classifyPaper, textSufficient, verifyStoredTaxonomy, type LocalClassification } from "@/lib/ai-import/taxonomy-classify";
import { classifierContext, examFormatRules, jobMemoryBrief, jobPaperMemory, type FormatRuleCode } from "@/lib/ai-import/taxonomy-memory";
import { confirmedRulesFor, memoryBrief, memoryFindings, type PaperRule } from "@/lib/ai-import/paper-memory";
import { v1FieldChecks, v2FieldChecks, type AnswerFacts } from "@/lib/ai-import/field-checks";
import { readDocx } from "@/lib/ai-import/docx";
import { numbersMissingFromSource } from "@/lib/ai-import/fidelity";
import { MIN_CROP_SIDE, visionImage } from "@/lib/ai-import/figures";
import { assignSections, ensureRender, mergeContinuation, parsePage, readsAgree, type StepContext } from "@/lib/ai-import/process";
import { exhaustedModels, importerAiCall, modelFamily, parseModelJson, preferReliable, estimateInputTokens, ImporterAiFailure, ImporterAiUnavailable, PRICE_MARGIN, REQUEST_ATTEMPTS } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM, CLASSIFY_BATCH, classifyAnswerOf, documentTextUserText, extractUserText, toExtracted } from "@/lib/ai-import/prompts";
import { computeModelPlan, profileInputTokens, requestUsd } from "@/lib/ai-import/select";
import { compareWithReference, listReferences, referenceOnly, textSimilarity, type ReferencePaper } from "@/lib/ai-import/reference";
import { recordVersion, snapshotFigures } from "@/lib/ai-import/versions";
import { exists as vaultExists, vaultPath } from "@/lib/ai-import/vault";
import { jobQuality, settleJobStatus } from "@/lib/ai-import/summary";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { approveQuestions, requestImport } from "@/lib/ai-import/review";
import { MAX_VERIFY_PASSES, V2_RESULT_STATUSES, contentCurrent, contentFingerprint, fingerprintParts, fingerprintsOf, needsVerify2, passCount, stampOf, verifyState, withPass, type Fp } from "@/lib/ai-import/verify-core";
import type { CandidateRow, PlanPrice, TaskChoice } from "@/lib/ai-import/selection-types";
import type { ExtractedQuestion, PaperVerification, VerifyFix, VerifyProblem } from "@/lib/ai-import/types";

/**
 * Full-paper verification of an import (Admin → AI Question Importer → Review Exceptions):
 *
 *  Verify 1 — the whole job at once, deterministic and free: question segmentation and numbering, every
 *  option and printed answer (an answer run into an option is moved out of it when the source text shows
 *  it), answer key ↔ question type, exam subject / topic / subtopic ids, formulas and unreadable glyphs,
 *  figure crops (file, bounds, aspect ratio, resolution) and their question, questions spanning pages and
 *  the optional reference papers. Corrections are applied only with source evidence; the previous version
 *  is kept in the question history.
 *
 *  Verify 2 — an independent second read of the ORIGINAL source by a separately selected model (never one
 *  that extracted this job), priced and confirmed before anything is sent, run by the worker. Each
 *  question's wording, options, printed answer, numbers / symbols, figures and subject are compared with the
 *  stored question and its Verify 1 result; a disagreement the source text cannot settle is flagged for
 *  manual correction. Model, changes, reasons, cost and status are recorded.
 *
 *  Results live on the extraction (data.paperVerify) with a content fingerprint, so any later change makes
 *  them stale instead of silently trusted.
 */

const LOCKED: AiImportQuestionStatus[] = [AiImportQuestionStatus.IMPORTED, AiImportQuestionStatus.PUBLISHED, AiImportQuestionStatus.REJECTED];
const FINISHED: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES];

type QRow = AiImportQuestion & { figures: AiImportFigure[] };

/** The question's current fingerprints (combined + parts): what a verification result is judged against. */
export function fingerprintOf(q: QRow): Fp {
  return fingerprintsOf({ e: effective(q), finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures });
}
/** What a new result records: the combined fingerprint (older readers) and the parts. */
const stamp = (q: QRow) => stampOf(fingerprintOf(q));
/** The answer facts a field check judges (the official key outranks everything; an admin's choice is recorded as such). */
const answerFacts = (q: Pick<QRow, "finalAnswer" | "officialAnswer" | "answerStatus" | "answerConfirmedById">): AnswerFacts => ({ final: q.finalAnswer, official: q.officialAnswer, status: q.answerStatus, adminConfirmed: !!q.answerConfirmedById });
/** A confirmed rule of this paper says its printed answer marks contradicted the official key. */
const marksUnreliable = (rules: PaperRule[]) => rules.some((r) => r.kind === "ANNOTATION_RELIABILITY" && Number(r.value.agree ?? 0) < Number(r.value.total ?? 0));
/** The subject / topic a classification check saw is the one stored now. */
const sameTaxonomy = (q: Pick<QRow, "subjectId" | "topicId" | "subTopicId">, c: { stored: { subjectId: string | null; topicId: string | null; subTopicId: string | null } } | null | undefined) => !!c && c.stored.subjectId === q.subjectId && c.stored.topicId === q.topicId && c.stored.subTopicId === q.subTopicId;

async function finishedJob(jobId: string) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (!FINISHED.includes(job.status)) throw new ImportJobError(job.status === AiImportJobStatus.QUEUED || job.status === AiImportJobStatus.PROCESSING ? "The import is running. Verify it once processing has finished." : `The import is ${job.status.toLowerCase().replace(/_/g, " ")}; only a processed import can be verified.`, 409);
  return job;
}

async function savePaperVerify(q: { id: string; data: Prisma.JsonValue }, patch: PaperVerification): Promise<void> {
  const d = q.data as unknown as ExtractedQuestion;
  await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { data: { ...d, paperVerify: { ...(d.paperVerify ?? {}), ...patch } } as unknown as Prisma.InputJsonValue } });
}

const nrm = (s: string) => s.toLowerCase().replace(/\$|\\[a-z]+|[\s.,;:()[\]{}'"`]/g, "");

// ---- Verify 1 -------------------------------------------------------------------------------------------

export interface Verify1Result {
  questions: number;
  passed: number;
  withProblems: number;
  corrected: number;
  missing: string[];
  duplicateNumbers: string[];
  referenceOnly: string[];
  referenceConflicts: number;
  referencesCompared: number;
  /** References that were only stored (scanned): named, never counted as compared. */
  referencesNotCompared: string[];
  /** Questions whose line breaks (statements, paragraphs) were restored from the Word source. */
  whitespaceRestored: number;
  /** Subject / topic check results (free): AGREED / DISAGREEMENT / NEEDS_REVIEW / NOT_VERIFIED. */
  classification?: Record<string, number>;
  /** Printed ticks removed from options with source evidence; section headings restored / removed from explanations. */
  annotationsRemoved?: number;
  headingsRestored?: number;
  /** Earlier Verify 2 results kept (provably unchanged content), settled by a rule, or left out of date. */
  verify2Upgrade?: { rebuilt: number; viaEdit: number; reassessed: number; stale: number };
}

/** The type disagreement of a statement-code question is no disagreement when its key gives one code option. */
function codeSingle(q: QRow, e: ExtractedQuestion, rules: Set<FormatRuleCode>): boolean {
  return e.type === "SINGLE_CORRECT" && statementCodeQuestion(e) && q.finalAnswer.length === 1 && (q.answerStatus === "OFFICIAL_MATCHED" || !!q.answerConfirmedById || rules.has("STATEMENT_CODE_SINGLE"));
}
/** The question as content checks compare it: a lone printed tick left at the end of the text / an option is no content. */
function withoutAnnotations(e: ExtractedQuestion): ExtractedQuestion {
  return { ...e, stem: stripAnnotationTail(e.stem), options: e.options.map((o) => ({ ...o, text: stripAnnotationTail(o.text) })) };
}

/**
 * Upgrades Verify 2 results without any AI request:
 *  - an older result (one combined fingerprint) whose combined fingerprint is reproduced EXACTLY from the stored
 *    content — the current one, or the original extraction when only a printed tick was removed by hand since — with
 *    the subject / topic it checked (recorded in its classification) proves that content, answer and figures did not
 *    change: it gets its parts (its taxonomy part = what it checked, so only the subject / topic check is out of date);
 *    anything else stays out of date;
 *  - a current DISAGREE whose every differing field a deterministic rule settles from the recorded second read
 *    (statement-code type with a one-label key; an option differing only by a printed tick) becomes VERIFIED, with the
 *    rule and the previous verdict recorded.
 */
export async function upgradeVerify2Results(jobId: string, rules: Set<FormatRuleCode>): Promise<{ rebuilt: number; viaEdit: number; reassessed: number; stale: number }> {
  const out = { rebuilt: 0, viaEdit: 0, reassessed: 0, stale: 0 };
  const now = new Date().toISOString();
  for (const q of await prisma.aiImportQuestion.findMany({ where: { jobId, status: { notIn: LOCKED } }, include: { figures: true } })) {
    const d = q.data as unknown as ExtractedQuestion;
    let v2 = d.paperVerify?.v2;
    if (!v2) continue;
    const cur = fingerprintOf(q);
    let changed = false;
    if (!v2.parts) {
      const taxCandidates = [v2.classification?.stored, d.paperVerify?.v1?.classification?.stored, { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId }].filter((x): x is { subjectId: string | null; topicId: string | null; subTopicId: string | null } => !!x);
      const contents: { e: ExtractedQuestion; edited: boolean }[] = [{ e: effective(q), edited: false }, ...(q.editedData ? [{ e: d, edited: true }] : [])];
      let proof: { tax: (typeof taxCandidates)[number]; edited: boolean } | null = null;
      for (const c of contents)
        for (const tax of taxCandidates) {
          if (proof) break;
          if (contentFingerprint({ e: c.e, finalAnswer: q.finalAnswer, ...tax, figures: q.figures }) !== v2.fingerprint) continue;
          // Reproduced: this content was what Verify 2 compared. It counts only if the current content is the same once
          // printed ticks are ignored (an edit that removed only a tick), with the same answer.
          const then = fingerprintParts({ e: c.e, finalAnswer: q.finalAnswer, ...tax, figures: q.figures });
          if (then.content === cur.parts.content && then.answer === cur.parts.answer && then.figures === cur.parts.figures) proof = { tax, edited: c.edited };
        }
      if (proof) {
        const taxonomy = fingerprintParts({ e: effective(q), finalAnswer: q.finalAnswer, ...proof.tax, figures: q.figures }).taxonomy;
        v2 = { ...v2, parts: { ...cur.parts, taxonomy }, rebuilt: { at: now, proof: `combined fingerprint ${v2.fingerprint.slice(0, 8)}… reproduced from the ${proof.edited ? "original extraction (the later edit only removed a printed tick)" : "stored content"} with the subject / topic it checked; content, answer and figures unchanged` } };
        out.rebuilt++;
        if (proof.edited) out.viaEdit++;
        changed = true;
      } else {
        out.stale++;
        continue;
      }
    }
    if (v2.status === "DISAGREE" && contentCurrent(v2, cur)) {
      const e = effective(q);
      const settled = v2.fields.every((f) => {
        if (f === "type") return codeSingle(q, e, rules);
        const m = /^option ([A-E])$/.exec(f);
        if (!m) return false;
        const i = e.options.findIndex((o) => o.label === m[1]);
        const second = v2!.second?.options?.[i];
        const mine = e.options[i] ? stripAnnotationTail(e.options[i].text) : null;
        return mine !== null && typeof second === "string" && textSimilarity(mine.slice(0, 200), second) >= 0.85;
      });
      if (settled && v2.fields.length) {
        const rule = v2.fields.map((f) => (f === "type" ? "statement-code question with a one-label key is single-correct" : `${f} differs only by a printed tick`)).join("; ");
        v2 = { ...v2, status: "VERIFIED", reassessed: { at: now, rule, before: v2.detail.slice(0, 300) }, resolvedBySource: rule, detail: `re-assessed without AI: ${rule}` };
        out.reassessed++;
        changed = true;
      }
    }
    if (changed) await savePaperVerify(q, { v2 });
  }
  return out;
}

export async function runVerify1(jobId: string, actorId: string): Promise<Verify1Result> {
  const job = await finishedJob(jobId);
  const settings = await getImporterSettings();
  const ctx: StepContext = { job, settings: { ...settings, aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true };
  const pages = await prisma.aiImportPage.findMany({ where: { jobId }, select: { fileId: true, pageNumber: true, kind: true, textLayer: true, renderWidth: true, renderHeight: true } });
  const pageOf = (fileId: string, n: number) => pages.find((p) => p.fileId === fileId && p.pageNumber === n);
  const files = await prisma.aiImportFile.findMany({ where: { jobId }, select: { id: true, pageCount: true, detected: true } });
  const fixesBy = new Map<string, VerifyFix[]>();
  const fixProblems = new Map<string, VerifyProblem[]>();
  const rules = await examFormatRules(job.examId);
  // 0. Verify 2 results of an earlier release (one combined fingerprint) are given their parts where the stored content
  // provably did not change since (rebuildLegacy); a recorded disagreement a deterministic rule settles is re-assessed.
  // Both use only what is stored — no AI request. Runs before any correction below changes the content.
  const legacy = await upgradeVerify2Results(jobId, rules);
  if (legacy.rebuilt || legacy.reassessed || legacy.stale) await logEvent(jobId, "VERIFY2_RESULTS_UPGRADED", `Earlier Verify 2 results checked without AI: ${legacy.rebuilt} kept (content provably unchanged since the read — only the subject / topic changed${legacy.viaEdit ? `, or only a printed tick was removed by hand in ${legacy.viaEdit}` : ""}), ${legacy.reassessed} disagreement(s) settled by a deterministic rule (statement-code type, printed tick), ${legacy.stale} left out of date (content, answer or figures changed — Verify 2 must read them again).`, { ...legacy }, actorId);
  // A previous Verify 1 result is replaced, so its findings must not decide this run.
  for (const q of await prisma.aiImportQuestion.findMany({ where: { jobId }, select: { id: true, data: true } })) {
    const d = q.data as unknown as ExtractedQuestion;
    if (!d.paperVerify?.v1) continue;
    const { v1: _old, ...rest } = d.paperVerify;
    void _old;
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { data: { ...d, paperVerify: rest } as unknown as Prisma.InputJsonValue } });
  }

  // 1. Corrections with source evidence: an answer (and explanation) run into an option / the question text.
  for (const q of await prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true } })) {
    if (LOCKED.includes(q.status)) continue;
    const d = q.data as unknown as ExtractedQuestion;
    const m = mergedAnswerIn(effective(q));
    if (!m) continue;
    const kind = (files.find((f) => f.id === q.fileId)?.detected as { kind?: string } | null)?.kind;
    const layer = d.pages.map((p) => pageOf(q.fileId, p)?.textLayer ?? "").join("\n");
    const evidence = layer && nrm(layer).includes(nrm(m.raw)) ? `printed in the source text of page ${d.pages.join(", ")}` : kind === "docx" || kind === "xlsx" || kind === "csv" || d.method === "LOCAL_PDF" ? "read from the document's own text" : null;
    const printed = effective(q).printedAnswer;
    if (q.editedData || !evidence || (printed.length && [...printed].sort().join() !== [...m.labels].sort().join())) {
      fixProblems.set(q.id, [{ code: "ANSWER_IN_OPTION", detail: `${m.where[0].toUpperCase()}${m.where.slice(1)} contains the printed answer “${m.raw.slice(0, 80)}”. ${q.editedData ? "The question was corrected by hand, so it is not changed automatically" : !evidence ? "The source text cannot confirm it (scanned page)" : `The paper also prints ${printed.join(", ")}`} — remove it from the option and set the answer.` }]);
      continue;
    }
    const after: ExtractedQuestion = { ...d, stem: m.stem, options: m.options, printedAnswer: m.labels, printedAnswerRaw: m.raw, ...(m.explanation ? { hints: { ...(d.hints ?? {}), explanation: d.hints?.explanation ?? m.explanation } } : {}), notes: [...(d.notes ?? []), `Verify 1 moved the printed answer “${m.raw.slice(0, 60)}” out of the ${m.where} (${evidence}).`] };
    const fixes: VerifyFix[] = [{ field: m.where, before: m.where === "question text" ? d.stem.slice(-160) : (d.options.find((o) => `option ${o.label}` === m.where)?.text ?? "").slice(0, 300), after: m.where === "question text" ? m.stem.slice(-160) : (m.options.find((o) => `option ${o.label}` === m.where)?.text ?? "").slice(0, 300), evidence }, { field: "printed answer", before: printed.join(", ") || "—", after: m.labels.join(", "), evidence }];
    if (m.explanation) fixes.push({ field: "explanation", before: d.hints?.explanation ?? "—", after: m.explanation.slice(0, 200), evidence });
    await recordVersion({ questionId: q.id, jobId, kind: "EXTRACTION", data: d, figures: snapshotFigures(q.figures), changes: fixes, actorId, note: `Before Verify 1 moved the printed answer out of the ${m.where}.` });
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { data: after as unknown as Prisma.InputJsonValue, approvedById: null, approvedAt: null } });
    fixesBy.set(q.id, fixes);
  }

  // 1b. Line breaks lost by an earlier reading (numbered statements run together): restored from the Word source when
  // the source's text is the same apart from whitespace. Only whitespace changes; the previous version is kept.
  let restored = 0;
  const freshByFile = new Map<string, { name: string; questions: Map<string, ExtractedQuestion> }>();
  for (const file of files) {
    if ((file.detected as { kind?: string } | null)?.kind !== "docx") continue;
    const row = await prisma.aiImportFile.findUnique({ where: { id: file.id }, select: { storageKey: true, originalName: true } });
    if (!row?.storageKey) continue;
    const fresh = new Map<string, ExtractedQuestion>();
    try {
      const doc = await readDocx(vaultPath(row.storageKey));
      for (const b of splitQuestions(doc.lines).blocks) {
        const fq = blockToQuestion(b, 1, "DOCX").q;
        fresh.set(`${fq.section}|${fq.number}`, fq);
      }
    } catch {
      continue;
    }
    freshByFile.set(file.id, { name: row.originalName, questions: fresh });
    const strip = (t: string) => t.replace(/\s*⟦IMG:(?:\d+|missing)⟧\s*/g, " ");
    const flat = (t: string) => strip(t).replace(/\s+/g, "");
    for (const q of await prisma.aiImportQuestion.findMany({ where: { fileId: file.id }, include: { figures: true } })) {
      if (LOCKED.includes(q.status) || q.editedData) continue;
      const d = q.data as unknown as ExtractedQuestion;
      const src = fresh.get(`${d.section}|${d.number}`);
      if (!src) continue;
      const stem = strip(src.stem).replace(/[ \t]{2,}/g, " ").trim();
      if (stem === d.stem || flat(stem) !== flat(d.stem)) continue;
      const fixes: VerifyFix[] = [{ field: "question text", before: d.stem.slice(0, 300), after: stem.slice(0, 300), evidence: `line breaks as printed in ${row.originalName} (whitespace only)` }];
      await recordVersion({ questionId: q.id, jobId, kind: "EXTRACTION", data: d, figures: snapshotFigures(q.figures), changes: fixes, actorId, note: "Before Verify 1 restored the line breaks from the Word source." });
      await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { data: { ...d, stem, notes: [...(d.notes ?? []), "Verify 1 restored the line breaks of the question text from the Word source (whitespace only)."] } as unknown as Prisma.InputJsonValue, approvedById: null, approvedAt: null } });
      fixesBy.set(q.id, [...(fixesBy.get(q.id) ?? []), ...fixes]);
      restored++;
    }
  }

  // 1d. A lone printed tick left at the end of an option / the question text (the mark of the answer line that follows
  // the options, "✓ Correct Answer: (b) …"), and section headings the earlier reading missed: corrected only with source
  // evidence (the Word source read again, or the page's text layer), never on a question an administrator edited or
  // approved; the previous version is kept in the question history. A heading stored as an explanation is removed.
  let ticksRemoved = 0;
  let headingsRestored = 0;
  for (const q of await prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true } })) {
    if (LOCKED.includes(q.status)) continue;
    const d = q.data as unknown as ExtractedQuestion;
    const src = freshByFile.get(q.fileId);
    const twin = src?.questions.get(`${d.section}|${d.number}`);
    const fixes: VerifyFix[] = [];
    let next: ExtractedQuestion = d;
    const tailed = [d.stem, ...d.options.map((o) => o.text)].some((t) => ANNOTATION_TAIL.test(t));
    if (tailed && !q.editedData && !q.approvedById) {
      const layer = d.pages.map((p) => pageOf(q.fileId, p)?.textLayer ?? "").join("\n");
      const docEvidence = twin && twin.options.length === d.options.length && twin.options.every((o, i) => o.text.trim() === stripAnnotationTail(d.options[i].text).trim()) && !!twin.printedAnswerRaw && /^[✓✔☑√■]/.test(twin.printedAnswerRaw);
      const layerEvidence = /(?:^|\n)\s*[✓✔☑√■]\s*(?:the\s+)?(?:correct|right|official|final|ans|key)/i.test(layer);
      const evidence = docEvidence ? `${src!.name} prints the mark on the answer line (“${twin!.printedAnswerRaw!.slice(0, 50)}”)` : layerEvidence ? `the page's text prints the mark on the answer line` : null;
      if (evidence) {
        next = { ...next, stem: stripAnnotationTail(next.stem), options: next.options.map((o) => ({ ...o, text: stripAnnotationTail(o.text) })) };
        for (const [i, o] of d.options.entries()) if (o.text !== next.options[i].text) fixes.push({ field: `option ${o.label}`, before: o.text.slice(-120), after: next.options[i].text.slice(-120), evidence });
        if (d.stem !== next.stem) fixes.push({ field: "question text", before: d.stem.slice(-120), after: next.stem.slice(-120), evidence });
        ticksRemoved++;
      } else fixProblems.set(q.id, [...(fixProblems.get(q.id) ?? []), { code: "EXTRACTION_UNCERTAIN", detail: "A lone ✓ / ■ mark ends an option or the question text, and the source cannot confirm it is the answer line's mark — remove it by hand if it is not part of the option." }]);
    }
    if (twin && !q.approvedById) {
      const heading = twin.hints?.subject ?? null;
      const leaked = explanationIsHeading(d.hints?.explanation);
      if ((heading && heading !== d.hints?.subject) || leaked) {
        const hints = { ...(d.hints ?? {}), ...(heading ? { subject: heading } : {}) };
        if (leaked) delete hints.explanation;
        next = { ...next, hints };
        if (heading && heading !== d.hints?.subject) fixes.push({ field: "section heading", before: d.hints?.subject ?? "—", after: heading, evidence: `printed above this question in ${src!.name}` });
        if (leaked) fixes.push({ field: "explanation", before: d.hints!.explanation!.slice(0, 120), after: "—", evidence: `the next section's heading in ${src!.name}, not an explanation` });
        headingsRestored++;
      }
    }
    if (!fixes.length) continue;
    await recordVersion({ questionId: q.id, jobId, kind: "EXTRACTION", data: d, figures: snapshotFigures(q.figures), changes: fixes, actorId, note: "Before Verify 1 removed a printed annotation / restored the section heading from the source." });
    const notes = [...(d.notes ?? []), `Verify 1: ${fixes.map((f) => f.field).join(", ")} corrected from the source.`];
    // Only annotations and hints change (never the wording): the content fingerprint is the same, so no verification lapses.
    const edited = q.editedData && next.hints !== d.hints ? { ...(q.editedData as unknown as ExtractedQuestion), hints: next.hints } : null;
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { data: { ...next, notes } as unknown as Prisma.InputJsonValue, ...(edited ? { editedData: edited as unknown as Prisma.InputJsonValue } : {}) } });
    fixesBy.set(q.id, [...(fixesBy.get(q.id) ?? []), ...fixes]);
  }

  // 1c. A reusable paper-format profile for this exam / format, checked against THIS paper (never trusted blindly).
  const profileRun = await applyFormatProfile(jobId);
  const profileFindings = profileRun?.findings ?? new Map<string, { id: string; version: number; findings: string[] }>();
  const profileNote = profileRun?.summary ?? null;

  // 2. Every deterministic check of the importer, on the corrected content (no AI). Questions still without a
  // subject / topic get the free local classification there (never a paid call).
  await runPostProcessing(ctx);

  // 2b. Subject / topic check (free): the local classifier over the whole paper WITHOUT the stored choice (only a
  // single-subject paper stays within its selected subject), compared with what is stored.
  const examTaxonomy = await getExamTaxonomy(prisma, job.examId);
  const independent = new Map<string, LocalClassification>();
  {
    const rows = (await prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }] })).filter((q) => !LOCKED.includes(q.status));
    if (examTaxonomy.length && rows.length) {
      const cc = await classifierContext(job.examId);
      const single = job.paperType === "SINGLE_SUBJECT" && job.subjectId ? [job.subjectId] : null;
      const { results } = classifyPaper(cc.index, rows.map((q) => effective(q)), { allowedSubjects: rows.map(() => single), topicMin: settings.verification.topicMinConfidence });
      rows.forEach((q, i) => independent.set(q.id, results[i]));
    }
  }
  const taxTally = { AGREED: 0, DISAGREEMENT: 0, NEEDS_REVIEW: 0, VERIFICATION_FAILED: 0, NOT_VERIFIED: 0 };
  // Paper memory: the confirmed rules of this paper / exam (format, printed-mark reliability, known extraction errors,
  // OCR confusions, subject scope) are checked on every question — a finding is flagged, never changed.
  const { paper, rules: paperRules } = await jobPaperMemory(job);
  const memRules = confirmedRulesFor(paperRules, paper);
  const subjectNames = new Map(examTaxonomy.map((s) => [s.id, s.name]));
  const taxName = new Map([...examTaxonomy.map((s) => [s.id, s.name] as const), ...examTaxonomy.flatMap((s) => s.topics.map((t) => [t.id, t.name] as const))]);
  const fileSha = new Map((await prisma.aiImportFile.findMany({ where: { jobId }, select: { id: true, sha256: true } })).map((f) => [f.id, f.sha256]));

  // 3. Full-paper checks + reference papers.
  const refs = await listReferences(jobId);
  const questions = await prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }] });
  const lastPage = new Map(files.map((f) => [f.id, f.pageCount ?? 1]));
  let passed = 0;
  let withProblems = 0;
  let refConflicts = 0;
  for (const q of questions) {
    if (LOCKED.includes(q.status)) continue;
    const e = effective(q);
    const problems: VerifyProblem[] = [...(fixProblems.get(q.id) ?? [])];
    for (const f of profileFindings.get(q.id)?.findings ?? []) problems.push({ code: "FORMAT_DEVIATION", detail: `Format profile: ${f}` });
    const tax = verifyStoredTaxonomy({ subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, source: q.taxonomySource }, independent.get(q.id), examTaxonomy);
    taxTally[tax.verification.status]++;
    problems.push(...tax.problems);
    const memory = memRules.length ? memoryFindings(memRules, paper, e, { aiRead: /^AI/.test(e.method ?? ""), officialAnswer: q.answerStatus === "OFFICIAL_MATCHED", finalAnswer: q.finalAnswer, subjectName: q.subjectId ? (subjectNames.get(q.subjectId) ?? null) : null, fileSha256: fileSha.get(q.fileId) ?? null }) : [];
    for (const m of memory) problems.push({ code: "FORMAT_DEVIATION", detail: m.detail });
    if (e.continuesOnNextPage && e.pages.length === 1 && e.pages[0] < (lastPage.get(q.fileId) ?? 1)) problems.push({ code: "QUESTION_TEXT_SUSPECT", detail: `Marked as continuing on page ${e.pages[0] + 1}, but no continuation was joined to it — check both pages.` });
    const texts = [e.stem, ...e.options.map((o) => o.text)];
    if (texts.some((t) => /�|[-]/.test(t))) problems.push({ code: "FORMULA_ISSUE", detail: "Unreadable characters (font encoding / OCR) in the text — compare with the source page." });
    const dollars = (t: string) => (t.replace(/\\\$/g, "").match(/\$/g) ?? []).length;
    if (texts.some((t) => dollars(t) % 2 === 1)) problems.push({ code: "FORMULA_ISSUE", detail: "A formula is not closed (odd number of $) — check the formula against the source." });
    // Figure crops: stored file, inside the page, aspect ratio of the box kept, enough resolution.
    for (const f of q.figures) {
      if (f.confirmedById) continue;
      const box = f.box as { x: number; y: number; w: number; h: number; reason?: string } | null;
      const reasons: string[] = [];
      if (!(await vaultExists(f.originalKey))) reasons.push("its stored image file is missing");
      if (f.source === "CROP" && box) {
        if (box.x < -0.001 || box.y < -0.001 || box.x + box.w > 1.001 || box.y + box.h > 1.001) reasons.push("its crop box lies partly outside the page");
        const pg = pageOf(f.fileId, f.pageNumber);
        if (pg?.renderWidth && pg.renderHeight && box.w > 0 && box.h > 0) {
          const plain = (box.w * pg.renderWidth) / (box.h * pg.renderHeight);
          const padded = ((box.w + 0.024) * pg.renderWidth) / ((box.h + 0.024) * pg.renderHeight);
          const ratio = f.width / Math.max(1, f.height);
          if (Math.abs(ratio - plain) / plain > 0.12 && Math.abs(ratio - padded) / padded > 0.12) reasons.push(`the crop (${f.width}×${f.height}) does not keep the aspect ratio of its box`);
        }
        if (Math.min(f.width, f.height) < MIN_CROP_SIDE) reasons.push(`the crop is only ${f.width}×${f.height} pixels`);
      }
      if (reasons.length) {
        const why = `Verify 1: ${reasons.join("; ")} — adjust the crop or confirm it.`;
        if (f.mappingStatus !== "MISSING") await prisma.aiImportFigure.update({ where: { id: f.id }, data: { mappingStatus: "UNCERTAIN", box: { ...(box ?? {}), reason: why } as Prisma.InputJsonValue } });
        f.mappingStatus = "UNCERTAIN";
        problems.push({ code: "IMAGE_MAPPING_UNCERTAIN", detail: `${f.owner === "OPTION" ? `Option ${f.optionLabel} image` : "Figure"} on page ${f.pageNumber}: ${reasons.join("; ")}.` });
      }
    }
    let reference: NonNullable<PaperVerification["v1"]>["reference"] = null;
    const references: NonNullable<NonNullable<PaperVerification["v1"]>["references"]> = [];
    for (const ref of refs) {
      // A reference nothing could be read from (scanned, only stored) is recorded as NOT compared — never as "no conflict".
      if (!referenceComparable(ref)) {
        references.push({ refId: ref.refId, name: ref.name, compared: false, matched: null, similarity: null, conflicts: [], note: `not compared: ${scannedPagesOf(ref)} scanned page(s) without a text layer need OCR / vision (paid AI) — stored only` });
        continue;
      }
      const c = compareWithReference(e, q.finalAnswer, ref);
      // Uncertain OCR is shown as "reference unreadable" and is no evidence either way (never a conflict, never agreement).
      if (c.unreadable) {
        references.push({ refId: ref.refId, name: ref.name, compared: false, matched: c.matched, similarity: null, conflicts: [], note: "reference unreadable — its OCR reading of this question is too uncertain to compare (confidence below 70 %)" });
        continue;
      }
      references.push({ refId: ref.refId, name: ref.name, compared: true, matched: c.matched, similarity: c.similarity, conflicts: c.conflicts });
      if (!reference || c.matched) reference = { refId: ref.refId, name: ref.name, matched: c.matched, conflicts: c.conflicts };
      if (c.conflicts.length) {
        refConflicts++;
        problems.push({ code: "REFERENCE_CONFLICT", detail: `${ref.name}: ${c.conflicts.join(" ")}`.slice(0, 500) });
      }
      if (c.suggestedAnswer.length && !q.finalAnswer.length) problems.push({ code: "REFERENCE_CONFLICT", detail: `${ref.name} gives answer ${c.suggestedAnswer.join(", ")}; this question has no answer. Accept it with “Use reference answers” (an administrator's decision) or set the answer.` });
    }
    const blockingNow = q.issueCodes.filter((c) => ISSUE_DEFS[c]?.blocking || ISSUE_DEFS[c]?.publishBlocking);
    const ok = !problems.length && !blockingNow.length && q.status !== AiImportQuestionStatus.NOT_IMPORTABLE && q.status !== AiImportQuestionStatus.DUPLICATE;
    if (ok) passed++;
    else withProblems++;
    const kind = (files.find((f) => f.id === q.fileId)?.detected as { kind?: string } | null)?.kind;
    const fieldChecks = v1FieldChecks({ e, problems, fixes: fixesBy.get(q.id) ?? [], issueCodes: q.issueCodes, issueLabel: (c) => ISSUE_DEFS[c]?.label ?? c, memory, answer: answerFacts(q), classification: tax.verification, name: (id) => (id ? (taxName.get(id) ?? null) : null), documentText: kind === "docx" || kind === "xlsx" || kind === "csv" || e.method === "LOCAL_PDF" || e.method === "DOCX" });
    await savePaperVerify(q, { v1: { ...stamp(q), at: new Date().toISOString(), passed: ok, problems, fixes: fixesBy.get(q.id) ?? [], reference, references, profile: profileFindings.get(q.id) ?? null, classification: tax.verification, fieldChecks, memoryRules: [...new Set(memory.map((m) => m.ruleId))] }, passes: withPass((q.data as unknown as ExtractedQuestion).paperVerify, "v1") });
  }

  // 4. The findings become the questions' flags (still no AI), then the job's status follows its quality.
  await runPostProcessing(ctx);
  await settleJobStatus(jobId);
  const quality = await jobQuality(jobId);
  const refOnly = refs.filter(referenceComparable).flatMap((r) => referenceOnly(r, questions.map((x) => effective(x))).map((l) => `${l} (${r.name})`));
  const compared = refs.filter(referenceComparable);
  const notCompared = refs.filter((r) => !referenceComparable(r));
  const result: Verify1Result = { questions: passed + withProblems, passed, withProblems, corrected: fixesBy.size, missing: quality?.missing ?? [], duplicateNumbers: quality?.duplicateNumbers ?? [], referenceOnly: refOnly.slice(0, 200), referenceConflicts: refConflicts, referencesCompared: compared.length, referencesNotCompared: notCompared.map((r) => r.name), whitespaceRestored: restored, classification: taxTally, annotationsRemoved: ticksRemoved, headingsRestored, verify2Upgrade: legacy };
  await logEvent(jobId, "VERIFY1_DONE", `Verify 1 (full paper, no AI): ${result.questions} question(s) checked — ${passed} passed, ${withProblems} with findings, ${result.corrected} corrected from the source${result.missing.length ? `; missing ${result.missing.slice(0, 10).join(", ")}${result.missing.length > 10 ? " …" : ""}` : ""}${result.duplicateNumbers.length ? `; numbers read twice ${result.duplicateNumbers.slice(0, 10).join(", ")}` : ""}${compared.length ? `; reference papers compared: ${compared.map((r) => `“${r.name}”`).join(", ")} — ${refConflicts} conflict(s)${refOnly.length ? `, ${refOnly.length} reference question(s) not in the source (${refOnly.slice(0, 6).join(", ")})` : ""}` : ""}${notCompared.length ? `; NOT compared (scanned, stored only — needs OCR / vision): ${notCompared.map((r) => `“${r.name}” (${scannedPagesOf(r)} page(s))`).join(", ")}` : ""}${result.whitespaceRestored ? `; line breaks restored from the Word source in ${result.whitespaceRestored} question(s)` : ""}${ticksRemoved ? `; printed answer-line tick removed from ${ticksRemoved} question(s) (source evidence)` : ""}${headingsRestored ? `; section heading restored in ${headingsRestored} question(s)` : ""}${profileNote ? `; ${profileNote}` : ""}; subject / topic check (free): ${taxTally.AGREED} agreed, ${taxTally.DISAGREEMENT} disagreement(s), ${taxTally.NEEDS_REVIEW} need review, ${taxTally.NOT_VERIFIED} not verified.`, result as unknown as Record<string, unknown>, actorId);
  await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_VERIFY1", entityType: "AiImportJob", entityId: jobId, metadata: { questions: result.questions, passed, corrected: result.corrected } } });
  return result;
}

// ---- Verify 2: pricing, model choice, confirmation -------------------------------------------------------

export interface Verify2State {
  status: "QUEUED" | "RUNNING" | "DONE" | "STOPPED";
  model: string;
  choice: TaskChoice;
  /** Cheaper-or-equal suitable models for ONE bounded fallback per request (never one that extracted the job). */
  alternates: string[];
  usedModels: string[];
  requestedById: string;
  requestedAt: string;
  units: number;
  classifyBatches: number;
  estimateInr: number;
  maxInr: number;
  confirmedMaxInr: number;
  spentBeforeInr: number;
  doneUnits: string[];
  startedAt?: string | null;
  finishedAt?: string | null;
  stopReason?: string | null;
  counts?: Record<string, number>;
  /** COMPLETE: every part answered · PARTIAL: some parts gave no answer · NO_RESULT: not one independent result. */
  outcome?: "COMPLETE" | "PARTIAL" | "NO_RESULT";
  actualInr?: number;
}

/** How a finished Verify 2 went, from its counts (a run without one independent result is never "done" in the UI). */
export function verify2Outcome(c: Record<string, number>): NonNullable<Verify2State["outcome"]> {
  const results = (c.VERIFIED ?? 0) + (c.DISAGREE ?? 0) + (c.NOT_FOUND ?? 0);
  if (!results && (c.attempted ?? 0) > 0) return "NO_RESULT";
  return (c.failedUnits ?? 0) > 0 || (c.FAILED ?? 0) + (c.UNAVAILABLE ?? 0) > 0 ? "PARTIAL" : "COMPLETE";
}

interface Unit {
  key: string;
  kind: "page" | "text";
  file: AiImportFile;
  pageId?: string;
  pageNumber?: number;
  textLayer?: string | null;
  startState?: unknown;
  parts?: string[];
  /** Text part: its position, and the questions (section|number) the local reading found in it. */
  partIndex?: number;
  partCount?: number;
  qkeys?: string[];
  /** Every question key of the file's text parts (a stored question outside all of them is compared in the last part). */
  fileKeys?: Set<string>;
}

const CHUNK = 11_000;
/**
 * Verify 2 reads a text document in small parts — at most PART_QUESTIONS questions / PART_CHARS characters, split at
 * question starts — so one answer fits the output limit with room for a reasoning model's thinking. (2026-10-23: a
 * 120-question DOCX went out as ~11,000-character parts; the reasoning model spent its whole 8,000-token limit and the
 * fallback's answer was cut off, so all 120 questions had no result.) A failed part leaves only its own questions
 * without a result.
 */
const PART_CHARS = 4_500;
const PART_QUESTIONS = 8;

const qkey = (section: string | null | undefined, number: number | null | undefined) => `${section ?? ""}|${number ?? "?"}`;
type IdxLine = { text: string; idx: number };

/** Document lines → Verify 2 text parts, each starting at a question start, with the questions it holds. */
export function verify2TextParts(lines: string[]): { text: string; keys: string[] }[] {
  const tagged: IdxLine[] = lines.map((text, idx) => ({ text, idx }));
  const { blocks } = splitQuestions(tagged);
  if (!blocks.length) return chunkText(lines).map((text) => ({ text, keys: [] }));
  const starts = blocks.map((b) => (b.lines[0] as unknown as IdxLine).idx);
  const out: { text: string; keys: string[] }[] = [];
  let from = 0;
  let keys: string[] = [];
  let chars = 0;
  for (let i = 0; i < blocks.length; i++) {
    const end = i + 1 < blocks.length ? starts[i + 1] : lines.length;
    const size = lines.slice(starts[i], end).join("\n").length + 1;
    if (keys.length && (chars + size > PART_CHARS || keys.length >= PART_QUESTIONS)) {
      out.push({ text: lines.slice(from, starts[i]).join("\n"), keys });
      from = starts[i];
      keys = [];
      chars = 0;
    }
    keys.push(qkey(blocks[i].section, blocks[i].number));
    chars += size;
  }
  out.push({ text: lines.slice(from).join("\n"), keys });
  return out;
}

/** The second read numbers questions as printed; sections (numbering restarts) come from the part's known questions. */
function sectionsFromKeys(qs: ExtractedQuestion[], keys: string[]): void {
  const left = [...keys];
  for (const q of qs) {
    if (q.number === null) continue;
    const i = left.findIndex((k) => k.endsWith(`|${q.number}`));
    if (i >= 0) {
      q.section = left[i].split("|")[0];
      left.splice(i, 1);
    } else q.section = keys.length && keys.every((k) => k.split("|")[0] === keys[0].split("|")[0]) ? keys[0].split("|")[0] : "";
  }
}

function chunkText(lines: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    // A new numbered question starts a new part when the current one is large enough.
    if (cur.length + l.length + 1 > CHUNK || (cur.length > CHUNK * 0.8 && /^\s*(?:Q\.?\s*)?\d{1,3}\s*[.):]/.test(l))) {
      if (cur.trim()) out.push(cur);
      cur = "";
    }
    cur += `${l}\n`;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

async function sheetLines(file: AiImportFile): Promise<string[]> {
  const bytes = await readFile(vaultPath(file.storageKey!));
  const parsed = await parseImportFile(new File([new Uint8Array(bytes)], `${file.id}.${file.ext}`), "RICH");
  return parsed.rows.flatMap((r) => [`${r.questionNumber ?? r.rowNumber - 1}. ${r.questionText}`, ...(["A", "B", "C", "D"] as const).map((l) => `(${l}) ${String(r[`option${l}` as const] ?? "")}`), ...(r.correctAnswer ? [`Ans: ${r.correctAnswer}`] : [])]);
}

/** The source units Verify 2 reads: every page image (PDF / image), or the document text in parts (DOCX / sheets). */
async function verify2Units(jobId: string): Promise<Unit[]> {
  const files = await prisma.aiImportFile.findMany({ where: { jobId, role: "PAPER", status: { in: ["ANALYZED", "PROCESSED"] } }, orderBy: { createdAt: "asc" } });
  const units: Unit[] = [];
  for (const file of files) {
    const kind = (file.detected as { kind?: string } | null)?.kind;
    if (!file.storageKey) continue;
    if (kind === "pdf" || kind === "png" || kind === "jpeg") {
      const pages = await prisma.aiImportPage.findMany({ where: { fileId: file.id, status: "DONE", NOT: { kind: "BLANK" } }, orderBy: { pageNumber: "asc" }, select: { id: true, pageNumber: true, textLayer: true, rawOutput: true } });
      for (const p of pages) units.push({ key: `${file.id}:p${p.pageNumber}`, kind: "page", file, pageId: p.id, pageNumber: p.pageNumber, textLayer: p.textLayer, startState: (p.rawOutput as { startState?: unknown } | null)?.startState });
    } else if (kind === "docx" || kind === "xlsx" || kind === "csv") {
      const lines = kind === "docx" ? (await readDocx(vaultPath(file.storageKey))).lines.map((l) => l.text.replace(/⟦IMG:(?:\d+|missing)⟧/g, "[image]")) : await sheetLines(file);
      const parts = verify2TextParts(lines);
      const fileKeys = new Set(parts.flatMap((x) => x.keys));
      parts.forEach((x, i) => units.push({ key: `${file.id}:t${i + 1}of${parts.length}`, kind: "text", file, parts: [x.text], partIndex: i, partCount: parts.length, qkeys: x.keys, fileKeys }));
    }
  }
  return units;
}

/** Models that extracted (or re-read) this job — Verify 2 must use a different one. */
async function usedModels(jobId: string, config: unknown): Promise<string[]> {
  const [pages, qs] = await Promise.all([
    prisma.aiImportPage.findMany({ where: { jobId, model: { not: null } }, distinct: ["model"], select: { model: true } }),
    prisma.aiImportQuestion.findMany({ where: { jobId }, select: { data: true } }),
  ]);
  const plan = (config as { modelPlan?: { tasks?: { extract?: { model?: string | null } } } } | null)?.modelPlan;
  const out = new Set<string>();
  for (const p of pages) if (p.model && p.model !== "local") out.add(p.model);
  for (const q of qs) {
    const m = (q.data as { model?: string | null } | null)?.model;
    if (m) out.add(m);
  }
  if (plan?.tasks?.extract?.model) out.add(plan.tasks.extract.model);
  return [...out];
}

/** A catalog id the job already used (the provider may report a dated variant, e.g. "<id>-2025-04-01"). */
const usedBy = (used: string[], id: string) => used.some((m) => m === id || m.startsWith(`${id}-`));

/** Pass 2 targets: questions Verify 2 still has to read, and those whose subject / topic check is not yet agreed. */
const pvOf = (q: QRow) => (q.data as unknown as ExtractedQuestion).paperVerify;
const taxAgreed = (q: QRow) => pvOf(q)?.v2?.classification?.status === "AGREED" && sameTaxonomy(q, pvOf(q)?.v2?.classification);
function verify2Targets(rows: QRow[]): { read: Set<string>; classify: Set<string>; atLimit: number } {
  const read = new Set<string>();
  const classify = new Set<string>();
  let atLimit = 0;
  for (const q of rows) {
    if (passCount(pvOf(q)) >= MAX_VERIFY_PASSES) {
      atLimit++;
      continue;
    }
    if (needsVerify2(q, fingerprintOf(q))) read.add(q.id);
    if (!taxAgreed(q)) classify.add(q.id);
  }
  return { read, classify, atLimit };
}

type UnitRow = QRow;
/**
 * A question is compared once its LAST page has been read again (a question spanning pages is joined first); in a
 * text document, in the part that holds it (a question the local reading did not place: in the last part).
 */
const inUnit = (u: Unit, q: UnitRow) => {
  if (q.fileId !== u.file.id) return false;
  if (u.kind === "page") return q.pages[q.pages.length - 1] === u.pageNumber;
  if (!u.qkeys) return true;
  const k = qkey(effective(q).section, effective(q).number);
  return u.qkeys.includes(k) || (u.partIndex === (u.partCount ?? 1) - 1 && !u.fileKeys?.has(k));
};
const unitLabel = (u: Unit) => `${u.file.originalName}${u.kind === "page" ? ` page ${u.pageNumber}` : (u.partCount ?? 1) > 1 ? ` part ${(u.partIndex ?? 0) + 1} of ${u.partCount}` : ""}`;

/** A unit needs no new read when this model already read it and every one of its questions still has an up-to-date result. */
function unitDone(u: Unit, rows: UnitRow[], state: Verify2State | null, model: string | null): boolean {
  if (!state || state.model !== model || !state.doneUnits.includes(u.key)) return false;
  return rows.filter((q) => inUnit(u, q)).every((q) => {
    const s = verifyState(q.data, fingerprintOf(q));
    return (s.v2 === "verified" || s.v2 === "disagree" || s.v2 === "not_found") && s.pv?.v2?.model !== undefined;
  });
}

async function verify2Settings(config: unknown): Promise<ImporterSettings> {
  const current = await getImporterSettings();
  // Paid AI follows the CURRENT switch (this is a new, separately confirmed operation); privacy stays the stricter.
  return { ...jobRunSettings(config, current), aiEnabled: current.aiEnabled };
}

async function choiceFor(settings: ImporterSettings, model: string, extractModel: string | null, jobId: string, refresh: boolean): Promise<TaskChoice> {
  const plan = await computeModelPlan({ ...settings, selection: { ...settings.selection, mode: "manual" }, models: { ...settings.models, extract: extractModel, extractFallbacks: [], verify: model } }, { refresh, jobId });
  return plan.tasks.verify;
}

export interface Verify2Preview {
  aiEnabled: boolean;
  usedModels: string[];
  candidates: CandidateRow[];
  model: string | null;
  reason: string;
  units: number;
  pages: number;
  textParts: number;
  questions: number;
  classifyBatches: number;
  perRequestMaxInr: number | null;
  estimateInr: number | null;
  maxInr: number | null;
  spentInr: number;
  confirmedMaxInr: number;
  state: Verify2State | null;
  problems: string[];
  /**
   * Scanned reference papers: only stored, NOT compared. Comparing them needs OCR / vision of every page — paid AI that
   * is NOT part of this Verify 2 and is never sent by it; the estimate is shown so the cost is known before any use.
   */
  referenceOcr: { name: string; pages: number; processing: string; estimateInr: number | null; maxInr: number | null }[];
}

async function priceVerify2(jobId: string, modelArg: string | null, refresh: boolean) {
  const job = await finishedJob(jobId);
  const settings = await verify2Settings(job.config);
  const used = await usedModels(jobId, job.config);
  // Every importer model, evaluated for page reading (the same request Verify 2 sends), minus the job's own readers.
  const auto = await computeModelPlan({ ...settings, selection: { ...settings.selection, mode: "auto" } }, { refresh: false, jobId }, { extract: used });
  // Price order, but a reliable non-thinking model (no repeated "output limit used up") first.
  const candidates = await preferReliable(auto.tasks.extract.candidates.map((c) => (usedBy(used, c.id) ? { ...c, eligible: false, reason: "extracted this import (Verify 2 needs a different model)" } : c)));
  const model = modelArg ?? candidates.find((c) => c.eligible)?.id ?? null;
  const problems: string[] = [...auto.problems];
  if (!settings.aiEnabled) problems.push("Paid AI is switched off in Import Settings — Verify 2 cannot run.");
  if (modelArg && usedBy(used, modelArg)) throw new ImportJobError(`${modelArg} extracted this import; Verify 2 must use a different model.`);
  const prior = (job.config as { verify2?: Verify2State } | null)?.verify2 ?? null;
  const units = await verify2Units(jobId);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, status: { notIn: LOCKED } }, include: { figures: true } });
  // Targeted: only parts holding a question that still needs a read (no agreeing result, under the pass limit).
  const targets = verify2Targets(rows);
  const todo = units.filter((u) => !unitDone(u, rows, prior, model) && rows.some((q) => targets.read.has(q.id) && inUnit(u, q)));
  const questions = new Set([...targets.read, ...targets.classify]).size;
  const classifyBatches = Math.ceil(targets.classify.size / CLASSIFY_BATCH);
  // Fallbacks: any other eligible model (no price allowance or spending cap since 2026-10-26 — the maximum below
  // prices the fallback), another model family first.
  const family = modelFamily;
  const alternates = candidates
    .filter((c) => c.eligible && c.id !== model)
    .sort((a, b) => Number(family(a.id) === family(model)) - Number(family(b.id) === family(model)))
    .map((c) => c.id)
    .slice(0, 3);
  let choice: TaskChoice | null = null;
  let estimateInr: number | null = null;
  let maxInr: number | null = null;
  let reason = auto.tasks.extract.reason;
  if (model) {
    choice = await choiceFor(settings, model, used[0] ?? null, jobId, refresh);
    reason = choice.reason;
    const fx = refresh ? await getUsdInr() : { rate: auto.fxRate };
    // The one fallback a failed read is sent to (verifyCall: the first alternate), priced exactly like the main model.
    const fallback = alternates[0] ? await choiceFor(settings, alternates[0], used[0] ?? null, jobId, refresh) : null;
    const fallbackPrice = fallback?.model === alternates[0] ? fallback?.price ?? null : null;
    if (choice.model === model && choice.price && fx.rate) {
      // Every read carries the confirmed paper memory (when there is any): priced in.
      const memory = await jobMemoryBrief(job, "extract");
      const pageTokens = profileInputTokens("verify");
      const classifyTokens = profileInputTokens("classify");
      // Worst case of every request: REQUEST_ATTEMPTS sends to the model and, after a failed read, REQUEST_ATTEMPTS to the fallback.
      const worst = (price: PlanPrice) => {
        let usd = 0;
        for (const u of todo) {
          if (u.kind === "page") usd += requestUsd(price, pageTokens, 8000, 1) * PRICE_MARGIN;
          else
            for (const part of u.parts ?? []) {
              const t = estimateInputTokens(EXTRACT_SYSTEM, [{ type: "text", text: documentTextUserText({ exam: "", subject: null, part: 1, parts: 1, text: part, memory }) }]);
              usd += requestUsd({ ...price, image: 0 }, t, 8000, 0) * PRICE_MARGIN;
            }
        }
        return usd + classifyBatches * requestUsd({ ...price, image: 0 }, classifyTokens, 2500, 0) * PRICE_MARGIN;
      };
      let typUsd = 0;
      for (const u of todo) {
        if (u.kind === "page") typUsd += requestUsd(choice.price, pageTokens, 3200, 1);
        else
          for (const part of u.parts ?? []) {
            const t = estimateInputTokens(EXTRACT_SYSTEM, [{ type: "text", text: documentTextUserText({ exam: "", subject: null, part: 1, parts: 1, text: part, memory }) }]);
            typUsd += requestUsd({ ...choice.price, image: 0 }, t, 3200, 0);
          }
      }
      typUsd += classifyBatches * requestUsd({ ...choice.price, image: 0 }, Math.round(classifyTokens / 3), 600, 0);
      const maxUsd = REQUEST_ATTEMPTS * (worst(choice.price) + (fallbackPrice ? worst(fallbackPrice) : 0));
      maxInr = Math.ceil((usdToInr(maxUsd, fx.rate) ?? 0) * 100) / 100;
      estimateInr = Math.ceil((usdToInr(typUsd, fx.rate) ?? 0) * 100) / 100;
    } else problems.push(`${model} cannot be used for Verify 2: ${choice.reason}`);
  } else problems.push(`No suitable model for Verify 2: ${reason}`);
  const refs = await listReferences(jobId);
  const pageMax = choice?.price && choice.model === model ? REQUEST_ATTEMPTS * requestUsd(choice.price, profileInputTokens("verify"), 8000, 1) * PRICE_MARGIN : null;
  const pageTyp = choice?.price && choice.model === model ? requestUsd(choice.price, profileInputTokens("verify"), 3200, 1) : null;
  const fxRate = auto.fxRate;
  const referenceOcr = refs
    .filter((r) => !r.ocr && (!referenceComparable(r) || scannedPagesOf(r) > 0))
    .map((r) => {
      const pages = scannedPagesOf(r);
      const inr = (usd: number | null) => (usd === null || !fxRate ? null : Math.ceil((usdToInr(usd * pages, fxRate) ?? 0) * 100) / 100);
      return { name: r.name, pages, processing: `OCR / vision reading of ${pages} scanned page image(s)${model ? ` (e.g. with ${model})` : ""}`, estimateInr: inr(pageTyp), maxInr: inr(pageMax) };
    })
    .filter((r) => r.pages > 0);
  return { job, settings, used, candidates, model, choice, reason, units: todo, allUnits: units, questions, classifyBatches, estimateInr, maxInr, problems, prior, alternates, referenceOcr };
}

export async function verify2Preview(jobId: string, model: string | null): Promise<Verify2Preview> {
  const p = await priceVerify2(jobId, model, false);
  return {
    aiEnabled: p.settings.aiEnabled,
    usedModels: p.used,
    candidates: p.candidates.slice(0, 20),
    model: p.model,
    reason: p.reason,
    units: p.units.reduce((a, u) => a + (u.kind === "page" ? 1 : (u.parts?.length ?? 0)), 0) + p.classifyBatches,
    pages: p.units.filter((u) => u.kind === "page").length,
    textParts: p.units.reduce((a, u) => a + (u.parts?.length ?? 0), 0),
    questions: p.questions,
    classifyBatches: p.classifyBatches,
    perRequestMaxInr: p.choice?.maxInr ?? null,
    estimateInr: p.estimateInr,
    maxInr: p.maxInr,
    spentInr: p.job.spentInr,
    confirmedMaxInr: p.job.budgetInr,
    state: p.prior,
    problems: p.problems,
    referenceOcr: p.referenceOcr,
  };
}

export type Verify2Request = { started: true; maxInr: number } | { started: false; preview: Verify2Preview; reason: string };

/**
 * Starts Verify 2 after the administrator confirmed the shown maximum. The price is computed again from fresh
 * provider routes; if it is higher than what was confirmed, nothing starts and the new price is returned for a
 * fresh confirmation. The job's confirmed maximum becomes spent + this operation's maximum (never less than before).
 */
export async function requestVerify2(input: { jobId: string; actorId: string; model: string; confirmedMaxInr: number | null }): Promise<Verify2Request> {
  const p = await priceVerify2(input.jobId, input.model, true);
  const preview = await verify2Preview(input.jobId, input.model);
  if (!p.settings.aiEnabled) throw new ImportJobError("Paid AI is switched off in Import Settings, so Verify 2 cannot run. Nothing was sent.");
  if (!p.choice || p.choice.model !== input.model || p.maxInr === null) throw new ImportJobError(`Verify 2 cannot use ${input.model}: ${p.problems.join(" ") || p.reason}`);
  if (!p.units.length) throw new ImportJobError("Every page of this import was already read by Verify 2 with this model, or its questions already agree or reached the limit of 3 verification passes. Nothing more is sent.");
  const confirmed = typeof input.confirmedMaxInr === "number" && Number.isFinite(input.confirmedMaxInr) ? input.confirmedMaxInr : null;
  const freshPreview = { ...preview, maxInr: p.maxInr, estimateInr: p.estimateInr, perRequestMaxInr: p.choice.maxInr };
  if (confirmed === null) return { started: false, preview: freshPreview, reason: "Confirm the maximum cost first." };
  if (confirmed + 0.005 < p.maxInr) return { started: false, preview: freshPreview, reason: `The price changed: the maximum is now ${formatInr(p.maxInr)} (you confirmed ${formatInr(confirmed)}). Confirm the new maximum to continue.` };
  const budget = Math.max(p.job.budgetInr, Math.ceil((p.job.spentInr + p.maxInr) * 100) / 100);
  const state: Verify2State = {
    status: "QUEUED",
    model: input.model,
    choice: p.choice,
    alternates: p.alternates,
    usedModels: p.used,
    requestedById: input.actorId,
    requestedAt: new Date().toISOString(),
    units: p.units.length,
    classifyBatches: p.classifyBatches,
    estimateInr: p.estimateInr ?? p.maxInr,
    maxInr: p.maxInr,
    confirmedMaxInr: confirmed,
    spentBeforeInr: p.job.spentInr,
    doneUnits: p.prior && p.prior.model === input.model ? p.prior.doneUnits : [],
  };
  const r = await prisma.aiImportJob.updateMany({ where: { id: input.jobId, status: p.job.status }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null, budgetInr: budget, config: { ...((p.job.config as object) ?? {}), verify2: state } as unknown as Prisma.InputJsonValue } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  await logEvent(input.jobId, "VERIFY2_REQUESTED", `Verify 2 confirmed with ${input.model}: ${p.units.length} source read(s) (${p.units.filter((u) => u.kind === "page").length} page image(s), ${p.units.filter((u) => u.kind === "text").length} document text part(s) of at most ${PART_QUESTIONS} questions) + ${p.classifyBatches} classification request(s), estimated ${formatInr(p.estimateInr)}, maximum ${formatInr(p.maxInr)} (confirmed ${formatInr(confirmed)}). Confirmed maximum of the import: ${formatInr(budget)} (₹${p.job.spentInr.toFixed(2)} spent so far).`, { model: input.model, units: p.units.length, classifyBatches: p.classifyBatches, estimateInr: p.estimateInr, maxInr: p.maxInr, confirmedMaxInr: confirmed, budgetInr: budget, alternates: p.alternates, usedModels: p.used }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_VERIFY2_REQUESTED", entityType: "AiImportJob", entityId: input.jobId, metadata: { model: input.model, maxInr: p.maxInr, confirmedMaxInr: confirmed } } });
  kickWorker();
  return { started: true, maxInr: p.maxInr };
}

// ---- Verify 2: the worker's part ------------------------------------------------------------------------

async function saveState(jobId: string, patch: Partial<Verify2State>): Promise<Verify2State> {
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId }, select: { config: true } });
  const cfg = (j.config as Record<string, unknown>) ?? {};
  const next = { ...(cfg.verify2 as Verify2State), ...patch };
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { config: { ...cfg, verify2: next } as unknown as Prisma.InputJsonValue } });
  return next;
}

/** One Verify 2 request with the confirmed model, and at most ONE recorded fallback to a cheaper-or-equal suitable model. */
async function verifyCall<T>(ctx: StepContext, state: Verify2State, input: Omit<Parameters<typeof importerAiCall>[0], "override" | "noReplace" | "models" | "jobId" | "settings">, parse: (text: string) => T): Promise<{ value: T; model: string }> {
  const base = { ...input, jobId: ctx.job.id, settings: ctx.settings, models: [state.model], noReplace: true };
  // The confirmed model used up its output limit repeatedly in this job: its remaining requests go to the (priced,
  // confirmed) fallback of another family instead of being paid for twice.
  const alt0 = state.alternates.find((m) => m !== state.model);
  if (alt0 && (await exhaustedModels(ctx.job.id)).has(state.model)) {
    const choice = await choiceFor(ctx.settings, alt0, state.usedModels[0] ?? null, ctx.job.id, false);
    if (choice.model === alt0 && choice.price) {
      const r = await importerAiCall({ ...base, models: [alt0], override: choice });
      return { value: parse(r.text), model: r.model };
    }
  }
  try {
    const r = await importerAiCall({ ...base, override: state.choice });
    return { value: parse(r.text), model: r.model };
  } catch (e) {
    if (!(e instanceof ImporterAiFailure) || !["model_output", "image_unsupported", "route_unavailable"].includes(e.kind)) throw e;
    const alt = state.alternates.find((m) => m !== state.model);
    if (!alt) throw e;
    const choice = await choiceFor(ctx.settings, alt, state.usedModels[0] ?? null, ctx.job.id, false);
    if (choice.model !== alt || !choice.price) throw new ImporterAiFailure(`${e.message} The fallback ${alt} cannot be used: ${choice.reason}`.slice(0, 600), e.kind, state.model, e.chargedInr);
    await logEvent(ctx.job.id, "MODEL_SWITCHED", `Verify 2: ${state.model} failed (${e.message.slice(0, 200)}); the same request is sent once to ${alt} (up to ${formatInr(choice.maxInr)} per request). The failed attempt cost ${e.chargedInr === null ? "an unknown amount (worst case kept)" : formatInr(e.chargedInr)}.`, { task: "verify2", from: state.model, to: alt, reason: e.message.slice(0, 300), failedChargedInr: e.chargedInr });
    const r = await importerAiCall({ ...base, models: [alt], override: choice });
    return { value: parse(r.text), model: r.model };
  }
}

interface SecondRead {
  q: ExtractedQuestion;
  model: string;
  sourceText: string | null;
}

function compareSecond(q: QRow, twin: SecondRead | undefined, v1: NonNullable<PaperVerification["v1"]> | undefined, rules: Set<FormatRuleCode> = new Set(), memo: { used: boolean; unreliableMarks: boolean; model?: string; part?: string | null } = { used: false, unreliableMarks: false }): NonNullable<PaperVerification["v2"]> {
  const r = compareSecondRead(q, twin, v1, rules);
  const e = effective(q);
  const typeDiffers = r.fields.includes("type");
  const missingNumbers = twin?.sourceText ? numbersMissingFromSource([e.stem, ...e.options.map((o) => o.text)], twin.sourceText) : [];
  const fieldChecks = v2FieldChecks({ e, twin: twin?.q ?? null, model: twin?.model || memo.model || r.model || "the Verify 2 model", part: memo.part ?? null, sourceText: twin?.sourceText ?? null, fields: r.fields, resolvedBySource: !!r.resolvedBySource, answer: answerFacts(q), typeDiffers, missingNumbers, memoryUsed: memo.used, unreliableMarks: memo.unreliableMarks });
  return { ...r, fieldChecks, memoryUsed: memo.used };
}

function compareSecondRead(q: QRow, twin: SecondRead | undefined, v1: NonNullable<PaperVerification["v1"]> | undefined, rules: Set<FormatRuleCode> = new Set()): NonNullable<PaperVerification["v2"]> {
  const fp = stamp(q);
  const now = new Date().toISOString();
  const e = effective(q);
  if (!twin) return { ...fp, at: now, model: "", status: "NOT_FOUND", fields: ["not found"], detail: "the independent read did not find this question in the source" };
  // A lone printed tick at the end of an option is an annotation, not content: compared without it.
  const v = readsAgree(withoutAnnotations(e), twin.q);
  const fields = [...v.fields];
  const diffs = v.detail === "both reads match" ? [] : v.detail.split("; ");
  // The answer: the second read's printed answer against the question's answer (an official key outranks a printed one).
  if (twin.q.printedAnswer.length && q.finalAnswer.length && !fields.includes("printed answer") && [...twin.q.printedAnswer].sort().join() !== [...q.finalAnswer].sort().join() && q.answerStatus !== "OFFICIAL_MATCHED") {
    fields.push("answer");
    diffs.push(`answer ${q.finalAnswer.join(",")} vs printed ${twin.q.printedAnswer.join(",")} in the second read`);
  }
  // A statement-code question whose key gives one code option is single-correct whatever the second read calls it.
  if (twin.q.type !== e.type && !(twin.q.type === "SINGLE_CORRECT" && e.type === "OTHER") && ["MULTIPLE_CORRECT", "SINGLE_CORRECT"].includes(twin.q.type) && ["MULTIPLE_CORRECT", "SINGLE_CORRECT"].includes(e.type) && !codeSingle(q, e, rules)) {
    fields.push("type");
    diffs.push(`type ${e.type.toLowerCase()} vs ${twin.q.type.toLowerCase()}`);
  }
  const second = { stem: twin.q.stem.slice(0, 600), options: twin.q.options.map((o) => o.text.slice(0, 200)), printedAnswer: twin.q.printedAnswer };
  if (!fields.length) return { ...fp, at: now, model: twin.model, status: "VERIFIED", fields: [], detail: `wording, ${e.options.length} options, answer, numbers / symbols and figures agree${v1 ? (v1.passed ? "; Verify 1 passed" : "; Verify 1 has findings") : ""}` };
  // The source text settles text / number differences when the stored question is in it and the second read is not.
  let resolved: string | null = null;
  if (twin.sourceText) {
    const src = nrm(twin.sourceText);
    const textFields = fields.filter((f) => f === "question text" || f.startsWith("option") || f.endsWith(" numbers"));
    const storedIn = [e.stem, ...e.options.map((o) => o.text)].every((t) => !t.trim() || src.includes(nrm(t)));
    const secondIn = [twin.q.stem, ...twin.q.options.map((o) => o.text)].every((t) => !t.trim() || src.includes(nrm(t)));
    const missingStored = numbersMissingFromSource([e.stem, ...e.options.map((o) => o.text)], twin.sourceText);
    if (textFields.length === fields.length && storedIn && !secondIn && !missingStored.length) resolved = `the source text contains the stored wording exactly; the second read differs (${diffs.join("; ").slice(0, 200)})`;
  }
  if (resolved) return { ...fp, at: now, model: twin.model, status: "VERIFIED", fields, detail: "the two reads differ, but the source text confirms the stored question", resolvedBySource: resolved, second };
  const alsoV1 = v1 && !v1.passed ? ` Verify 1 also has findings (${v1.problems.map((p) => p.code).join(", ") || "flags"}).` : "";
  return { ...fp, at: now, model: twin.model, status: "DISAGREE", fields, detail: `${diffs.join("; ")} — the source cannot settle it; correct the question by hand or approve it after checking.${alsoV1}`.slice(0, 900), second };
}

type V2Result = NonNullable<PaperVerification["v2"]>;

/** Why a request gave no result: FAILED (sent, unusable answer / provider error) or UNAVAILABLE (nothing usable could be sent). */
function noResultOf(e: unknown, model: string): { status: "FAILED" | "UNAVAILABLE"; error: NonNullable<V2Result["error"]> } {
  const message = (e instanceof Error ? e.message : "request failed").slice(0, 400);
  if (e instanceof ImporterAiFailure) return { status: e.kind === "route_unavailable" || e.kind === "image_unsupported" || e.kind === "paid_ai_off" ? "UNAVAILABLE" : "FAILED", error: { kind: e.kind, message, model: e.model ?? model } };
  if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) return { status: "UNAVAILABLE", error: { kind: e instanceof ImporterAiUnavailable ? "unavailable" : "budget", message, model } };
  return { status: "FAILED", error: { kind: "error", message, model } };
}

/** Verify 2 parts read at the same time (each request still priced, reserved and rate-limit guarded on its own). */
export const V2_PARALLEL = 3;

/** Worker: the confirmed Verify 2 of one job (job is PROCESSING, leased). Throws budget / unavailable stops. */
export async function runVerify2(ctx: StepContext): Promise<Record<string, number>> {
  let state = (ctx.job.config as { verify2?: Verify2State } | null)?.verify2;
  if (!state) throw new Error("Verify 2 request missing.");
  state = await saveState(ctx.job.id, { status: "RUNNING", startedAt: state.startedAt ?? new Date().toISOString() });
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: ctx.job.id, status: { notIn: LOCKED } }, include: { figures: true } });
  // Pass 2 is targeted (fixed at the start of the run): a question with an up-to-date agreeing result, or at the pass
  // limit, keeps its result and is not read again; a part with none of the targets is not sent.
  const targets = verify2Targets(rows);
  const units = (await verify2Units(ctx.job.id)).filter((u) => !unitDone(u, rows, state!, state!.model) && rows.some((q) => targets.read.has(q.id) && inUnit(u, q)));
  const exam = await prisma.exam.findUnique({ where: { id: ctx.job.examId }, select: { name: true } });
  const rules = await examFormatRules(ctx.job.examId);
  // Confirmed paper memory given to the Verify 2 model with every read (how this paper is printed — never content).
  const { paper, rules: paperRules } = await jobPaperMemory(ctx.job);
  const memory = memoryBrief(paperRules, paper, "extract");
  const memo = { used: !!memory, unreliableMarks: marksUnreliable(confirmedRulesFor(paperRules, paper)) };
  const counts: Record<string, number> = { VERIFIED: 0, DISAGREE: 0, NOT_FOUND: 0, FAILED: 0, UNAVAILABLE: 0, attempted: 0, units: 0, failedUnits: 0, extra: 0 };
  const done = [...state.doneUnits];
  // The second read's last question of the previous page when it continues on the next page (joined there).
  const tail = new Map<string, { q: ExtractedQuestion; page: number } | null>();
  // Every second-read question of a text document so far (a question the local reading did not place is matched against all of them).
  const fileSecond = new Map<string, SecondRead[]>();

  /** A stop (paid AI off, budget, provider unavailable): every question still without a current result is marked UNAVAILABLE with the reason. */
  const markUnavailable = async (from: number, e: unknown, to?: number) => {
    const why = noResultOf(e, state!.model);
    for (const u of units.slice(from, to)) {
      const qs = await prisma.aiImportQuestion.findMany({ where: { fileId: u.file.id, status: { notIn: LOCKED } }, include: { figures: true } });
      for (const q of qs.filter((x) => inUnit(u, x) && targets.read.has(x.id))) {
        const cur = verifyState(q.data, fingerprintOf(q)).v2;
        if (cur === "verified" || cur === "disagree" || cur === "not_found") continue;
        await savePaperVerify(q, { v2: { ...stamp(q), at: new Date().toISOString(), model: state!.model, status: "UNAVAILABLE", fields: [], detail: `not read independently — Verify 2 stopped: ${why.error.message}`.slice(0, 600), error: { ...why.error, kind: why.error.kind }, part: unitLabel(u) } });
        counts.UNAVAILABLE++;
        counts.attempted++;
      }
    }
  };

  // Up to V2_PARALLEL parts are read at the same time (each request is still priced, reserved, rate-limit guarded and
  // recorded on its own); the answers are compared in source order, so a question continued on the next page is
  // joined as before and every part's result is saved before the next window starts (resume, never restart).
  const readUnit = async (u: Unit): Promise<{ qs: ExtractedQuestion[]; model: string; text: string | null } | { failed: ReturnType<typeof noResultOf> } | { stop: unknown }> => {
    try {
      if (u.kind === "page") {
        const render = await ensureRender(ctx.job, u.file, u.pageNumber!, ctx.settings.limits.renderDpi);
        const image = await visionImage(render);
        const { value, model } = await verifyCall(ctx, state!, { task: "verify", system: EXTRACT_SYSTEM, content: [{ type: "text", text: extractUserText({ exam: exam?.name ?? "Exam", subject: null, page: u.pageNumber!, pages: u.file.pageCount ?? 1, textLayer: u.textLayer ?? null, memory }) }, { type: "image_url", image_url: { url: image, detail: "high" } }], maxOutputTokens: 8000, pageId: u.pageId, needsVision: true, jsonSchema: "extract" }, (t) => parsePage(t, "the Verify 2 model's answer"));
        const qs = toExtracted(value, u.pageNumber!, model);
        assignSections(qs, u.startState as never);
        return { qs, model, text: u.textLayer ?? null };
      }
      const text = u.parts?.[0] ?? "";
      const r = await verifyCall(ctx, state!, { task: "verify", system: EXTRACT_SYSTEM, content: [{ type: "text", text: documentTextUserText({ exam: exam?.name ?? "Exam", subject: null, part: (u.partIndex ?? 0) + 1, parts: u.partCount ?? 1, text, memory }) }], maxOutputTokens: 8000, needsVision: false, jsonSchema: "extract" }, (t) => parsePage(t, "the Verify 2 model's answer"));
      const qs = toExtracted(r.value, 1, r.model);
      // Sections (numbering restarts) as the local reader numbered this part's questions.
      if (u.qkeys?.length) sectionsFromKeys(qs, u.qkeys);
      else assignSections(qs, undefined);
      return { qs, model: r.model, text };
    } catch (e) {
      if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) return { stop: e };
      return { failed: noResultOf(e, state!.model) };
    }
  };

  let stopped: unknown = null;
  let notRead = units.length;
  for (let w = 0; w < units.length && !stopped; w += V2_PARALLEL) {
    if (!(await ctx.stillRunning())) return counts;
    const window = units.slice(w, w + V2_PARALLEL);
    const reads = await Promise.all(window.map(readUnit));
    notRead = w + window.length;
    for (const [k, u] of window.entries()) {
    const ui = w + k;
    const read = reads[k];
    if ("stop" in read) {
      // A stop (paid AI off, budget, provider unavailable): this part and every part not read yet get no result.
      stopped ??= read.stop;
      await markUnavailable(ui, read.stop, ui + 1);
      continue;
    }
    const second: SecondRead[] = [];
    const failed: ReturnType<typeof noResultOf> | null = "failed" in read ? read.failed : null;
    if (!("failed" in read)) {
      const qs = read.qs;
      if (u.kind === "page") {
        const prev = tail.get(u.file.id);
        if (qs[0]?.continuedFromPreviousPage && prev && prev.page === u.pageNumber! - 1) {
          second.push({ q: mergeContinuation(prev.q, qs.shift()!, u.pageNumber!), model: read.model, sourceText: read.text });
        }
        for (const q of qs) second.push({ q, model: read.model, sourceText: read.text });
        const last = qs[qs.length - 1];
        tail.set(u.file.id, last?.continuesOnNextPage ? { q: last, page: u.pageNumber! } : null);
      } else {
        for (const q of qs) second.push({ q, model: read.model, sourceText: read.text });
        fileSecond.set(u.file.id, [...(fileSecond.get(u.file.id) ?? []), ...second]);
      }
    } else if (u.kind === "page") tail.set(u.file.id, null);
    // Compare with every stored question of this unit (a page: the questions that end on it; a text part: the questions it holds).
    const stored = await prisma.aiImportQuestion.findMany({ where: { fileId: u.file.id, status: { notIn: LOCKED }, ...(u.kind === "page" ? { pages: { has: u.pageNumber! } } : {}) }, include: { figures: true } });
    const mine = stored.filter((q) => inUnit(u, q) && targets.read.has(q.id));
    const pool = u.kind === "text" ? (fileSecond.get(u.file.id) ?? second) : second;
    for (const q of mine) {
      const pv = (q.data as unknown as ExtractedQuestion).paperVerify ?? {};
      const e = effective(q);
      const v1 = pv.v1 && contentCurrent(pv.v1, fingerprintOf(q)) ? pv.v1 : undefined;
      const placed = u.qkeys?.includes(qkey(e.section, e.number)) ?? true;
      const find = (list: SecondRead[]) => list.find((x) => x.q.number === e.number && x.q.section === e.section) ?? (e.number === null ? list.find((x) => textSimilarity(x.q.stem, e.stem) >= 0.85) : undefined);
      const result: V2Result = failed
        ? { ...stamp(q), at: new Date().toISOString(), model: failed.error.model ?? state.model, status: failed.status, fields: [], detail: `no independent result (${failed.status === "UNAVAILABLE" ? "unavailable" : "failed"}): ${failed.error.message}`.slice(0, 600), error: failed.error, part: unitLabel(u) }
        : { ...compareSecond(q, find(second) ?? (placed ? undefined : find(pool)), v1, rules, { ...memo, model: state.model, part: unitLabel(u) }), part: unitLabel(u) };
      if (!result.model) result.model = state.model;
      counts[result.status]++;
      counts.attempted++;
      // A read with a result is one verification pass (a failed / unavailable one can be retried).
      await savePaperVerify(q, V2_RESULT_STATUSES.includes(result.status) ? { v2: result, passes: withPass(pvOf(q), "v2", result.model) } : { v2: result });
    }
    const all = u.kind === "text" ? await prisma.aiImportQuestion.findMany({ where: { fileId: u.file.id, status: { notIn: LOCKED } }, select: { data: true, editedData: true } }) : stored;
    const extra = second.filter((x) => !x.q.continuesOnNextPage && !all.some((q) => effective(q).number === x.q.number && effective(q).section === x.q.section)).map((x) => `${x.q.section ? `${x.q.section} ` : ""}Q${x.q.number ?? x.q.label}`);
    if (extra.length && !failed) {
      counts.extra += extra.length;
      await logEvent(ctx.job.id, "VERIFY_EXTRA", `${unitLabel(u)}: Verify 2 found ${extra.join(", ")}, which the import does not have — check for missing questions (nothing is added automatically).`, { unit: u.key, extra });
    }
    counts.units++;
    if (failed) {
      counts.failedUnits++;
      await logEvent(ctx.job.id, "VERIFY2_FAILED", `${unitLabel(u)}: Verify 2 ${failed.status === "UNAVAILABLE" ? "unavailable" : "failed"} (${failed.error.message.slice(0, 300)}). Its ${mine.length} question(s) have no independent result — not counted as agreement; use Verify 2 again to retry only the parts without a result.`, { unit: u.key, status: failed.status, error: failed.error, questions: mine.length });
    } else done.push(u.key);
    state = await saveState(ctx.job.id, { doneUnits: done, counts });
    }
  }
  if (stopped) {
    await markUnavailable(notRead, stopped);
    await saveState(ctx.job.id, { doneUnits: done, counts });
    throw stopped;
  }

  // Subject / topic / subtopic: an independent classification by the Verify 2 model over EVERY question with enough
  // text (also those without a subject), from the exam's full code list — it never sees the stored choice or Verify 1's.
  // Its result is kept apart from the text read (v2.classification): a taxonomy disagreement never turns a correct
  // reading into a failed one, and a failed / missing / truncated answer is VERIFICATION_FAILED, never agreement.
  const taxonomy = await getExamTaxonomy(prisma, ctx.job.examId);
  const all = await prisma.aiImportQuestion.findMany({ where: { jobId: ctx.job.id, status: { notIn: LOCKED } }, include: { figures: true }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }] });
  const tc = { AGREED: 0, DISAGREEMENT: 0, NEEDS_REVIEW: 0, VERIFICATION_FAILED: 0, NOT_VERIFIED: 0 };
  const saveTax = async (q: QRow, c: NonNullable<V2Result["classification"]>) => {
    tc[c.status]++;
    const fresh = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q.id }, include: { figures: true } });
    const pv = (fresh.data as unknown as ExtractedQuestion).paperVerify ?? {};
    // The content result (current, also when only the subject / topic changed) is kept; the check replaces only its classification.
    const base: V2Result = pv.v2 && contentCurrent(pv.v2, fingerprintOf(fresh)) ? pv.v2 : { ...stamp(fresh), at: new Date().toISOString(), model: state!.model, status: "UNAVAILABLE", fields: [], detail: "no independent text read of this question in this run", error: null };
    await savePaperVerify(fresh, { v2: { ...base, classification: c } });
  };
  const storedOf = (q: QRow) => ({ subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId });
  const v1Of = (q: QRow) => {
    const pv = (q.data as unknown as ExtractedQuestion).paperVerify;
    return pv?.v1 && contentCurrent(pv.v1, fingerprintOf(q)) && sameTaxonomy(q, pv.v1.classification) ? (pv.v1.classification ?? null) : null;
  };
  const vsV1 = (q: QRow, found: { subjectId: string | null; topicId: string | null }): "AGREES" | "DIFFERS" | "NO_V1" => {
    const v1 = v1Of(q)?.found;
    if (!v1 || !v1.subjectId) return "NO_V1";
    return v1.subjectId === found.subjectId && (!v1.topicId || !found.topicId || v1.topicId === found.topicId) ? "AGREES" : "DIFFERS";
  };
  const checkable: QRow[] = [];
  for (const q of all) {
    // Targeted: an up-to-date agreeing check, or a question at the pass limit before this run, is not asked again.
    if (!targets.classify.has(q.id)) continue;
    if (!taxonomy.length) await saveTax(q, { status: "NOT_VERIFIED", stored: storedOf(q), found: null, confidence: null, method: state.model, findings: ["this exam has no subjects configured — missing configuration"], comparedWithV1: "NO_V1" });
    else if (!textSufficient(effective(q)).ok) await saveTax(q, { status: "NOT_VERIFIED", stored: storedOf(q), found: null, confidence: null, method: state.model, findings: [`not classified: ${textSufficient(effective(q)).why} (an extraction problem, not a taxonomy one)`], comparedWithV1: "NO_V1" });
    else checkable.push(q);
  }
  if (checkable.length) {
    const codes = taxonomyCodes(taxonomy);
    for (let i = 0; i < checkable.length; i += CLASSIFY_BATCH) {
      if (!(await ctx.stillRunning())) return counts;
      const batch = checkable.slice(i, i + CLASSIFY_BATCH);
      const text = classifyUserText(codes.list, batch.map((q) => effective(q)), memoryBrief(paperRules, paper, "classify"));
      let value: { results: { q: string; subject: string | null; topic: string | null; subtopic: string | null; confidence: number; about: string | string[] | null; reason: string | null }[] } | null = null;
      let model = state.model;
      let failure: string | null = null;
      try {
        const r = await verifyCall(ctx, state, { task: "classify", system: CLASSIFY_SYSTEM, content: [{ type: "text", text }], maxOutputTokens: 2500, needsVision: false, jsonSchema: "classify" }, (out) => {
          const parsed = classifyAnswerOf(parseModelJson(out));
          if (!parsed) throw new ImporterAiFailure(failureMessage("model_output", "the classification answer did not match the expected format"), "model_output");
          return parsed;
        });
        value = r.value;
        model = r.model;
      } catch (e) {
        if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) {
          for (const q of checkable.slice(i)) await saveTax(q, { status: "VERIFICATION_FAILED", stored: storedOf(q), found: null, confidence: null, method: state.model, findings: [`not checked — Verify 2 stopped: ${(e as Error).message.slice(0, 200)}`], comparedWithV1: "NO_V1" });
          throw e;
        }
        failure = e instanceof Error ? e.message.slice(0, 300) : "request failed";
        await logEvent(ctx.job.id, "VERIFY2_FAILED", `Verify 2 classification request failed (${failure.slice(0, 200)}); the subject / topic of those ${batch.length} question(s) is VERIFICATION_FAILED (not agreement).`, {});
      }
      for (const [k, q] of batch.entries()) {
        const stored = storedOf(q);
        if (!value) {
          await saveTax(q, { status: "VERIFICATION_FAILED", stored, found: null, confidence: null, method: model, findings: [`the classification request failed: ${failure}`], comparedWithV1: "NO_V1" });
          continue;
        }
        const res = value.results.find((x) => Number.parseInt(x.q.replace(/\D+/g, ""), 10) - 1 === k);
        if (!res) {
          await saveTax(q, { status: "VERIFICATION_FAILED", stored, found: null, confidence: null, method: model, findings: [`${model} returned no answer for this question (${value.results.length} answer(s) for ${batch.length} question(s))`], comparedWithV1: "NO_V1" });
          continue;
        }
        const d = decideClassification(res, effective(q), codes, taxonomy, model);
        const found = { subjectId: d.subject, topicId: d.topic, subTopicId: d.subTopic };
        const name = (id: string | null) => codes.name(id);
        if (!d.subject) {
          // An answer that cannot be tied to this question, or names codes outside the exam, is a failed check.
          const failed = !!d.rejected && (/key words/.test(d.rejected) || /not in this exam/.test(d.rejected));
          await saveTax(q, { status: failed ? "VERIFICATION_FAILED" : "NEEDS_REVIEW", stored, found: null, confidence: res.confidence, method: model, findings: [failed ? `unusable answer: ${d.rejected}` : `${model} could not place it reliably (${d.rejected ?? "no subject fits"})${stored.subjectId ? ` — the stored ${name(stored.subjectId)} is not confirmed` : ""}`], comparedWithV1: "NO_V1" });
          continue;
        }
        const findings: string[] = [];
        let status: NonNullable<V2Result["classification"]>["status"] = "AGREED";
        if (!stored.subjectId) {
          status = "NEEDS_REVIEW";
          findings.push(`no subject is stored; Verify 2 suggests ${name(d.subject)}${d.topic ? ` › ${name(d.topic)}` : ""} (${Math.round(d.confidence * 100)}%) — never applied automatically`);
        } else if (d.subject !== stored.subjectId) {
          status = "DISAGREEMENT";
          findings.push(`subject ${name(stored.subjectId)} vs ${name(d.subject)} (independent classification, ${Math.round(d.confidence * 100)}%)${res.reason ? ` — reason given: ${res.reason.slice(0, 160)}` : ""}`);
        } else if (d.topic && stored.topicId && d.topic !== stored.topicId && d.confidence >= 0.7) {
          status = "DISAGREEMENT";
          findings.push(`topic ${name(stored.topicId)} vs ${name(d.topic)} (independent classification, ${Math.round(d.confidence * 100)}%)${res.reason ? ` — reason given: ${res.reason.slice(0, 160)}` : ""}`);
        } else if (d.subTopic && stored.subTopicId && d.subTopic !== stored.subTopicId && d.confidence >= 0.7) {
          status = "DISAGREEMENT";
          findings.push(`subtopic ${name(stored.subTopicId)} vs ${name(d.subTopic)} (independent classification, ${Math.round(d.confidence * 100)}%)`);
        } else if (!stored.topicId && d.topic) {
          status = "NEEDS_REVIEW";
          findings.push(`subject confirmed; no topic is stored — Verify 2 suggests ${name(d.topic)} (never applied automatically)`);
        } else findings.push(`${name(d.subject)}${stored.topicId ? ` › ${name(stored.topicId)}` : ""} confirmed independently (${Math.round(d.confidence * 100)}%)`);
        if (d.rejected) findings.push(`ignored: ${d.rejected}`);
        await saveTax(q, { status, stored, found, confidence: d.confidence, method: model, findings, comparedWithV1: vsV1(q, found) });
      }
    }
  }
  await logEvent(ctx.job.id, "VERIFY2_CLASSIFIED", `Verify 2 subject / topic check of ${all.length} question(s): ${tc.AGREED} agreed, ${tc.DISAGREEMENT} disagreement(s), ${tc.NEEDS_REVIEW} need review, ${tc.VERIFICATION_FAILED} verification failed (never counted as agreement), ${tc.NOT_VERIFIED} not verified.`, { ...tc });
  counts.taxAgreed = tc.AGREED;
  counts.taxDisagree = tc.DISAGREEMENT;
  counts.taxFailed = tc.VERIFICATION_FAILED;
  return counts;
}

// ---- Paper summary, eligibility, bulk actions -----------------------------------------------------------

export interface PaperSummary {
  total: number;
  verified: number;
  /** Every question is in exactly one bucket of each (the buckets add up to `total`). */
  v1: { passed: number; problems: number; stale: number; none: number };
  v2: { verified: number; disagree: number; not_found: number; failed: number; unavailable: number; stale: number; none: number };
  /** The job's Verify 2 run: whether it genuinely ran, how it ended, and the first reason a question has no result. */
  verify2Run: { status: string; outcome: string | null; model: string; attempted: number; results: number; noResult: number; parts: number; failedParts: number; firstError: string | null; stopReason: string | null } | null;
  corrected: number;
  missing: string[];
  duplicates: string[];
  answerIssues: number;
  /** Question / option / answer boundaries: answer text in an option, statements run together, placeholder text, options missing. */
  structureIssues: number;
  classificationIssues: number;
  classification: { subjectUnknown: number; subjectMismatch: number; topicMissing: number; classificationFailed: number; disagreements: number };
  formulaIssues: number;
  figureIssues: number;
  unresolved: number;
  eligible: string[];
  approvedNotStored: number;
  cost: { estimateInr: number | null; spentInr: number; confirmedMaxInr: number; verify2: { model: string; status: string; estimateInr: number; maxInr: number; actualInr: number } | null };
  references: { refId: string; name: string; questions: number; key: number; note: string | null; compared: boolean; matched: number; conflicts: number; scannedPages: number; status: ReferenceStatus }[];
}

const has = (q: { issueCodes: string[] }, codes: string[]) => q.issueCodes.some((c) => codes.includes(c));
export const STRUCTURE_CODES = ["ANSWER_IN_OPTION", "STATEMENTS_MERGED", "QUESTION_TEXT_SUSPECT", "OPTIONS_INCOMPLETE", "NUMBER_CONFLICT"];
export const TAXONOMY_CODES = ["SUBJECT_UNKNOWN", "CLASSIFICATION_FAILED", "SUBJECT_MISMATCH", "TOPIC_UNCERTAIN", "TAXONOMY_DISAGREES"];

/** Pages of a reference with no text layer (stored, but not compared without OCR / vision). */
export function scannedPagesOf(r: Pick<ReferencePaper, "note" | "kind" | "pageCount"> & { scannedPages?: number }): number {
  if (typeof r.scannedPages === "number") return r.scannedPages;
  const m = /(\d+) of (\d+) page\(s\) have no text layer/.exec(r.note ?? "");
  if (m) return Number(m[1]);
  return r.kind === "png" || r.kind === "jpeg" ? (r.pageCount ?? 1) : 0;
}
/** A reference is compared only through what was read from it: questions or answer-key entries. */
export const referenceComparable = (r: Pick<ReferencePaper, "questions" | "key">) => r.questions.length > 0 || r.key.length > 0;

/** Questions that may be imported and published without individual review: both verifications fresh and clean, every check passed. */
export function eligibleForPublish(q: QRow, settings: ImporterSettings, rescanPending: boolean): boolean {
  if (q.questionId || LOCKED.includes(q.status) || rescanPending) return false;
  const s = verifyState(q.data, fingerprintOf(q));
  if (s.v1 !== "passed" || s.v2 !== "verified") return false;
  if (q.status !== AiImportQuestionStatus.READY && !(q.approvedById && q.status === AiImportQuestionStatus.EXTRACTED)) return false;
  if (q.issueCodes.some((c) => ISSUE_DEFS[c]?.blocking || ISSUE_DEFS[c]?.publishBlocking)) return false;
  // A subject that differs from the printed section is decided on its own (never published in bulk / from the list).
  if (q.issueCodes.includes("SECTION_SUBJECT_DIFFERS")) return false;
  return !importBlocker(q, settings, { ignoreApproval: true }) && !publishBlocker(q, settings);
}

export async function paperSummary(jobId: string): Promise<PaperSummary | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { estCostInr: true, spentInr: true, budgetInr: true, config: true } });
  if (!job) return null;
  const [rows, quality, settings, pending, refs] = await Promise.all([
    prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true } }),
    jobQuality(jobId),
    getImporterSettings(),
    prisma.aiImportQuestionVersion.findMany({ where: { jobId, kind: "RESCAN", status: "PENDING" }, select: { questionId: true } }),
    listReferences(jobId),
  ]);
  const pendingIds = new Set(pending.map((p) => p.questionId));
  const active = rows.filter((q) => q.status !== AiImportQuestionStatus.REJECTED);
  const out: PaperSummary = {
    total: active.length,
    verified: 0,
    v1: { passed: 0, problems: 0, stale: 0, none: 0 },
    v2: { verified: 0, disagree: 0, not_found: 0, failed: 0, unavailable: 0, stale: 0, none: 0 },
    verify2Run: null,
    corrected: 0,
    missing: quality?.missing ?? [],
    duplicates: [...(quality?.duplicateNumbers ?? []), ...active.filter((q) => has(q, ["DUPLICATE_IN_BATCH", "DUPLICATE_EXISTING"])).map((q) => `Q${q.sourceLabel} (duplicate)`)],
    answerIssues: active.filter((q) => has(q, ["ANSWER_MISSING", "ANSWER_MISMATCH", "ANSWER_AMBIGUOUS", "ANSWER_KEY_PAPER_MISMATCH", "ANSWER_TYPE_CONFLICT", "POSSIBLE_WITHDRAWN", "UNSUPPORTED_TYPE"])).length,
    structureIssues: active.filter((q) => has(q, STRUCTURE_CODES)).length,
    classificationIssues: active.filter((q) => has(q, TAXONOMY_CODES)).length,
    classification: { subjectUnknown: active.filter((q) => has(q, ["SUBJECT_UNKNOWN"])).length, subjectMismatch: active.filter((q) => has(q, ["SUBJECT_MISMATCH"])).length, topicMissing: active.filter((q) => has(q, ["TOPIC_UNCERTAIN"])).length, classificationFailed: active.filter((q) => has(q, ["CLASSIFICATION_FAILED"])).length, disagreements: active.filter((q) => has(q, ["TAXONOMY_DISAGREES"])).length },
    formulaIssues: active.filter((q) => has(q, ["FORMULA_ISSUE", "UNREADABLE_TEXT", "EXTRACTION_UNCERTAIN", "QUESTION_TEXT_SUSPECT"])).length,
    figureIssues: active.filter((q) => has(q, ["IMAGE_MISSING", "IMAGE_MAPPING_UNCERTAIN", "IMAGE_REFERENCE_UNCERTAIN"])).length,
    unresolved: active.filter((q) => has(q, ["VERIFY2_DISAGREES", "VERIFY_DISAGREES", "REFERENCE_CONFLICT"])).length,
    eligible: [],
    approvedNotStored: active.filter((q) => q.approvedById && !q.questionId).length,
    cost: { estimateInr: job.estCostInr, spentInr: job.spentInr, confirmedMaxInr: job.budgetInr, verify2: null },
    references: refs.map((r) => {
      // A comparison counts only when Verify 1 ran after the reference was added and after its latest reading.
      const readAt = [r.uploadedAt, r.ocr?.at].filter((x): x is string => !!x).sort().pop() ?? "";
      let readAfterVerify = false;
      const results = active
        .map((q) => {
          const v1 = (q.data as unknown as ExtractedQuestion).paperVerify?.v1;
          const x = v1?.references?.find((y) => y.refId === r.refId) ?? null;
          if (x && v1 && v1.at < readAt) {
            readAfterVerify = true;
            return { ...x, compared: false, conflicts: [] };
          }
          return x;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (!results.length && active.some((q) => (q.data as unknown as ExtractedQuestion).paperVerify?.v1)) readAfterVerify = active.every((q) => ((q.data as unknown as ExtractedQuestion).paperVerify?.v1?.at ?? "") < readAt);
      const status = referenceStatus({ questions: r.questions.length, key: r.key.length, scannedPages: scannedPagesOf(r), readAfterVerify }, results.filter((x) => x.compared).length);
      return { refId: r.refId, name: r.name, questions: r.questions.length, key: r.key.length, note: r.note, compared: status.state === "compared", matched: results.filter((x) => x.matched).length, conflicts: results.filter((x) => x.conflicts.length).length, scannedPages: scannedPagesOf(r), status };
    }),
  };
  for (const q of active) {
    const s = verifyState(q.data, fingerprintOf(q));
    out.v1[s.v1]++;
    out.v2[s.v2]++;
    if (s.v1 === "passed" && s.v2 === "verified") out.verified++;
    if (q.editedData || s.pv?.v1?.fixes.length) out.corrected++;
    if (eligibleForPublish(q, settings, pendingIds.has(q.id))) out.eligible.push(q.id);
  }
  const v2 = (job.config as { verify2?: Verify2State } | null)?.verify2;
  if (v2) {
    out.cost.verify2 = { model: v2.model, status: v2.status, estimateInr: v2.estimateInr, maxInr: v2.maxInr, actualInr: Math.max(0, Math.round((job.spentInr - v2.spentBeforeInr) * 100) / 100) };
    const c = v2.counts ?? {};
    const errors = active.map((q) => (q.data as unknown as ExtractedQuestion).paperVerify?.v2).filter((x) => x && (x.status === "FAILED" || x.status === "UNAVAILABLE"));
    out.verify2Run = {
      status: v2.status,
      outcome: v2.outcome ?? (v2.status === "DONE" && c.attempted === undefined ? verify2Outcome({ ...c, attempted: (c.VERIFIED ?? 0) + (c.DISAGREE ?? 0) + (c.NOT_FOUND ?? 0) + (c.FAILED ?? 0) }) : null),
      model: v2.model,
      attempted: c.attempted ?? (c.VERIFIED ?? 0) + (c.DISAGREE ?? 0) + (c.NOT_FOUND ?? 0) + (c.FAILED ?? 0) + (c.UNAVAILABLE ?? 0),
      results: (c.VERIFIED ?? 0) + (c.DISAGREE ?? 0) + (c.NOT_FOUND ?? 0),
      noResult: (c.FAILED ?? 0) + (c.UNAVAILABLE ?? 0),
      parts: c.units ?? v2.units,
      failedParts: c.failedUnits ?? 0,
      firstError: errors[0]?.error?.message ?? errors[0]?.detail ?? null,
      stopReason: v2.stopReason ?? null,
    };
  }
  return out;
}

/**
 * "Import & Publish Eligible Questions": only questions that passed Verify 1 and Verify 2 (both fresh) and every
 * deterministic check are approved — by this explicit administrator action, recorded on each question — and
 * imported and published. Everything else stays as it is.
 */
export async function importAndPublishEligible(jobId: string, actorId: string): Promise<{ approved: number; requested: number; skipped: number }> {
  await finishedJob(jobId);
  const summary = await paperSummary(jobId);
  if (!summary?.eligible.length) throw new ImportJobError("No question is eligible yet: a question needs a passed Verify 1 and an agreeing Verify 2 (both up to date) and no open flag. Run the verifications, or approve questions one by one.");
  const r = await approveQuestions(summary.eligible, actorId);
  const approvedIds = (await prisma.aiImportQuestion.findMany({ where: { id: { in: summary.eligible }, approvedById: { not: null }, questionId: null }, select: { id: true } })).map((q) => q.id);
  if (!approvedIds.length) throw new ImportJobError(`None of the eligible questions could be approved (${r.refused.slice(0, 3).map((x) => `Q${x.label}: ${x.reason}`).join("; ")}).`);
  await logEvent(jobId, "VERIFIED_BULK_APPROVAL", `${approvedIds.length} question(s) approved by Import & Publish Eligible (Verify 1 passed, Verify 2 agreed, no open flag)${r.refused.length ? `; ${r.refused.length} refused` : ""}.`, { ids: approvedIds, refused: r.refused }, actorId);
  await requestImport(jobId, actorId, "PUBLISH_SELECTED", approvedIds);
  return { approved: r.approved, requested: approvedIds.length, skipped: summary.eligible.length - approvedIds.length };
}

/**
 * The Publish button of one list row (Exceptions table / one-page list), after the administrator's explicit
 * confirmation: allowed only when the question is eligible NOW under every server-side rule (eligibleForPublish:
 * Verify 1 passed and Verify 2 agreed on the current content, no blocking / publish-blocking / individual-decision flag,
 * import and publish blockers clear). The question is approved by this action (recorded, list rules) and imported and
 * published like "Publish selected".
 */
export async function publishEligibleQuestion(questionId: string, actorId: string): Promise<{ requested: boolean; reason: string | null }> {
  const q = await prisma.aiImportQuestion.findUnique({ where: { id: questionId }, include: { figures: true } });
  if (!q) throw new ImportJobError("Question not found.", 404);
  await finishedJob(q.jobId);
  const { revalidateQuestions } = await import("@/lib/ai-import/review");
  await revalidateQuestions(q.jobId, [q.id]);
  const fresh = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: questionId }, include: { figures: true } });
  const settings = await getImporterSettings();
  const pending = await prisma.aiImportQuestionVersion.count({ where: { questionId, kind: "RESCAN", status: "PENDING" } });
  if (!eligibleForPublish(fresh, settings, pending > 0)) {
    const s = verifyState(fresh.data, fingerprintOf(fresh));
    const why = s.v1 !== "passed" ? `Verify 1 is ${s.v1 === "stale" ? "out of date" : s.v1 === "none" ? "not run" : "not passed"}` : s.v2 !== "verified" ? `Verify 2 has ${s.v2 === "stale" ? "an out-of-date result" : s.v2 === "none" ? "not run" : `no agreeing result (${s.v2})`}` : (importBlocker(fresh, settings, { ignoreApproval: true }) ?? publishBlocker(fresh, settings) ?? "an open flag needs a decision");
    throw new ImportJobError(`Q${fresh.sourceLabel} is not eligible to publish: ${why}. Open the question to decide it.`);
  }
  if (!fresh.approvedById) {
    const r = await approveQuestions([questionId], actorId, { from: "list" });
    if (!r.approved) throw new ImportJobError(`Q${fresh.sourceLabel} could not be approved: ${r.refused[0]?.reason ?? "refused"}.`);
  }
  await logEvent(fresh.jobId, "LIST_PUBLISH_REQUESTED", `Q${fresh.sourceLabel}: publish requested from the question list (eligible: Verify 1 passed, Verify 2 agreed, no open flag).`, { questionId }, actorId);
  await requestImport(fresh.jobId, actorId, "PUBLISH_SELECTED", [questionId]);
  return { requested: true, reason: null };
}

/** "Use reference answers": an administrator accepts the reference's answer for questions that have none. */
export async function applyReferenceAnswers(jobId: string, ids: string[], actorId: string): Promise<number> {
  await finishedJob(jobId);
  const refs = await listReferences(jobId);
  if (!refs.length) throw new ImportJobError("This import has no reference paper.");
  const { setAnswer } = await import("@/lib/ai-import/review");
  let n = 0;
  for (const q of await prisma.aiImportQuestion.findMany({ where: { jobId, id: { in: ids }, status: { notIn: LOCKED } } })) {
    if (q.finalAnswer.length) continue;
    const e = effective(q);
    const answers = refs.map((r) => compareWithReference(e, [], r).suggestedAnswer).filter((a) => a.length);
    const first = answers[0];
    if (!first || answers.some((a) => a.join() !== first.join()) || first.some((l) => !e.options.some((o) => o.label === l))) continue;
    if (e.type !== "MULTIPLE_CORRECT" && first.length !== 1) continue;
    await setAnswer(q.id, actorId, first);
    n++;
  }
  await logEvent(jobId, "REFERENCE_ANSWERS_APPLIED", `${n} answer(s) taken from the reference paper by an administrator (questions that had no answer).`, { count: n }, actorId);
  return n;
}
