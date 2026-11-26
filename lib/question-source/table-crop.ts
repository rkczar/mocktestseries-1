import { AiImportFileStatus, QuestionContentFormat } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runTool } from "@/lib/ai-import/tools";
import { vaultPath } from "@/lib/ai-import/vault";
import { OCR_DPI } from "@/lib/ai-import/ocr";
import { ensureRender } from "@/lib/ai-import/process";
import { cropFromRender } from "@/lib/ai-import/figures";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { escapeForRich } from "@/lib/ai-import/adapter";
import { attachQuestionAsset } from "@/lib/question-media-admin";
import type { NBox } from "@/lib/ai-import/types";
import { orderParagraphsBySource, uniqueParagraphs } from "@/lib/question-source/audit-compare";

/**
 * Tables shown as the ORIGINAL crop (owner rule 2026-11-26): a table the reader flattened into "a | b | c" text lines is
 * replaced by the table cut from the source page, placed under the question text (stem → table image → options). The
 * region runs from the table's first header word below the question number down to the "(a)" option line, inside the
 * question's own source band. No reliable region → nothing attached; the question is flagged IMAGE_REVIEW_REQUIRED.
 */

export type PageWord = { x: number; y: number; x0: number; x1: number; y0: number; y1: number; t: string };

/** Lines of a stored text that are a flattened table row (two or more "|"). */
/** A flattened table row: ≥ 2 table separators (" | ", or a leading / trailing pipe); "|x|" absolute values never. */
const isRow = (l: string) => (l.match(/\s\|\s|^\s*\||\|\s*$/g) ?? []).length >= 2; // " | " cell separators / edge pipes, never "|x|"
export const pipeTableLines = (text: string) => text.split("\n").filter(isRow);
/** The text without its flattened table rows (blank runs collapsed). */
/** Lines of the text that are leftovers of the table (every word of the line is a word of the cropped table). */
export function stripTableLeftovers(text: string, tableWords: Set<string>): string {
  return text
    .split("\n")
    .filter((l) => { const t = l.split(/[\s|]+/).map(tok).filter(Boolean); return !(t.length && t.every((x) => tableWords.has(x)) && !/[?:]\s*$/.test(l.trim())); })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export const stripPipeTable = (text: string) =>
  text
    .split("\n")
    .filter((l) => !isRow(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Words of one page (normalised 0..1): PDF text layer, else local-OCR lines. */
export async function pageWords(file: { id: string; storageKey: string | null; detected: unknown; status: string }, page: number): Promise<PageWord[]> {
  const kind = (file.detected as { kind?: string } | null)?.kind;
  let size: { w: number; h: number } | null = null;
  if (kind === "pdf" && file.storageKey && file.status !== AiImportFileStatus.PURGED) {
    try {
      const xml = (await runTool("pdftotext", ["-bbox-layout", "-f", String(page), "-l", String(page), vaultPath(file.storageKey), "-"], { timeoutMs: 60_000, maxOutput: 16 * 1024 * 1024 })).toString("utf8");
      const pg = /<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(xml);
      if (pg) {
        const W = Number(pg[1]);
        const H = Number(pg[2]);
        size = { w: (W / 72) * OCR_DPI, h: (H / 72) * OCR_DPI };
        const ws = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => {
          const x0 = Number(m[1]) / W, y0 = Number(m[2]) / H, x1 = Number(m[3]) / W, y1 = Number(m[4]) / H;
          return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, x0, x1, y0, y1, t: m[5].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'") };
        });
        if (ws.length >= 40) return ws;
      }
    } catch {
      /* scanned → OCR lines */
    }
  }
  const p = await prisma.aiImportPage.findFirst({ where: { fileId: file.id, pageNumber: page }, select: { ocrLines: true, renderWidth: true, renderHeight: true } });
  if (!p || !Array.isArray(p.ocrLines)) return [];
  const sz = size ?? (p.renderHeight ? { w: (p.renderWidth ?? 0) * (OCR_DPI / 150), h: p.renderHeight * (OCR_DPI / 150) } : null);
  if (!sz?.w || !sz.h) return [];
  return (p.ocrLines as { text?: string; box?: number[] }[])
    .filter((l) => l.box && l.text)
    .map((l) => {
      const [a, b, c, d] = l.box!;
      return { x: (a + c) / 2 / sz.w, y: (b + d) / 2 / sz.h, x0: a / sz.w, x1: c / sz.w, y0: b / sz.h, y1: d / sz.h, t: l.text! };
    });
}

type Line = { y: number; y0: number; y1: number; words: Set<string> };
const tok = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
function linesOf(words: PageWord[]): Line[] {
  const out: Line[] = [];
  for (const w of [...words].sort((a, b) => a.y - b.y)) {
    const l = out.find((x) => Math.abs(x.y - w.y) < 0.006);
    if (l) {
      l.y0 = Math.min(l.y0, w.y0);
      l.y1 = Math.max(l.y1, w.y1);
      for (const t of w.t.split(/\s+/)) if (tok(t)) l.words.add(tok(t));
    } else out.push({ y: w.y, y0: w.y0, y1: w.y1, words: new Set(w.t.split(/\s+/).map(tok).filter(Boolean)) });
  }
  return out.sort((a, b) => a.y - b.y);
}
const rowTokens = (row: string) => row.split("|").map((c) => tok(c.trim().split(/\s+/)[0] ?? "")).filter((t) => t.length > 0);
const matches = (l: Line, row: string) => {
  const t = rowTokens(row);
  const hit = t.filter((x) => l.words.has(x)).length;
  return t.length > 0 && hit >= Math.max(1, Math.ceil(t.length * 0.6));
};

/**
 * The table's box inside a question band (pure). Bottom = the last line matching the table's LAST flattened row; top =
 * the nearest line ABOVE it matching the FIRST row (searching upward, so words of the question sentence above the table
 * are never taken for the header). Both edges stop at the neighbouring lines, so no question text, no option and no
 * other question enters the crop. Null when either row is not found (the caller flags instead of guessing).
 */
export function tableRegion(words: PageWord[], band: NBox, rows: string[]): NBox | null {
  if (rows.length < 2) return null;
  const lines = linesOf(words.filter((w) => w.x >= band.x && w.x <= band.x + band.w && w.y >= band.y && w.y <= band.y + band.h));
  const lastRow = rows[rows.length - 1];
  let bi = lines.map((l, i) => (matches(l, lastRow) ? i : -1)).filter((i) => i >= 0).pop();
  if (bi === undefined) return null;
  let ti = -1;
  for (let i = bi; i >= 0; i--) if (matches(lines[i], rows[0])) { ti = i; break; }
  if (ti < 0 || bi - ti + 1 < Math.min(rows.length, 2)) return null;
  // The flattened text may have dropped a header / total row (2018 P-II Q10: "Brain tumour" header and the 3,60,000 row):
  // extend over adjacent lines spaced like table rows, never into the question sentence ("?" / ":" ending) or "(a)".
  const gaps = lines.slice(ti + 1, bi + 1).map((l, k) => l.y - lines[ti + k].y).sort((x, y) => x - y);
  const rowGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.02;
  const isText = (l: Line, w: PageWord[]) => w.some((x) => Math.abs(x.y - l.y) < 0.006 && /[?:]\s*$/.test(x.t)) || [...l.words][0] === "a";
  const wordsAt = (l: Line) => words.filter((x) => Math.abs(x.y - l.y) < 0.006);
  while (ti > 0 && lines[ti].y - lines[ti - 1].y <= rowGap * 1.6 && !isText(lines[ti - 1], wordsAt(lines[ti - 1]))) ti--;
  while (bi + 1 < lines.length && lines[bi + 1].y - lines[bi].y <= rowGap * 1.6 && !isText(lines[bi + 1], wordsAt(lines[bi + 1])) && !wordsAt(lines[bi + 1]).some((x) => /^\(a\)/.test(x.t.trim()))) bi++;
  const top = Math.max(band.y, lines[ti].y0 - 0.004, ti > 0 ? lines[ti - 1].y1 + 0.001 : band.y);
  const bottom = Math.min(band.y + band.h, lines[bi].y1 + 0.004, bi + 1 < lines.length ? lines[bi + 1].y0 - 0.001 : 1);
  if (bottom - top < 0.015) return null;
  return { x: band.x, y: top, w: band.w, h: bottom - top };
}

type Outcome = { status: "ATTACHED"; page: number; box: NBox; bytes: Buffer } | { status: "FLAGGED" | "SKIPPED"; reason: string };

/**
 * For one Question Bank question with stored source evidence: crop its flattened table from the source and show it as
 * an image under the stem (pipe rows removed from the text; text / options escaped for RICH_V1 exactly as the importer
 * does). Never changes words, options or answers. Audited.
 */
export async function attachTableCrop(questionId: string, actorId: string | null, redo?: { rows: string[]; replaceAssetId: string }): Promise<Outcome> {
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { id: true, text: true, textHi: true, contentFormat: true, explanation: true, reviewReason: true, options: { select: { id: true, label: true, text: true } }, assets: { select: { role: true } }, sourceEvidence: true } });
  if (!q) return { status: "SKIPPED", reason: "question not found" };
  const rows = redo?.rows ?? pipeTableLines(q.text);
  if (rows.length < 2) return { status: "SKIPPED", reason: "no flattened table" };
  if (!redo && q.assets.some((a) => a.role === "QUESTION")) return { status: "SKIPPED", reason: "already has a question image" };
  const flag = async (reason: string): Promise<Outcome> => {
    await prisma.question.update({ where: { id: q.id }, data: { reviewRequired: true, reviewReason: `IMAGE_REVIEW_REQUIRED — table: ${reason}. ${q.reviewReason ?? ""}`.slice(0, 1000) } });
    return { status: "FLAGGED", reason };
  };
  if (q.textHi?.trim()) return flag("bilingual question — the Hindi text would differ from the English; crop it by hand");
  const ev = q.sourceEvidence;
  const crop = (Array.isArray(ev?.questionCrops) ? ev!.questionCrops : []) as { page: number; box: NBox | null }[];
  if (!ev?.fileId || !crop.length) return flag("no source crop to cut the table from");
  const file = await prisma.aiImportFile.findUnique({ where: { id: ev.fileId } });
  if (!file?.storageKey || file.status === AiImportFileStatus.PURGED) return flag("original paper no longer stored");
  let region: { page: number; box: NBox } | null = null;
  let tableWords = new Set<string>();
  let bandText: string | null = null; // the question as printed (band words in reading order): paragraph order
  for (const part of crop) {
    if (!part.box) continue; // whole page (position unknown): another question's table could be picked → flag instead
    const pw = await pageWords(file, part.page);
    const box = tableRegion(pw, part.box, rows);
    if (box) {
      region = { page: part.page, box };
      tableWords = new Set(pw.filter((w) => w.y >= box.y && w.y <= box.y + box.h).flatMap((w) => w.t.split(/\s+/)).map(tok).filter(Boolean));
      const b = part.box;
      bandText = pw.filter((w) => w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h).sort((x, y) => x.y - y.y || x.x - y.x).map((w) => w.t).join(" ");
      break;
    }
  }
  if (!region) return flag("its first and last rows could not be located on the source page");
  const settings = await getImporterSettings();
  const render = await ensureRender({ id: ev.jobId! }, file, region.page, settings.limits.renderDpi);
  const cut = await cropFromRender(render, region.box, 0);
  if (!cut) return flag("the crop could not be cut");
  const before = { text: q.text, contentFormat: q.contentFormat, options: q.options.map((o) => ({ label: o.label, text: o.text })), explanation: q.explanation };
  // Flag first: whatever happens next, the question is never publishable without the owner checking the crop.
  await prisma.question.update({ where: { id: q.id }, data: { reviewRequired: true, reviewReason: `IMAGE_REVIEW_REQUIRED — table shown as the original crop (page ${region.page}); verify rows / columns. ${q.reviewReason ?? ""}`.slice(0, 1000) } });
  const toRich = q.contentFormat !== QuestionContentFormat.RICH_V1;
  // 1) RICH_V1 with the table text still in place (escaped exactly as the importer does); 2) attach the crop; 3) only
  // then remove the flattened rows — a failed attach never loses the table.
  if (toRich) {
    await prisma.$transaction([
      prisma.question.update({ where: { id: q.id }, data: { text: escapeForRich(q.text), contentFormat: QuestionContentFormat.RICH_V1, explanation: q.explanation ? escapeForRich(q.explanation) : q.explanation } }),
      ...q.options.map((o) => prisma.questionOption.update({ where: { id: o.id }, data: { text: escapeForRich(o.text) } })),
    ]);
  }
  await attachQuestionAsset({ questionId: q.id, actorId, file: { bytes: cut.bytes, filename: "table.png", mime: "image/png" }, role: "QUESTION", alt: "Table from the original question paper", caption: null, replaceAssetId: redo?.replaceAssetId ?? null });
  const now = await prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: { text: true } });
  // Rows (and leftovers of the table the reader split into short lines) are in the image now; repeated paragraphs once.
  const cleaned = stripTableLeftovers(stripPipeTable(now.text), tableWords);
  await prisma.question.update({ where: { id: q.id }, data: { text: orderParagraphsBySource(uniqueParagraphs(cleaned, bandText ?? ev.sourceText) ?? cleaned, bandText ?? ev.sourceText) } });
  await prisma.auditLog.create({ data: { actorId, action: "QUESTION_TABLE_CROP_ATTACHED", entityType: "Question", entityId: q.id, metadata: { page: region.page, box: region.box, before, removedRows: rows } as never } });
  return { status: "ATTACHED", page: region.page, box: region.box, bytes: cut.bytes };
}
