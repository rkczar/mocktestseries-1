import "server-only";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { AiImportFileRole, AiImportFileStatus, type AiImportFile, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runTool } from "@/lib/ai-import/tools";
import { readDocx } from "@/lib/ai-import/docx";
import { decodeMarkdown, parseMarkdown } from "@/lib/ai-import/markdown";
import { vaultPath } from "@/lib/ai-import/vault";
import { importerAiCallChecked, parseModelJson, ImporterAiFailure, ImporterAiUnavailable } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { KEY_SYSTEM, keySchema, keyUserText } from "@/lib/ai-import/prompts";
import { jobMemoryBrief } from "@/lib/ai-import/taxonomy-memory";
import { visionImage } from "@/lib/ai-import/figures";
import { ensureRender, saveKeyEntries, type StepContext } from "@/lib/ai-import/process";
import { logEvent } from "@/lib/ai-import/jobs";
import sharp from "sharp";
import { KEY_MIN_COVERAGE } from "@/lib/ai-import/config";
import { ocrAvailable, ocrImageFile, ocrPdfPage } from "@/lib/ai-import/ocr";
import type { OcrPage } from "@/lib/ai-import/ocr-layout";
import type { NBox } from "@/lib/ai-import/types";

/**
 * Answer-key files: the key is read as printed (number + value), never
 * solved. Text keys are parsed locally; scanned keys need the vision model.
 * Matching to questions happens in lib/ai-import/answers.ts.
 */

export interface KeyPair {
  number: number;
  section: string;
  raw: string;
  /** Page of the key file the entry was read from (source reference). */
  page?: number | null;
  /** Normalized box (0..1) of the number + value cells on that page (local OCR only), for the review card's key crop. */
  box?: NBox | null;
}

/** The key's own identifiers as printed (paper, series / set, total questions) — compared with the question paper. */
export interface KeyHeader {
  paper: string | null;
  series: string | null;
  set: string | null;
  totalQuestions: number | null;
  exam: string | null;
}

/** Header identifiers printed in a text key ("Paper II", "Series A", "Total Questions 120"); null when none. */
export function parseKeyHeader(text: string): KeyHeader | null {
  const head = text.slice(0, 3000);
  const paper = /\bPaper\s*(?:No\.?|Code)?\s*[-:–]?\s*\(?([IVX]{1,4}|\d{1,2})\)?(?![\w])/i.exec(head)?.[1] ?? null;
  const series = /\b(?:Series|Booklet\s*(?:Series|Code)?|Test\s*Booklet)\s*[-:–]?\s*\(?([A-D])\)?(?![\w])/i.exec(head)?.[1] ?? null;
  const set = /\bSet\s*(?:No\.?|Code)?\s*[-:–]?\s*\(?([A-Z0-9]{1,3})\)?(?![\w])/i.exec(head)?.[1] ?? null;
  const total = /\bTotal\s*(?:No\.?\s*of\s*)?Questions\s*[-:–]?\s*(\d{1,4})/i.exec(head)?.[1];
  const h = { paper, series, set, totalQuestions: total ? Number(total) : null, exam: null };
  return h.paper || h.series || h.set || h.totalQuestions ? h : null;
}

/**
 * The number of questions a paper or key PRINTS about itself, from its first 3,000 characters: "Total Questions: 120",
 * "Total Number of Questions: 120", "No. of Questions: 100", "This Test Booklet contains 120 items (questions)".
 * Null when nothing is printed. Used to establish the expected count independently of the extraction.
 */
export function printedQuestionTotal(text: string): number | null {
  const head = text.slice(0, 3000);
  const m =
    /\bTotal\s*(?:No\.?|Number)?\s*(?:of\s*)?(?:Questions|Items)\s*[-:–=]?\s*(\d{1,4})\b/i.exec(head) ??
    /\b(?:No\.?|Number)\s*of\s*(?:Questions|Items)\s*[-:–=]?\s*(\d{1,4})\b/i.exec(head) ??
    /\bcontains\s+(\d{1,4})\s+(?:items|questions)\b/i.exec(head);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : null;
}

function headerOf(h: { paper?: string | null; series?: string | null; set?: string | null; total_questions?: number | string | null; exam?: string | null } | null | undefined): KeyHeader | null {
  if (!h) return null;
  const total = h.total_questions === null || h.total_questions === undefined ? null : Number.parseInt(String(h.total_questions), 10);
  const out = { paper: h.paper?.trim() || null, series: h.series?.trim() || null, set: h.set?.trim() || null, totalQuestions: Number.isFinite(total) ? total : null, exam: h.exam?.trim() || null };
  return out.paper || out.series || out.set || out.totalQuestions || out.exam ? out : null;
}

