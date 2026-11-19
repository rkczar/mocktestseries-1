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
// "|" = the scan's reading of the bracket in "[P.T.O." (2026-11-19 CMS 2023: Q37 / Q50 options ended with "|P.T.O.").
const FURNITURE_WORDS = /^[[(|]?\s*(?:p\.?\s*t\.?\s*o\.?|turn over|space for rough work|rough work|\(?\s*contd\.?\s*\)?)\s*[\])]?$/i;
const furnitureText = (t: string) => t.length <= 40 && (PAGE_NUMBER.test(t) || BOOKLET_CODE.test(t) || BOOKLET_TOKEN.test(t) || FURNITURE_WORDS.test(t));

/** Running header/footer text (page numbers, booklet codes, watermark URLs) — never question text. */
export function isFurniture(text: string, box: NBox): boolean {
  const t = text.trim();
  if (!t) return true;
  if (URL_ONLY.test(t)) return true;
  // A whole line "[P.T.O." / "Turn over" is never question text, wherever the scan placed it (CMS 2024: ~0.877).
  // ("Rough work" stays in the band rule: nonQuestionPage needs it to recognise a rough-work page.)
  if (/^[[(|]?\s*(?:p\.?\s*t\.?\s*o\.?|turn over)\s*[\])]?$/i.test(t)) return true;
  const inBand = box.y + box.h < 0.075 || box.y > 0.88;
  if (!inBand) return false;
  return furnitureText(t);
}

/** Footer text that never occurs in a question: "[P.T.O.", a booklet code, or a page number WITH its series ("(3-A)"). */
// (Not BOOKLET_CODE: it also matches ordinary words such as "COVID-19".)
export const STRONG_FOOTER = (t: string) => t.length <= 40 && (FURNITURE_WORDS.test(t) || BOOKLET_TOKEN.test(t) || /^[\s(\[]*\d{1,3}\s*[-–]\s*[A-Z][\s)\]]*$/.test(t));

/**
 * The page's LAST text row when it is a footer printed above the fixed bottom band (2026-11-19 replay: CMS 2024 scans
 * print "(3-A)" + "[P.T.O." at ~80–88% of the page height, which ended up inside the last option). Removed only when
 * EVERY line of that row is strong footer text — a bare number is never removed here (a statement value "4" can be the
 * last line of a page; real page numbers are caught by the fixed band). Returns the removed texts.
 */
export function dropFooterRow(lines: LayoutLine[]): string[] {
  if (lines.length < 2) return [];
  const bottom = Math.max(...lines.map((l) => l.box.y + l.box.h));
  const lineH = Math.max(...lines.filter((l) => l.box.y + l.box.h === bottom).map((l) => l.box.h));
  const row = lines.filter((l) => l.box.y + l.box.h > bottom - lineH * 0.8);
  if (row.length === lines.length || !row.every((l) => STRONG_FOOTER(l.text.trim()))) return [];
  for (const l of row) lines.splice(lines.indexOf(l), 1);
  return row.map((l) => l.text);
}

/**
 * x (0..1) where the second text column begins, or null for a single-column page. Columns are told apart by where
 * lines START (the question parser assigns columns by start too): the x in [0.35, 0.65] crossed by the fewest lines
 * (tie → closest to the middle), placed just left of the second column's first start. Empty-band detection fails on
 * shifted or skewed scans whose left column runs into the right one (seen 2026-11-04, CMS 2025 Paper II page 5: left
 * lines end at 0.471 while right-column questions start at 0.468) — hence the small crossing tolerance.
 */
