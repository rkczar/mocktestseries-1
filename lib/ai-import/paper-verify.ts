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
import { mergedAnswerIn } from "@/lib/ai-import/local-parse";
import { readDocx } from "@/lib/ai-import/docx";
import { numbersMissingFromSource } from "@/lib/ai-import/fidelity";
import { MIN_CROP_SIDE, visionImage } from "@/lib/ai-import/figures";
import { assignSections, ensureRender, mergeContinuation, parsePage, readsAgree, type StepContext } from "@/lib/ai-import/process";
import { importerAiCall, parseModelJson, estimateInputTokens, ImporterAiFailure, ImporterAiUnavailable, PRICE_MARGIN } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM, classifySchema, documentTextUserText, extractUserText, toExtracted } from "@/lib/ai-import/prompts";
import { computeModelPlan, profileInputTokens, requestUsd } from "@/lib/ai-import/select";
import { compareWithReference, listReferences, referenceOnly, textSimilarity } from "@/lib/ai-import/reference";
import { recordVersion, snapshotFigures } from "@/lib/ai-import/versions";
import { exists as vaultExists, vaultPath } from "@/lib/ai-import/vault";
import { jobQuality, settleJobStatus } from "@/lib/ai-import/summary";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { approveQuestions, requestImport } from "@/lib/ai-import/review";
import { contentFingerprint, verifyState } from "@/lib/ai-import/verify-core";
import type { CandidateRow, TaskChoice } from "@/lib/ai-import/selection-types";
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

export function fingerprintOf(q: QRow): string {
  return contentFingerprint({ e: effective(q), finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures });
}

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

  // 2. Every deterministic check of the importer, on the corrected content (no AI).
  await runPostProcessing(ctx);

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
    for (const ref of refs) {
      const c = compareWithReference(e, q.finalAnswer, ref);
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
    await savePaperVerify(q, { v1: { fingerprint: fingerprintOf(q), at: new Date().toISOString(), passed: ok, problems, fixes: fixesBy.get(q.id) ?? [], reference } });
  }

  // 4. The findings become the questions' flags (still no AI), then the job's status follows its quality.
  await runPostProcessing(ctx);
  await settleJobStatus(jobId);
  const quality = await jobQuality(jobId);
  const refOnly = refs.flatMap((r) => referenceOnly(r, questions.map((x) => effective(x))).map((l) => `${l} (${r.name})`));
  const result: Verify1Result = { questions: passed + withProblems, passed, withProblems, corrected: fixesBy.size, missing: quality?.missing ?? [], duplicateNumbers: quality?.duplicateNumbers ?? [], referenceOnly: refOnly.slice(0, 200), referenceConflicts: refConflicts };
  await logEvent(jobId, "VERIFY1_DONE", `Verify 1 (full paper, no AI): ${result.questions} question(s) checked — ${passed} passed, ${withProblems} with findings, ${result.corrected} corrected from the source${result.missing.length ? `; missing ${result.missing.slice(0, 10).join(", ")}${result.missing.length > 10 ? " …" : ""}` : ""}${result.duplicateNumbers.length ? `; numbers read twice ${result.duplicateNumbers.slice(0, 10).join(", ")}` : ""}${refs.length ? `; reference papers: ${refConflicts} conflict(s)${refOnly.length ? `, ${refOnly.length} reference question(s) not in the source (${refOnly.slice(0, 6).join(", ")})` : ""}` : ""}.`, result as unknown as Record<string, unknown>, actorId);
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
}

const CHUNK = 11_000;

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
      units.push({ key: `${file.id}:text`, kind: "text", file, parts: chunkText(lines) });
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

type UnitRow = QRow;
/** A question is compared once its LAST page has been read again (a question spanning pages is joined first). */
const inUnit = (u: Unit, q: UnitRow) => q.fileId === u.file.id && (u.kind !== "page" || q.pages[q.pages.length - 1] === u.pageNumber);

