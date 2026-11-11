import "server-only";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { AiImportFileRole, AiImportFileStatus, AiImportPageStatus, AiImportQuestionStatus, type AiImportFile, type AiImportJob, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseImportFile } from "@/lib/bulk-import";
import { ocrTextLayer, pageLayout, renderPage, type PageLayout } from "@/lib/ai-import/pdf";
import { readDocx, IMG_TOKEN, type DocxContent } from "@/lib/ai-import/docx";
import { joinPreamble, orphanQuestion, parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import { blockToQuestion, candidateInstruction, cleanStem, formatStem, splitQuestions, type NumberingState } from "@/lib/ai-import/local-parse";
import { jobMemoryBrief } from "@/lib/ai-import/taxonomy-memory";
import { cropFromRender, cropFromScan, iou, storeOriginalFigure, visionImage, FigureError, MIN_CROP_SIDE } from "@/lib/ai-import/figures";
import { checkFigureMapping, overlappingRegions } from "@/lib/ai-import/figure-map";
import { formulaDiff, sourceDiffSummary, sourceTextDiff } from "@/lib/ai-import/fidelity";
import { importerAiCallChecked, parseModelJson, ImporterAiFailure, ImporterAiSwitchedOff, ImporterAiUnavailable, ImporterJobStopped, ImporterRateLimited } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { EXTRACT_SYSTEM, RESCAN_RULES, extractUserText, pageSchema, toExtracted, type PageOutput } from "@/lib/ai-import/prompts";
import { gapPages, incompleteReading } from "@/lib/ai-import/reading-checks";
import { readVault, renderKey, putIntermediate, vaultPath, workDir, exists as vaultExists } from "@/lib/ai-import/vault";
import { logEvent } from "@/lib/ai-import/jobs";
import { sourceKeyOf, type ExtractedQuestion, type NBox, type PageExtraction } from "@/lib/ai-import/types";
import { pixelRect, toPageBox, type ViewPart } from "@/lib/ai-import/rescan-target";
import { ocrAvailable, ocrImageFile, ocrPdfPage } from "@/lib/ai-import/ocr";
import { readOcrPage, type OcrPageResult } from "@/lib/ai-import/ocr-page";
import { BLANK_INK_BELOW, type OcrPage } from "@/lib/ai-import/ocr-layout";
import type { ImporterSettings, VerifyMode } from "@/lib/ai-import/config";
import { figureRows, manuallyCorrected, recordVersion, snapshotFigures, type FigureSnapshot } from "@/lib/ai-import/versions";
import { mkdir } from "node:fs/promises";
import { BILINGUAL_RULES, hindiAgreement, mergeHindi } from "@/lib/ai-import/bilingual";
import { withPass } from "@/lib/ai-import/verify-core";

/**
 * Extraction stage of the worker. Question papers are read LOCALLY first
 * (text layer + embedded images, DOCX, spreadsheets — free and exact); only
 * pages the local parser cannot read reliably (scanned pages, flattened
 * formulas, unclear figure positions) are sent to the vision model, and a
 * DIFFERENT model re-reads low-confidence pages. Every page is a checkpoint:
 * an interrupted job resumes at the first page that is not DONE.
 */

/** The job's exam prints every question in Hindi and English (Exam.languageMode BILINGUAL). */
export async function jobIsBilingual(job: { examId: string }): Promise<boolean> {
  return (await prisma.exam.findUnique({ where: { id: job.examId }, select: { languageMode: true } }))?.languageMode === "BILINGUAL";
}

export interface StepContext {
  job: AiImportJob;
  settings: ImporterSettings;
  examName: string;
  subjectName: string | null;
  /** Returns false when the job was paused/cancelled meanwhile (stop between pages). */
  stillRunning: () => Promise<boolean>;
  /** Independent verification of this job: second read of risky pages only, or of every page. */
  verifyMode?: VerifyMode;
}

/** What a re-scan sends to the reader: the whole page, a band of it, or a band stacked with the next page's band. */
export type RescanView = { kind: "PAGE" } | { kind: "REGION"; box: NBox } | { kind: "STACK"; pages: [number, number]; boxes: [NBox, NBox] };

/** A re-scan requested by an administrator: only these question keys (null = the whole page) are re-read. */
export interface RescanRequest {
  keys: string[] | null;
  requestedById: string;
  requestedAt: string;
  /** Absent on requests stored before cut-outs existed (= the whole page). */
  view?: RescanView;
}

/** An empty question added for a missing number (by an administrator or a re-scan), not yet filled. */
export function isPlaceholder(e: Pick<ExtractedQuestion, "method" | "stem" | "options">): boolean {
  return e.method === "ADMIN" && !e.stem.trim() && e.options.every((o) => !o.text.trim());
}

type PageState = {
  startState?: NumberingState;
  local?: { reliable: boolean; reasons: string[] };
  ai?: unknown;
  secondRead?: unknown;
  rescan?: RescanRequest;
  /** Set when the page was read again because question numbers expected on it were missing (rereadGapPages). */
  gapRetried?: boolean;
  verified?: { model: string; at: string; extra: string[] };
  /** The page's paid first read, kept until the page is finished: a stop during the second read never pays for it again. */
  primaryCache?: { model: string; out: PageOutput; at: string };
  /**
   * Text at the top of this page that continues a question of the previous page, read before that page was
   * finished (pages are read in parallel). Joined once the previous page is done; `savedAs` = the question it
   * was saved as meanwhile (so it is visible), removed again when the join succeeds.
   */
  pendingJoins?: { q: ExtractedQuestion; savedAs?: string | null }[];
};

/** Parses a page answer into the page schema (an unusable answer throws "model_output", which may switch the model once). */
export function parsePage(text: string, what = "the model's answer"): PageOutput {
  const parsed = pageSchema.safeParse(parseModelJson(text));
  if (!parsed.success) throw new ImporterAiFailure(failureMessage("model_output", `${what} did not match the expected format (${parsed.error.issues[0]?.path.join(/* turbopackIgnore: true */ ".") ?? "?"})`), "model_output");
  return parsed.data;
}

export function aiUsable(s: ImporterSettings): boolean {
  return s.aiEnabled && !!s.models.extract;
}

// ---- Persisting questions + figures -----------------------------------------------------------------

/** Where a crop was cut: the original embedded scan or the page render, and its pixel rectangle there. */
type CropProvenance = { from: "scan" | "render"; width: number; height: number };
export type FigureBytes = (f: ExtractedQuestion["figures"][number]) => Promise<{ bytes: Buffer; ext: string; source: string; crop?: CropProvenance } | null>;

/**
 * Figure bytes for one page: exact embedded image when the box matches one, otherwise a crop of the box
 * from the ORIGINAL full-page scan (scanned PDF, at the scan's own resolution) or from the page render.
 * The original page and render are never modified.
 */
function pageFigureBytes(render: Buffer, renderWidth: number, layout: PageLayout | null): FigureBytes {
  const scan = layout?.images.find((img) => img.box.w * img.box.h >= 0.85) ?? null;
  return async (f) => {
    if (!f.box) return null;
    if (layout) {
      const hit = layout.images.map((img, i) => ({ i, score: iou(img.box, f.box!), area: img.box.w * img.box.h })).filter((x) => x.area < 0.6).sort((a, b) => b.score - a.score)[0];
      if (hit && hit.score >= 0.6) return { bytes: layout.images[hit.i].bytes, ext: layout.images[hit.i].ext, source: "EMBEDDED" };
    }
    const fromScan = scan && layout ? await cropFromScan(scan, layout, f.box, renderWidth) : null;
    const crop = fromScan ?? (await cropFromRender(render, f.box));
    if (!crop) return null;
    const why: string[] = [];
    if (crop.clipped) {
      f.confidence = Math.min(f.confidence, 0.6);
      why.push("The figure touches the page edge — part of it may be cut off.");
    }
    if (Math.min(crop.width, crop.height) < MIN_CROP_SIDE) {
      f.confidence = Math.min(f.confidence, 0.5);
      why.push(`The crop is only ${crop.width}×${crop.height} px — check that the whole figure is legible.`);
    }
    if (why.length) f.mappingReason = [f.mappingReason, ...why].filter(Boolean).join(" ");
    return { bytes: crop.bytes, ext: "png", source: "CROP", crop: { from: fromScan ? "scan" : "render", width: crop.width, height: crop.height } };
  };
}

/** Stores the original bytes of each extracted figure in the vault (never modified) and describes it. */
async function storeFigures(q: ExtractedQuestion, figureBytes: FigureBytes, pageNumber: number): Promise<FigureSnapshot[]> {
  const out: FigureSnapshot[] = [];
  for (const f of q.figures) {
    let stored: Awaited<ReturnType<typeof storeOriginalFigure>> | null = null;
    let source = "CROP";
    let note = f.description ?? null;
    let crop: CropProvenance | null = null;
    try {
      const got = await figureBytes(f);
      if (got) {
        stored = await storeOriginalFigure(got.bytes, got.ext);
        source = got.source;
        crop = got.crop ?? null;
      }
    } catch (e) {
      note = e instanceof FigureError ? e.message : "The figure could not be read.";
    }
    // Decided after the crop: a crop cut at the page edge or too small lowers the confidence.
    let mapping = f.confidence >= 0.8 ? "OK" : "UNCERTAIN";
    if (!stored) mapping = "MISSING";
    out.push({
      pageNumber: (f as { page?: number }).page ?? pageNumber,
      owner: f.owner,
      optionLabel: f.owner === "OPTION" ? (f.optionLabel ?? null) : null,
      sharedGroup: f.sharedGroup ?? null,
      // The page box plus the crop's provenance: pixel rectangle on the original it was cut from, and the mapping reason.
      box: f.box ? { ...f.box, ...(crop ? { crop } : {}), ...(f.mappingReason ? { reason: f.mappingReason.slice(0, 400) } : {}) } : null,
      source: stored ? source : "MISSING",
      originalKey: stored?.key ?? "",
      originalSha256: stored?.sha256 ?? "",
      originalMime: stored?.mime ?? "",
      width: stored?.width ?? 0,
      height: stored?.height ?? 0,
      bytes: stored?.bytes ?? 0,
      description: note?.slice(0, 500) ?? null,
      confidence: f.confidence,
      mappingStatus: f.owner === "UNASSIGNED" ? "UNCERTAIN" : mapping,
      confirmedById: null,
    });
  }
  return out;
}

/** What happened to one question of a re-scanned page. */
export type RescanOutcome = "applied" | "pending" | "new" | "stored" | "skipped";

/**
 * Saves one extracted question with its figures. A normal pass never overwrites a question that was
 * imported or corrected by an administrator. A RE-SCAN (`rescan` set) never loses work either: an
 * untouched question is replaced after its previous extraction is kept as a version; a manually
 * corrected one is left as it is and the new read waits as a PENDING version for the administrator.
 */
export async function saveQuestion(ctx: StepContext, file: AiImportFile, q: ExtractedQuestion, orderIndex: number, figureBytes: FigureBytes, pageNumber: number, rescan?: { model: string | null; ref?: string } | null): Promise<RescanOutcome> {
  // Every method: no printed number and no copied option list inside the stem (flagged when it cannot be removed exactly).
  cleanStem(q);
  // Formatting only (a leading "Question:" label, numbered statements run together): the text as read is kept with it.
  const formatted = formatStem(q.stem);
  if (formatted) {
    q.formatting = { original: q.stem, rules: formatted.rules, by: "EXTRACTION", at: new Date().toISOString() };
    q.stem = formatted.stem;
  }
  const key = sourceKeyOf(q);
  const existing = await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: file.id, sourceKey: key } }, include: { figures: true } });
  // The same printed number read on a DIFFERENT page (a misread number, or a repeated one) never replaces the
  // earlier question: it is kept as its own question under a page-qualified key, without a number, and flagged.
  if (existing && !rescan && q.pages.length && !existing.pages.some((p) => q.pages.includes(p))) {
    const shown = q.number ?? q.label;
    const kept: ExtractedQuestion = {
      ...q,
      printedNumber: q.number ?? q.printedNumber ?? null,
      number: null,
      label: `${shown}@p${q.pages[0]}`,
      confidence: Math.min(q.confidence, 0.5),
      notes: [...(q.notes ?? []), `Q${shown} was already read on page ${existing.pages.join(", ")}; this question on page ${q.pages.join(", ")} is kept separately — check which number is right.`],
    };
    return saveQuestion(ctx, file, kept, orderIndex, figureBytes, pageNumber, rescan);
  }
  if (existing && (existing.status === AiImportQuestionStatus.IMPORTED || existing.status === AiImportQuestionStatus.PUBLISHED)) {
    if (rescan) await recordVersion({ questionId: existing.id, jobId: ctx.job.id, kind: "RESCAN", status: "DISCARDED", data: q, model: rescan.model, note: "Already in the Question Bank — the re-scan result was kept for reference only (edit the saved question in the Question Bank)." });
    return "stored";
  }
  const manual = !!existing && manuallyCorrected(existing, existing.figures);
  if (existing && manual && !rescan) return "skipped";
  // Owner decision 2026-11-11: EVERY re-scan result is a candidate. It never replaces a question (approved, corrected or
  // untouched): it waits as a PENDING version until an administrator compares it and saves the fields to take.
  if (rescan) {
    // A number the re-scan found that has no row yet gets an empty placeholder row; the reading waits on it as a candidate.
    const target = existing ?? (await prisma.aiImportQuestion.create({ data: placeholderRow(ctx.job.id, file.id, key, q, orderIndex) }));
    const figs = await storeFigures(q, figureBytes, pageNumber);
    await prisma.aiImportQuestionVersion.updateMany({ where: { questionId: target.id, kind: "RESCAN", status: "PENDING" }, data: { status: "DISCARDED", decidedAt: new Date(), note: "Replaced by a newer re-scan." } });
    await recordVersion({ questionId: target.id, jobId: ctx.job.id, kind: "RESCAN", status: "PENDING", data: q, figures: figs, model: rescan.model, note: existing ? `Re-scan candidate${manual ? " (this question has manual corrections)" : ""}${existing.approvedById ? " (this question is approved)" : ""}: nothing was replaced. Compare and save the fields to take.` : "Found by the re-scan (it was not in the earlier extraction): review the candidate and save it to fill this question." });
    // The one place a re-scan uses a verification pass: a reading of this question was saved as a candidate. Counted
    // with the model that read it, once per request (`ref`), so a worker retry of the same request never counts twice.
    const td = target.data as unknown as ExtractedQuestion;
    const passes = withPass(td.paperVerify, "rescan", rescan.model, undefined, rescan.ref ?? undefined);
    await prisma.aiImportQuestion.update({ where: { id: target.id }, data: { status: AiImportQuestionStatus.EXTRACTED, ...(passes.length !== (td.paperVerify?.passes?.length ?? -1) ? { data: { ...td, paperVerify: { ...(td.paperVerify ?? {}), passes } } as unknown as Prisma.InputJsonValue } : {}) } });
    return existing ? "pending" : "new";
  }
  const data = {
    jobId: ctx.job.id,
    fileId: file.id,
    sourceKey: key,
    sourceNumber: q.number,
    sourceLabel: q.label,
    pages: q.pages,
    orderIndex,
    status: AiImportQuestionStatus.EXTRACTED,
    // A re-scan replaces the extraction (its old verification results no longer apply) but never the pass log: the
    // limit of verification passes per question must survive the re-scan it counts.
    data: (existing && rescan && (existing.data as unknown as ExtractedQuestion).paperVerify?.passes ? { ...q, paperVerify: { passes: (existing.data as unknown as ExtractedQuestion).paperVerify!.passes } } : q) as unknown as Prisma.InputJsonValue,
    questionType: q.type,
    optionCount: q.options.length,
    contentFormat: q.contentFormat,
    confidence: q.confidence,
    sourceAnswer: q.printedAnswer,
    // New content needs a new approval.
    approvedById: null,
    approvedAt: null,
  };
  const row = existing ? await prisma.aiImportQuestion.update({ where: { id: existing.id }, data }) : await prisma.aiImportQuestion.create({ data });
  const figs = await storeFigures(q, figureBytes, pageNumber);
  await prisma.aiImportFigure.deleteMany({ where: { questionId: row.id } });
  if (figs.length) await prisma.aiImportFigure.createMany({ data: figureRows(figs, { jobId: ctx.job.id, fileId: file.id, questionId: row.id }) });
  return existing ? "applied" : "new";
}

