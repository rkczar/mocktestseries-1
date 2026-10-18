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
import { cropFromRender, iou, storeOriginalFigure, visionImage, FigureError } from "@/lib/ai-import/figures";
import { importerAiCall, parseModelJson, ImporterAiUnavailable } from "@/lib/ai-import/ai";
import { EXTRACT_SYSTEM, extractUserText, pageSchema, toExtracted } from "@/lib/ai-import/prompts";
import { readVault, renderKey, putIntermediate, vaultPath, workDir, exists as vaultExists } from "@/lib/ai-import/vault";
import { logEvent } from "@/lib/ai-import/jobs";
import { sourceKeyOf, type ExtractedQuestion } from "@/lib/ai-import/types";
import type { ImporterSettings } from "@/lib/ai-import/config";
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
}

type PageState = { startState?: NumberingState; local?: { reliable: boolean; reasons: string[] }; ai?: unknown; secondRead?: unknown };

export function aiUsable(s: ImporterSettings): boolean {
  return s.aiEnabled && !!s.models.extract;
}

// ---- Persisting questions + figures -----------------------------------------------------------------

async function saveQuestion(ctx: StepContext, file: AiImportFile, q: ExtractedQuestion, orderIndex: number, figureBytes: (f: ExtractedQuestion["figures"][number]) => Promise<{ bytes: Buffer; ext: string; source: string } | null>, pageNumber: number): Promise<void> {
  const key = sourceKeyOf(q);
  const existing = await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: file.id, sourceKey: key } }, select: { id: true, status: true, editedData: true } });
  // Never overwrite a question that was already imported or that an admin edited.
  if (existing && (existing.status === AiImportQuestionStatus.IMPORTED || existing.status === AiImportQuestionStatus.PUBLISHED || existing.editedData)) return;
  const data = {
    jobId: ctx.job.id,
    fileId: file.id,
    sourceKey: key,
    sourceNumber: q.number,
    sourceLabel: q.label,
    pages: q.pages,
    orderIndex,
    status: AiImportQuestionStatus.EXTRACTED,
    data: q as unknown as Prisma.InputJsonValue,
    questionType: q.type,
    optionCount: q.options.length,
    contentFormat: q.contentFormat,
    confidence: q.confidence,
    sourceAnswer: q.printedAnswer,
  };
  const row = existing
    ? await prisma.aiImportQuestion.update({ where: { id: existing.id }, data })
    : await prisma.aiImportQuestion.create({ data });
  await prisma.aiImportFigure.deleteMany({ where: { questionId: row.id } });
  for (const f of q.figures) {
    let stored: Awaited<ReturnType<typeof storeOriginalFigure>> | null = null;
    let source = "CROP";
    let mapping = f.confidence >= 0.8 ? "OK" : "UNCERTAIN";
    let note = f.description ?? null;
    try {
      const got = await figureBytes(f);
      if (got) {
        stored = await storeOriginalFigure(got.bytes, got.ext);
        source = got.source;
      }
    } catch (e) {
      note = e instanceof FigureError ? e.message : "The figure could not be read.";
    }
    if (!stored) {
      mapping = "MISSING";
    }
    await prisma.aiImportFigure.create({
      data: {
        jobId: ctx.job.id,
        fileId: file.id,
        pageNumber,
        questionId: row.id,
        owner: f.owner,
        optionLabel: f.owner === "OPTION" ? (f.optionLabel ?? null) : null,
        sharedGroup: f.sharedGroup ?? null,
        box: (f.box ?? undefined) as Prisma.InputJsonValue | undefined,
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
      },
    });
  }
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
function assignSections(qs: ExtractedQuestion[], start: NumberingState | undefined): void {
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

/** Compares two independent reads of the same question (deterministic). */
export function readsAgree(a: ExtractedQuestion, b: ExtractedQuestion): { agree: boolean; detail: string } {
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
  const s = sim(a.stem, b.stem);
  if (s < 0.9) diffs.push(`question text differs (${Math.round(s * 100)}% similar)`);
  if (a.options.length !== b.options.length) diffs.push(`option count ${a.options.length} vs ${b.options.length}`);
  else a.options.forEach((o, i) => sim(o.text, b.options[i].text) < 0.85 && diffs.push(`option ${o.label} differs`));
  return { agree: diffs.length === 0, detail: diffs.join("; ") || "both reads match" };
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
    const r = await importerAiCall({
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
    });
    const parsed = pageSchema.safeParse(parseModelJson(r.text));
    if (!parsed.success) throw new Error(`The model's answer did not match the expected format (${parsed.error.issues[0]?.path.join(/* turbopackIgnore: true */ ".") ?? "?"}).`);
    return { out: parsed.data, model: r.model, cost: r.costInr ?? 0 };
  };
  const primary = await call([ctx.settings.models.extract!, ...ctx.settings.models.extractFallbacks], "extract");
  const qs = toExtracted(primary.out, page.pageNumber, primary.model);
  assignSections(qs, state.startState);

  // Layout of a text page: embedded images give exact original bytes for figures the model boxed.
  let layout: PageLayout | null = null;
  if ((file.detected as { kind?: string } | null)?.kind === "pdf") {
    try {
      layout = await pageLayout(vaultPath(file.storageKey!), page.pageNumber, workDir(ctx.job.id));
    } catch {
      layout = null;
    }
  }

  // Second read by a DIFFERENT model for scanned / low-confidence pages.
  let second: ExtractedQuestion[] | null = null;
  // Set when the second read was needed but did not run: the page is saved (its extraction is already paid
  // for), its questions are marked for correction, and a budget stop pauses the job after the page.
  let secondMissing: string | null = null;
  let budgetStop: Error | null = null;
  const verifyModel = ctx.settings.models.verify;
  const lowConfidence = page.kind === "SCANNED" || qs.some((q) => q.confidence < ctx.settings.verification.secondReadBelow);
  if (verifyModel && verifyModel !== ctx.settings.models.extract && lowConfidence) {
    try {
      const v = await call([verifyModel], "verify");
      second = toExtracted(v.out, page.pageNumber, v.model);
      assignSections(second, state.startState);
    } catch (e) {
      if (e instanceof ImporterAiUnavailable) throw e;
      if (e instanceof Error && e.name === "ImporterBudgetError") budgetStop = e;
      // A failed second read never blocks the page, but its questions are not treated as checked.
      second = null;
      secondMissing = e instanceof Error ? e.message.slice(0, 200) : "request failed";
    }
  }

  // Continuation from the previous page: merge into that question.
  let order = await nextOrderIndex(file.id);
  const localOnPage = await prisma.aiImportQuestion.findMany({ where: { fileId: file.id, pages: { has: page.pageNumber } }, select: { id: true, sourceKey: true, status: true, editedData: true, data: true } });
  const aiKeys = new Set<string>();
  for (const q of qs) {
    if (q.continuedFromPreviousPage) {
      const prev = await prisma.aiImportQuestion.findFirst({ where: { fileId: file.id, ...(q.number !== null ? { sourceNumber: q.number } : {}), pages: { has: page.pageNumber - 1 } }, orderBy: { orderIndex: "desc" } });
      if (prev && !prev.editedData && prev.status === AiImportQuestionStatus.EXTRACTED) {
        const pd = prev.data as unknown as ExtractedQuestion;
        const merged: ExtractedQuestion = { ...pd, stem: q.options.length && !pd.options.length ? `${pd.stem}\n${q.stem}`.trim() : pd.options.length ? pd.stem : `${pd.stem}\n${q.stem}`.trim(), options: pd.options.length >= 4 ? pd.options : [...pd.options, ...q.options].slice(0, 6), pages: [...new Set([...pd.pages, page.pageNumber])], figures: [...pd.figures, ...q.figures], confidence: Math.min(pd.confidence, q.confidence), notes: [...(pd.notes ?? []), "Joined with its continuation on the next page."] };
        await prisma.aiImportQuestion.update({ where: { id: prev.id }, data: { data: merged as unknown as Prisma.InputJsonValue, pages: merged.pages, optionCount: merged.options.length, confidence: merged.confidence } });
        continue;
      }
    }
    if (second) {
      const twin = second.find((s) => s.number === q.number && s.section === q.section);
      const verdict = twin ? readsAgree(q, twin) : { agree: false, detail: "the second model did not find this question" };
      q.notes = [...(q.notes ?? []), `Second read (${verifyModel}): ${verdict.detail}.`];
      if (!verdict.agree) q.confidence = Math.min(q.confidence, 0.5);
      else q.confidence = Math.max(q.confidence, 0.9);
    } else if (secondMissing) {
      q.notes = [...(q.notes ?? []), `The independent second read did not run (${secondMissing}).`];
      q.confidence = Math.min(q.confidence, 0.5);
    }
    const existingLocal = localOnPage.find((l) => l.sourceKey === sourceKeyOf(q));
    aiKeys.add(sourceKeyOf(q));
    await saveQuestion(ctx, file, q, existingLocal ? (await prisma.aiImportQuestion.findUnique({ where: { id: existingLocal.id }, select: { orderIndex: true } }))!.orderIndex : order++, async (f) => {
      if (!f.box) return null;
      if (layout) {
        const hit = layout.images.map((img, i) => ({ i, score: iou(img.box, f.box!), area: img.box.w * img.box.h })).filter((x) => x.area < 0.6).sort((a, b) => b.score - a.score)[0];
        if (hit && hit.score >= 0.6) return { bytes: layout.images[hit.i].bytes, ext: layout.images[hit.i].ext, source: "EMBEDDED" };
      }
      const crop = await cropFromRender(render, f.box);
      if (!crop) return null;
      if (crop.clipped) f.confidence = Math.min(f.confidence, 0.6);
      return { bytes: crop.bytes, ext: "png", source: "CROP" };
    }, page.pageNumber);
  }
  // Local questions on this page the AI did not return are KEPT and flagged — never silently dropped.
  for (const l of localOnPage) {
    if (aiKeys.has(l.sourceKey) || l.editedData || l.status !== AiImportQuestionStatus.EXTRACTED) continue;
    const d = l.data as unknown as ExtractedQuestion;
    if (d.method !== "LOCAL_PDF") continue;
    d.notes = [...(d.notes ?? []), "The AI read of this page did not return this question; kept from the text layer."];
    d.confidence = Math.min(d.confidence, 0.5);
    await prisma.aiImportQuestion.update({ where: { id: l.id }, data: { data: d as unknown as Prisma.InputJsonValue, confidence: d.confidence } });
  }
  await prisma.aiImportPage.update({
    where: { id: page.id },
    data: { status: AiImportPageStatus.DONE, model: primary.model, processedAt: new Date(), errorMessage: null, rawOutput: { ...state, ai: primary.out, ...(second ? { secondRead: { model: verifyModel, questions: second.length } } : {}) } as unknown as Prisma.InputJsonValue },
  });
  // Answer-key tables printed on question-paper pages are kept for the key matcher.
  if (primary.out.answer_key.length) {
    await saveKeyEntries(ctx, file.id, file.id, page.pageNumber, primary.out.answer_key.map((e) => ({ number: Number.parseInt(String(e.number), 10), section: "", raw: e.answer })));
  }
  if (budgetStop) throw budgetStop;
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

export async function saveKeyEntries(ctx: { job: { id: string } }, keyFileId: string, paperFileId: string | null, page: number | null, entries: { number: number; section: string; raw: string }[]): Promise<void> {
  const valid = entries.filter((e) => Number.isFinite(e.number) && e.number > 0 && e.number < 1000);
  if (!valid.length) return;
  await prisma.aiImportKeyEntry.createMany({
    data: valid.map((e) => ({ jobId: ctx.job.id, keyFileId, paperFileId, sourceNumber: e.number, section: e.section, rawValue: e.raw.slice(0, 40), labels: [], page })),
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
  if (stop) throw stop;
  return { skippedNoAi: 0 };
}