/** A unit needs no new read when this model already read it and every one of its questions still has an up-to-date result. */
function unitDone(u: Unit, rows: UnitRow[], state: Verify2State | null, model: string | null): boolean {
  if (!state || state.model !== model || !state.doneUnits.includes(u.key)) return false;
  return rows.filter((q) => inUnit(u, q)).every((q) => {
    const s = verifyState(q.data, fingerprintOf(q));
    return (s.v2 === "verified" || s.v2 === "disagree") && s.pv?.v2?.model !== undefined;
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
}

async function priceVerify2(jobId: string, modelArg: string | null, refresh: boolean) {
  const job = await finishedJob(jobId);
  const settings = await verify2Settings(job.config);
  const used = await usedModels(jobId, job.config);
  // Every importer model, evaluated for page reading (the same request Verify 2 sends), minus the job's own readers.
  const auto = await computeModelPlan({ ...settings, selection: { ...settings.selection, mode: "auto" } }, { refresh: false, jobId }, { extract: used });
  const candidates = auto.tasks.extract.candidates.map((c) => (usedBy(used, c.id) ? { ...c, eligible: false, reason: "extracted this import (Verify 2 needs a different model)" } : c));
  const model = modelArg ?? candidates.find((c) => c.eligible)?.id ?? null;
  const problems: string[] = [...auto.problems];
  if (!settings.aiEnabled) problems.push("Paid AI is switched off in Import Settings — Verify 2 cannot run.");
  if (modelArg && usedBy(used, modelArg)) throw new ImportJobError(`${modelArg} extracted this import; Verify 2 must use a different model.`);
  const prior = (job.config as { verify2?: Verify2State } | null)?.verify2 ?? null;
  const units = await verify2Units(jobId);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, status: { notIn: LOCKED } }, include: { figures: true } });
  const todo = units.filter((u) => !unitDone(u, rows, prior, model));
  const questions = rows.length;
  const classifyBatches = Math.ceil(questions / 20);
  let choice: TaskChoice | null = null;
  let estimateInr: number | null = null;
  let maxInr: number | null = null;
  let reason = auto.tasks.extract.reason;
  if (model) {
    choice = await choiceFor(settings, model, used[0] ?? null, jobId, refresh);
    reason = choice.reason;
    const fx = refresh ? await getUsdInr() : { rate: auto.fxRate };
    if (choice.model === model && choice.price && fx.rate) {
      const pageTokens = profileInputTokens("verify");
      const classifyTokens = profileInputTokens("classify");
      let maxUsd = 0;
      let typUsd = 0;
      for (const u of todo) {
        if (u.kind === "page") {
          maxUsd += requestUsd(choice.price, pageTokens, 8000, 1) * PRICE_MARGIN;
          typUsd += requestUsd(choice.price, pageTokens, 3200, 1);
        } else
          for (const part of u.parts ?? []) {
            const t = estimateInputTokens(EXTRACT_SYSTEM, [{ type: "text", text: documentTextUserText({ exam: "", subject: null, part: 1, parts: 1, text: part }) }]);
            maxUsd += requestUsd({ ...choice.price, image: 0 }, t, 8000, 0) * PRICE_MARGIN;
            typUsd += requestUsd({ ...choice.price, image: 0 }, t, 3200, 0);
          }
      }
      maxUsd += classifyBatches * requestUsd({ ...choice.price, image: 0 }, classifyTokens, 2500, 0) * PRICE_MARGIN;
      typUsd += classifyBatches * requestUsd({ ...choice.price, image: 0 }, Math.round(classifyTokens / 3), 600, 0);
      maxInr = Math.ceil((usdToInr(maxUsd, fx.rate) ?? 0) * 100) / 100;
      estimateInr = Math.ceil((usdToInr(typUsd, fx.rate) ?? 0) * 100) / 100;
    } else problems.push(`${model} cannot be used for Verify 2: ${choice.reason}`);
  } else problems.push(`No suitable model for Verify 2: ${reason}`);
  const alternates = candidates.filter((c) => c.eligible && c.id !== model && (settings.budget.allowPricierFallback || (c.maxInr ?? Infinity) <= (choice?.maxInr ?? 0) + 1e-9)).map((c) => c.id).slice(0, 3);
  return { job, settings, used, candidates, model, choice, reason, units: todo, allUnits: units, questions, classifyBatches, estimateInr, maxInr, problems, prior, alternates };
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
  if (!p.units.length) throw new ImportJobError("Every page of this import was already read by Verify 2 with this model. Choose another model to read it again.");
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
  await logEvent(input.jobId, "VERIFY2_REQUESTED", `Verify 2 confirmed with ${input.model}: ${p.units.length} source unit(s) + ${p.classifyBatches} classification request(s), estimated ${formatInr(p.estimateInr)}, maximum ${formatInr(p.maxInr)} (confirmed ${formatInr(confirmed)}). Confirmed maximum of the import: ${formatInr(budget)} (₹${p.job.spentInr.toFixed(2)} spent so far).`, { model: input.model, units: p.units.length, classifyBatches: p.classifyBatches, estimateInr: p.estimateInr, maxInr: p.maxInr, confirmedMaxInr: confirmed, budgetInr: budget, alternates: p.alternates, usedModels: p.used }, input.actorId);
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