/** An empty question at a printed number, waiting for a re-scan candidate (or an administrator) to fill it. */
export function placeholderRow(jobId: string, fileId: string, sourceKey: string, q: Pick<ExtractedQuestion, "section" | "number" | "label" | "pages">, orderIndex: number): Prisma.AiImportQuestionUncheckedCreateInput {
  const data: ExtractedQuestion = { section: q.section, number: q.number, label: q.label, pages: q.pages, type: "SINGLE_CORRECT", stem: "", options: ["A", "B", "C", "D"].map((l) => ({ label: l, printed: l, text: "" })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0, unreadable: [], figures: [], method: "ADMIN", notes: ["Placeholder for a question missing from the extraction — fill it from a re-scan candidate or by hand."] };
  return { jobId, fileId, sourceKey, sourceNumber: q.number, sourceLabel: q.label, pages: q.pages, orderIndex, status: AiImportQuestionStatus.EXTRACTED, data: data as unknown as Prisma.InputJsonValue, questionType: "SINGLE_CORRECT", optionCount: 4, confidence: 0, issueCodes: ["OPTIONS_INCOMPLETE"] };
}

async function nextOrderIndex(fileId: string): Promise<number> {
  const agg = await prisma.aiImportQuestion.aggregate({ where: { fileId }, _max: { orderIndex: true } });
  return (agg._max.orderIndex ?? -1) + 1;
}

// ---- PDF -------------------------------------------------------------------------------------------

async function localPdfPass(ctx: StepContext, file: AiImportFile): Promise<void> {
  const full = vaultPath(file.storageKey!);
  const pages = file.pageCount ?? 0;
  const work = workDir(ctx.job.id);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const facts = ((file.detected as { facts?: { pagesDetail?: { page: number; kind: string }[] } } | null)?.facts?.pagesDetail ?? []) as { page: number; kind: string }[];
  const state: NumberingState = { last: 0, sectionIdx: 1 };
  let order = await nextOrderIndex(file.id);
  let previous: ExtractedQuestion | null = null;
  // Bilingual papers: local OCR cannot read Devanagari (2026-11-10: RapidOCR PP-OCRv6 read Hindi as "3π", "HRH" at
  // 80–100% confidence) and the local parser would read the two language columns as two questions with one number.
  // Every page therefore goes to the vision reader, which returns each number once with both versions.
  const bilingual = await jobIsBilingual(ctx.job);
  const useOcr = ocrAvailable() && !bilingual;
  const record = (p: number, data: Prisma.AiImportPageUncheckedUpdateInput & { status: AiImportPageStatus }) =>
    prisma.aiImportPage.upsert({
      where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } },
      create: { ...(data as Prisma.AiImportPageUncheckedCreateInput), jobId: ctx.job.id, fileId: file.id, pageNumber: p },
      update: data,
    });
  for (let p = 1; p <= pages; p++) {
    const done = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } } });
    if (done?.status === AiImportPageStatus.DONE && done.kind) {
      // Resume: replay the numbering state recorded at the END of this page (older pages only have the start state).
      const raw = done.rawOutput as (PageState & { endState?: NumberingState }) | null;
      const st = raw?.endState ?? raw?.startState;
      if (st) Object.assign(state, st);
      continue;
    }
    if (!(await ctx.stillRunning())) return;
    const startState = { ...state };
    const kind = facts.find((f) => f.page === p)?.kind ?? "TEXT";
    let layout: PageLayout | null = null;
    try {
      layout = await pageLayout(full, p, work);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 300) : "layout failed";
      await record(p, { status: AiImportPageStatus.FAILED, kind, errorMessage: msg, outcome: "FAILED", outcomeReason: msg, rawOutput: { startState } });
      continue;
    }
    const textChars = layout.lines.reduce((a, l) => a + l.text.replace(/\s+/g, "").length, 0);
    const scanned = textChars < 80 || bilingual;
    let textLayer = layout.lines.map((l) => l.text).join("\n").slice(0, 20_000);
    let local: (PageExtraction & { preamble: string }) | null = scanned ? null : parsePdfPageLocal({ lines: layout.lines, images: layout.images }, p, state);
    // A searchable scan carries an invisible OCR text layer (Sprint A item 2, 2026-11-06). It is read (free) but never
    // trusted on its own: local OCR stays the reader, and the layer's question numbers are an independent cross-check
    // recorded on the page; without local OCR the layer's text is kept for review / the AI read as a hint only.
    const layerLayout = scanned ? await ocrTextLayer(full, p, work, textChars) : null;
    const layer = layerLayout
      ? {
          chars: layerLayout.lines.reduce((a, l) => a + l.text.replace(/\s+/g, "").length, 0),
          text: layerLayout.lines.map((l) => l.text).join("\n").slice(0, 20_000),
          numbers: parsePdfPageLocal({ lines: layerLayout.lines, images: [] }, p, { ...startState }).questions.map((q) => q.number).filter((n): n is number => n !== null),
        }
      : null;
    // No usable text layer (a scan, or text drawn as outlines) — or a text layer in which no question could be found
    // (e.g. a poor third-party OCR layer): read the RENDERED page with local OCR. A page is never "blank" only because
    // it has no text layer.
    let ocr: { raw: OcrPage; result: OcrPageResult } | null = null;
    if ((scanned || local?.questions.length === 0) && useOcr) {
      try {
        const raw = await ocrPdfPage(full, p);
        const st = { ...startState };
        const result = readOcrPage(raw, p, st);
        if (scanned || (result.extraction?.questions.length ?? 0) > 0) {
          ocr = { raw, result };
          Object.assign(state, st);
          local = result.extraction;
        }
      } catch (e) {
        if (scanned) {
          const msg = `Local OCR failed: ${e instanceof Error ? e.message.slice(0, 250) : "unknown error"}`;
          await record(p, { status: aiUsable(ctx.settings) ? AiImportPageStatus.PENDING : AiImportPageStatus.FAILED, kind: "SCANNED", textChars, imageCount: layout.images.length, errorMessage: msg, outcome: "FAILED", outcomeReason: msg, rawOutput: { startState } });
          continue;
        }
      }
    }
    const ocrFields = ocr
      ? { ocrText: ocr.result.layout.text.slice(0, 50_000), ocrLines: ocr.raw.lines as unknown as Prisma.InputJsonValue, ocrEngine: ocr.raw.engine, ocrConfidence: ocr.result.layout.meanConfidence, ocrLowLines: ocr.result.layout.lowLines, inkCoverage: ocr.raw.ink }
      : {};
    if (ocr) textLayer = ocr.result.layout.text.slice(0, 20_000);
    if (scanned && !ocr) {
      // No OCR on this server: blank only when the rendered page has (almost) no ink; anything else is read by AI or reviewed.
      const ink = await pageInk(full, p);
      const blank = ink < BLANK_INK_BELOW;
      const why = blank && !layer ? `blank: ${(ink * 100).toFixed(2)}% ink on the rendered page` : bilingual ? `bilingual paper (Hindi + English): read by the vision model, which pairs both language versions of each question${layer ? ` (the page's own text layer, ${layer.chars} characters, is kept as a hint)` : ""}` : layer ? `no visible text and local OCR is not available — the PDF's own OCR text layer (${layer.chars} characters${layer.numbers.length ? `, question numbers ${layer.numbers.join(", ")}` : ""}) is kept as a hint, not as the reading` : `no text layer and local OCR is not available — ${(ink * 100).toFixed(1)}% of the page has ink`;
      const status = blank && !layer ? AiImportPageStatus.DONE : AiImportPageStatus.PENDING;
      await record(p, { status, kind: blank && !layer ? "BLANK" : "SCANNED", textChars, ...(layer ? { textLayer: layer.text } : {}), imageCount: layout.images.length, inkCoverage: ink, outcome: blank && !layer ? "BLANK_VERIFIED" : "NEEDS_REVIEW", outcomeReason: why, rawOutput: { startState, endState: { ...state }, ...(layer ? { ocrLayer: { chars: layer.chars, numbers: layer.numbers } } : {}) }, processedAt: status === AiImportPageStatus.DONE ? new Date() : null });
      continue;
    }
    if (ocr && !ocr.result.extraction) {
      // Blank (verified by ink), cover / instructions / rough work, or ink without readable text.
      // The OCR layer showing question numbers on a page local OCR called blank / instructions is a disagreement to review.
      const explained = (ocr.result.outcome === "BLANK_VERIFIED" || ocr.result.outcome === "INSTRUCTIONS") && !layer?.numbers.length;
      const status = explained ? AiImportPageStatus.DONE : AiImportPageStatus.PENDING;
      await record(p, { status, kind: ocr.result.outcome === "BLANK_VERIFIED" ? "BLANK" : "SCANNED", textChars, textLayer, imageCount: layout.images.length, ...ocrFields, outcome: ocr.result.outcome, outcomeReason: ocr.result.reason, model: status === AiImportPageStatus.DONE ? "local" : null, processedAt: status === AiImportPageStatus.DONE ? new Date() : null, rawOutput: { startState, endState: { ...state } } });
      if (ocr.result.outcome === "INSTRUCTIONS") await logEvent(ctx.job.id, "PAGE_NOT_QUESTIONS", `${file.originalName} page ${p}: ${ocr.result.reason} — no questions taken from it.`, { page: p });
      continue;
    }
    local = local!;
    // Text before the first question on this page continues the previous page's last question.
    const joined = joinPreamble(previous, local.preamble, p);
    if (joined && previous) {
      await saveQuestion(ctx, file, joined, (await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: file.id, sourceKey: sourceKeyOf(previous) } }, select: { orderIndex: true } }))?.orderIndex ?? order++, async () => null, previous.pages[0]);
    }
    // A complete question before the first readable number on the page (its number was not read): kept unnumbered.
    const orphan = joined ? null : orphanQuestion(previous, local.preamble, p, ocr ? "LOCAL_OCR" : "LOCAL_PDF", ocr ? { engine: ocr.raw.engine, minConfidence: Math.min(...ocr.result.layout.lines.map((l) => l.conf), 1), meanConfidence: ocr.result.layout.meanConfidence } : null);
    if (orphan) await saveQuestion(ctx, file, orphan, order++, async () => null, p);
    const noQuestions = !local.questions.length;
    const needsAi = !local.reliable || noQuestions;
    for (const q of local.questions) {
      await saveQuestion(ctx, file, q, order++, async (f) => (!ocr && f.embeddedIndex !== null && f.embeddedIndex !== undefined && layout!.images[f.embeddedIndex] ? { bytes: layout!.images[f.embeddedIndex].bytes, ext: layout!.images[f.embeddedIndex].ext, source: "EMBEDDED" } : null), p);
    }
    if (local.questions.length) previous = local.questions[local.questions.length - 1];
    const status = needsAi && aiUsable(ctx.settings) ? AiImportPageStatus.PENDING : AiImportPageStatus.DONE;
    const read = local.questions.map((q) => q.number).filter((n): n is number => n !== null);
    const layerOnly = layer ? layer.numbers.filter((n) => !read.includes(n)) : [];
    // A question number the OCR layer shows but the reading missed leaves the page unexplained (quality blocker).
    const outcome = layerOnly.length ? "NEEDS_REVIEW" : ocr ? ocr.result.outcome : noQuestions ? "NO_QUESTIONS" : "TEXT_LAYER";
    const layerCheck = layer ? (layerOnly.length ? ` The PDF's own OCR text layer also shows question number(s) ${layerOnly.join(", ")} that this reading did not find — check the page.` : ` The PDF's own OCR text layer agrees on the question numbers (${layer.numbers.length}).`) : "";
    const outcomeReason = (ocr ? ocr.result.reason : noQuestions ? "the text layer was read but no numbered question was found — check it" : `${local.questions.length} question(s) from the PDF's own text${local.reliable ? "" : ` (uncertain: ${local.reasons.slice(0, 3).join("; ")})`}`) + layerCheck;
    const pageKind = ocr ? "SCANNED" : needsAi ? "TEXT_UNRELIABLE" : "TEXT";
    const rawOutput = { startState, endState: { ...state }, local: { reliable: local.reliable, reasons: local.reasons }, ...(layer ? { ocrLayer: { chars: layer.chars, numbers: layer.numbers, notRead: layerOnly } } : {}), ...(ocr ? { ocr: { skew: ocr.result.layout.skew, gutter: ocr.result.layout.gutter, furniture: ocr.result.layout.furniture.slice(0, 40), seconds: ocr.raw.seconds, rereads: ocr.raw.rereads } } : {}) } as Prisma.InputJsonValue;
    await record(p, { status, kind: pageKind, textChars, textLayer, imageCount: layout.images.length, ...ocrFields, outcome, outcomeReason, rawOutput, processedAt: status === AiImportPageStatus.DONE ? new Date() : null, model: status === AiImportPageStatus.DONE ? (ocr ? ocr.raw.engine : "local") : null });
  }
}

