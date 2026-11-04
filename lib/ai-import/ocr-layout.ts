/**
 * Layout of one OCR-read page (pure: no I/O, so the regression suite exercises it directly).
 *
 * OCR returns lines in pixel coordinates of the rendered page. Before the existing question parser sees them:
 *   - skew is measured from the lines' own top edges and removed in COORDINATE space (the page image is never altered),
 *   - page furniture (running headers/footers, page numbers, booklet codes, watermark URLs) is set aside, kept for audit,
 *   - the column gutter of a two-column page is found from where text actually is, not assumed at the page middle,
 *   - non-question pages (cover instructions, "space for rough work") are recognised so they are explained, not parsed.
 * Nothing here changes a word of the text.
 */
import type { NBox } from "@/lib/ai-import/types";

export interface OcrLine {
  text: string;
  score: number;
  box: [number, number, number, number];
  poly?: [number, number][];
  reread?: { text?: string; score?: number; dpi?: number | null; firstText?: string; firstScore?: number; error?: string };
}

export interface OcrPage {
  engine: string;
  width: number;
  height: number;
  dpi: number | null;
  ink: number;
  rereads: number;
  seconds: number;
  lines: OcrLine[];
}

export interface LayoutLine {
  text: string;
  box: NBox;
  conf: number;
}

/** OCR lines below this confidence are shown for review (after the script's sharper re-read). */
export const OCR_REVIEW_BELOW = 0.9;
/** A rendered page with less dark ink than this, and no OCR text, is blank. Text pages measured 3–9%. */
export const BLANK_INK_BELOW = 0.002;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Page skew in degrees, from the top edges of wide lines (0 when not measurable). */
export function skewDegrees(page: Pick<OcrPage, "width" | "lines">): number {
  const angles: number[] = [];
  for (const l of page.lines) {
    const p = l.poly;
    if (!p || p.length < 2) continue;
    const dx = p[1][0] - p[0][0];
    const dy = p[1][1] - p[0][1];
    if (dx < page.width * 0.2) continue;
    angles.push((Math.atan2(dy, dx) * 180) / Math.PI);
  }
  return angles.length >= 3 ? median(angles) : 0;
}

function rotated(page: OcrPage, deg: number): OcrLine[] {
  if (Math.abs(deg) < 0.1) return page.lines;
  const a = (-deg * Math.PI) / 180;
  const cx = page.width / 2;
  const cy = page.height / 2;
  const rot = ([x, y]: [number, number]): [number, number] => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
  return page.lines.map((l) => {
    const pts: [number, number][] = l.poly && l.poly.length >= 4 ? l.poly.map(rot) : ([[l.box[0], l.box[1]], [l.box[2], l.box[1]], [l.box[2], l.box[3]], [l.box[0], l.box[3]]] as [number, number][]).map(rot);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { ...l, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
}

const PAGE_NUMBER = /^[\s(\[–-]*\d{1,3}\s*(?:[-–]\s*[A-Z])?[\s)\]–-]*$/;
const BOOKLET_CODE = /^[A-Z0-9]{2,6}(?:\s*-\s*[A-Z0-9]{1,6}){1,4}$/;
// A booklet code inside a footer string ("3 A- TDSP-O-GMPK", "TDSP-T-SGOP (2-A)").
const BOOKLET_TOKEN = /\b[A-Z]{3,6}-[A-Z0-9]{1,2}-[A-Z]{3,6}\b/;
const QUESTION_LIKE = /^\s*(?:Q\.?\s*(?:No[.:]?)?\s*)?\d{1,3}\s*[.)]|^\s*\(?[a-dA-D]\)/;
const URL_ONLY = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:in|com|org|net)$/i;
const FURNITURE_WORDS = /^(?:p\.?\s*t\.?\s*o\.?|turn over|space for rough work|rough work|\(?\s*contd\.?\s*\)?)$/i;

/** Running header/footer text (page numbers, booklet codes, watermark URLs) — never question text. */
export function isFurniture(text: string, box: NBox): boolean {
  const t = text.trim();
  if (!t) return true;
  if (URL_ONLY.test(t)) return true;
  const inBand = box.y + box.h < 0.075 || box.y > 0.88;
  if (!inBand) return false;
  if (t.length > 40) return false;
  return PAGE_NUMBER.test(t) || BOOKLET_CODE.test(t) || BOOKLET_TOKEN.test(t) || FURNITURE_WORDS.test(t);
}

/**
 * x (0..1) where the second text column begins, or null for a single-column page. Columns are told apart by where
 * lines START (the question parser assigns columns by start too): the largest gap between line-start positions near
 * the middle of the page, placed just left of the second column's first start. Empty-band detection fails on shifted
 * or skewed scans whose left column runs into the right one (seen 2026-11-04, CMS 2025 Paper II page 5: left lines end
 * at 0.471 while right-column questions start at 0.468), and on columns whose question numbers stand in the gap.
 */
export function findGutter(lines: LayoutLine[]): number | null {
  const narrow = lines.filter((l) => l.box.w < 0.55);
  if (narrow.length < 8) return null;
  const starts = [...new Set(narrow.map((l) => Math.round(l.box.x * 1000) / 1000))].sort((a, b) => a - b);
  // A column edge is where MANY lines start in alignment; a table's second cell column inside one text column
  // starts only a few (seen 2026-11-04, CMS 2025 Paper I page 3: "Arrhythmia | Response" cells at x 0.355).
  let best: { split: number; aligned: number } | null = null;
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    if (starts[i] < 0.3 || starts[i] > 0.75 || gap < 0.05) continue;
    const split = starts[i] - 0.002;
    const left = narrow.filter((l) => l.box.x < split).length;
    const right = narrow.length - left;
    if (left < narrow.length * 0.2 || right < narrow.length * 0.2) continue;
    const aligned = narrow.filter((l) => l.box.x >= split && l.box.x < split + 0.04).length;
    if (!best || aligned > best.aligned) best = { split, aligned };
  }
  return best ? Math.round(best.split * 1000) / 1000 : null;
}