export function findGutter(lines: LayoutLine[]): number | null {
  const narrow = lines.filter((l) => l.box.w < 0.55);
  if (narrow.length < 8) return null;
  // The gutter is the x crossed by the FEWEST lines: a dense run of hanging numbers / indents in the right column, or a
  // table inside one column, never hides it (2026-11-19 audit: start-gap scoring split CMS 2024 P-II p18 at 0.721 and
  // CMS 2026 P-I p17 at 0.324). A 0.003 tolerance absorbs columns that touch on shifted scans (CMS 2025 P-II p5).
  const T = 0.003;
  const crossing = (x: number) => narrow.filter((l) => l.box.x < x - T && l.box.x + l.box.w > x + T).length;
  let best: { x: number; n: number } | null = null;
  for (let i = 0; i <= 60; i++) {
    const x = 0.35 + i * 0.005;
    const n = crossing(x);
    if (!best || n < best.n || (n === best.n && Math.abs(x - 0.5) < Math.abs(best.x - 0.5))) best = { x, n };
  }
  if (!best || best.n > narrow.length * 0.15) return null;
  // Placed just left of the second column's first start (columns are assigned by where lines start).
  const rightStarts = narrow.filter((l) => l.box.x >= best!.x - T).map((l) => l.box.x);
  if (!rightStarts.length) return null;
  const split = Math.min(...rightStarts) - 0.002;
  const left = narrow.filter((l) => l.box.x < split).length;
  const right = narrow.length - left;
  // Single column: one side holds almost nothing.
  if (left < narrow.length * 0.2 || right < narrow.length * 0.2) return null;
  return Math.round(split * 1000) / 1000;
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
      // OCR boxes may overlap the number by a few pixels (CMS 2026 P-I p9: "41." ends at x 826, its stem starts at 812).
      .filter((l) => l !== n && l.box.x > n.box.x + n.box.w / 2 && l.box.x - (n.box.x + n.box.w) < 0.06 && Math.abs(l.box.y - n.box.y) < Math.max(n.box.h, l.box.h) * 0.8)
      .sort((a, b) => a.box.x - b.box.x)[0];
    if (right && right.box.x >= gutter) n.box = { ...n.box, x: Math.max(gutter, right.box.x - n.box.w - 0.002) };
  }
}

/**
 * Two-column booklets (2026-11-15, CMS 2026 Paper II pages 6, 26, 27): (1) OCR returns ONE line across both columns
 * ("The manoeuvre (marked with an asterisk)  21. A 42-year-old lady underwent a") — it is split at the right column's
 * question number when that number sits at the gutter; (2) a right-column question number hangs left of the gutter
 * ("115. Which one…" at x 0.50, gutter 0.56) and was read into the left column — its line moves to the right column.
 * Text is never changed: a line is only cut in two at a printed question number, and only box positions move.
 */
export function separateColumns(lines: LayoutLine[], gutter: number): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!(l.box.x < gutter - 0.05 && l.box.x + l.box.w > gutter + 0.05)) continue;
    const cut = [...l.text.matchAll(/\s+(?=\d{1,3}\s*[.)]\s+\S)/g)].find((m) => {
      const at = m.index! + m[0].length;
      return at > 3 && Math.abs(l.box.x + l.box.w * (at / l.text.length) - gutter) < 0.08;
    });
    if (!cut) continue;
    const at = cut.index! + cut[0].length;
    const left: LayoutLine = { ...l, text: l.text.slice(0, cut.index!).trim(), box: { ...l.box, w: Math.max(0.01, gutter - 0.002 - l.box.x) } };
    const right: LayoutLine = { ...l, text: l.text.slice(at).trim(), box: { ...l.box, x: gutter, w: Math.max(0.01, l.box.x + l.box.w - gutter) } };
    lines.splice(i, 1, left, right);
  }
  for (const l of lines) if (l.box.x >= 0.3 && l.box.x < gutter && l.box.x >= gutter - 0.08 && l.box.w < 0.55 && /^\d{1,3}\s*[.)]\s*\S/.test(l.text)) l.box = { ...l.box, x: gutter };
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
  furniture.push(...dropFooterRow(lines));
  anchorTableLabels(lines);
  const gutter = findGutter(lines);
  if (gutter !== null) {
    attachNumberBoxes(lines, gutter);
    separateColumns(lines, gutter);
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