/** Share of dark pixels of a page rendered at low resolution (blank detection when local OCR is unavailable). */
async function pageInk(file: string, page: number): Promise<number> {
  const png = await renderPage(file, page, 100);
  const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i++) if (data[i] < 128) dark++;
  return data.length ? dark / data.length : 0;
}

/** Page render for vision/crops/review (cached in the vault; re-creatable from the original). */
export async function ensureRender(job: { id: string }, file: AiImportFile, page: number, dpi: number): Promise<Buffer> {
  const key = renderKey(job.id, file.id, page);
  if (await vaultExists(key)) return readVault(key);
  const kind = (file.detected as { kind?: string } | null)?.kind;
  let png: Buffer;
  if (kind === "pdf") png = await renderPage(vaultPath(file.storageKey!), page, dpi);
  else png = await sharp(vaultPath(file.storageKey!), { limitInputPixels: 60_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  await putIntermediate(key, png);
  return png;
}

/** Section names for AI numbers, continuing the local numbering state of the page. */
export function assignSections(qs: ExtractedQuestion[], start: NumberingState | undefined): void {
  const st = { ...(start ?? { last: 0, sectionIdx: 1 }) };
  for (const q of qs) {
    if (q.number === null) {
      q.section = st.sectionIdx > 1 ? `S${st.sectionIdx}` : "";
      continue;
    }
    if (st.last >= 5 && q.number === 1) st.sectionIdx++;
    q.section = st.sectionIdx > 1 ? `S${st.sectionIdx}` : "";
    st.last = q.number;
  }
}

/**
 * Page-level structure checks of one read, before anything is saved: a printed number returned twice on the
 * page keeps both questions (the later one without a number, flagged — never merged or overwritten), the
 * figure ↔ question mapping is checked against the page geometry, and overlapping question areas (two
 * questions merged / one split) are flagged.
 */
export function checkPageStructure(qs: ExtractedQuestion[], pageNumber: number): void {
  const seen = new Map<string, number>();
  for (const q of qs) {
    if (q.continuedFromPreviousPage || q.number === null) continue;
    const k = sourceKeyOf(q);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 1) continue;
    q.printedNumber = q.number;
    q.label = `${q.number}@p${pageNumber}#${n}`;
    q.number = null;
    q.confidence = Math.min(q.confidence, 0.5);
    q.notes = [...(q.notes ?? []), `Q${q.printedNumber} was read twice on page ${pageNumber}; this second one is kept separately — check its number against the page.`];
  }
  checkFigureMapping(qs);
  for (const pair of overlappingRegions(qs)) {
    for (const q of qs) {
      if (!pair.split("/").includes(`Q${q.number ?? q.label}`)) continue;
      q.confidence = Math.min(q.confidence, 0.6);
      q.notes = [...(q.notes ?? []), `The page areas of ${pair.replace("/", " and ")} overlap — the questions may be merged or split; check them against the page.`];
    }
  }
}

/**
 * Joins the text at the top of a page to the question it continues on the previous page. Nothing is
 * dropped: options are appended in printed order (never cut to four), the continuation's figures are cropped
 * from THIS page and linked to the joined question, and text that cannot be placed is kept in the notes
 * with the confidence lowered.
 */
export function mergeContinuation(pd: ExtractedQuestion, q: ExtractedQuestion, pageNumber: number): ExtractedQuestion {
  const notes = [...(pd.notes ?? []), `Joined with its continuation on page ${pageNumber}.`];
  let stem = pd.stem;
  let options = pd.options;
  let confidence = Math.min(pd.confidence, q.confidence);
  const tail = q.stem.trim();
  if (!pd.options.length) {
    stem = `${pd.stem}\n${tail}`.trim();
    options = q.options;
  } else {
    const have = new Set(pd.options.map((o) => o.printed.replace(/[()[\].\s]/g, "").toLowerCase()));
    const added = q.options.filter((o) => !have.has(o.printed.replace(/[()[\].\s]/g, "").toLowerCase()));
    if (added.length < q.options.length) {
      notes.push(`Page ${pageNumber} repeats option label(s) already read on the previous page — check the options.`);
      confidence = Math.min(confidence, 0.5);
    }
    options = [...pd.options, ...added].map((o, i) => ({ ...o, label: String.fromCharCode(65 + i) }));
    if (tail) {
      notes.push(`Text at the top of page ${pageNumber} could not be placed automatically: "${tail.slice(0, 300)}" — add it where it belongs.`);
      confidence = Math.min(confidence, 0.4);
    }
  }
  const figures = [...pd.figures, ...q.figures];
  return {
    ...pd,
    stem,
    options,
    type: options.length >= 5 ? "FIVE_OPTIONS" : pd.type,
    pages: [...new Set([...pd.pages, pageNumber])],
    figures,
    printedAnswer: [...new Set([...pd.printedAnswer, ...q.printedAnswer])],
    listI: pd.listI || q.listI ? [...(pd.listI ?? []), ...(q.listI ?? [])] : null,
    listII: pd.listII || q.listII ? [...(pd.listII ?? []), ...(q.listII ?? [])] : null,
    ...(pd.hi !== undefined || q.hi !== undefined ? { hi: mergeHindi(pd.hi, q.hi) } : {}),
    unreadable: [...pd.unreadable, ...q.unreadable],
    contentFormat: pd.contentFormat === "RICH_V1" || q.contentFormat === "RICH_V1" ? "RICH_V1" : "PLAIN",
    confidence,
    continuesOnNextPage: q.continuesOnNextPage ?? false,
    notes,
  };
}

const UNTOUCHED_STATUSES: AiImportQuestionStatus[] = [AiImportQuestionStatus.EXTRACTED, AiImportQuestionStatus.READY, AiImportQuestionStatus.NEEDS_CORRECTION, AiImportQuestionStatus.NOT_IMPORTABLE];

/** Never corrected, reviewed, approved or stored by an administrator — still the extractor's own result. */
function untouched(q: { editedData: unknown; approvedById: string | null; reviewedById: string | null; answerConfirmedById: string | null; questionId: string | null; status: AiImportQuestionStatus }): boolean {
  return !q.editedData && !q.approvedById && !q.reviewedById && !q.answerConfirmedById && !q.questionId && UNTOUCHED_STATUSES.includes(q.status);
}

/** "joined" | "deferred" (previous page not finished yet) | the reason it cannot be joined. */
async function joinContinuation(ctx: StepContext, file: AiImportFile, pageNumber: number, q: ExtractedQuestion, figureBytes: FigureBytes): Promise<string> {
  if (pageNumber <= 1) return "it is on the first page";
  const prevPage = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: pageNumber - 1 } }, select: { status: true } });
  // Not read yet, or failed (a retry may still read it): joined later, never guessed now.
  if (!prevPage || prevPage.status === AiImportPageStatus.PENDING || prevPage.status === AiImportPageStatus.FAILED) return "deferred";
  if (prevPage.status !== AiImportPageStatus.DONE) return `page ${pageNumber - 1} was not read`;
  const prev = await prisma.aiImportQuestion.findFirst({ where: { fileId: file.id, ...(q.number !== null ? { sourceNumber: q.number } : {}), pages: { has: pageNumber - 1 } }, orderBy: { orderIndex: "desc" } });
  if (!prev) return q.number !== null ? `Q${q.number} is not on page ${pageNumber - 1}` : `no question on page ${pageNumber - 1}`;
  if (prev.pages.includes(pageNumber)) return "joined";
  if (!untouched(prev)) return `Q${prev.sourceLabel} was already corrected or reviewed`;
  const merged = mergeContinuation(prev.data as unknown as ExtractedQuestion, q, pageNumber);
  const figs = await storeFigures(q, figureBytes, pageNumber);
  await prisma.$transaction([
    prisma.aiImportQuestion.update({ where: { id: prev.id }, data: { data: merged as unknown as Prisma.InputJsonValue, pages: merged.pages, optionCount: merged.options.length, questionType: merged.type, contentFormat: merged.contentFormat, confidence: merged.confidence } }),
    ...(figs.length ? [prisma.aiImportFigure.createMany({ data: figureRows(figs, { jobId: ctx.job.id, fileId: file.id, questionId: prev.id }) })] : []),
  ]);
  return "joined";
}

