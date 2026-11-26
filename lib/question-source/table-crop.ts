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

/**
 * Tables shown as the ORIGINAL crop (owner rule 2026-11-26): a table the reader flattened into "a | b | c" text lines is
 * replaced by the table cut from the source page, placed under the question text (stem → table image → options). The
 * region runs from the table's first header word below the question number down to the "(a)" option line, inside the
 * question's own source band. No reliable region → nothing attached; the question is flagged IMAGE_REVIEW_REQUIRED.
 */

export type PageWord = { x: number; y: number; x0: number; x1: number; y0: number; y1: number; t: string };

/** Lines of a stored text that are a flattened table row (two or more "|"). */
export const pipeTableLines = (text: string) => text.split("\n").filter((l) => (l.match(/\|/g) ?? []).length >= 2);
/** The text without its flattened table rows (blank runs collapsed). */
export const stripPipeTable = (text: string) =>
  text
    .split("\n")
    .filter((l) => (l.match(/\|/g) ?? []).length < 2)
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

/**
 * The table's box inside a question band (pure): top = the first word of the table's first header cell found below the
 * band's first line; bottom = the "(a)" option line; x = the band's width. Null when either end is not found or the
 * region is implausible (no other words between, or taller than the band).
 */
export function tableRegion(words: PageWord[], band: NBox, firstCellWord: string): NBox | null {
  const inBand = words.filter((w) => w.x >= band.x && w.x <= band.x + band.w && w.y >= band.y && w.y <= band.y + band.h).sort((a, b) => a.y - b.y || a.x - b.x);
  if (!inBand.length) return null;
  const firstLineY = inBand[0].y;
  const key = firstCellWord.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  const head = inBand.find((w) => w.y > firstLineY + 0.004 && w.t.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(key));
  if (!head) return null;
  const optA = inBand.find((w) => w.y > head.y && /^\(?\s*a\s*\)/i.test(w.t.trim()));
  if (!optA) return null;
  const inside = inBand.filter((w) => w.y0 >= head.y0 - 0.002 && w.y1 <= optA.y0 + 0.001);
  if (inside.length < 6) return null;
  const top = Math.max(band.y, head.y0 - 0.006);
  const bottom = Math.min(band.y + band.h, optA.y0 - 0.002);
  if (bottom - top < 0.02 || bottom <= top) return null;
  return { x: band.x, y: top, w: band.w, h: bottom - top };
}

type Outcome = { status: "ATTACHED"; page: number; box: NBox; bytes: Buffer } | { status: "FLAGGED" | "SKIPPED"; reason: string };

/**
 * For one Question Bank question with stored source evidence: crop its flattened table from the source and show it as
 * an image under the stem (pipe rows removed from the text; text / options escaped for RICH_V1 exactly as the importer
 * does). Never changes words, options or answers. Audited.
 */
export async function attachTableCrop(questionId: string, actorId: string | null): Promise<Outcome> {
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { id: true, text: true, contentFormat: true, explanation: true, reviewReason: true, options: { select: { id: true, label: true, text: true } }, assets: { select: { role: true } }, sourceEvidence: true } });
  if (!q) return { status: "SKIPPED", reason: "question not found" };
  const rows = pipeTableLines(q.text);
  if (rows.length < 2) return { status: "SKIPPED", reason: "no flattened table" };
  if (q.assets.some((a) => a.role === "QUESTION")) return { status: "SKIPPED", reason: "already has a question image" };
  const flag = async (reason: string): Promise<Outcome> => {
    await prisma.question.update({ where: { id: q.id }, data: { reviewRequired: true, reviewReason: `IMAGE_REVIEW_REQUIRED — table: ${reason}. ${q.reviewReason ?? ""}`.slice(0, 1000) } });
    return { status: "FLAGGED", reason };
  };
  const ev = q.sourceEvidence;
  const crop = (Array.isArray(ev?.questionCrops) ? ev!.questionCrops : []) as { page: number; box: NBox | null }[];
  if (!ev?.fileId || !crop.length) return flag("no source crop to cut the table from");
  const file = await prisma.aiImportFile.findUnique({ where: { id: ev.fileId } });
  if (!file?.storageKey || file.status === AiImportFileStatus.PURGED) return flag("original paper no longer stored");
  const firstCell = rows[0].split("|").map((c) => c.trim()).find((c) => c.length > 0) ?? "";
  const firstWord = firstCell.split(/\s+/)[0] ?? "";
  let region: { page: number; box: NBox } | null = null;
  for (const part of crop) {
    const box = tableRegion(await pageWords(file, part.page), part.box ?? { x: 0, y: 0, w: 1, h: 1 }, firstWord);
    if (box) {
      region = { page: part.page, box };
      break;
    }
  }
  if (!region) return flag(`its position on the source page could not be established reliably (first header "${firstWord}")`);
  const settings = await getImporterSettings();
  const render = await ensureRender({ id: ev.jobId! }, file, region.page, settings.limits.renderDpi);
  const cut = await cropFromRender(render, region.box, 0);
  if (!cut) return flag("the crop could not be cut");
  const before = { text: q.text, contentFormat: q.contentFormat, options: q.options.map((o) => ({ label: o.label, text: o.text })), explanation: q.explanation };
  const toRich = q.contentFormat !== QuestionContentFormat.RICH_V1;
  // 1) RICH_V1 with the table text still in place (escaped exactly as the importer does); 2) attach the crop; 3) only
  // then remove the flattened rows — a failed attach never loses the table.
  if (toRich) {
    await prisma.$transaction([
      prisma.question.update({ where: { id: q.id }, data: { text: escapeForRich(q.text), contentFormat: QuestionContentFormat.RICH_V1, explanation: q.explanation ? escapeForRich(q.explanation) : q.explanation } }),
      ...q.options.map((o) => prisma.questionOption.update({ where: { id: o.id }, data: { text: escapeForRich(o.text) } })),
    ]);
  }
  await attachQuestionAsset({ questionId: q.id, actorId, file: { bytes: cut.bytes, filename: "table.png", mime: "image/png" }, role: "QUESTION", alt: "Table from the original question paper", caption: null });
  const now = await prisma.question.findUniqueOrThrow({ where: { id: q.id }, select: { text: true } });
  await prisma.question.update({ where: { id: q.id }, data: { text: stripPipeTable(now.text) } });
  await prisma.question.update({ where: { id: q.id }, data: { reviewRequired: true, reviewReason: `IMAGE_REVIEW_REQUIRED — table shown as the original crop (page ${region.page}); verify rows / columns. ${q.reviewReason ?? ""}`.slice(0, 1000) } });
  await prisma.auditLog.create({ data: { actorId, action: "QUESTION_TABLE_CROP_ATTACHED", entityType: "Question", entityId: q.id, metadata: { page: region.page, box: region.box, before, removedRows: rows } } });
  return { status: "ATTACHED", page: region.page, box: region.box, bytes: cut.bytes };
}
