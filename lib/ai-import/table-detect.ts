/**
 * Table regions in a page's positioned lines (PDF text layer or OCR), pure. A table = at least 3 consecutive lines of
 * one column whose pieces start at the same 2+ x positions (left-aligned cells). Rows whose pieces are option markers
 * ("(a) … (b) …") or a question number are never table rows. The result keeps every cell's text exactly as read,
 * row by row, plus the region box for an original image crop. Uncertain shapes are not tables (the text stays as read).
 */
import type { Line } from "@/lib/ai-import/local-parse";
import type { NBox } from "@/lib/ai-import/types";

export interface DetectedTable {
  /** Index range [from, to] into the given lines. */
  from: number;
  to: number;
  rows: string[][];
  box: NBox;
}

const MIN_GAP = 0.02; // a cell gap: 2% of the page width
const ALIGN = 0.025; // pieces starting within 2.5% are one column
const OPTION_PIECE = /^\s*(?:\(?[a-dA-D]\)|[a-dA-D][.)])\s/;
const QUESTION_START = /^\s*(?:Q\.?\s*)?\d{1,3}\s*[.)]\s+\S/;

function pieces(l: Line): { text: string; x: number; box: NBox }[] {
  const segs = (l.segs ?? []).filter((s): s is typeof s & { box: NBox } => !!s.box).sort((a, b) => a.box.x - b.box.x);
  const out: { text: string; x: number; box: NBox }[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    // Pieces closer than a cell gap are one cell (a text layer often splits a phrase into runs).
    if (prev && s.box.x - (prev.box.x + prev.box.w) < MIN_GAP) {
      prev.text = `${prev.text} ${s.text}`.trim();
      const x1 = Math.max(prev.box.x + prev.box.w, s.box.x + s.box.w);
      prev.box = { x: prev.box.x, y: Math.min(prev.box.y, s.box.y), w: x1 - prev.box.x, h: Math.max(prev.box.h, s.box.h) };
    } else out.push({ text: s.text.trim(), x: s.box.x, box: { ...s.box } });
  }
  return out.filter((p) => p.text);
}

function rowCandidate(l: Line): boolean {
  const p = pieces(l);
  if (p.length < 2) return false;
  if (p.some((x) => OPTION_PIECE.test(`${x.text} `))) return false;
  return !QUESTION_START.test(l.text);
}

/** Shared column starts of a run of rows: x positions used by ≥ 60% of the rows. */
function anchorsOf(rows: { x: number }[][]): number[] {
  const xs = rows.flatMap((r) => r.map((p) => p.x)).sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const x of xs) {
    const c = clusters[clusters.length - 1];
    if (c && x - c[c.length - 1] <= ALIGN) c.push(x);
    else clusters.push([x]);
  }
  return clusters
    .filter((c) => rows.filter((r) => r.some((p) => c[0] - 1e-9 <= p.x && p.x <= c[c.length - 1] + 1e-9)).length >= Math.ceil(rows.length * 0.6))
    .map((c) => c[0]);
}

export function detectTables(lines: Line[]): DetectedTable[] {
  const out: DetectedTable[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!rowCandidate(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && rowCandidate(lines[j + 1]) && (lines[j + 1].column ?? 0) === (lines[i].column ?? 0)) {
      const gap = (lines[j + 1].y ?? 0) - ((lines[j].y ?? 0) + (lines[j].h ?? 0));
      if (gap > Math.max(0.03, (lines[j].h ?? 0.01) * 2.5)) break;
      j++;
    }
    if (j - i + 1 >= 3) {
      const rowPieces = lines.slice(i, j + 1).map(pieces);
      const anchors = anchorsOf(rowPieces);
      if (anchors.length >= 2) {
        const rows = rowPieces.map((r) => {
          const cells = anchors.map(() => [] as string[]);
          for (const p of r) {
            let k = 0;
            while (k + 1 < anchors.length && p.x >= anchors[k + 1] - ALIGN) k++;
            cells[k].push(p.text);
          }
          return cells.map((c) => c.join(" "));
        });
        const boxes = rowPieces.flat().map((p) => p.box);
        const x0 = Math.min(...boxes.map((b) => b.x));
        const y0 = Math.min(...boxes.map((b) => b.y));
        const pad = 0.006;
        const box = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: Math.min(1, Math.max(...boxes.map((b) => b.x + b.w)) - x0 + 2 * pad), h: Math.min(1, Math.max(...boxes.map((b) => b.y + b.h)) - y0 + 2 * pad) };
        out.push({ from: i, to: j, rows, box });
        i = j + 1;
        continue;
      }
    }
    i = j + 1;
  }
  return out;
}

/** A pipe table (first row = header), `|` inside a cell escaped: the shape lib/rich-content.ts renders as a table. */
export function tableMarkdown(rows: string[][]): string {
  const cell = (c: string) => c.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const line = (r: string[]) => `| ${r.map(cell).join(" | ")} |`;
  return [line(rows[0]), `|${rows[0].map(() => "---").join("|")}|`, ...rows.slice(1).map(line)].join("\n");
}