/**
 * Continuations read before their previous page was finished (parallel reading): joined now, in page
 * order. One that still cannot be joined is saved as its own flagged question so it is never lost; it is
 * joined (and that question removed, if untouched) once the previous page is read on a retry.
 */
export async function joinPendingContinuations(ctx: StepContext): Promise<number> {
  const pages = await prisma.aiImportPage.findMany({ where: { jobId: ctx.job.id, status: AiImportPageStatus.DONE }, orderBy: [{ fileId: "asc" }, { pageNumber: "asc" }], include: { file: true } });
  let joined = 0;
  for (const p of pages) {
    const state = (p.rawOutput as PageState | null) ?? {};
    if (!state.pendingJoins?.length) continue;
    const render = await ensureRender(ctx.job, p.file, p.pageNumber, ctx.settings.limits.renderDpi);
    const meta = await sharp(render).metadata();
    let layout: PageLayout | null = null;
    if ((p.file.detected as { kind?: string } | null)?.kind === "pdf") layout = await pageLayout(vaultPath(p.file.storageKey!), p.pageNumber, workDir(ctx.job.id)).catch(() => null);
    const figureBytes = pageFigureBytes(render, meta.width ?? 0, layout);
    const left: NonNullable<PageState["pendingJoins"]> = [];
    for (const item of state.pendingJoins) {
      const q: ExtractedQuestion = JSON.parse(JSON.stringify(item.q));
      if (item.savedAs) {
        // Saved separately meanwhile: once an administrator worked on it, it is theirs and is never joined automatically.
        const saved = await prisma.aiImportQuestion.findUnique({ where: { id: item.savedAs } });
        if (!saved || !untouched(saved)) continue;
      }
      const outcome = await joinContinuation(ctx, p.file, p.pageNumber, q, figureBytes);
      if (outcome === "joined") {
        joined++;
        // The separately saved copy (untouched, checked above) is replaced by the joined question; its vault originals stay.
        if (item.savedAs) await prisma.aiImportQuestion.delete({ where: { id: item.savedAs } });
        continue;
      }
      if (!item.savedAs) {
        // Not joinable now: kept visible as its own question (flagged), never dropped.
        const shown = q.number ?? "?";
        const frag: ExtractedQuestion = { ...q, printedNumber: q.number, number: null, label: `cont${shown}@p${p.pageNumber}`, confidence: Math.min(q.confidence, 0.4), notes: [...(q.notes ?? []), `This text continues a question from page ${p.pageNumber - 1}, but it could not be joined (${outcome === "deferred" ? `page ${p.pageNumber - 1} is not finished` : outcome}). Kept separately — retry the previous page or join it by hand.`] };
        await saveQuestion(ctx, p.file, frag, await nextOrderIndex(p.fileId), figureBytes, p.pageNumber);
        const row = await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: p.fileId, sourceKey: sourceKeyOf(frag) } }, select: { id: true } });
        left.push({ q: item.q, savedAs: row?.id ?? null });
      } else left.push(item);
    }
    await prisma.aiImportPage.update({ where: { id: p.id }, data: { rawOutput: { ...state, pendingJoins: left.length ? left : undefined } as unknown as Prisma.InputJsonValue } });
  }
  return joined;
}

