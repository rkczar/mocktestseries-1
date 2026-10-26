import "server-only";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { AiImportFileRole, AiImportFileStatus, AiImportPageStatus, AiImportQuestionStatus, type AiImportFile, type AiImportJob, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseImportFile } from "@/lib/bulk-import";
import { pageLayout, renderPage, type PageLayout } from "@/lib/ai-import/pdf";
import { readDocx, IMG_TOKEN } from "@/lib/ai-import/docx";
import { parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import { blockToQuestion, splitQuestions, type NumberingState } from "@/lib/ai-import/local-parse";
import { cropFromRender, cropFromScan, iou, storeOriginalFigure, visionImage, FigureError, MIN_CROP_SIDE } from "@/lib/ai-import/figures";
import { checkFigureMapping, overlappingRegions } from "@/lib/ai-import/figure-map";
import { formulaDiff } from "@/lib/ai-import/fidelity";
import { importerAiCallChecked, parseModelJson, ImporterAiFailure, ImporterAiSwitchedOff, ImporterAiUnavailable, ImporterJobStopped, ImporterRateLimited } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { EXTRACT_SYSTEM, extractUserText, pageSchema, toExtracted, type PageOutput } from "@/lib/ai-import/prompts";
import { readVault, renderKey, putIntermediate, vaultPath, workDir, exists as vaultExists } from "@/lib/ai-import/vault";
import { logEvent } from "@/lib/ai-import/jobs";
import { sourceKeyOf, type ExtractedQuestion } from "@/lib/ai-import/types";
import type { ImporterSettings, VerifyMode } from "@/lib/ai-import/config";
import { figureRows, manuallyCorrected, recordVersion, snapshotFigures, type FigureSnapshot } from "@/lib/ai-import/versions";
import { mkdir } from "node:fs/promises";

/**
 * Extraction stage of the worker. Question papers are read LOCALLY first
 * (text layer + embedded images, DOCX, spreadsheets — free and exact); only
 * pages the local parser cannot read reliably (scanned pages, flattened
 * formulas, unclear figure positions) are sent to the vision model, and a
 * DIFFERENT model re-reads low-confidence pages. Every page is a checkpoint:
 * an interrupted job resumes at the first page that is not DONE.
 */

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

/** A re-scan requested by an administrator: only these question keys (null = the whole page) are re-read. */
export interface RescanRequest {
  keys: string[] | null;
  requestedById: string;
  requestedAt: string;
}

type PageState = {
  startState?: NumberingState;
  local?: { reliable: boolean; reasons: string[] };
  ai?: unknown;
  secondRead?: unknown;
  rescan?: RescanRequest;
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
type FigureBytes = (f: ExtractedQuestion["figures"][number]) => Promise<{ bytes: Buffer; ext: string; source: string; crop?: CropProvenance } | null>;

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
      pageNumber,
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
async function saveQuestion(ctx: StepContext, file: AiImportFile, q: ExtractedQuestion, orderIndex: number, figureBytes: FigureBytes, pageNumber: number, rescan?: { model: string | null } | null): Promise<RescanOutcome> {
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
  if (existing && manual && rescan) {
    const figs = await storeFigures(q, figureBytes, pageNumber);
    await prisma.aiImportQuestionVersion.updateMany({ where: { questionId: existing.id, kind: "RESCAN", status: "PENDING" }, data: { status: "DISCARDED", decidedAt: new Date(), note: "Replaced by a newer re-scan." } });
    await recordVersion({ questionId: existing.id, jobId: ctx.job.id, kind: "RESCAN", status: "PENDING", data: q, figures: figs, model: rescan.model, note: "This question was corrected by an administrator, so the re-scan did not replace it. Compare and choose what to keep." });
    await prisma.aiImportQuestion.update({ where: { id: existing.id }, data: { status: AiImportQuestionStatus.EXTRACTED } });
    return "pending";
  }
  if (existing && rescan) {
    await recordVersion({ questionId: existing.id, jobId: ctx.job.id, kind: "EXTRACTION", data: existing.data as unknown as ExtractedQuestion, figures: snapshotFigures(existing.figures), model: (existing.data as { model?: string | null }).model ?? null, note: "Extraction before the re-scan replaced it." });
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
  if (rescan) await recordVersion({ questionId: row.id, jobId: ctx.job.id, kind: "RESCAN", status: existing ? "AUTO_APPLIED" : "APPLIED", data: q, figures: figs, model: rescan.model, note: existing ? "Applied automatically (the question had no manual corrections; the previous extraction is kept in its history)." : "Found by the re-scan (it was not in the earlier extraction)." });
  return existing ? "applied" : "new";
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
  for (let p = 1; p <= pages; p++) {
    const done = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } } });
    if (done?.status === AiImportPageStatus.DONE && done.kind) {
      // Resume: replay the numbering state recorded for this page.
      const st = (done.rawOutput as PageState | null)?.startState;
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
      await prisma.aiImportPage.upsert({
        where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } },
        create: { jobId: ctx.job.id, fileId: file.id, pageNumber: p, status: AiImportPageStatus.FAILED, kind, errorMessage: e instanceof Error ? e.message.slice(0, 300) : "layout failed", rawOutput: { startState } },
        update: { status: AiImportPageStatus.FAILED, errorMessage: e instanceof Error ? e.message.slice(0, 300) : "layout failed" },
      });
      continue;
    }
    const textChars = layout.lines.reduce((a, l) => a + l.text.replace(/\s+/g, "").length, 0);
    const scanned = textChars < 80;
    const textLayer = layout.lines.map((l) => l.text).join("\n").slice(0, 20_000);
    if (scanned) {
      // No usable text layer → vision.
      await prisma.aiImportPage.upsert({
        where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } },
        create: { jobId: ctx.job.id, fileId: file.id, pageNumber: p, status: AiImportPageStatus.PENDING, kind: layout.images.length || textChars ? "SCANNED" : "BLANK", textChars, imageCount: layout.images.length, rawOutput: { startState } },
        update: { status: AiImportPageStatus.PENDING, kind: layout.images.length || textChars ? "SCANNED" : "BLANK", textChars, imageCount: layout.images.length, rawOutput: { startState } },
      });
      if (!layout.images.length && !textChars) await prisma.aiImportPage.update({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } }, data: { status: AiImportPageStatus.DONE } });
      continue;
    }
    const local = parsePdfPageLocal({ lines: layout.lines, images: layout.images }, p, state);
    // Text before the first question on this page continues the previous page's last question.
    if (local.preamble && previous && previous.options.length < 4) {
      const merged = blockToQuestion({ section: previous.section, number: previous.number ?? 0, label: previous.label, lines: [], text: `${previous.stem}\n${previous.options.map((o) => `${o.printed} ${o.text}`).join("  ")}\n${local.preamble}` }, previous.pages[0], "LOCAL_PDF");
      merged.q.pages = [...new Set([...previous.pages, p])];
      merged.q.figures = previous.figures;
      merged.q.notes = [...(merged.q.notes ?? []), "Continues from the previous page."];
      const prevFile = file;
      await saveQuestion(ctx, prevFile, merged.q, (await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: file.id, sourceKey: sourceKeyOf(previous) } }, select: { orderIndex: true } }))?.orderIndex ?? order++, async () => null, previous.pages[0]);
    }
    const needsAi = !local.reliable;
    for (const q of local.questions) {
      await saveQuestion(ctx, file, q, order++, async (f) => (f.embeddedIndex !== null && f.embeddedIndex !== undefined && layout!.images[f.embeddedIndex] ? { bytes: layout!.images[f.embeddedIndex].bytes, ext: layout!.images[f.embeddedIndex].ext, source: "EMBEDDED" } : null), p);
    }
    if (local.questions.length) previous = local.questions[local.questions.length - 1];
    const status = needsAi && aiUsable(ctx.settings) ? AiImportPageStatus.PENDING : AiImportPageStatus.DONE;
    await prisma.aiImportPage.upsert({
      where: { fileId_pageNumber: { fileId: file.id, pageNumber: p } },
      create: { jobId: ctx.job.id, fileId: file.id, pageNumber: p, status, kind: needsAi ? "TEXT_UNRELIABLE" : "TEXT", textChars, textLayer, imageCount: layout.images.length, rawOutput: { startState, local: { reliable: local.reliable, reasons: local.reasons } } as Prisma.InputJsonValue, processedAt: status === AiImportPageStatus.DONE ? new Date() : null, model: status === AiImportPageStatus.DONE ? "local" : null },
      update: { status, kind: needsAi ? "TEXT_UNRELIABLE" : "TEXT", textChars, textLayer, imageCount: layout.images.length, rawOutput: { startState, local: { reliable: local.reliable, reasons: local.reasons } } as Prisma.InputJsonValue, processedAt: status === AiImportPageStatus.DONE ? new Date() : null, model: status === AiImportPageStatus.DONE ? "local" : null },
    });
  }
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