const COVER_MARKS = [/do not open this (?:test )?booklet/i, /\btest booklet\b/i, /\binstructions?\b/i, /time allowed/i, /maximum marks/i, /roll number/i, /answer sheet|\bOMR\b/i, /invigilator/i, /penalty for wrong answers?/i];

/**
 * A page that holds no questions by design: the cover / instructions to candidates, or a "space for rough work"
 * page. Numbered instructions on a cover ("1. Immediately after the commencement…") must never become questions.
 */
export function nonQuestionPage(texts: string[]): { kind: "COVER" | "ROUGH_WORK"; why: string } | null {
  const all = texts.join("\n");
  const hits = COVER_MARKS.filter((r) => r.test(all));
  const optionLines = texts.filter((t) => /^\s*\(?[a-dA-D][).]\s+\S/.test(t)).length;
  if (hits.length >= 3 && optionLines < 4) return { kind: "COVER", why: `cover / instructions page (${hits.length} instruction markers, no option lists)` };
  const content = texts.filter((t) => !/rough work/i.test(t)).join("").replace(/\s+/g, "");
  if (/rough work/i.test(all) && content.length < 60) return { kind: "ROUGH_WORK", why: "space for rough work" };
  return null;
}

const LABEL_Q = /^\s*Q(?:uestion)?\.?\s*No[.:]?\s*\d{1,3}\b/i;
const LABEL_END = /^\s*(?:Correct|Right)\s+(?:Option|Answer)\b/i;

/**
 * Table-style papers ("Q. No. 25 | stem…", "Option A | …", "Correct Option | D") print the question label vertically
 * centred in its cell, so a long stem starts ABOVE its label and would be read as the end of the previous question
 * (seen 2026-11-04, RUHS MO 2016 Q25). Each label in the left label column is moved up to the first text line of its
 * cell — the first line below the previous question's "Correct Option" row. Only positions change, never text.
 */