/** Compares two independent reads of the same question (deterministic), field by field. */
export function readsAgree(a: ExtractedQuestion, b: ExtractedQuestion): { agree: boolean; detail: string; fields: string[] } {
  const norm = (s: string) => s.toLowerCase().replace(/\$|\\[a-z]+|[{}\s.,;:()[\]'"`]/g, "");
  const sim = (x: string, y: string) => {
    const A = norm(x);
    const B = norm(y);
    if (!A && !B) return 1;
    const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
    const ga = grams(A);
    const gb = grams(B);
    let inter = 0;
    for (const g of ga) if (gb.has(g)) inter++;
    return ga.size + gb.size ? (2 * inter) / (ga.size + gb.size) : A === B ? 1 : 0;
  };
  const diffs: string[] = [];
  const fields: string[] = [];
  const s = sim(a.stem, b.stem);
  if (s < 0.9) {
    diffs.push(`question text differs (${Math.round(s * 100)}% similar)`);
    fields.push("question text");
  }
  if (a.options.length !== b.options.length) {
    diffs.push(`option count ${a.options.length} vs ${b.options.length}`);
    fields.push("options count");
  } else
    a.options.forEach((o, i) => {
      if (sim(o.text, b.options[i].text) < 0.85) {
        diffs.push(`option ${o.label} differs`);
        fields.push(`option ${o.label}`);
      }
    });
  // Text similarity hides a changed sign, exponent, digit or symbol ("10^{-3}" vs "10^{3}"): compared exactly.
  const parts: [string, string, string][] = [["question text", a.stem, b.stem], ...(a.options.length === b.options.length ? a.options.map((o, i): [string, string, string] => [`option ${o.label}`, o.text, b.options[i].text]) : [])];
  for (const [field, x, y] of parts) {
    const d = formulaDiff(x, y);
    if (d) {
      diffs.push(`numbers / symbols in ${field} differ (${d})`);
      fields.push(`${field} numbers`);
    }
  }
  const pa = [...a.printedAnswer].sort().join();
  const pb = [...b.printedAnswer].sort().join();
  if (pa && pb && pa !== pb) {
    diffs.push(`printed answer ${pa} vs ${pb}`);
    fields.push("printed answer");
  }
  const fa = a.figures.filter((f) => f.owner !== "UNASSIGNED").length;
  const fb = b.figures.filter((f) => f.owner !== "UNASSIGNED").length;
  if (fa !== fb) {
    diffs.push(`figures ${fa} vs ${fb}`);
    fields.push("figures");
  } else if (a.figures.some((f) => f.owner === "OPTION") || b.figures.some((f) => f.owner === "OPTION")) {
    const owners = (q: ExtractedQuestion) => q.figures.map((f) => (f.owner === "OPTION" ? `O${f.optionLabel}` : f.owner === "UNASSIGNED" ? "" : "S")).filter(Boolean).sort().join();
    if (owners(a) !== owners(b)) {
      diffs.push("figure placement differs");
      fields.push("figure placement");
    }
  }
  return { agree: diffs.length === 0, detail: diffs.join("; ") || "both reads match", fields };
}

/** The verification record of one question after an independent second read (or its absence). */
function verificationOf(q: ExtractedQuestion, second: ExtractedQuestion[], model: string): NonNullable<ExtractedQuestion["verification"]> {
  const twin = second.find((s) => s.number === q.number && s.section === q.section) ?? (q.number === null ? second.find((s) => s.number === null && readsAgree(q, s).agree) : undefined);
  if (!twin) return { model, agree: false, fields: ["not found"], detail: "the independent read did not find this question", at: new Date().toISOString() };
  const v = readsAgree(q, twin);
  return { model, agree: v.agree, fields: v.fields, detail: v.detail, at: new Date().toISOString() };
}

/** The cut-out sent for a question-level re-scan: page band(s) from the renders, stacked top to bottom. */
async function rescanImage(ctx: StepContext, file: AiImportFile, pageNumber: number, render: Buffer, view: Exclude<RescanView, { kind: "PAGE" }>): Promise<{ image: Buffer; parts: ViewPart[]; renders: Map<number, Buffer>; widths: Map<number, number> }> {
  const specs = view.kind === "REGION" ? [{ page: pageNumber, box: view.box }] : view.pages.map((p, i) => ({ page: p, box: view.boxes[i] }));
  const renders = new Map<number, Buffer>([[pageNumber, render]]);
  const widths = new Map<number, number>();
  const cuts: { page: number; box: NBox; buf: Buffer; w: number; h: number }[] = [];
  for (const s of specs) {
    if (!renders.has(s.page)) renders.set(s.page, await ensureRender(ctx.job, file, s.page, ctx.settings.limits.renderDpi));
    const r = renders.get(s.page)!;
    const m = await sharp(r).metadata();
    widths.set(s.page, m.width ?? 0);
    const rect = pixelRect(s.box, m.width ?? 1, m.height ?? 1);
    cuts.push({ page: s.page, box: s.box, buf: await sharp(r).extract(rect).png().toBuffer(), w: rect.width, h: rect.height });
  }
  const W = Math.max(...cuts.map((c) => c.w));
  const H = cuts.reduce((n, c) => n + c.h, 0);
  const parts: ViewPart[] = [];
  let y = 0;
  for (const c of cuts) {
    parts.push({ page: c.page, box: c.box, top: y / H, height: c.h / H, width: c.w / W });
    y += c.h;
  }
  const image = cuts.length === 1 ? cuts[0].buf : await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite(cuts.map((c, i) => ({ input: c.buf, left: 0, top: Math.round(parts[i].top * H) }))).png().toBuffer();
  return { image, parts, renders, widths };
}

/** Boxes the reader gave on a cut-out → boxes on the page they lie on (figures keep that page for their crop). */
function toPageBoxes(qs: ExtractedQuestion[], parts: ViewPart[]): void {
  for (const q of qs) {
    if (q.region) q.region = toPageBox(q.region, parts).box;
    for (const f of q.figures) {
      if (!f.box) continue;
      const m = toPageBox(f.box, parts);
      f.box = m.box;
      (f as { page?: number }).page = m.page;
    }
    if (parts.length > 1) q.pages = [...new Set(parts.map((p) => p.page))];
  }
}

async function aiPage(ctx: StepContext, file: AiImportFile, pageId: string): Promise<void> {
  const page = await prisma.aiImportPage.findUniqueOrThrow({ where: { id: pageId } });
  const total = file.pageCount ?? 1;
  const state = (page.rawOutput as PageState | null) ?? {};
  await prisma.aiImportPage.update({ where: { id: page.id }, data: { attempts: { increment: 1 } } });
  const render = await ensureRender(ctx.job, file, page.pageNumber, ctx.settings.limits.renderDpi);
  const meta = await sharp(render).metadata();
  await prisma.aiImportPage.update({ where: { id: page.id }, data: { renderKey: renderKey(ctx.job.id, file.id, page.pageNumber), renderWidth: meta.width ?? null, renderHeight: meta.height ?? null } });
  // A question-level re-scan may send only the question's band (or the band stacked with its continuation page).
  const view = state.rescan?.view ?? { kind: "PAGE" as const };
  const sent = view.kind === "PAGE" ? null : await rescanImage(ctx, file, page.pageNumber, render, view);
  const image = await visionImage(sent?.image ?? render);
  // Confirmed paper memory of this exam / paper (empty when none applies): how the paper is printed, never content.
  const memory = await jobMemoryBrief(ctx.job, "extract");
  const userText =
    extractUserText({ exam: ctx.examName, subject: ctx.subjectName, page: page.pageNumber, pages: total, textLayer: sent ? null : page.textLayer, memory }) +
    (sent ? `\n\nThis image is a CUT-OUT of ${view.kind === "STACK" ? `page ${view.pages[0]} (top part of the image) continued on page ${view.pages[1]} (lower part)` : `page ${page.pageNumber}`}, around one question. Read only what is visible; give boxes relative to THIS image.\n${RESCAN_RULES}` : "");
  const bilingual = await jobIsBilingual(ctx.job);
  const call = async (models: string[], task: "extract" | "verify", stage?: string) => {
    const { value, result: r } = await importerAiCallChecked(
      {
        jobId: ctx.job.id,
        task,
        models,
        system: bilingual ? EXTRACT_SYSTEM + BILINGUAL_RULES : EXTRACT_SYSTEM,
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: image, detail: "high" } },
        ],
        // Both language versions of every question (Devanagari costs several tokens per word). 2026-11-11: 10,000 —
        // the largest real bilingual page read (FSO, 64 pages, google/gemini-4-carbon) was 3,695 output tokens; the
        // worst case reserved before each request stays proportionate (a read that reaches the limit is "cut off", never
        // accepted).
        maxOutputTokens: bilingual ? 10000 : 8000,
        settings: ctx.settings,
        pageId: page.id,
        needsVision: true,
        jsonSchema: "extract",
        ...(stage ? { stage } : {}),
      },
      (text) => parsePage(text)
    );
    return { out: value, model: r.model, cost: r.costInr ?? 0 };
  };
  // A first read already paid for in an earlier run (the run stopped during the second read) is reused, never bought again.
  const cached = !state.rescan && state.primaryCache ? state.primaryCache : null;
  let primary = cached ? { out: cached.out, model: cached.model, cost: 0 } : await call([ctx.settings.models.extract!, ...ctx.settings.models.extractFallbacks], "extract");
  // A near-empty / incomplete reading (the model's notes instead of the page) is never accepted as processed: the page
  // is read again by the confirmed reader, then by each configured fallback (approved models only), at most
  // INCOMPLETE_READ_RETRIES more times; every attempt is a recorded, budgeted request. Still incomplete → the page
  // fails with the reasons (Review → failed pages); nothing from such a reading is saved.
  let incomplete = incompleteReading(toExtracted(primary.out, page.pageNumber, primary.model));
  const retryModels = [ctx.settings.models.extract!, ...ctx.settings.models.extractFallbacks].filter((m, i, a) => !!m && a.indexOf(m) === i);
  let reread = false;
  for (let k = 0; incomplete.length && k < INCOMPLETE_READ_RETRIES; k++) {
    const model = retryModels[Math.min(k, retryModels.length - 1)];
    await logEvent(ctx.job.id, "PAGE_READING_INCOMPLETE", `${file.originalName} page ${page.pageNumber}: the reading by ${primary.model} is incomplete (${incomplete.slice(0, 3).join("; ")}) — reading the page again with ${model} (attempt ${k + 2} of ${INCOMPLETE_READ_RETRIES + 1}).`, { pageId: page.id, model: primary.model, reasons: incomplete.slice(0, 10), attempt: k + 1 });
    primary = await call([model], "extract", "extract-retry-incomplete");
    reread = true;
    incomplete = incompleteReading(toExtracted(primary.out, page.pageNumber, primary.model));
  }
  if (incomplete.length) {
    await logEvent(ctx.job.id, "PAGE_READING_INCOMPLETE", `${file.originalName} page ${page.pageNumber}: still incomplete after ${INCOMPLETE_READ_RETRIES + 1} readings — sent to review; nothing from these readings was saved.`, { pageId: page.id, reasons: incomplete.slice(0, 10), final: true });
    throw new Error(`Incomplete reading after ${INCOMPLETE_READ_RETRIES + 1} attempts (${incomplete.slice(0, 2).join("; ")}). Nothing from it was saved — check the page and use Retry, or enter its questions by hand.`);
  }
  if ((!cached || reread) && !state.rescan) await prisma.aiImportPage.update({ where: { id: page.id }, data: { rawOutput: { ...state, primaryCache: { model: primary.model, out: primary.out, at: new Date().toISOString() } } as unknown as Prisma.InputJsonValue } });
  const read = toExtracted(primary.out, page.pageNumber, primary.model);
  if (sent) toPageBoxes(read, sent.parts);
  // Numbered instructions to candidates are never questions: kept in the page's reading, not saved, so they cannot take
  // the numbers of the real questions on the next page.
  const qs = read.filter((q) => !candidateInstruction(q));
  if (qs.length < read.length) await logEvent(ctx.job.id, "INSTRUCTIONS_SKIPPED", `${file.originalName} page ${page.pageNumber}: ${read.length - qs.length} numbered instruction(s) to candidates (${read.filter((q) => candidateInstruction(q)).map((q) => q.number ?? "?").join(", ")}) were not taken as questions — they have no option list and instruction wording. Check the page if a real question is missing.`, { pageId: page.id });
  assignSections(qs, state.startState);
  checkPageStructure(qs, page.pageNumber);

  // Layout of a text page: embedded images give exact original bytes for figures the model boxed.
  let layout: PageLayout | null = null;
  if ((file.detected as { kind?: string } | null)?.kind === "pdf") {
    try {
      layout = await pageLayout(vaultPath(file.storageKey!), page.pageNumber, workDir(ctx.job.id));
    } catch {
      layout = null;
    }
  }

  // Independent verification (Agent B): a DIFFERENT model reads the same page image without seeing the
  // first result — for scanned / low-confidence pages, or for every page when the job verifies all pages.
  let second: ExtractedQuestion[] | null = null;
  let secondModel: string | null = null;
  // Set when the second read was needed but did not run: the page is saved (its extraction is already paid
  // for), its questions are marked for correction, and a budget stop pauses the job after the page.
  let secondMissing: string | null = null;
  let budgetStop: Error | null = null;
  const verifyModel = ctx.settings.models.verify;
  const lowConfidence = page.kind === "SCANNED" || qs.some((q) => q.confidence < ctx.settings.verification.secondReadBelow);
  if (verifyModel && verifyModel !== ctx.settings.models.extract && (lowConfidence || ctx.verifyMode === "all")) {
    try {
      const v = await call([verifyModel], "verify");
      secondModel = v.model;
      second = toExtracted(v.out, page.pageNumber, v.model).filter((q) => !candidateInstruction(q));
      if (sent) toPageBoxes(second, sent.parts);
      assignSections(second, state.startState);
    } catch (e) {
      // The page's first read is already paid for: a stop that only says "send nothing more" (rate-limit
      // breaker, Paid AI switched off, job paused / cancelled) saves it first, like a budget stop; other
      // configuration stops end the page.
      if (e instanceof ImporterRateLimited || e instanceof ImporterAiSwitchedOff || e instanceof ImporterJobStopped) budgetStop = e;
      else if (e instanceof ImporterAiUnavailable) throw e;
      if (e instanceof Error && e.name === "ImporterBudgetError") budgetStop = e;
      // A failed second read never blocks the page, but its questions are not treated as checked.
      second = null;
      secondMissing = e instanceof Error ? e.message.slice(0, 200) : "request failed";
    }
  }

  // A re-scan requested by an administrator re-reads the original page; only the requested questions are saved.
  const rescan = state.rescan ?? null;
  const inScope = (key: string) => !rescan || !rescan.keys || rescan.keys.includes(key);
  const outcomes: { key: string; outcome: RescanOutcome | "not_found" }[] = [];
  // Continuation from the previous page: merge into that question.
  let order = await nextOrderIndex(file.id);
  const localOnPage = await prisma.aiImportQuestion.findMany({ where: { fileId: file.id, pages: { has: page.pageNumber } }, select: { id: true, sourceKey: true, status: true, editedData: true, data: true } });
  const aiKeys = new Set<string>();
  const pageBytes = pageFigureBytes(render, meta.width ?? 0, layout);
  // A stacked re-scan crops each figure from the ORIGINAL render of the page it lies on (full quality, never the cut-out).
  const otherBytes = new Map<number, FigureBytes>();
  for (const pt of sent?.parts ?? []) if (pt.page !== page.pageNumber) otherBytes.set(pt.page, pageFigureBytes(sent!.renders.get(pt.page)!, sent!.widths.get(pt.page)!, null));
  const figureBytes: FigureBytes = (f) => ((f as { page?: number }).page && otherBytes.has((f as { page?: number }).page!) ? otherBytes.get((f as { page?: number }).page!)!(f) : pageBytes(f));
  const pendingJoins: NonNullable<PageState["pendingJoins"]> = [];
  for (const q of qs) {
    if (q.continuedFromPreviousPage && !rescan) {
      const joined = await joinContinuation(ctx, file, page.pageNumber, q, figureBytes);
      if (joined === "joined") continue;
      if (joined === "deferred") {
        // The previous page is still being read (pages run in parallel): joined after the stage.
        pendingJoins.push({ q, savedAs: null });
        continue;
      }
      q.confidence = Math.min(q.confidence, 0.4);
      q.notes = [...(q.notes ?? []), `This text continues a question from page ${page.pageNumber - 1}, but that question could not be joined (${joined}) — check it against both pages.`];
    }
    if (!inScope(sourceKeyOf(q))) continue;
    if (second) {
      q.verification = verificationOf(q, second, secondModel ?? verifyModel ?? "second model");
      if (q.hi) q.hi.secondReadAgreement = hindiAgreement(q.hi, second.find((s) => s.number === q.number && s.section === q.section)?.hi);
      q.notes = [...(q.notes ?? []), `Independent read (${q.verification.model}): ${q.verification.detail}.`];
      if (!q.verification.agree) q.confidence = Math.min(q.confidence, 0.5);
      else q.confidence = Math.max(q.confidence, 0.9);
    } else if (secondMissing) {
      q.notes = [...(q.notes ?? []), `The independent second read did not run (${secondMissing}).`];
      q.confidence = Math.min(q.confidence, 0.5);
    }
    const existingLocal = localOnPage.find((l) => l.sourceKey === sourceKeyOf(q));
    // The page's own reading (OCR or text layer) is the evidence: AI text that drops, adds or changes medical words,
    // numbers or negations is flagged for a person (SOURCE_TEXT_MISMATCH) — never accepted silently.
    const twin = existingLocal ? (existingLocal.data as unknown as ExtractedQuestion) : null;
    const twinText = twin?.ocr?.text ?? (twin?.method === "LOCAL_PDF" ? [twin.stem, ...twin.options.map((o) => `${o.printed} ${o.text}`)].join("\n") : null);
    const pageText = page.ocrText ?? (page.kind === "TEXT_UNRELIABLE" ? page.textLayer : null);
    if (twinText || pageText) {
      const aiText = [q.stem, ...q.options.map((o) => o.text), ...(q.listI ?? []).map((x) => x.text), ...(q.listII ?? []).map((x) => x.text)].join("\n");
      const diff = sourceTextDiff(aiText, twinText ?? pageText!, !!twinText);
      const summary = sourceDiffSummary(diff);
      if (summary) {
        q.sourceCheck = { source: twin?.ocr ? "OCR" : twinText ? "TEXT_LAYER" : "OCR_PAGE", ...diff };
        q.notes = [...(q.notes ?? []), `Compared with the page's own reading: ${summary}.`];
      }
      if (twin?.ocr) q.ocr = twin.ocr;
    }
    aiKeys.add(sourceKeyOf(q));
    const outcome = await saveQuestion(ctx, file, q, existingLocal ? (await prisma.aiImportQuestion.findUnique({ where: { id: existingLocal.id }, select: { orderIndex: true } }))!.orderIndex : order++, figureBytes, page.pageNumber, rescan ? { model: primary.model, ref: rescan.requestedAt } : null);
    if (rescan) outcomes.push({ key: sourceKeyOf(q), outcome });
  }
  // Local questions on this page the AI did not return are KEPT and flagged — never silently dropped.
  for (const l of localOnPage) {
    if (aiKeys.has(l.sourceKey) || !inScope(l.sourceKey)) continue;
    if (rescan) {
      outcomes.push({ key: l.sourceKey, outcome: "not_found" });
      await recordVersion({ questionId: l.id, jobId: ctx.job.id, kind: "RESCAN", status: "NOT_FOUND", data: l.data as unknown as ExtractedQuestion, model: primary.model, note: "The re-scan did not find this question on the page; nothing was changed." });
    }
    // A re-scan only records its result (NOT_FOUND version above); it never edits the existing question.
    if (rescan || l.editedData || l.status !== AiImportQuestionStatus.EXTRACTED) continue;
    const d = l.data as unknown as ExtractedQuestion;
    if (d.method !== "LOCAL_PDF" && d.method !== "LOCAL_OCR") continue;
    d.notes = [...(d.notes ?? []), "The AI read of this page did not return this question; kept from the text layer."];
    d.confidence = Math.min(d.confidence, 0.5);
    await prisma.aiImportQuestion.update({ where: { id: l.id }, data: { data: d as unknown as Prisma.InputJsonValue, confidence: d.confidence } });
  }
  // Questions the independent read found but the primary read did not: possible missing questions (never added silently).
  const extra = second ? second.filter((s) => !qs.some((q) => q.number === s.number && q.section === s.section)).map((s) => `${s.section ? `${s.section} ` : ""}Q${s.number ?? s.label}`) : [];
  const { rescan: _done, primaryCache: _cache, pendingJoins: _joins, ...rest } = state;
  void _done;
  void _cache;
  // A re-scan does not join continuations, so joins still waiting from the first read are kept.
  if (rescan && _joins?.length) pendingJoins.push(..._joins);
  if (rescan) {
    // A re-scan never replaces the page's own reading or outcome: its reading is appended to the page's re-scan log.
    const log = Array.isArray((rest as { rescanReads?: unknown[] }).rescanReads) ? (rest as { rescanReads: unknown[] }).rescanReads : [];
    await prisma.aiImportPage.update({
      where: { id: page.id },
      data: { status: AiImportPageStatus.DONE, processedAt: new Date(), errorMessage: null, rawOutput: { ...rest, ...(pendingJoins.length ? { pendingJoins } : {}), rescanReads: [...log.slice(-9), { at: new Date().toISOString(), model: primary.model, view: rescan.view ?? { kind: "PAGE" }, keys: rescan.keys, out: primary.out }] } as unknown as Prisma.InputJsonValue },
    });
  } else
  await prisma.aiImportPage.update({
    where: { id: page.id },
    data: { status: AiImportPageStatus.DONE, model: primary.model, outcome: "AI", outcomeReason: `${qs.length} question(s) read by ${primary.model}${page.ocrText ? " (checked against the local OCR reading)" : ""}`, processedAt: new Date(), errorMessage: null, rawOutput: { ...rest, ai: primary.out, ...(pendingJoins.length ? { pendingJoins } : {}), ...(second ? { secondRead: { model: secondModel, questions: second.length }, verified: { model: secondModel ?? "", at: new Date().toISOString(), extra } } : {}) } as unknown as Prisma.InputJsonValue },
  });
  if (extra.length) await logEvent(ctx.job.id, "VERIFY_EXTRA", `${file.originalName} page ${page.pageNumber}: the independent read found ${extra.join(", ")}, which the primary read did not — check for missing questions.`, { pageId: page.id, extra });
  if (rescan) {
    const count = (o: string) => outcomes.filter((x) => x.outcome === o).length;
    await logEvent(ctx.job.id, "RESCAN_DONE", `Re-scan of ${file.originalName} page ${page.pageNumber} (${primary.model}): ${count("pending")} candidate(s) waiting for your choice, ${count("new")} new (placeholder + candidate), ${count("not_found")} not found again, ${count("stored")} already in the Question Bank.`, { pageId: page.id, outcomes, requestedById: rescan.requestedById });
  }
  // Answer-key tables printed on question-paper pages are kept for the key matcher — only from a page that holds no
  // questions (a key page). On a question page a "key" is a table or list of the questions themselves (seen 2026-10-31:
  // CMS 2024 page 6, Q25's "A: Myoglobinuria … 1, 2, 3" table became official answers for Q22–26 and displaced the real key).
  // A re-scan never writes official answers (it reads one question, often a cut-out).
  if (rescan) {
    if (budgetStop) throw budgetStop;
    return;
  }
  if (primary.out.answer_key.length && !qs.length) {
    await saveKeyEntries(ctx, file.id, file.id, page.pageNumber, primary.out.answer_key.map((e) => ({ number: Number.parseInt(String(e.number), 10), section: "", raw: e.answer })));
  } else if (primary.out.answer_key.length) {
    await logEvent(ctx.job.id, "PAGE_KEY_IGNORED", `${file.originalName} page ${page.pageNumber}: the reading returned ${primary.out.answer_key.length} answer-key entr(ies) on a page with questions — not used as official answers (kept in the page's reading for review). Upload the answer key as its own file.`, { pageId: page.id, entries: primary.out.answer_key.slice(0, 50) });
  }
  if (budgetStop) throw budgetStop;
}