async function aiPage(ctx: StepContext, file: AiImportFile, pageId: string): Promise<void> {
  const page = await prisma.aiImportPage.findUniqueOrThrow({ where: { id: pageId } });
  const total = file.pageCount ?? 1;
  const state = (page.rawOutput as PageState | null) ?? {};
  await prisma.aiImportPage.update({ where: { id: page.id }, data: { attempts: { increment: 1 } } });
  const render = await ensureRender(ctx.job, file, page.pageNumber, ctx.settings.limits.renderDpi);
  const meta = await sharp(render).metadata();
  await prisma.aiImportPage.update({ where: { id: page.id }, data: { renderKey: renderKey(ctx.job.id, file.id, page.pageNumber), renderWidth: meta.width ?? null, renderHeight: meta.height ?? null } });
  const image = await visionImage(render);
  const userText = extractUserText({ exam: ctx.examName, subject: ctx.subjectName, page: page.pageNumber, pages: total, textLayer: page.textLayer });
  const call = async (models: string[], task: "extract" | "verify") => {
    const { value, result: r } = await importerAiCallChecked(
      {
        jobId: ctx.job.id,
        task,
        models,
        system: EXTRACT_SYSTEM,
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: image, detail: "high" } },
        ],
        maxOutputTokens: 8000,
        settings: ctx.settings,
        pageId: page.id,
        needsVision: true,
        jsonSchema: "extract",
      },
      (text) => parsePage(text)
    );
    return { out: value, model: r.model, cost: r.costInr ?? 0 };
  };
  // A first read already paid for in an earlier run (the run stopped during the second read) is reused, never bought again.
  const cached = !state.rescan && state.primaryCache ? state.primaryCache : null;
  const primary = cached ? { out: cached.out, model: cached.model, cost: 0 } : await call([ctx.settings.models.extract!, ...ctx.settings.models.extractFallbacks], "extract");
  if (!cached) await prisma.aiImportPage.update({ where: { id: page.id }, data: { rawOutput: { ...state, primaryCache: { model: primary.model, out: primary.out, at: new Date().toISOString() } } as unknown as Prisma.InputJsonValue } });
  const qs = toExtracted(primary.out, page.pageNumber, primary.model);
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
      second = toExtracted(v.out, page.pageNumber, v.model);
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
  const figureBytes = pageFigureBytes(render, meta.width ?? 0, layout);
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
      q.notes = [...(q.notes ?? []), `Independent read (${q.verification.model}): ${q.verification.detail}.`];
      if (!q.verification.agree) q.confidence = Math.min(q.confidence, 0.5);
      else q.confidence = Math.max(q.confidence, 0.9);
    } else if (secondMissing) {
      q.notes = [...(q.notes ?? []), `The independent second read did not run (${secondMissing}).`];
      q.confidence = Math.min(q.confidence, 0.5);
    }
    const existingLocal = localOnPage.find((l) => l.sourceKey === sourceKeyOf(q));
    aiKeys.add(sourceKeyOf(q));
    const outcome = await saveQuestion(ctx, file, q, existingLocal ? (await prisma.aiImportQuestion.findUnique({ where: { id: existingLocal.id }, select: { orderIndex: true } }))!.orderIndex : order++, figureBytes, page.pageNumber, rescan ? { model: primary.model } : null);
    if (rescan) outcomes.push({ key: sourceKeyOf(q), outcome });
  }
  // Local questions on this page the AI did not return are KEPT and flagged — never silently dropped.
  for (const l of localOnPage) {
    if (aiKeys.has(l.sourceKey) || !inScope(l.sourceKey)) continue;
    if (rescan) {
      outcomes.push({ key: l.sourceKey, outcome: "not_found" });
      await recordVersion({ questionId: l.id, jobId: ctx.job.id, kind: "RESCAN", status: "NOT_FOUND", data: l.data as unknown as ExtractedQuestion, model: primary.model, note: "The re-scan did not find this question on the page; nothing was changed." });
    }
    if (l.editedData || l.status !== AiImportQuestionStatus.EXTRACTED) continue;
    const d = l.data as unknown as ExtractedQuestion;
    if (d.method !== "LOCAL_PDF" && !rescan) continue;
    d.notes = [...(d.notes ?? []), rescan ? "The re-scan of this page did not find this question; it is kept as it was." : "The AI read of this page did not return this question; kept from the text layer."];
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
  await prisma.aiImportPage.update({
    where: { id: page.id },
    data: { status: AiImportPageStatus.DONE, model: primary.model, processedAt: new Date(), errorMessage: null, rawOutput: { ...rest, ai: primary.out, ...(pendingJoins.length ? { pendingJoins } : {}), ...(second ? { secondRead: { model: secondModel, questions: second.length }, verified: { model: secondModel ?? "", at: new Date().toISOString(), extra } } : {}) } as unknown as Prisma.InputJsonValue },
  });
  if (extra.length) await logEvent(ctx.job.id, "VERIFY_EXTRA", `${file.originalName} page ${page.pageNumber}: the independent read found ${extra.join(", ")}, which the primary read did not — check for missing questions.`, { pageId: page.id, extra });
  if (rescan) {
    const count = (o: string) => outcomes.filter((x) => x.outcome === o).length;
    await logEvent(ctx.job.id, "RESCAN_DONE", `Re-scan of ${file.originalName} page ${page.pageNumber} (${primary.model}): ${count("applied")} replaced (previous extraction kept), ${count("pending")} waiting for your choice (manually corrected), ${count("new")} new, ${count("not_found")} not found again, ${count("stored")} already in the Question Bank.`, { pageId: page.id, outcomes, requestedById: rescan.requestedById });
  }
  // Answer-key tables printed on question-paper pages are kept for the key matcher.
  if (primary.out.answer_key.length) {
    await saveKeyEntries(ctx, file.id, file.id, page.pageNumber, primary.out.answer_key.map((e) => ({ number: Number.parseInt(String(e.number), 10), section: "", raw: e.answer })));
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
        { type: "text", text: extractUserText({ exam: ctx.examName, subject: ctx.subjectName, page: page.pageNumber, pages: file.pageCount ?? 1, textLayer: page.textLayer }) },
        { type: "image_url", image_url: { url: image, detail: "high" } },
      ],
      maxOutputTokens: 8000,
      settings: ctx.settings,
      pageId: page.id,
      needsVision: true,
    },
    (text) => parsePage(text, "the verification model's answer")
  );
  const second = toExtracted(out, page.pageNumber, r.model);
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