function compareSecond(q: QRow, twin: SecondRead | undefined, v1: NonNullable<PaperVerification["v1"]> | undefined): NonNullable<PaperVerification["v2"]> {
  const fp = fingerprintOf(q);
  const now = new Date().toISOString();
  const e = effective(q);
  if (!twin) return { fingerprint: fp, at: now, model: "", status: "NOT_FOUND", fields: ["not found"], detail: "the independent read did not find this question in the source" };
  const v = readsAgree(e, twin.q);
  const fields = [...v.fields];
  const diffs = v.detail === "both reads match" ? [] : v.detail.split("; ");
  // The answer: the second read's printed answer against the question's answer (an official key outranks a printed one).
  if (twin.q.printedAnswer.length && q.finalAnswer.length && !fields.includes("printed answer") && [...twin.q.printedAnswer].sort().join() !== [...q.finalAnswer].sort().join() && q.answerStatus !== "OFFICIAL_MATCHED") {
    fields.push("answer");
    diffs.push(`answer ${q.finalAnswer.join(",")} vs printed ${twin.q.printedAnswer.join(",")} in the second read`);
  }
  if (twin.q.type !== e.type && !(twin.q.type === "SINGLE_CORRECT" && e.type === "OTHER") && ["MULTIPLE_CORRECT", "SINGLE_CORRECT"].includes(twin.q.type) && ["MULTIPLE_CORRECT", "SINGLE_CORRECT"].includes(e.type)) {
    fields.push("type");
    diffs.push(`type ${e.type.toLowerCase()} vs ${twin.q.type.toLowerCase()}`);
  }
  const second = { stem: twin.q.stem.slice(0, 600), options: twin.q.options.map((o) => o.text.slice(0, 200)), printedAnswer: twin.q.printedAnswer };
  if (!fields.length) return { fingerprint: fp, at: now, model: twin.model, status: "VERIFIED", fields: [], detail: `wording, ${e.options.length} options, answer, numbers / symbols and figures agree${v1 ? (v1.passed ? "; Verify 1 passed" : "; Verify 1 has findings") : ""}` };
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
  if (resolved) return { fingerprint: fp, at: now, model: twin.model, status: "VERIFIED", fields, detail: "the two reads differ, but the source text confirms the stored question", resolvedBySource: resolved, second };
  const alsoV1 = v1 && !v1.passed ? ` Verify 1 also has findings (${v1.problems.map((p) => p.code).join(", ") || "flags"}).` : "";
  return { fingerprint: fp, at: now, model: twin.model, status: "DISAGREE", fields, detail: `${diffs.join("; ")} — the source cannot settle it; correct the question by hand or approve it after checking.${alsoV1}`.slice(0, 900), second };
}