/**
 * "Verify every page": pages the local reader handled exactly (text layer, no AI) get the same
 * independent read by the verification model, compared field by field with what was stored. The
 * evidence is kept on each question (data.verification); nothing is changed or added automatically.
 */
async function verifyLocalPage(ctx: StepContext, file: AiImportFile, pageId: string, model: string): Promise<void> {
  const page = await prisma.aiImportPage.findUniqueOrThrow({ where: { id: pageId } });
  const state = (page.rawOutput as PageState | null) ?? {};
  const render = await ensureRender(ctx.job, file, page.pageNumber, ctx.settings.limits.renderDpi);
  const image = await visionImage(render);
  const { value: out, result: r } = await importerAiCallChecked(
    {
      jobId: ctx.job.id,
      task: "verify",
      models: [model],
      system: EXTRACT_SYSTEM,
      content: [
        { type: "text", text: extractUserText({ exam: ctx.examName, subject: ctx.subjectName, page: page.pageNumber, pages: file.pageCount ?? 1, textLayer: page.textLayer, memory: await jobMemoryBrief(ctx.job, "extract") }) },
        { type: "image_url", image_url: { url: image, detail: "high" } },
      ],
      maxOutputTokens: 8000,
      settings: ctx.settings,
      pageId: page.id,
      needsVision: true,
    },
    (text) => parsePage(text, "the verification model's answer")
  );
  const second = toExtracted(out, page.pageNumber, r.model).filter((q) => !candidateInstruction(q));
  assignSections(second, state.startState);
  const stored = await prisma.aiImportQuestion.findMany({ where: { fileId: file.id, pages: { has: page.pageNumber } }, select: { id: true, data: true, pages: true } });
  const mine = stored.filter((q) => q.pages[0] === page.pageNumber);
  for (const q of mine) {
    const d = q.data as unknown as ExtractedQuestion;
    const v = verificationOf(d, second, r.model);
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { data: { ...d, verification: v } as unknown as Prisma.InputJsonValue } });
  }
  const extra = second.filter((s) => !mine.some((q) => {
    const d = q.data as unknown as ExtractedQuestion;
    return d.number === s.number && d.section === s.section;
  })).map((s) => `${s.section ? `${s.section} ` : ""}Q${s.number ?? s.label}`);
  await prisma.aiImportPage.update({ where: { id: page.id }, data: { rawOutput: { ...state, verified: { model: r.model, at: new Date().toISOString(), extra } } as unknown as Prisma.InputJsonValue } });
  if (extra.length) await logEvent(ctx.job.id, "VERIFY_EXTRA", `${file.originalName} page ${page.pageNumber}: the independent read found ${extra.join(", ")}, which the local reader did not — check for missing questions.`, { pageId: page.id, extra });
}