async function localDocxPass(ctx: StepContext, file: AiImportFile): Promise<void> {
  const doc = await readDocx(vaultPath(file.storageKey!));
  const { blocks } = splitQuestions(doc.lines);
  const media = new Map(doc.media.map((m) => [m.token, m]));
  let order = await nextOrderIndex(file.id);
  for (const b of blocks) {
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
    await saveQuestion(ctx, file, q, order++, async (f) => {
      const mm = f.mediaPart ? media.get(f.mediaPart) : undefined;
      return mm ? { bytes: mm.bytes, ext: mm.ext, source: "EMBEDDED" } : null;
    }, 1);
  }
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
export async function runAiPages(ctx: StepContext): Promise<{ skippedNoAi: number }> {
  const pending = await prisma.aiImportPage.findMany({ where: { jobId: ctx.job.id, status: AiImportPageStatus.PENDING }, orderBy: [{ fileId: "asc" }, { pageNumber: "asc" }], include: { file: true } });
  if (!pending.length) return { skippedNoAi: 0 };
  if (!aiUsable(ctx.settings)) {
    for (const p of pending) {
      await prisma.aiImportPage.update({ where: { id: p.id }, data: { status: AiImportPageStatus.SKIPPED, errorMessage: p.kind === "SCANNED" ? "Scanned page: needs AI vision, which is switched off in Import Settings." : "Needs AI to confirm the layout (switched off); the locally read questions are flagged." } });
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
  return { skippedNoAi: 0 };
}
