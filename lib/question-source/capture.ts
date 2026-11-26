import { AiImportFileStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureRender } from "@/lib/ai-import/process";
import { cropFromRender } from "@/lib/ai-import/figures";
import { putContent } from "@/lib/ai-import/vault";
import type { PlacedQuestion } from "@/lib/ai-import/rescan-target";
import { runTool } from "@/lib/ai-import/tools";
import { vaultPath } from "@/lib/ai-import/vault";
import { OCR_DPI } from "@/lib/ai-import/ocr";
import { getImporterSettings } from "@/lib/ai-import/settings";
import type { NBox } from "@/lib/ai-import/types";

/**
 * Source evidence of an imported question (QuestionSource, 2026-11-26): provenance plus GENUINE crops of the original
 * question and of its answer-key entry, cut from the original page renders and stored content-addressed in the vault
 * (figures/), so they outlive render cleanup and original-file retention. Never AI-generated; when the original is gone
 * the row says so (cropNote / keyStatus) instead of inventing an image. Idempotent: re-capturing refreshes the row.
 */

type Crop = { key: string; page: number; box: NBox | null };
type Data = { section?: string; number?: number | null; region?: NBox | null; sourceText?: string | null; ocr?: { engine?: string; confidence?: number } | null; method?: string };

const PAD_X = 0.06;
const PAD_Y = 0.012;
const widen = (b: NBox): NBox => {
  const x = Math.max(0, b.x - PAD_X);
  const y = Math.max(0, b.y - PAD_Y);
  return { x, y, w: Math.min(1, b.x + b.w + PAD_X) - x, h: Math.min(1, b.y + b.h + PAD_Y) - y };
};
const validBox = (b: unknown): b is NBox => {
  const v = b as Partial<NBox> | null;
  return !!v && [v.x, v.y, v.w, v.h].every((n) => typeof n === "number" && Number.isFinite(n)) && v.w! > 0 && v.h! > 0;
};