/** Independent verification of locally read pages (verifyMode "all" only). A page that fails is reported, never retried silently. */
export async function runVerifyPages(ctx: StepContext): Promise<{ verified: number; failed: number }> {
  const model = ctx.settings.models.verify;
  if (ctx.verifyMode !== "all" || !aiUsable(ctx.settings) || !model) return { verified: 0, failed: 0 };
  const pages = await prisma.aiImportPage.findMany({ where: { jobId: ctx.job.id, status: AiImportPageStatus.DONE, kind: "TEXT", model: "local" }, orderBy: [{ fileId: "asc" }, { pageNumber: "asc" }], include: { file: true } });
  let verified = 0;
  let failed = 0;
  for (const p of pages) {
    if ((p.rawOutput as PageState | null)?.verified) continue;
    if (!(await ctx.stillRunning())) break;
    try {
      await verifyLocalPage(ctx, p.file, p.id, model);
      verified++;
    } catch (e) {
      if (e instanceof Error && (e.name === "ImporterBudgetError" || e instanceof ImporterAiUnavailable)) throw e;
      failed++;
      await logEvent(ctx.job.id, "VERIFY_FAILED", `${p.file.originalName} page ${p.pageNumber}: independent verification failed (${e instanceof Error ? e.message.slice(0, 200) : "error"}). Its questions stay unverified.`, { pageId: p.id });
    }
  }
  return { verified, failed };
}

// ---- DOCX / sheets / images -----------------------------------------------------------------------

/** The questions of a Word file as the importer reads them (local, no AI) — shared by extraction and the source re-read. */
export function docxQuestions(doc: DocxContent): ExtractedQuestion[] {
  const out: ExtractedQuestion[] = [];
  for (const b of splitQuestions(doc.lines).blocks) {
    const { q, split, text } = blockToQuestion(b, 1, "DOCX");
    // Images: the token's position decides stem vs option — exact, no guessing.
    for (const m of text.matchAll(IMG_TOKEN)) {
      const at = m.index ?? 0;
      const span = split.spans.find((s) => at >= s.start && at < s.end);
      q.figures.push({ owner: span ? "OPTION" : at < split.stemEnd ? "STEM" : "UNASSIGNED", optionLabel: span?.label ?? null, mediaPart: m[1], confidence: span || at < split.stemEnd ? 0.95 : 0.4 });
    }
    if (/⟦IMG:missing⟧/.test(text)) {
      q.notes = [...(q.notes ?? []), "An image in this question is linked from outside the document or unreadable."];
      q.figures.push({ owner: "UNASSIGNED", mediaPart: "missing", confidence: 0 });
    }
    const strip = (s: string) => s.replace(/\s*⟦IMG:(?:\d+|missing)⟧\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
    q.stem = strip(q.stem);
    q.options = q.options.map((o) => ({ ...o, text: strip(o.text) }));
    if (/\$/.test(q.stem + q.options.map((o) => o.text).join(""))) q.contentFormat = "RICH_V1";
    if (q.options.some((o) => !o.text && !q.figures.some((f) => f.owner === "OPTION" && f.optionLabel === o.label))) q.confidence = Math.min(q.confidence, 0.4);
    else if (q.notes?.length === 1 && q.notes[0].startsWith("An option has no text")) {
      q.notes = [];
      q.confidence = 0.95;
    }
    if (doc.unconvertedMath) q.notes = [...(q.notes ?? []), "The document has equation parts that could not be converted exactly — check formulas."];
    // A Word file's sub/superscripts and equations were converted exactly (no PDF text layer that could have
    // flattened them): the text-layer notation warning does not apply when every equation part was converted.
    else if (q.notes?.some((n) => n.startsWith("Text layer may have lost notation"))) {
      q.notes = q.notes.filter((n) => !n.startsWith("Text layer may have lost notation"));
      if (q.options.length >= 4 && q.options.every((o) => o.text || q.figures.some((f) => f.owner === "OPTION" && f.optionLabel === o.label)) && q.notes.every((n) => n.startsWith("The printed answer"))) q.confidence = 0.95;
    }
    out.push(q);
  }
  return out;
}

/** Figure bytes of a Word file's embedded images (exact originals). */
export const docxFigureBytes = (doc: DocxContent): FigureBytes => {
  const media = new Map(doc.media.map((m) => [m.token, m]));
  return async (f) => {
    const mm = f.mediaPart ? media.get(f.mediaPart) : undefined;
    return mm ? { bytes: mm.bytes, ext: mm.ext, source: "EMBEDDED" } : null;
  };
};

async function localDocxPass(ctx: StepContext, file: AiImportFile): Promise<void> {
  const doc = await readDocx(vaultPath(file.storageKey!));
  let order = await nextOrderIndex(file.id);
  const bytes = docxFigureBytes(doc);
  for (const q of docxQuestions(doc)) await saveQuestion(ctx, file, q, order++, bytes, 1);
  await prisma.aiImportPage.upsert({
    where: { fileId_pageNumber: { fileId: file.id, pageNumber: 1 } },
    create: { jobId: ctx.job.id, fileId: file.id, pageNumber: 1, status: AiImportPageStatus.DONE, kind: "DOCUMENT", textChars: doc.lines.reduce((a, l) => a + l.text.length, 0), imageCount: doc.media.length, model: "local", processedAt: new Date() },
    update: { status: AiImportPageStatus.DONE, kind: "DOCUMENT", model: "local", processedAt: new Date() },
  });
}

async function localSheetPass(ctx: StepContext, file: AiImportFile): Promise<void> {
  const bytes = await readFile(vaultPath(file.storageKey!));
  const parsed = await parseImportFile(new File([new Uint8Array(bytes)], `${file.id}.${file.ext}`), "RICH");
  let order = await nextOrderIndex(file.id);
  for (const r of parsed.rows) {
    const number = Number.parseInt(r.questionNumber ?? "", 10);
    const options = (["A", "B", "C", "D"] as const).map((l) => ({ label: l, printed: l, text: String(r[`option${l}` as const] ?? "").trim() }));
    const answer = [...String(r.correctAnswer ?? "").toUpperCase().matchAll(/[A-D]/g)].map((m) => m[0]);
    const imagesReferenced = [r.questionImageFilename, r.optionAImageFilename, r.optionBImageFilename, r.optionCImageFilename, r.optionDImageFilename, r.image].some(Boolean);
    const q: ExtractedQuestion = {
      section: "",
      number: Number.isFinite(number) ? number : r.rowNumber - 1,
      label: Number.isFinite(number) ? String(number) : `row${r.rowNumber}`,
      pages: [1],
      type: (r.questionType && ["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING"].includes(r.questionType.toUpperCase()) ? r.questionType.toUpperCase() : r.questionType?.toUpperCase() === "MSQ" ? "MULTIPLE_CORRECT" : "SINGLE_CORRECT") as ExtractedQuestion["type"],
      stem: r.questionText.trim(),
      options,
      printedAnswer: [...new Set(answer)],
      contentFormat: (r.contentFormat ?? "").toUpperCase() === "RICH_V1" ? "RICH_V1" : "PLAIN",
      confidence: options.every((o) => o.text) && r.questionText.trim() ? 0.98 : 0.4,
      unreadable: [],
      figures: imagesReferenced ? [{ owner: "UNASSIGNED", mediaPart: "missing", confidence: 0, description: "The spreadsheet references image files; upload the paper as PDF/DOCX or use Bulk Import with its image ZIP." }] : [],
      method: "SHEET",
      hints: { subject: r.subject || null, topic: r.topic || null, difficulty: r.difficulty || null, explanation: r.explanation || null },
      notes: [],
    };
    await saveQuestion(ctx, file, q, order++, async () => null, 1);
  }
  await prisma.aiImportPage.upsert({
    where: { fileId_pageNumber: { fileId: file.id, pageNumber: 1 } },
    create: { jobId: ctx.job.id, fileId: file.id, pageNumber: 1, status: AiImportPageStatus.DONE, kind: "DOCUMENT", model: "local", processedAt: new Date() },
    update: { status: AiImportPageStatus.DONE, kind: "DOCUMENT", model: "local", processedAt: new Date() },
  });
}

async function imagePass(ctx: StepContext, file: AiImportFile): Promise<void> {
  const existing = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: 1 } } });
  if (existing?.status === AiImportPageStatus.DONE) return;
  // A photographed / scanned page: local OCR first (free); the vision model only when OCR cannot resolve the page.
  if (ocrAvailable() && !existing?.outcome) {
    try {
      const raw = await ocrImageFile(vaultPath(file.storageKey!));
      const state: NumberingState = { last: 0, sectionIdx: 1 };
      const result = readOcrPage(raw, 1, state);
      const qs = result.extraction?.questions ?? [];
      let order = await nextOrderIndex(file.id);
      for (const q of qs) await saveQuestion(ctx, file, q, order++, async () => null, 1);
      const explained = result.outcome === "BLANK_VERIFIED" || result.outcome === "INSTRUCTIONS" || (result.outcome === "OCR" && !!result.extraction?.reliable);
      const status = explained || !aiUsable(ctx.settings) ? AiImportPageStatus.DONE : AiImportPageStatus.PENDING;
      const fields = { status, kind: "SCANNED", imageCount: 1, textLayer: result.layout.text.slice(0, 20_000), ocrText: result.layout.text.slice(0, 50_000), ocrLines: raw.lines as unknown as Prisma.InputJsonValue, ocrEngine: raw.engine, ocrConfidence: result.layout.meanConfidence, ocrLowLines: result.layout.lowLines, inkCoverage: raw.ink, outcome: result.outcome, outcomeReason: result.reason, model: status === AiImportPageStatus.DONE ? raw.engine : null, processedAt: status === AiImportPageStatus.DONE ? new Date() : null, rawOutput: { startState: { last: 0, sectionIdx: 1 }, endState: state, ocr: { skew: result.layout.skew, gutter: result.layout.gutter, furniture: result.layout.furniture.slice(0, 40) } } as unknown as Prisma.InputJsonValue };
      await prisma.aiImportPage.upsert({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: 1 } }, create: { ...fields, jobId: ctx.job.id, fileId: file.id, pageNumber: 1 }, update: fields });
      return;
    } catch (e) {
      await logEvent(ctx.job.id, "OCR_FAILED", `${file.originalName}: local OCR failed (${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}) — the page is left for the vision model or review.`, { fileId: file.id });
    }
  }
  await prisma.aiImportPage.upsert({
    where: { fileId_pageNumber: { fileId: file.id, pageNumber: 1 } },
    create: { jobId: ctx.job.id, fileId: file.id, pageNumber: 1, status: AiImportPageStatus.PENDING, kind: "SCANNED", imageCount: 1, rawOutput: { startState: { last: 0, sectionIdx: 1 } } },
    update: {},
  });
}