// A–E / 1–5 are read as printed: a value that is not one of the question's options becomes a KEY MISMATCH, never dropped.
// "X" / "×" is how UPSC keys print a dropped item (CMS 2013, 2024).
// (?!\d) after the number: a year in the title ("Exam - 2022") is not "Q202 = 2" (RPSC FSO 2022 key, 2026-11-10).
const VALUE = String.raw`(?:[A-Ea-e1-5](?:\s*[,&/]\s*[A-Ea-e1-5]){0,3}|Bonus|BONUS|Dropped|DROPPED|Deleted|DELETED|Withdrawn|WITHDRAWN|X|×|\*)`;
const PAIR = new RegExp(String.raw`(?:^|[\s|])Q?\.?\s*(\d{1,3})(?!\d)\s*[.):\-–=]?\s*\(?\s*(${VALUE})\s*\)?(?=[\s|,;]|$)`, "g");
const TOKEN_VALUE = new RegExp(`^\\(?(${VALUE})\\)?$`);

/** Parses key text: "1. B  2. (c)", "1-A, 2-B", or a numbers row followed by an answers row. */
export function parseKeyText(text: string): KeyPair[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: KeyPair[] = [];
  const used = new Set<number>();
  // Column tables: "1 2 3 4 5" then "B C A D A".
  for (let i = 0; i + 1 < lines.length; i++) {
    const nums = lines[i].replace(/^(Q\.?\s*No\.?|Question|Q)\s*[:.]?\s*/i, "").split(/[\s|]+/).filter(Boolean);
    const vals = lines[i + 1].replace(/^(Ans(wer)?s?|Key|Correct)\s*[:.]?\s*/i, "").split(/[\s|]+/).filter(Boolean);
    if (nums.length >= 3 && nums.length === vals.length && nums.every((n) => /^\d{1,3}$/.test(n)) && vals.every((v) => TOKEN_VALUE.test(v))) {
      const ns = nums.map(Number);
      if (ns.every((n, k) => k === 0 || n === ns[k - 1] + 1)) {
        ns.forEach((n, k) => out.push({ number: n, section: "", raw: vals[k].replace(/[()]/g, "") }));
        used.add(i).add(i + 1);
        i++;
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    for (const m of lines[i].matchAll(PAIR)) out.push({ number: Number(m[1]), section: "", raw: m[2].replace(/\s+/g, "") });
  }
  return out;
}

export { KEY_MIN_COVERAGE };

/**
 * How many entries the key should have: the administrator's confirmed question count. The key's own printed total is
 * not used — it may belong to another paper (a wrong key is the paper check's business, not a coverage question).
 */
export function keyExpected(expectedQuestions: number | null | undefined): number | null {
  return expectedQuestions ?? null;
}

/**
 * An AI-vision reading of a key that covers fewer than KEY_MIN_COVERAGE of the expected questions: not used (null = complete
 * or unknown). Text-layer and local-OCR readings are kept per entry (ocrKeyPairs already drops doubtful cells); the numbers
 * they miss simply have no entry (seen 2026-11-19: 89/89 and 85/85 OCR entries identical to the text key were discarded).
 */
export function keyReadingIncomplete(method: string, pairs: KeyPair[], expected: number | null): { read: number; expected: number } | null {
  const read = new Set(pairs.map((x) => x.number)).size;
  return method === "ai" && pairs.length && expected && read < Math.ceil(expected * KEY_MIN_COVERAGE) ? { read, expected } : null;
}

/**
 * Sanity of a parsed key: enough entries, few repeated numbers, and either mostly increasing in reading order (a
 * one-column key) or a dense block of numbers in any order (a grid read row by row: 1, 16, 31, … — seen 2026-11-05,
 * CMS 2024 Paper I: all 120 entries were read and then rejected, so every answer fell back to an AI guess).
 */
/**
 * Whether a key page must be read by OCR: no usable text layer, or a short one (a watermark / header over a scanned
 * grid) that gave no key pairs — CMS 2018 keys carry ~84 characters of text over the scanned grid (2026-11-26) and were
 * never OCR'd. A real text key (hundreds of characters) is never re-read.
 */
export function keyPageNeedsOcr(text: string, localPairs: number): boolean {
  const n = text.replace(/\s+/g, "").length;
  return n < 40 || (localPairs === 0 && n < 400);
}

export function keyLooksValid(pairs: KeyPair[]): boolean {
  if (pairs.length < 3) return false;
  const nums = pairs.map((p) => p.number);
  const unique = [...new Set(nums.map((n, i) => `${pairs[i].section}#${n}`))].length;
  if (unique / nums.length < 0.9) return false;
  let ordered = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] === nums[i - 1] + 1) ordered++;
  if (ordered / Math.max(1, nums.length - 1) >= 0.6) return true;
  const set = [...new Set(nums)];
  const span = Math.max(...set) - Math.min(...set) + 1;
  return set.length >= 10 && set.length / span >= 0.9;
}