export function anchorTableLabels(lines: LayoutLine[]): void {
  const labels = lines.filter((l) => l.box.x + l.box.w < 0.25 && LABEL_Q.test(l.text)).sort((a, b) => a.box.y - b.box.y);
  if (labels.length < 2) return;
  const ends = lines.filter((l) => l.box.x < 0.25 && LABEL_END.test(l.text)).map((l) => l.box.y + l.box.h);
  // Left edge of the cell text column (stems and options are left-aligned there; centred page titles are not).
  const right = lines.filter((l) => l.box.x >= 0.15 && l.box.x < 0.4).map((l) => l.box.x).sort((a, b) => a - b);
  const colX = right.length ? right[Math.floor(right.length / 2)] : null;
  if (colX === null) return;
  for (const lab of labels) {
    // A cell is at most a few lines tall: never reach above it (page headers, logos) when no answer row precedes it.
    const floor = Math.max(lab.box.y - 0.06, ...ends.filter((e) => e <= lab.box.y + 0.002));
    const cell = lines.filter((l) => l !== lab && Math.abs(l.box.x - colX) < 0.02 && l.box.y >= floor - 0.001 && l.box.y < lab.box.y - 0.002);
    if (!cell.length) continue;
    const top = Math.min(...cell.map((l) => l.box.y));
    lab.box = { ...lab.box, y: top };
  }
}

const NUMBER_ONLY = /^\s*\d{1,3}\s*[.)]\s*$/;

/**
 * A bare question-number box ("4.") belongs to the text that starts right after it on the same row — even when the
 * number stands left of the column gap (seen 2026-11-04, CMS 2025 Paper II page 2: "4." and "5." of the right column
 * sat inside the gap and were read into the left column). Only the box's x changes, never its text.
 */
export function attachNumberBoxes(lines: LayoutLine[], gutter: number): void {
  for (const n of lines) {
    if (!NUMBER_ONLY.test(n.text) || n.box.x >= gutter) continue;
    const right = lines
      .filter((l) => l !== n && l.box.x > n.box.x + n.box.w - 0.002 && l.box.x - (n.box.x + n.box.w) < 0.06 && Math.abs(l.box.y - n.box.y) < Math.max(n.box.h, l.box.h) * 0.8)
      .sort((a, b) => a.box.x - b.box.x)[0];
    if (right && right.box.x >= gutter) n.box = { ...n.box, x: Math.max(gutter, right.box.x - n.box.w - 0.002) };
  }
}

export interface PageLayoutResult {
  lines: LayoutLine[];
  furniture: string[];
  skew: number;
  gutter: number | null;
  meanConfidence: number;
  lowLines: number;
  /** All OCR text of the page in reading order (furniture excluded) — the original reading, never corrected. */
  text: string;
}

/** OCR page → normalized, deskewed, furniture-free lines with confidences, plus the column gutter. */
export function layoutOcrPage(page: OcrPage): PageLayoutResult {
  const skew = skewDegrees(page);
  const W = page.width;
  const H = page.height;
  const furniture: string[] = [];
  const lines: LayoutLine[] = [];
  for (const l of rotated(page, skew)) {
    const box: NBox = { x: Math.max(0, l.box[0] / W), y: Math.max(0, l.box[1] / H), w: (l.box[2] - l.box[0]) / W, h: (l.box[3] - l.box[1]) / H };
    if (isFurniture(l.text, box)) {
      furniture.push(l.text);
      continue;
    }
    // A table's identifier column ("0011006" under "Q. No. 6") is a record id, not question text.
    if (/^\d{6,8}$/.test(l.text.trim()) && box.x + box.w < 0.2) {
      furniture.push(l.text);
      continue;
    }
    lines.push({ text: l.text, box, conf: l.score });
  }
  anchorTableLabels(lines);
  const gutter = findGutter(lines);
  if (gutter !== null) {
    attachNumberBoxes(lines, gutter);
    // On a two-column booklet page the top 5% holds the running header and show-through from the back of the sheet
    // (mirrored text), never question text. Single-column table papers DO continue questions there (RUHS), so the
    // rule applies only when columns were found.
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.box.y + l.box.h < 0.05 && !QUESTION_LIKE.test(l.text)) {
        furniture.push(l.text);
        lines.splice(i, 1);
      }
    }
  }
  const scores = lines.map((l) => l.conf);
  const ordered = [...lines].sort((a, b) => (gutter !== null ? Number(a.box.x >= gutter && a.box.w < 0.55) - Number(b.box.x >= gutter && b.box.w < 0.55) : 0) || a.box.y - b.box.y || a.box.x - b.box.x);
  return {
    lines,
    furniture,
    skew: Math.round(skew * 100) / 100,
    gutter,
    meanConfidence: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10000) / 10000 : 0,
    lowLines: scores.filter((s) => s < OCR_REVIEW_BELOW).length,
    text: ordered.map((l) => l.text).join("\n"),
  };
}