// ---- Answer-key entries (shared with lib/ai-import/keys.ts) ------------------------------------------

export async function saveKeyEntries(ctx: { job: { id: string } }, keyFileId: string, paperFileId: string | null, page: number | null, entries: { number: number; section: string; raw: string; page?: number | null }[]): Promise<void> {
  const valid = entries.filter((e) => Number.isFinite(e.number) && e.number > 0 && e.number < 1000);
  if (!valid.length) return;
  await prisma.aiImportKeyEntry.createMany({
    data: valid.map((e) => ({ jobId: ctx.job.id, keyFileId, paperFileId, sourceNumber: e.number, section: e.section, rawValue: e.raw.slice(0, 40), labels: [], page: e.page ?? page })),
  });
}

// ---- Stage driver --------------------------------------------------------------------------------

/** Local pass over every not-yet-processed question paper. */
export async function runLocalPasses(ctx: StepContext): Promise<void> {
  const files = await prisma.aiImportFile.findMany({ where: { jobId: ctx.job.id, role: AiImportFileRole.PAPER, status: AiImportFileStatus.ANALYZED }, orderBy: { createdAt: "asc" } });
  for (const file of files) {
    if (!(await ctx.stillRunning())) return;
    const kind = (file.detected as { kind?: string } | null)?.kind;
    if (kind === "pdf") await localPdfPass(ctx, file);
    else if (kind === "docx") await localDocxPass(ctx, file);
    else if (kind === "xlsx" || kind === "csv") await localSheetPass(ctx, file);
    else await imagePass(ctx, file);
    if (!(await ctx.stillRunning())) return;
    await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.PROCESSED } });
    await logEvent(ctx.job.id, "LOCAL_PASS_DONE", `${file.originalName}: local reading finished`, { fileId: file.id });
  }
}

/** Vision extraction of pending pages, a bounded number at a time. Returns the pages it could not do without AI. */
/**
 * After every page of a paper was read successfully: a page that gave NO question although numbers are missing exactly
 * around it (lib/ai-import/reading-checks.ts gapPages — the 2026-11-11 FSO page 2 case) is read once more by the
 * confirmed reader, as a normal first reading (continuations join as usual); still nothing → the page goes to review
 * (status FAILED naming the numbers). Deliberately narrow: pages that gave some questions keep the existing
 * missing-number reporting, a file with a failed or unread page is left alone (its numbers are explained by that page),
 * and papers whose numbering repeats (sections numbered from 1 again) are skipped.
 */
async function rereadGapPages(ctx: StepContext): Promise<void> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: ctx.job.id }, select: { expectedQuestions: true } });
  const files = await prisma.aiImportFile.findMany({ where: { jobId: ctx.job.id, role: AiImportFileRole.PAPER } });
  for (const file of files) {
    if (!file.pageCount) continue;
    const gapsNow = async () => {
      const qs = await prisma.aiImportQuestion.findMany({ where: { fileId: file.id }, select: { data: true, editedData: true, pages: true } });
      const found = qs.map((q) => ({ number: ((q.editedData ?? q.data) as unknown as ExtractedQuestion).number, pages: q.pages })).filter((f): f is { number: number; pages: number[] } => typeof f.number === "number" && f.pages.length > 0);
      if (new Set(found.map((f) => f.number)).size !== found.length) return new Map<number, number[]>();
      return gapPages(found, files.length === 1 ? (job?.expectedQuestions ?? null) : null, file.pageCount!);
    };
    const gaps = await gapsNow();
    if (!gaps.size) continue;
    if (await prisma.aiImportPage.count({ where: { fileId: file.id, status: { not: AiImportPageStatus.DONE } } })) continue;
    const withQuestions = new Set((await prisma.aiImportQuestion.findMany({ where: { fileId: file.id }, select: { pages: true } })).flatMap((q) => q.pages));
    const pages = await prisma.aiImportPage.findMany({ where: { fileId: file.id, pageNumber: { in: [...gaps.keys()].filter((n) => !withQuestions.has(n)) }, status: AiImportPageStatus.DONE } });
    for (const p of pages) {
      const st = (p.rawOutput as PageState | null) ?? {};
      if (st.gapRetried || p.kind === "BLANK" || p.kind === "DOCUMENT") continue;
      if (!(await ctx.stillRunning())) return;
      const missing = gaps.get(p.pageNumber)!;
      await logEvent(ctx.job.id, "PAGE_NUMBERS_MISSING", `${file.originalName} page ${p.pageNumber}: question number(s) ${missing.join(", ")} should be on this page but were not read — reading the page once more.`, { pageId: p.id, missing });
      const { primaryCache: _cached, ...fresh } = st;
      await prisma.aiImportPage.update({ where: { id: p.id }, data: { status: AiImportPageStatus.PENDING, rawOutput: { ...fresh, gapRetried: true } as unknown as Prisma.InputJsonValue } });
      try {
        await aiPage(ctx, file, p.id);
      } catch (e) {
        if (e instanceof Error && (e.name === "ImporterBudgetError" || e instanceof ImporterAiUnavailable)) throw e;
        await prisma.aiImportPage.update({ where: { id: p.id }, data: { status: AiImportPageStatus.FAILED, errorMessage: e instanceof Error ? e.message.slice(0, 300) : "extraction failed" } });
        await logEvent(ctx.job.id, "PAGE_FAILED", `${file.originalName} page ${p.pageNumber}: ${e instanceof Error ? e.message.slice(0, 200) : "failed"}`, { pageId: p.id });
      }
    }
    const still = await gapsNow();
    const nowWith = new Set((await prisma.aiImportQuestion.findMany({ where: { fileId: file.id }, select: { pages: true } })).flatMap((q) => q.pages));
    for (const p of await prisma.aiImportPage.findMany({ where: { fileId: file.id, pageNumber: { in: [...still.keys()].filter((n) => !nowWith.has(n)) }, status: AiImportPageStatus.DONE } })) {
      if (!((p.rawOutput as PageState | null)?.gapRetried)) continue;
      const missing = still.get(p.pageNumber)!;
      await prisma.aiImportPage.update({ where: { id: p.id }, data: { status: AiImportPageStatus.FAILED, errorMessage: `Question number(s) ${missing.join(", ")} were not found on this page after it was read twice — check the page (Retry, or enter them by hand).`.slice(0, 300) } });
      await logEvent(ctx.job.id, "PAGE_NUMBERS_MISSING", `${file.originalName} page ${p.pageNumber}: number(s) ${missing.join(", ")} still missing after a second reading — sent to review.`, { pageId: p.id, missing, final: true });
    }
  }
}

/** Extra readings of a page whose reading was incomplete (lib/ai-import/reading-checks.ts), and of a page missing numbers. */
export const INCOMPLETE_READ_RETRIES = 1;

export async function runAiPages(ctx: StepContext): Promise<{ skippedNoAi: number }> {
  const pending = await prisma.aiImportPage.findMany({ where: { jobId: ctx.job.id, status: AiImportPageStatus.PENDING }, orderBy: [{ fileId: "asc" }, { pageNumber: "asc" }], include: { file: true } });
  if (!pending.length) return { skippedNoAi: 0 };
  if (!aiUsable(ctx.settings)) {
    for (const p of pending) {
      await prisma.aiImportPage.update({ where: { id: p.id }, data: { status: AiImportPageStatus.SKIPPED, errorMessage: ctx.settings.aiBlockedReason ? `${p.kind === "SCANNED" ? "Scanned page: needs AI vision" : "Needs AI to confirm the layout"}, which the importer budget blocks now: ${ctx.settings.aiBlockedReason}`.slice(0, 500) : p.kind === "SCANNED" ? "Scanned page: needs AI vision, which is switched off in Import Settings." : "Needs AI to confirm the layout (switched off); the locally read questions are flagged." } });
    }
    return { skippedNoAi: pending.length };
  }
  const queue = [...pending];
  // A budget or configuration stop ends the whole stage, but only after every
  // in-flight request has settled (no request is abandoned mid-way).
  let stop: Error | null = null;
  const workers = Array.from({ length: Math.min(ctx.settings.limits.concurrency, queue.length) }, async () => {
    while (queue.length && !stop) {
      if (!(await ctx.stillRunning())) return;
      const p = queue.shift()!;
      try {
        await aiPage(ctx, p.file, p.id);
      } catch (e) {
        if (e instanceof Error && (e.name === "ImporterBudgetError" || e instanceof ImporterAiUnavailable)) {
          stop ??= e;
          return;
        }
        await prisma.aiImportPage.update({ where: { id: p.id }, data: { status: AiImportPageStatus.FAILED, errorMessage: e instanceof Error ? e.message.slice(0, 300) : "extraction failed" } });
        await logEvent(ctx.job.id, "PAGE_FAILED", `${p.file.originalName} page ${p.pageNumber}: ${e instanceof Error ? e.message.slice(0, 200) : "failed"}`, { pageId: p.id });
      }
    }
  });
  await Promise.all(workers);
  // Continuations read before their previous page finished are joined now that every page has settled.
  await joinPendingContinuations(ctx);
  if (stop) throw stop;
  await rereadGapPages(ctx);
  return { skippedNoAi: 0 };
}