/** Worker: the confirmed Verify 2 of one job (job is PROCESSING, leased). Throws budget / unavailable stops. */
export async function runVerify2(ctx: StepContext): Promise<Record<string, number>> {
  let state = (ctx.job.config as { verify2?: Verify2State } | null)?.verify2;
  if (!state) throw new Error("Verify 2 request missing.");
  state = await saveState(ctx.job.id, { status: "RUNNING", startedAt: state.startedAt ?? new Date().toISOString() });
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: ctx.job.id, status: { notIn: LOCKED } }, include: { figures: true } });
  const units = (await verify2Units(ctx.job.id)).filter((u) => !unitDone(u, rows, state!, state!.model));
  const exam = await prisma.exam.findUnique({ where: { id: ctx.job.examId }, select: { name: true } });
  const counts: Record<string, number> = { VERIFIED: 0, DISAGREE: 0, NOT_FOUND: 0, FAILED: 0, units: 0, failedUnits: 0, extra: 0 };
  const done = [...state.doneUnits];
  // The second read's last question of the previous page when it continues on the next page (joined there).
  const tail = new Map<string, { q: ExtractedQuestion; page: number } | null>();
  for (const u of units) {
    if (!(await ctx.stillRunning())) return counts;
    const second: SecondRead[] = [];
    let failed: string | null = null;
    try {
      if (u.kind === "page") {
        const render = await ensureRender(ctx.job, u.file, u.pageNumber!, ctx.settings.limits.renderDpi);
        const image = await visionImage(render);
        const { value, model } = await verifyCall(ctx, state, { task: "verify", system: EXTRACT_SYSTEM, content: [{ type: "text", text: extractUserText({ exam: exam?.name ?? "Exam", subject: null, page: u.pageNumber!, pages: u.file.pageCount ?? 1, textLayer: u.textLayer ?? null }) }, { type: "image_url", image_url: { url: image, detail: "high" } }], maxOutputTokens: 8000, pageId: u.pageId, needsVision: true }, (t) => parsePage(t, "the Verify 2 model's answer"));
        const qs = toExtracted(value, u.pageNumber!, model);
        assignSections(qs, u.startState as never);
        const prev = tail.get(u.file.id);
        if (qs[0]?.continuedFromPreviousPage && prev && prev.page === u.pageNumber! - 1) {
          second.push({ q: mergeContinuation(prev.q, qs.shift()!, u.pageNumber!), model, sourceText: u.textLayer ?? null });
        }
        for (const q of qs) second.push({ q, model, sourceText: u.textLayer ?? null });
        const last = qs[qs.length - 1];
        tail.set(u.file.id, last?.continuesOnNextPage ? { q: last, page: u.pageNumber! } : null);
      } else {
        const parts = u.parts ?? [];
        const all: ExtractedQuestion[] = [];
        let model = state.model;
        for (let i = 0; i < parts.length; i++) {
          if (!(await ctx.stillRunning())) return counts;
          const r = await verifyCall(ctx, state, { task: "verify", system: EXTRACT_SYSTEM, content: [{ type: "text", text: documentTextUserText({ exam: exam?.name ?? "Exam", subject: null, part: i + 1, parts: parts.length, text: parts[i] }) }], maxOutputTokens: 8000, needsVision: false }, (t) => parsePage(t, "the Verify 2 model's answer"));
          model = r.model;
          all.push(...toExtracted(r.value, 1, r.model));
        }
        // Sections (numbering restarts) over the whole document, as the local reader numbers them.
        assignSections(all, undefined);
        for (const q of all) second.push({ q, model, sourceText: parts.join("\n") });
      }
    } catch (e) {
      if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) {
        await saveState(ctx.job.id, { doneUnits: done });
        throw e;
      }
      failed = e instanceof Error ? e.message.slice(0, 300) : "request failed";
    }
    // Compare with every stored question of this unit (a page: the questions that start on it).
    const stored = await prisma.aiImportQuestion.findMany({ where: { fileId: u.file.id, status: { notIn: LOCKED }, ...(u.kind === "page" ? { pages: { has: u.pageNumber! } } : {}) }, include: { figures: true } });
    const mine = stored.filter((q) => inUnit(u, q));
    for (const q of mine) {
      const pv = (q.data as unknown as ExtractedQuestion).paperVerify ?? {};
      const e = effective(q);
      const v1 = pv.v1 && pv.v1.fingerprint === fingerprintOf(q) ? pv.v1 : undefined;
      const result: NonNullable<PaperVerification["v2"]> = failed
        ? { fingerprint: fingerprintOf(q), at: new Date().toISOString(), model: state.model, status: "FAILED", fields: [], detail: `no independent result: ${failed}` }
        : compareSecond(q, second.find((s) => s.q.number === e.number && s.q.section === e.section) ?? (e.number === null ? second.find((s) => textSimilarity(s.q.stem, e.stem) >= 0.85) : undefined), v1);
      if (!result.model) result.model = state.model;
      counts[result.status]++;
      await savePaperVerify(q, { v2: result });
    }
    const extra = second.filter((s) => !s.q.continuesOnNextPage && !stored.some((q) => effective(q).number === s.q.number && effective(q).section === s.q.section)).map((s) => `${s.q.section ? `${s.q.section} ` : ""}Q${s.q.number ?? s.q.label}`);
    if (extra.length && !failed) {
      counts.extra += extra.length;
      await logEvent(ctx.job.id, "VERIFY_EXTRA", `${u.file.originalName}${u.kind === "page" ? ` page ${u.pageNumber}` : ""}: Verify 2 found ${extra.join(", ")}, which the import does not have — check for missing questions (nothing is added automatically).`, { unit: u.key, extra });
    }
    counts.units++;
    if (failed) {
      counts.failedUnits++;
      await logEvent(ctx.job.id, "VERIFY2_FAILED", `${u.file.originalName}${u.kind === "page" ? ` page ${u.pageNumber}` : ""}: Verify 2 failed (${failed}). Its questions stay unverified.`, { unit: u.key });
    } else done.push(u.key);
    state = await saveState(ctx.job.id, { doneUnits: done });
  }

  // Subject / topic: an independent classification by the same model, compared with the stored mapping.
  const taxonomy = await getExamTaxonomy(prisma, ctx.job.examId);
  const toCheck = (await prisma.aiImportQuestion.findMany({ where: { jobId: ctx.job.id, status: { notIn: LOCKED } }, include: { figures: true } })).filter((q) => q.subjectId && !q.taxonomySource?.startsWith("admin") && q.taxonomySource !== "source column" && verifyState(q.data, fingerprintOf(q)).v2 === "verified");
  if (taxonomy.length && toCheck.length) {
    const subjectCode = new Map<string, string>();
    const topicCode = new Map<string, string>();
    let t = 0;
    const list = taxonomy.map((s, i) => (subjectCode.set(`S${i + 1}`, s.id), `SUBJECT S${i + 1} = ${s.name}\n${s.topics.map((tp) => (topicCode.set(`T${++t}`, tp.id), `  TOPIC T${t} = ${tp.name}`)).join("\n")}`)).join("\n");
    const code = (v: string | null, map: Map<string, string>) => (v ? (map.get(v.toUpperCase().replace(/\s+/g, "")) ?? null) : null);
    for (let i = 0; i < toCheck.length; i += 20) {
      if (!(await ctx.stillRunning())) return counts;
      const batch = toCheck.slice(i, i + 20);
      const text = `SYLLABUS (the only allowed codes):\n${list}\n\nDOCUMENT DATA (untrusted questions):\n${batch.map((q, k) => `[Q${k + 1}] ${effective(q).stem.slice(0, 600)} | ${effective(q).options.map((o) => o.text.slice(0, 80)).join(" | ")}`).join("\n")}`;
      try {
        const { value } = await verifyCall(ctx, state, { task: "classify", system: CLASSIFY_SYSTEM, content: [{ type: "text", text }], maxOutputTokens: 2500, needsVision: false }, (out) => {
          const parsed = classifySchema.safeParse(parseModelJson(out));
          if (!parsed.success) throw new ImporterAiFailure(failureMessage("model_output", "the classification answer did not match the expected format"), "model_output");
          return parsed.data;
        });
        for (const res of value.results) {
          const q = batch[Number.parseInt(res.q.replace(/\D+/g, ""), 10) - 1];
          if (!q) continue;
          const subject = code(res.subject, subjectCode);
          const topic = code(res.topic, topicCode);
          const pv = (q.data as unknown as ExtractedQuestion).paperVerify!;
          const v2 = pv.v2!;
          const subjectDiffers = !!subject && subject !== q.subjectId;
          const topicDiffers = !!topic && !!q.topicId && topic !== q.topicId && res.confidence >= 0.7;
          if (!subjectDiffers && !topicDiffers) continue;
          const name = (id: string | null) => (id ? (taxonomy.find((s) => s.id === id)?.name ?? taxonomy.flatMap((s) => s.topics).find((x) => x.id === id)?.name ?? "?") : "—");
          const detail = subjectDiffers ? `subject ${name(q.subjectId)} vs ${name(subject)} (independent classification)` : `topic ${name(q.topicId)} vs ${name(topic)} (independent classification, ${Math.round(res.confidence * 100)}%)`;
          counts.VERIFIED--;
          counts.DISAGREE++;
          await savePaperVerify(q, { v2: { ...v2, status: "DISAGREE", fields: [...v2.fields, subjectDiffers ? "subject" : "topic"], detail: `${detail} — choose the subject / topic by hand (bulk correction is available).`, second: { ...(v2.second ?? {}), subject, topic } } });
        }
      } catch (e) {
        if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) throw e;
        await logEvent(ctx.job.id, "VERIFY2_FAILED", `Verify 2 classification request failed (${e instanceof Error ? e.message.slice(0, 200) : "error"}); the subject / topic of those questions was not cross-checked.`, {});
      }
    }
  }
  return counts;
}