export function sheetPairs(bytes: Buffer, ext: string): KeyPair[] {
  const wb = ext === "csv" ? XLSX.read(bytes.toString("utf8"), { type: "string", raw: true }) : XLSX.read(bytes, { type: "buffer", cellFormula: false, cellHTML: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, blankrows: false }) as unknown[][];
  const out: KeyPair[] = [];
  for (const r of rows) {
    const n = Number.parseInt(String(r[0] ?? "").replace(/^Q\.?\s*/i, ""), 10);
    const v = String(r[1] ?? "").trim().replace(/[()]/g, "");
    if (Number.isFinite(n) && v && TOKEN_VALUE.test(v)) out.push({ number: n, section: String(r[2] ?? "").trim().slice(0, 40), raw: v });
  }
  return out;
}

async function aiKeyPage(ctx: StepContext, file: AiImportFile, page: number): Promise<{ pairs: KeyPair[]; header: KeyHeader | null }> {
  const model = ctx.settings.models.key ?? ctx.settings.models.extract;
  const render = await ensureRender(ctx.job, file, page, ctx.settings.limits.renderDpi);
  const { value } = await importerAiCallChecked(
    {
      jobId: ctx.job.id,
      task: "key",
      models: [model!],
      system: KEY_SYSTEM,
      content: [
        { type: "text", text: keyUserText(page, await jobMemoryBrief(ctx.job, "key")) },
        { type: "image_url", image_url: { url: await visionImage(render), detail: "high" } },
      ],
      maxOutputTokens: 4000,
      settings: ctx.settings,
      needsVision: true,
    },
    (text) => {
      const parsed = keySchema.safeParse(parseModelJson(text));
      if (!parsed.success) throw new ImporterAiFailure(failureMessage("model_output", "the answer-key reading did not match the expected format"), "model_output");
      return parsed.data;
    }
  );
  return { pairs: value.entries.map((e) => ({ number: Number.parseInt(String(e.number), 10), section: (e.section ?? "").trim(), raw: e.answer.trim().replace(/\s+/g, " "), page })), header: headerOf(value.header) };
}

/** OCR lines below this confidence are never used as a key number or value. */
const KEY_OCR_MIN_SCORE = 0.9;
const OCR_KEY_LETTER = /^\(?([A-Da-dX×])\)?$/;
/**
 * Scan specks and print dots around one cell ("C.", "-A.", "64.", "À") — seen 2026-11-19, CMS 2023 key screenshot: 43 of
 * 120 cells were read at ≥0.9 confidence and dropped only for a trailing dot. Only the token's EDGES are cleaned (and accents
 * removed); "1.17" or "AB" still never match. X / × = the key's dropped-question mark (post.ts WITHDRAWN).
 */
const cleanKeyToken = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").trim().replace(/^[.,·'`^_\-:;~*]+|[.,·'`^_\-:;~*]+$/g, "");

/**
 * A scanned key page read by local OCR (no AI): each printed question number is paired with the nearest option letter to
 * its right on the same row, with no other number between them (one-, two- or many-column grids). Conservative: a
 * low-confidence token, a value that is not a single option letter, a number its column neighbours contradict, or a number paired twice (an OCR misread) gives no
 * entry — that question keeps Answer unverified. Nothing is inferred from the grid position.
 */
export function ocrKeyPairs(page: Pick<OcrPage, "lines"> & Partial<Pick<OcrPage, "width" | "height">>, maxNumber = 300): { pairs: KeyPair[]; text: string } {
  const toks = page.lines
    .filter((l) => l.score >= KEY_OCR_MIN_SCORE)
    .map((l) => ({ t: cleanKeyToken(l.text), x0: l.box[0], x1: l.box[2], y0: l.box[1], y1: l.box[3], cy: (l.box[1] + l.box[3]) / 2, h: Math.max(1, l.box[3] - l.box[1]) }));
  const nums = toks.filter((k) => /^\d{1,3}$/.test(k.t) && +k.t >= 1 && +k.t <= maxNumber);
  const vals = toks.filter((k) => OCR_KEY_LETTER.test(k.t));
  const sameRow = (a: { cy: number; h: number }, b: { cy: number }) => Math.abs(a.cy - b.cy) <= a.h * 0.6;
  // A grid prints consecutive numbers down each column: a number whose every vertical neighbour contradicts it is an OCR
  // misread (2026-11-15: Q99 read as "66", between 98 and 100 — paired, it would give Q66 the answer of Q99).
  const centre = (k: { x0: number; x1: number }) => (k.x0 + k.x1) / 2;
  const vertical = (n: (typeof nums)[number]) => {
    const col = nums.filter((m) => m !== n && Math.abs(centre(m) - centre(n)) < n.h * 3);
    // Two rows each way, so one misread neighbour never condemns a correct number (Q100 under the misread "66").
    const above = col.filter((m) => m.cy < n.cy).sort((a, b) => b.cy - a.cy).slice(0, 2);
    const below = col.filter((m) => m.cy > n.cy).sort((a, b) => a.cy - b.cy).slice(0, 2);
    if (!above.length && !below.length) return true;
    return above.some((m, i) => +m.t === +n.t - 1 - i) || below.some((m, i) => +m.t === +n.t + 1 + i);
  };
  const found: KeyPair[] = [];
  for (const n of nums) {
    if (!vertical(n)) continue;
    const right = vals.filter((v) => sameRow(n, v) && v.x0 >= n.x1).sort((a, b) => a.x0 - b.x0)[0];
    if (!right) continue;
    if (nums.some((m) => m !== n && sameRow(n, m) && m.x0 >= n.x1 && m.x0 < right.x0)) continue;
    found.push({ number: +n.t, section: "", raw: OCR_KEY_LETTER.exec(right.t)![1].toUpperCase(), box: keyCellBox(page, n, right) });
  }
  const count = new Map<number, number>();
  for (const f of found) count.set(f.number, (count.get(f.number) ?? 0) + 1);
  // A number paired twice is an OCR misread of another cell: neither pairing is used.
  const pairs = found.filter((f) => count.get(f.number) === 1).sort((a, b) => a.number - b.number);
  const text = [...page.lines].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]).map((l) => l.text).join("\n");
  return { pairs, text };
}