const okRegion = (b: NBox | null | undefined): b is NBox => !!b && [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.h > 0 && b.y >= 0 && b.y + b.h <= 1.001;

/**
 * Full-width band(s) holding the WHOLE question: from the end of the previous question on its first page (or the page
 * top) to the start of the next question on its last page (or the page bottom), always including its own stored
 * region. A stored region often covers only part of a question (2026-11-26: Q26 → options only), so the neighbours'
 * positions bound it instead. Unknown positions → the whole page (box null). Pure.
 */
export function questionBands(q: PlacedQuestion, others: PlacedQuestion[]): { page: number; box: NBox | null }[] {
  if (!q.pages.length) return [];
  const pages = q.pages.slice(0, 2);
  const first = pages[0];
  const last = pages[pages.length - 1];
  const same = others.filter((o) => o.section === q.section && typeof o.number === "number" && typeof q.number === "number");
  const prev = same.filter((o) => o.number! < q.number! && o.pages[o.pages.length - 1] === first && okRegion(o.region) && o.pages.length === 1).sort((a, b) => b.number! - a.number!)[0];
  const next = same.filter((o) => o.number! > q.number! && o.pages[0] === last && okRegion(o.region)).sort((a, b) => a.number! - b.number!)[0];
  const own = okRegion(q.region) ? q.region : null;
  if (!prev && !next && !own) return pages.map((p) => ({ page: p, box: null }));
  const pad = 0.012;
  let top = prev ? prev.region!.y + prev.region!.h : 0;
  if (own && own.y < top) top = own.y;
  let bottom = next ? next.region!.y : 1;
  if (own && pages.length === 1 && own.y + own.h > bottom) bottom = own.y + own.h;
  const band = (t: number, b: number): NBox => {
    const y = Math.max(0, t - pad);
    return { x: 0, y, w: 1, h: Math.min(1, b + pad) - y };
  };
  if (pages.length === 1) return bottom > top ? [{ page: first, box: band(top, bottom) }] : [{ page: first, box: null }];
  return [{ page: first, box: band(top, 1) }, { page: last, box: band(0, bottom) }];
}

/**
 * Positions (page fraction, top) of printed question numbers ("26." / "26)") at the left of a page: from the PDF text
 * layer (word boxes), else from the page's local-OCR lines. These are real positions — the AI reader's regions are
 * coarse guesses and are only a fallback.
 */
export type NumPos = { x: number; y: number };
const atLineStart = (x: number) => x < 0.3 || (x > 0.42 && x < 0.62);
export function numbersFromBboxXml(xml: string): Map<number, NumPos> {
  const out = new Map<number, NumPos>();
  const pg = /<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(xml);
  if (!pg) return out;
  const W = Number(pg[1]);
  const H = Number(pg[2]);
  for (const m of xml.matchAll(/<line[^>]*>\s*<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>\s*(\d{1,3})\.\s*<\/word>/g)) {
    const n = Number(m[3]);
    const x = Number(m[1]) / W;
    if (atLineStart(x) && (!out.has(n) || x < out.get(n)!.x - 0.02)) out.set(n, { x, y: Number(m[2]) / H });
  }
  return out;
}
export function numbersFromOcr(lines: unknown, heightPx: number, widthPx?: number): Map<number, NumPos> {
  const out = new Map<number, NumPos>();
  if (!Array.isArray(lines) || !heightPx) return out;
  const W = widthPx || Math.max(...lines.map((l) => (l as { box?: number[] }).box?.[2] ?? 0), 1);
  for (const l of lines as { text?: string; box?: number[] }[]) {
    const m = /^\s*(\d{1,3})\.\s/.exec(`${l.text ?? ""} `);
    const x = l.box ? l.box[0] / W : 1;
    if (m && l.box && atLineStart(x) && (!out.has(Number(m[1])) || x < out.get(Number(m[1]))!.x - 0.02)) out.set(Number(m[1]), { x, y: l.box[1] / heightPx });
  }
  return out;
}
/**
 * Crop band(s) of question `num` from printed-number positions (pure): from its number down to the next number in the
 * same column (or the page / column bottom); a two-column page (numbers starting near the middle) crops one column.
 */
export function bandsByNumber(num: number, firstPage: number, lastPage: number, first: Map<number, NumPos>, last: Map<number, NumPos>): { page: number; box: NBox }[] | null {
  const me = first.get(num);
  if (!me) return null;
  // Two columns only when several question numbers (> 4, so not a List-II "1.–4.") start near the middle.
  const twoCol = (m: Map<number, NumPos>) => [...m.entries()].filter(([n, p]) => p.x > 0.42 && n > 4).length >= 2;
  const colOf = (p: NumPos) => (p.x > 0.42 ? 1 : 0);
  const span = (m: Map<number, NumPos>, col: number) => (twoCol(m) ? { x: col ? 0.47 : 0, w: col ? 0.53 : 0.53 } : { x: 0, w: 1 });
  const col = colOf(me);
  const top = Math.max(0, me.y - 0.012);
  if (lastPage === firstPage) {
    const next = [...first.entries()].filter(([n, p]) => n > num && colOf(p) === col && p.y > me.y && Math.abs(p.x - me.x) < 0.04).sort((a, b) => a[0] - b[0])[0]?.[1];
    const bottom = Math.min(1, (next?.y ?? 1) - 0.004);
    return [{ page: firstPage, box: { ...span(first, col), y: top, h: bottom - top } }];
  }
  const next = [...last.entries()].filter(([n]) => n > num).sort((a, b) => a[0] - b[0])[0]?.[1];
  const ncol = next ? colOf(next) : 0;
  return [
    { page: firstPage, box: { ...span(first, col), y: top, h: 1 - top } },
    { page: lastPage, box: { ...span(last, ncol), y: 0, h: Math.min(1, (next?.y ?? 1) - 0.004) } },
  ];
}

async function numberPositions(file: { id: string; storageKey: string | null; detected: unknown }, page: number, renderDpi: number, num: number): Promise<Map<number, NumPos>> {
  const kind = (file.detected as { kind?: string } | null)?.kind;
  let sizePx: { w: number; h: number } | null = null;
  if (kind === "pdf" && file.storageKey) {
    try {
      const xml = (await runTool("pdftotext", ["-bbox-layout", "-f", String(page), "-l", String(page), vaultPath(file.storageKey), "-"], { timeoutMs: 60_000, maxOutput: 8 * 1024 * 1024 })).toString("utf8");
      const m = numbersFromBboxXml(xml);
      if (m.has(num)) return m; // a sparse text layer without this number → local-OCR lines instead
      // Scanned page: its size in OCR pixels (points → OCR_DPI) normalises the local-OCR line boxes.
      const pg = /<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(xml);
      if (pg) sizePx = { w: (Number(pg[1]) / 72) * OCR_DPI, h: (Number(pg[2]) / 72) * OCR_DPI };
    } catch {
      /* fall through to OCR lines */
    }
  }
  const p = await prisma.aiImportPage.findFirst({ where: { fileId: file.id, pageNumber: page }, select: { ocrLines: true, renderHeight: true, renderWidth: true } });
  if (!p) return new Map();
  if (!sizePx && p.renderHeight) sizePx = { w: (p.renderWidth ?? 0) * (OCR_DPI / renderDpi), h: p.renderHeight * (OCR_DPI / renderDpi) };
  return sizePx ? numbersFromOcr(p.ocrLines, sizePx.h, sizePx.w) : new Map();
}

async function store(bytes: Buffer): Promise<string> {
  return (await putContent("figures", bytes, "png")).key;
}

/** Captures (or refreshes) the source evidence of one imported importer question. Returns null when it is not imported. */
export async function captureQuestionSource(aiImportQuestionId: string): Promise<{ questionId: string; crops: number; key: string | null } | null> {
  const q = await prisma.aiImportQuestion.findUnique({ where: { id: aiImportQuestionId }, include: { job: { select: { id: true, title: true, year: true, previousYearPaperId: true } } } });
  if (!q?.questionId) return null;
  const [file, paper, settings] = await Promise.all([
    prisma.aiImportFile.findUnique({ where: { id: q.fileId } }),
    q.job.previousYearPaperId ? prisma.previousYearPaper.findUnique({ where: { id: q.job.previousYearPaperId }, select: { title: true, year: true } }) : null,
    getImporterSettings(),
  ]);
  const dpi = settings.limits.renderDpi;
  const e = ((q.editedData ?? q.data) ?? {}) as Data;
  const raw = (q.data ?? {}) as Data;

  // Question crop(s): the question's own band (same targeting as Re-scan), its two-page continuation, or the whole page.
  const crops: Crop[] = [];
  let cropNote: string | null = null;
  if (!file || file.status === AiImportFileStatus.PURGED || !file.storageKey) cropNote = "Original paper file is no longer stored (retention) — source crop unavailable.";
  else if (!q.pages.length) cropNote = "No source page was recorded for this question.";
  else {
    try {
      const others = (await prisma.aiImportQuestion.findMany({ where: { fileId: q.fileId, id: { not: q.id }, pages: { hasSome: [...new Set(q.pages.flatMap((p) => [p - 1, p, p + 1]))] } }, select: { pages: true, data: true, editedData: true } })).map((o): PlacedQuestion => {
        const d = ((o.editedData ?? o.data) ?? {}) as Data;
        return { section: d.section ?? "", number: typeof d.number === "number" ? d.number : null, pages: o.pages, region: d.region ?? null };
      });
      // Printed numbers first (genuine positions); the reader's regions only when the number is not found.
      const num = typeof e.number === "number" ? e.number : q.sourceNumber;
      const firstPos = num !== null ? await numberPositions(file, q.pages[0], dpi, num) : new Map<number, NumPos>();
      const lastPage = q.pages[Math.min(1, q.pages.length - 1)];
      const lastPos = lastPage === q.pages[0] ? firstPos : num !== null ? await numberPositions(file, lastPage, dpi, num + 1) : new Map<number, NumPos>();
      const byNumber = num !== null ? bandsByNumber(num, q.pages[0], lastPage, firstPos, lastPos) : null;
      const parts = byNumber ?? questionBands({ section: e.section ?? "", number: typeof e.number === "number" ? e.number : q.sourceNumber, pages: q.pages, region: e.region ?? raw.region ?? null }, others);
      if (parts.some((x) => !x.box)) cropNote = "Whole page shown: the question's position on the page is not known.";
      for (const part of parts) {
        const render = await ensureRender(q.job, file, part.page, dpi);
        const bytes = part.box ? (await cropFromRender(render, part.box, 0))?.bytes : render;
        if (bytes) crops.push({ key: await store(bytes), page: part.page, box: part.box });
      }
    } catch (err) {
      cropNote = `Source crop could not be made: ${(err as Error).message.slice(0, 160)}`;
    }
  }

  // Answer-key evidence: the matched key entry's cell (local OCR box) or its whole key page.
  const entry = await prisma.aiImportKeyEntry.findFirst({ where: { OR: [{ matchedQuestionId: q.id }, ...(q.sourceNumber !== null ? [{ jobId: q.jobId, sourceNumber: q.sourceNumber, section: e.section ?? "" }] : [])] }, orderBy: [{ matchedQuestionId: "asc" }, { createdAt: "desc" }] });
  const keyFile = entry ? await prisma.aiImportFile.findUnique({ where: { id: entry.keyFileId } }) : null;
  let keyCrop: { key: string; page: number; box: NBox | null; kind: "CELL" | "PAGE" } | null = null;
  let keyStatus: string;
  if (!entry) keyStatus = (await prisma.aiImportFile.count({ where: { jobId: q.jobId, role: "ANSWER_KEY" } })) ? "NO_ENTRY" : "NOT_AVAILABLE";
  else {
    const conf = (keyFile?.detected as { keyPaperConfirmed?: { source?: string } } | null)?.keyPaperConfirmed?.source;
    keyStatus = conf === "PROVISIONAL" ? "PROVISIONAL" : q.answerStatus === "OFFICIAL_MATCHED" || q.answerStatus === "WITHDRAWN" || conf === "OFFICIAL" ? "OFFICIAL" : "UNCONFIRMED";
    if (keyFile && keyFile.status !== AiImportFileStatus.PURGED && keyFile.storageKey && entry.page) {
      try {
        const render = await ensureRender(q.job, keyFile, entry.page, dpi);
        if (validBox(entry.box)) {
          const b = widen(entry.box as NBox);
          const c = await cropFromRender(render, b, 0);
          if (c) keyCrop = { key: await store(c.bytes), page: entry.page, box: b, kind: "CELL" };
        }
        if (!keyCrop) keyCrop = { key: await store(render), page: entry.page, box: null, kind: "PAGE" };
      } catch {
        keyCrop = null;
      }
    }
  }

  const data = {
    aiImportQuestionId: q.id,
    jobId: q.jobId,
    jobTitle: q.job.title,
    fileId: q.fileId,
    fileName: file?.originalName ?? null,
    year: paper?.year ?? q.job.year ?? null,
    paperTitle: paper?.title ?? null,
    section: e.section ?? "",
    sourceNumber: q.sourceNumber,
    sourceLabel: q.sourceLabel,
    pages: q.pages,
    questionCrops: crops.length ? (crops as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    cropNote,
    sourceText: raw.sourceText ?? (raw.ocr as { text?: string } | null)?.text ?? null,
    ocrEngine: raw.ocr?.engine ?? raw.method ?? null,
    ocrConfidence: typeof raw.ocr?.confidence === "number" ? raw.ocr.confidence : q.confidence,
    extraction: raw.method ?? null,
    issueCodes: q.issueCodes,
    issues: (q.issues ?? Prisma.DbNull) as Prisma.InputJsonValue,
    answerStatus: q.answerStatus,
    officialAnswerRaw: q.officialAnswerRaw,
    officialAnswer: q.officialAnswer,
    extractedAnswer: q.sourceAnswer,
    aiAnswer: q.aiAnswer,
    keyFileId: keyFile?.id ?? null,
    keyFileName: keyFile?.originalName ?? null,
    keyPage: entry?.page ?? null,
    keyCrop: keyCrop ? (keyCrop as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    keyStatus,
  };
  await prisma.questionSourceEvidence.upsert({ where: { questionId: q.questionId }, create: { questionId: q.questionId, ...data }, update: data });
  return { questionId: q.questionId, crops: crops.length, key: keyCrop?.kind ?? null };
}

/** All vault keys referenced by source evidence (kept by the storage cleanup). */
export async function questionSourceKeys(): Promise<string[]> {
  const rows = await prisma.questionSourceEvidence.findMany({ select: { questionCrops: true, keyCrop: true } });
  const out: string[] = [];
  for (const r of rows) {
    for (const c of (Array.isArray(r.questionCrops) ? r.questionCrops : []) as { key?: string }[]) if (c?.key) out.push(c.key);
    const k = (r.keyCrop as { key?: string } | null)?.key;
    if (k) out.push(k);
  }
  return out;
}