// ---- Paper summary, eligibility, bulk actions -----------------------------------------------------------

export interface PaperSummary {
  total: number;
  verified: number;
  v1: { passed: number; problems: number; stale: number; none: number };
  v2: { verified: number; disagree: number; failed: number; stale: number; none: number };
  corrected: number;
  missing: string[];
  duplicates: string[];
  answerIssues: number;
  classificationIssues: number;
  formulaIssues: number;
  figureIssues: number;
  unresolved: number;
  eligible: string[];
  approvedNotStored: number;
  cost: { estimateInr: number | null; spentInr: number; confirmedMaxInr: number; verify2: { model: string; status: string; estimateInr: number; maxInr: number; actualInr: number } | null };
  references: { refId: string; name: string; questions: number; key: number; note: string | null }[];
}

const has = (q: { issueCodes: string[] }, codes: string[]) => q.issueCodes.some((c) => codes.includes(c));

/** Questions that may be imported and published without individual review: both verifications fresh and clean, every check passed. */
export function eligibleForPublish(q: QRow, settings: ImporterSettings, rescanPending: boolean): boolean {
  if (q.questionId || LOCKED.includes(q.status) || rescanPending) return false;
  const s = verifyState(q.data, fingerprintOf(q));
  if (s.v1 !== "passed" || s.v2 !== "verified") return false;
  if (q.status !== AiImportQuestionStatus.READY && !(q.approvedById && q.status === AiImportQuestionStatus.EXTRACTED)) return false;
  if (q.issueCodes.some((c) => ISSUE_DEFS[c]?.blocking || ISSUE_DEFS[c]?.publishBlocking)) return false;
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
    v2: { verified: 0, disagree: 0, failed: 0, stale: 0, none: 0 },
    corrected: 0,
    missing: quality?.missing ?? [],
    duplicates: [...(quality?.duplicateNumbers ?? []), ...active.filter((q) => has(q, ["DUPLICATE_IN_BATCH", "DUPLICATE_EXISTING"])).map((q) => `Q${q.sourceLabel} (duplicate)`)],
    answerIssues: active.filter((q) => has(q, ["ANSWER_MISSING", "ANSWER_MISMATCH", "ANSWER_AMBIGUOUS", "ANSWER_KEY_PAPER_MISMATCH", "ANSWER_TYPE_CONFLICT", "ANSWER_IN_OPTION", "POSSIBLE_WITHDRAWN", "UNSUPPORTED_TYPE"])).length,
    classificationIssues: active.filter((q) => has(q, ["SUBJECT_UNKNOWN", "TOPIC_UNCERTAIN"])).length,
    formulaIssues: active.filter((q) => has(q, ["FORMULA_ISSUE", "UNREADABLE_TEXT", "EXTRACTION_UNCERTAIN", "QUESTION_TEXT_SUSPECT"])).length,
    figureIssues: active.filter((q) => has(q, ["IMAGE_MISSING", "IMAGE_MAPPING_UNCERTAIN"])).length,
    unresolved: active.filter((q) => has(q, ["VERIFY2_DISAGREES", "VERIFY_DISAGREES", "REFERENCE_CONFLICT"])).length,
    eligible: [],
    approvedNotStored: active.filter((q) => q.approvedById && !q.questionId).length,
    cost: { estimateInr: job.estCostInr, spentInr: job.spentInr, confirmedMaxInr: job.budgetInr, verify2: null },
    references: refs.map((r) => ({ refId: r.refId, name: r.name, questions: r.questions.length, key: r.key.length, note: r.note })),
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
  if (v2) out.cost.verify2 = { model: v2.model, status: v2.status, estimateInr: v2.estimateInr, maxInr: v2.maxInr, actualInr: Math.max(0, Math.round((job.spentInr - v2.spentBeforeInr) * 100) / 100) };
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