/** Union of the number and value cells, padded by about one row, normalized to the page (0..1); null without page size. */
function keyCellBox(page: Partial<Pick<OcrPage, "width" | "height">>, a: { x0: number; x1: number; y0: number; y1: number; h: number }, b: { x0: number; x1: number; y0: number; y1: number }): NBox | null {
  const W = page.width ?? 0;
  const H = page.height ?? 0;
  if (!(W > 0 && H > 0)) return null;
  const x0 = Math.max(0, Math.min(a.x0, b.x0) - a.h) / W;
  const y0 = Math.max(0, Math.min(a.y0, b.y0) - a.h) / H;
  const x1 = Math.min(W, Math.max(a.x1, b.x1) + a.h) / W;
  const y1 = Math.min(H, Math.max(a.y1, b.y1) + a.h) / H;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---- Missing key cells (2026-11-19 CMS 2023: 20 of 120 cells not read by OCR — "8" for B, a smudge, confidence < 0.9) ----
// Each missing number's printed cell is cropped from the key image and read by vision, which must return the printed NUMBER
// too. A letter is used only when (a) the low-confidence local OCR reading of that same cell agrees, or (b) two different
// vision models agree. Anything else keeps Answer unverified. Never inferred from the grid or from the question.
export interface KeyCell { number: number; box: { x0: number; y0: number; x1: number; y1: number }; ocr: string | null; ocrScore?: number }
export interface KeyCellRead { model: string; number: string; answer: string }
/** OCR digit read for a key letter in a printed grid: only as one of the two required agreeing readings, never alone. */
const OCR_DIGIT_AS_LETTER: Record<string, string> = { "8": "B", "0": "D" };
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

export function keyCellCandidates(page: Pick<OcrPage, "lines">, pairs: KeyPair[], expected: number): KeyCell[] {
  const toks = page.lines.map((l) => ({ t: cleanKeyToken(l.text), score: l.score, x0: l.box[0], x1: l.box[2], cy: (l.box[1] + l.box[3]) / 2, h: Math.max(1, l.box[3] - l.box[1]) }));
  const nums = toks.filter((k) => /^\d{1,3}$/.test(k.t) && k.score >= KEY_OCR_MIN_SCORE);
  const count = new Map<number, number>();
  for (const n of nums) count.set(+n.t, (count.get(+n.t) ?? 0) + 1);
  const byN = new Map(nums.filter((n) => count.get(+n.t) === 1).map((n) => [+n.t, n]));
  const h = median(nums.map((n) => n.h));
  const sameRow = (a: { cy: number }, b: { cy: number }) => Math.abs(a.cy - b.cy) <= h * 0.6;
  const pitch = median(nums.map((n) => Math.min(...nums.filter((m) => m !== n && sameRow(n, m) && m.x0 > n.x1).map((m) => m.x0 - n.x0))).filter(Number.isFinite));
  if (!h || !pitch) return [];
  const have = new Set(pairs.map((p) => p.number));
  const out: KeyCell[] = [];
  for (let n = 1; n <= expected; n++) {
    if (have.has(n)) continue;
    const a = byN.get(n);
    const up = byN.get(n - 1);
    const down = byN.get(n + 1);
    // Located by its own printed number, else between its column neighbours (the crop is then checked by the number the reader returns).
    const at = a ? { x0: a.x0, cy: a.cy } : up && down && Math.abs(up.x0 - down.x0) <= h ? { x0: (up.x0 + down.x0) / 2, cy: (up.cy + down.cy) / 2 } : null;
    if (!at) continue;
    const box = { x0: Math.max(0, at.x0 - 0.3 * h), y0: Math.max(0, at.cy - 0.9 * h), x1: at.x0 + pitch - 0.3 * h, y1: at.cy + 0.9 * h };
    const right = a ? a.x1 : at.x0 + h;
    const vals = toks.filter((k) => k.cy > box.y0 && k.cy < box.y1 && k.x0 >= right && k.x1 <= box.x1 + 0.3 * h);
    const v = vals.length === 1 ? vals[0].t : null;
    const ocrScore = vals.length === 1 ? vals[0].score : undefined;
    const ocr = v ? (OCR_KEY_LETTER.test(v) ? OCR_KEY_LETTER.exec(v)![1].toUpperCase().replace("×", "X") : (OCR_DIGIT_AS_LETTER[v] ?? null)) : null;
    out.push({ number: n, box, ocr, ocrScore });
  }
  return out;
}

export const KEY_CELL_SYSTEM = "You read printed ANSWER KEY cells. Each image is one cell of a printed answer-key grid: a question number and, to its right, its key letter. Copy exactly what is printed: number = the printed question number; answer = the printed key letter (A, B, C or D), X when the key prints X / × (question dropped), ? when it is unclear, smudged or not visible. Never guess, never answer the question, never use medical knowledge. Answer JSON only: {\"cells\":[{\"ref\":\"C1\",\"number\":\"12\",\"answer\":\"B\"}]} — one entry per image, in the given refs.";

export function keyCellAnswerOf(json: unknown, model: string): Map<string, KeyCellRead> {
  const out = new Map<string, KeyCellRead>();
  const cells = (json as { cells?: unknown } | null)?.cells;
  if (!Array.isArray(cells)) return out;
  for (const c of cells as { ref?: unknown; number?: unknown; answer?: unknown }[]) {
    const ref = String(c?.ref ?? "").trim().toUpperCase();
    if (!/^C\d+$/.test(ref) || out.has(ref)) continue;
    out.set(ref, { model, number: String(c?.number ?? "").replace(/\D+/g, ""), answer: String(c?.answer ?? "").trim().toUpperCase().replace("×", "X") });
  }
  return out;
}

/** The answer of one missing cell, or why none is used. reads[0] = the key model, reads[1] = a different vision model. */
export function acceptKeyCell(cell: Pick<KeyCell, "number" | "ocr" | "ocrScore">, reads: KeyCellRead[]): { answer: string; how: string } | { answer: null; why: string } {
  const valid = reads.filter((r) => r.number === String(cell.number) && /^[A-DX]$/.test(r.answer));
  const bad = reads.find((r) => r.number && r.number !== String(cell.number));
  if (bad) return { answer: null, why: `${bad.model} read the number ${bad.number} in this crop (expected ${cell.number})` };
  if (!valid.length) return { answer: null, why: `no clear letter (${reads.map((r) => `${r.model}: ${r.answer || "—"}`).join("; ") || "no reading"})` };
  const letters = new Set(valid.map((r) => r.answer));
  if (letters.size > 1) return { answer: null, why: `readings disagree (${valid.map((r) => `${r.model}: ${r.answer}`).join("; ")})` };
  const a = valid[0].answer;
  const models = new Set(valid.map((r) => r.model));
  if (cell.ocr && cell.ocr === a) return { answer: a, how: `local OCR (low confidence) and ${valid[0].model} agree` };
  // A contradicting OCR token BELOW the confidence floor is not a witness against two different vision models that agree
  // (2026-11-19 Q116: OCR "a." at 0.89 vs D read by every vision model; the key prints D). A confident OCR token still blocks.
  if (cell.ocr && !(models.size >= 2 && (cell.ocrScore ?? 1) < KEY_OCR_MIN_SCORE)) return { answer: null, why: `local OCR read ${cell.ocr}, ${valid[0].model} read ${a}` };
  if (cell.ocr) return { answer: a, how: `${[...models].join(" and ")} agree; the conflicting local OCR "${cell.ocr}" was below the confidence floor (${Math.round((cell.ocrScore ?? 0) * 100)}%)` };
  return valid.length >= 2 && new Set(valid.map((r) => r.model)).size >= 2 ? { answer: a, how: `${valid.map((r) => r.model).join(" and ")} agree` } : { answer: null, why: `only one reading (${valid[0].model}: ${a}); a second, different model is needed` };
}

/** Crops of the cells (JPEG data URLs), scaled from OCR pixel space to the image actually cropped. */
export async function keyCellCrops(image: Buffer, ocrWidth: number, cells: KeyCell[]): Promise<string[]> {
  const meta = await sharp(image).metadata();
  const k = (meta.width ?? ocrWidth) / ocrWidth;
  return Promise.all(cells.map(async (c) => {
    const left = Math.max(0, Math.floor(c.box.x0 * k));
    const top = Math.max(0, Math.floor(c.box.y0 * k));
    const width = Math.max(8, Math.min((meta.width ?? 0) - left, Math.ceil((c.box.x1 - c.box.x0) * k)));
    const height = Math.max(8, Math.min((meta.height ?? 0) - top, Math.ceil((c.box.y1 - c.box.y0) * k)));
    const buf = await sharp(image).extract({ left, top, width, height }).resize({ height: 96, withoutEnlargement: false }).jpeg({ quality: 85 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  }));
}

export const keyCellContent = (crops: string[]) => [{ type: "text" as const, text: `${crops.length} answer-key cell image(s), refs C1..C${crops.length} in order.` }, ...crops.flatMap((url, i) => [{ type: "text" as const, text: `C${i + 1}:` }, { type: "image_url" as const, image_url: { url, detail: "high" as const } }])];

/** Reads the missing cells of one OCR key page with vision (budget-checked calls); returns the accepted entries + an audit list. */
async function recoverKeyCells(ctx: StepContext, image: Buffer, ocr: OcrPage, pairs: KeyPair[], page: number): Promise<{ pairs: KeyPair[]; audit: { number: number; ocr: string | null; reads: KeyCellRead[]; result: string }[] }> {
  const expected = keyExpected(ctx.job.expectedQuestions);
  const keyModel = ctx.settings.models.key ?? ctx.settings.models.extract;
  if (!expected || !ctx.settings.aiEnabled || !keyModel) return { pairs: [], audit: [] };
  const cells = keyCellCandidates(ocr, pairs, expected).slice(0, 60);
  if (!cells.length) return { pairs: [], audit: [] };
  const crops = await keyCellCrops(image, ocr.width ?? 0, cells);
  // Output budget: reasoning models spend tokens before the JSON (2026-11-19 benchmark: 4 of 6 models cut off at 60 + 40 per cell).
  const read = async (model: string, idx: number[]) => {
    const { value } = await importerAiCallChecked({ jobId: ctx.job.id, task: "key", stage: "key-cells", models: [model], system: KEY_CELL_SYSTEM, content: keyCellContent(idx.map((i) => crops[i])), maxOutputTokens: 1500 + idx.length * 60, settings: ctx.settings, needsVision: true, jsonSchema: "keyCells" }, (t) => keyCellAnswerOf(parseModelJson(t), model));
    return new Map(idx.map((i, k) => [i, value.get(`C${k + 1}`)]));
  };
  const all = cells.map((_, i) => i);
  const first = await read(keyModel, all);
  // A second, different vision model only for cells without a local OCR reading (the OCR reading is the other witness otherwise).
  const second = ctx.settings.models.verify && ctx.settings.models.verify !== keyModel ? ctx.settings.models.verify : (ctx.settings.models.extractFallbacks ?? []).find((m) => m !== keyModel) ?? null;
  // ...and for cells whose first reading contradicts an OCR token below the confidence floor (two models can outweigh it).
  const need = all.filter((i) => first.get(i) && (!cells[i].ocr || (first.get(i)!.answer !== cells[i].ocr && (cells[i].ocrScore ?? 1) < KEY_OCR_MIN_SCORE)));
  const again = second && need.length ? await read(second, need) : new Map<number, KeyCellRead | undefined>();
  const out: KeyPair[] = [];
  const audit = cells.map((c, i) => {
    const reads = [first.get(i), again.get(i)].filter((r): r is KeyCellRead => !!r);
    const d = acceptKeyCell(c, reads);
    if ("how" in d) out.push({ number: c.number, section: "", raw: d.answer, page, box: ocr.width && ocr.height ? { x: c.box.x0 / ocr.width, y: c.box.y0 / ocr.height, w: (c.box.x1 - c.box.x0) / ocr.width, h: (c.box.y1 - c.box.y0) / ocr.height } : null });
    return { number: c.number, ocr: c.ocr, reads, result: "how" in d ? `${d.answer} — ${d.how}` : `not used — ${d.why}` };
  });
  return { pairs: out, audit };
}

/** Local OCR of one scanned key page (free); null when OCR is unavailable or failed — the caller falls back as before. */
async function ocrKeyPage(full: string, kind: string | undefined, page: number, maxNumber: number): Promise<{ pairs: KeyPair[]; header: KeyHeader | null; ocr: OcrPage } | null> {
  if (!ocrAvailable()) return null;
  try {
    const ocr = kind === "pdf" ? await ocrPdfPage(full, page) : await ocrImageFile(full);
    const r = ocrKeyPairs(ocr, maxNumber);
    return keyLooksValid(r.pairs) ? { pairs: r.pairs.map((x) => ({ ...x, page })), header: parseKeyHeader(r.text), ocr } : null;
  } catch (e) {
    console.warn(`[ai-import] key OCR of page ${page} failed: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`);
    return null;
  }
}

/** Reads every unprocessed answer-key file of the job into AiImportKeyEntry rows. */
export async function runKeyFiles(ctx: StepContext): Promise<void> {
  const files = await prisma.aiImportFile.findMany({ where: { jobId: ctx.job.id, role: AiImportFileRole.ANSWER_KEY, status: { in: [AiImportFileStatus.UPLOADED, AiImportFileStatus.ANALYZED] } }, orderBy: { createdAt: "asc" } });
  if (!files.length) return;
  const papers = await prisma.aiImportFile.findMany({ where: { jobId: ctx.job.id, role: AiImportFileRole.PAPER, status: { not: AiImportFileStatus.REJECTED } }, select: { id: true } });
  for (const file of files) {
    if (!(await ctx.stillRunning())) return;
    const paperFileId = file.paperFileId ?? (papers.length === 1 ? papers[0].id : null);
    const kind = (file.detected as { kind?: string } | null)?.kind;
    let pairs: KeyPair[] = [];
    let header: KeyHeader | null = null;
    let method = "local";
    /** Entries a text page gave that did not form a recognisable key (reported, never used). */
    let rejectedPairs = 0;
    const full = vaultPath(file.storageKey!);
    const maxKeyNumber = Math.max(300, ctx.job.expectedQuestions ?? 0);
    let ocrRead: Awaited<ReturnType<typeof ocrKeyPage>> = null;
    try {
    if (kind === "pdf") {
      const text = (await runTool("pdftotext", ["-layout", "-enc", "UTF-8", full, "-"], { timeoutMs: 120_000, maxOutput: 16 * 1024 * 1024 })).toString("utf8");
      // pdftotext ends every page with a form feed: never read past the real page count.
      const pages = text.split("\f").slice(0, Math.max(1, file.pageCount ?? 1));
      for (let p = 0; p < pages.length; p++) {
        header ??= parseKeyHeader(pages[p]);
        const local = parseKeyText(pages[p]);
        if (local.length) rejectedPairs = Math.max(rejectedPairs, keyLooksValid(local) ? 0 : local.length);
        if (keyLooksValid(local)) {
          pairs.push(...local.map((x) => ({ ...x, page: p + 1 })));
          continue;
        }
        // A scanned page (no text layer): local OCR first (free), AI vision only when OCR gives no recognisable key.
        const scanned = keyPageNeedsOcr(pages[p], local.length);
        const ocrRead = scanned ? await ocrKeyPage(full, kind, p + 1, maxKeyNumber) : null;
        if (ocrRead) {
          pairs.push(...ocrRead.pairs);
          const rec = await recoverKeyCells(ctx, await ensureRender(ctx.job, file, p + 1, Math.round((ocrRead.ocr.dpi ?? 0) || ctx.settings.limits.renderDpi)), ocrRead.ocr, ocrRead.pairs, p + 1);
          pairs.push(...rec.pairs);
          if (rec.audit.length) await logEvent(ctx.job.id, "KEY_CELLS_READ", `${file.originalName} page ${p + 1}: ${rec.audit.length} key cell(s) not read by local OCR were cropped and read by vision — ${rec.pairs.length} used (two agreeing readings + matching printed number), ${rec.audit.length - rec.pairs.length} left unverified.`, { fileId: file.id, page: p + 1, cells: rec.audit });
          header ??= ocrRead.header;
          method = "ocr";
          continue;
        }
        // Paid vision only for a page with no text layer at all (a short watermark page is OCR-only, never AI).
        if (scanned && pages[p].replace(/\s+/g, "").length < 40 && ctx.settings.aiEnabled && (ctx.settings.models.key ?? ctx.settings.models.extract)) {
          const read = await aiKeyPage(ctx, file, p + 1);
          pairs.push(...read.pairs);
          header ??= read.header;
          method = "ai";
        }
      }
    } else if (kind === "docx") {
      const text = (await readDocx(full)).lines.map((l) => l.text).join("\n");
      header = parseKeyHeader(text);
      pairs = parseKeyText(text).map((x) => ({ ...x, page: 1 }));
    } else if (kind === "xlsx" || kind === "csv") {
      pairs = sheetPairs(await readFile(full), kind);
    } else if (kind === "md") {
      // A key-only (or paper + key) Markdown file: its key tables / lines, read locally, per paper section.
      const md = parseMarkdown(decodeMarkdown(await readFile(full)));
      pairs = md.papers.flatMap((p) => p.key.map((e) => ({ number: e.number, section: md.papers.length > 1 ? p.section : "", raw: e.raw, page: 1 })));
    } else if ((kind === "png" || kind === "jpeg") && (ocrRead = await ocrKeyPage(full, kind, 1, maxKeyNumber))) {
      const rec = await recoverKeyCells(ctx, await readFile(full), ocrRead.ocr, ocrRead.pairs, 1);
      pairs = [...ocrRead.pairs, ...rec.pairs];
      header = ocrRead.header;
      method = "ocr";
      if (rec.audit.length) await logEvent(ctx.job.id, "KEY_CELLS_READ", `${file.originalName}: ${rec.audit.length} key cell(s) not read by local OCR were cropped and read by vision — ${rec.pairs.length} used (two agreeing readings + matching printed number), ${rec.audit.length - rec.pairs.length} left unverified.`, { fileId: file.id, cells: rec.audit });
    } else if (ctx.settings.aiEnabled && (ctx.settings.models.key ?? ctx.settings.models.extract)) {
      const read = await aiKeyPage(ctx, file, 1);
      pairs = read.pairs;
      header = read.header;
      method = "ai";
    }
    } catch (e) {
      // Budget / configuration stops are the job's business; anything else fails this key file only.
      if (e instanceof ImporterAiUnavailable || (e instanceof Error && e.name === "ImporterBudgetError")) throw e;
      // The required reading failed: the file is NOT marked processed, so Retry reads it again (its entries
      // are replaced, never added twice). The message starts with the failure kind (lib/ai-import/failure.ts).
      const why = e instanceof ImporterAiFailure ? e.message.slice(0, 260) : `The answer key could not be read: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`;
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.ANALYZED, errorMessage: `${why} The answer key was not read — use Retry to read it again.`.slice(0, 500) } });
      await logEvent(ctx.job.id, "KEY_FAILED", `${file.originalName}: the answer key could not be read — ${why.slice(0, 200)}`, { fileId: file.id, kind: e instanceof ImporterAiFailure ? e.kind : null });
      continue;
    }
    // An AI reading of a key that covers far fewer questions than the paper has is an incomplete reading (seen 2026-10-31:
    // 15 of a 120-cell grid, 9 of them wrong): its values are not used as official answers. The file stays readable again
    // (Retry), and the partial reading is kept in the event for review.
    const incomplete = keyReadingIncomplete(method, pairs, keyExpected(ctx.job.expectedQuestions));
    if (incomplete) {
      const { read, expected } = incomplete;
      const why = `Only ${read} of ${expected} answer-key entries could be read (the key looks like a grid the reading did not cover). The entries were not used as official answers — use Retry with a stronger key model, or enter the answers by hand.`;
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.ANALYZED, errorMessage: why } });
      await logEvent(ctx.job.id, "KEY_INCOMPLETE", `${file.originalName}: ${why}`, { fileId: file.id, read, expected, entries: pairs.slice(0, 200), header });
      continue;
    }
    await prisma.aiImportKeyEntry.deleteMany({ where: { keyFileId: file.id } });
    if (!pairs.length) {
      await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.PROCESSED, errorMessage: rejectedPairs ? `The key's text was read (${rejectedPairs} number–answer pair(s)), but they do not form a recognisable key layout, so none was used — no answer was substituted. Check the file, or enter the answers by hand.` : kind === "pdf" || kind === "png" || kind === "jpeg" ? "No answer-key entries could be read (local OCR found no recognisable key, and AI vision is off, not configured or blocked by the budget). No answer was substituted — use Retry to read it again." : "No answer-key entries were found. No answer was substituted." } });
      await logEvent(ctx.job.id, "KEY_EMPTY", `${file.originalName}: no answer-key entries could be read${rejectedPairs ? ` (${rejectedPairs} pair(s) read from the text layer did not form a recognisable layout)` : ""} — the questions keep Answer unverified; no AI answer is substituted`, { fileId: file.id, rejectedPairs });
      continue;
    }
    await saveKeyEntries(ctx, file.id, paperFileId, null, pairs);
    // The key's printed identifiers are kept with the file (post.ts compares them with the question paper).
    const detected = { ...((file.detected as Record<string, unknown> | null) ?? {}), keyHeader: header, keyMethod: method } as unknown as Prisma.InputJsonValue;
    await prisma.aiImportFile.update({ where: { id: file.id }, data: { status: AiImportFileStatus.PROCESSED, errorMessage: null, detected } });
    const printed = header ? [header.paper && `Paper ${header.paper}`, header.series && `Series ${header.series}`, header.set && `Set ${header.set}`, header.totalQuestions && `${header.totalQuestions} questions`].filter(Boolean).join(", ") : "";
    await logEvent(ctx.job.id, "KEY_READ", `${file.originalName}: ${pairs.length} answer-key entries read (${method === "ai" ? "AI vision" : method === "ocr" ? "local OCR, no AI" : "text layer"})${printed ? ` — the key is printed for ${printed}` : ""}`, { fileId: file.id, entries: pairs.length, method, header });
  }
}
