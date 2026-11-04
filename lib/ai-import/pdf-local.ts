/**
 * Local extraction of one digital PDF page (text layer + embedded images)
 * into questions, including deterministic figure ↔ stem/option mapping from
 * positions. Pure: the caller supplies the layout read by lib/ai-import/pdf.ts.
 */
import { UNNUMBERED, blockToQuestion, markersOf, orderSegments, scriptFragments, splitQuestions, type Line, type NumberingState } from "@/lib/ai-import/local-parse";
import type { ExtractedFigure, ExtractedQuestion, NBox, PageExtraction } from "@/lib/ai-import/types";

export interface LocalLayout {
  lines: { text: string; box: NBox; conf?: number }[];
  images: { box: NBox }[];
}

/** How the page's lines were obtained: the PDF's own text layer (default) or local OCR of the rendered page. */
export interface LocalParseOptions {
  /** Measured column gutter of an OCR page (null = one column); undefined keeps the text-layer heuristic. */
  gutter?: number | null;
  ocr?: { engine: string; reviewBelow: number } | null;
}

interface Positioned {
  q: ExtractedQuestion;
  column: number;
  yStart: number;
  yEnd: number;
  markers: { label: string; x: number; y: number; h: number }[];
  family: string | null;
}

export function parsePdfPageLocal(layout: LocalLayout, page: number, state: NumberingState, opts: LocalParseOptions = {}): PageExtraction & { preamble: string } {
  const ocr = opts.ocr ?? null;
  const segs = layout.lines.map((l) => ({ text: l.text, box: l.box, ...(l.conf !== undefined ? { conf: l.conf } : {}) }));
  const lines: Line[] = orderSegments(segs, opts.gutter);
  const { blocks, preamble } = splitQuestions(lines, state);
  const reasons: string[] = [];
  // Sub/superscript size heuristics describe a PDF text layer, not OCR lines.
  const fragments = ocr ? 0 : scriptFragments(segs);
  if (fragments > 0) reasons.push(`${fragments} small text fragment(s) look like subscripts/superscripts the text layer flattened`);

  const positioned: Positioned[] = blocks.map((b, i) => {
    const { q, split } = blockToQuestion(b, page, ocr ? "LOCAL_OCR" : "LOCAL_PDF");
    if (b.label === UNNUMBERED) {
      q.number = null;
      q.label = `p${page}-${i + 1}-unnumbered`;
      q.confidence = Math.min(q.confidence, 0.5);
      q.notes = [...(q.notes ?? []), `The printed question number was not read (a new column on page ${page} starts here); set the number before importing.`];
    }
    if (ocr) {
      // The original OCR reading of this question (number and labels included, exactly as read), kept apart from
      // the cleaned stem/options; uncertain lines are listed for review, never "fixed" here.
      const segsOf = b.lines.flatMap((l) => l.segs ?? []);
      const confs = segsOf.map((x) => x.conf ?? 1);
      q.ocr = {
        engine: ocr.engine,
        text: b.lines.map((l) => (l.segs?.length ? l.segs.map((x) => x.text).join("  ") : l.text)).join("\n"),
        minConfidence: confs.length ? Math.min(...confs) : 0,
        meanConfidence: confs.length ? Math.round((confs.reduce((a, c) => a + c, 0) / confs.length) * 10000) / 10000 : 0,
        lowLines: segsOf.filter((x) => (x.conf ?? 1) < ocr.reviewBelow).map((x) => ({ text: x.text, confidence: x.conf ?? 0 })),
      };
      const boxes = segsOf.filter((x) => x.box).map((x) => x.box!);
      if (boxes.length) {
        const x0 = Math.min(...boxes.map((x) => x.x));
        const y0 = Math.min(...boxes.map((x) => x.y));
        q.region = { x: x0, y: y0, w: Math.max(...boxes.map((x) => x.x + x.w)) - x0, h: Math.max(...boxes.map((x) => x.y + x.h)) - y0 };
      }
      if (q.ocr.lowLines.length) q.notes = [...(q.notes ?? []), `OCR is unsure of ${q.ocr.lowLines.length} line(s): ${q.ocr.lowLines.map((x) => `“${x.text.slice(0, 60)}” (${Math.round(x.confidence * 100)}%)`).join("; ")} — check them against the page.`];
    }
    const first = b.lines[0];
    const column = first.column ?? 0;
    const next = blocks.slice(i + 1).find((x) => (x.lines[0].column ?? 0) === column);
    const markers: Positioned["markers"] = [];
    if (split.family) {
      for (const line of b.lines) {
        for (const seg of line.segs ?? []) {
          if (!seg.box) continue;
          for (const m of markersOf(seg.text)) {
            if (m.family !== split.family) continue;
            const frac = seg.text.length ? m.start / seg.text.length : 0;
            markers.push({ label: String.fromCharCode(65 + m.index), x: seg.box.x + frac * seg.box.w, y: seg.box.y, h: seg.box.h });
          }
        }
      }
    }
    return { q, column, yStart: first.y ?? 0, yEnd: next ? (next.lines[0].y ?? 1) : 1, markers, family: split.family };
  });

  // Figures: embedded images assigned by position.
  layout.images.forEach((img, index) => {
    const cx = img.box.x + img.box.w / 2;
    const cy = img.box.y + img.box.h / 2;
    const twoCols = positioned.some((p) => p.column === 1);
    const col = twoCols && cx >= 0.5 ? 1 : 0;
    const host = positioned.find((p) => p.column === col && cy >= p.yStart - 0.005 && cy < p.yEnd);
    if (!host) {
      // Not inside any question block on this page (header figure, shared diagram, continuation).
      const target = positioned.find((p) => p.column === col && p.yStart > cy) ?? positioned[0];
      if (target) target.q.figures.push({ owner: "UNASSIGNED", embeddedIndex: index, box: img.box, confidence: 0.3, description: "Figure outside any question block" });
      else reasons.push("A figure on this page could not be linked to any question");
      return;
    }
    const fig: ExtractedFigure = { owner: "STEM", embeddedIndex: index, box: img.box, confidence: 0.9 };
    const ms = host.markers.sort((a, b) => a.y - b.y || a.x - b.x);
    const top = img.box.y;
    const bottom = img.box.y + img.box.h;
    // In the option area when below the first option label, or sharing a row with any option label.
    if (ms.length && (cy > ms[0].y - 0.002 || ms.some((m) => m.y + m.h >= top && m.y <= bottom))) {
      const sameRow = ms.filter((m) => m.y + m.h >= top && m.y <= bottom);
      const leftOf = sameRow.filter((m) => m.x <= img.box.x + 0.02).sort((a, b) => b.x - a.x);
      if (leftOf.length) {
        fig.owner = "OPTION";
        fig.optionLabel = leftOf[0].label;
        fig.confidence = 0.85;
      } else {
        const above = ms.filter((m) => m.y <= top).sort((a, b) => b.y - a.y || b.x - a.x);
        if (above.length) {
          fig.owner = "OPTION";
          fig.optionLabel = above[0].label;
          fig.confidence = 0.7;
        } else {
          fig.confidence = 0.6;
        }
      }
    }
    host.q.figures.push(fig);
  });

  for (const p of positioned) {
    const q = p.q;
    // An option with no text needs an image of its own.
    const imageOptions = new Set(q.figures.filter((f) => f.owner === "OPTION").map((f) => f.optionLabel));
    for (const o of q.options) if (!o.text && !imageOptions.has(o.label)) q.confidence = Math.min(q.confidence, 0.4);
    if (q.options.length && q.options.every((o) => o.text || imageOptions.has(o.label)) && q.notes?.length === 1 && q.notes[0].startsWith("An option has no text")) {
      q.notes = [];
      q.confidence = Math.max(q.confidence, 0.9);
    }
    if (fragments > 0) {
      q.confidence = Math.min(q.confidence, 0.7);
      q.notes = [...(q.notes ?? []), "Subscripts/superscripts may have been flattened by the PDF text layer."];
    }
  }

  const questions = positioned.map((p) => p.q);
  if (!questions.length && layout.lines.length > 3) reasons.push("No numbered questions were recognized on this page");
  for (const q of questions) {
    // OCR uncertainty alone is a review flag on the question (post.ts OCR_UNCERTAIN), not a reason to re-read the page.
    if (q.confidence < 0.9) reasons.push(`Q${q.label}: ${q.notes?.filter((n) => !n.startsWith("OCR is unsure")).join(" ") || "low confidence"}`);
    if (q.figures.some((f) => f.confidence < 0.8)) reasons.push(`Q${q.label}: a figure's position does not show clearly which part it belongs to`);
    if (q.type === "OTHER") reasons.push(`Q${q.label}: question type could not be recognized`);
  }
  return { questions, reliable: reasons.length === 0, reasons, preamble: preamble.join("\n").trim() };
}

/**
 * Text before the first question on a page continues the previous page's last question when that question has no
 * complete option list yet: the two are read again as one block (same rule for text-layer and OCR pages).
 * Returns the joined question, or null when the previous question is complete or there is no such text.
 */
/**
 * Text before the first numbered question of a page whose previous question is already complete, and which holds a
 * complete option list itself: a question whose printed number was not read. It is kept as an UNNUMBERED question
 * (never given a guessed number) so it is not lost; the completeness check still reports the missing number.
 */
export function orphanQuestion(previous: ExtractedQuestion | null, preamble: string, page: number, method: string, ocr?: { engine: string; minConfidence: number; meanConfidence: number } | null): ExtractedQuestion | null {
  if (!preamble.trim() || (previous && previous.options.length < 4)) return null;
  const { q } = blockToQuestion({ section: previous?.section ?? "", number: 0, label: `p${page}-unnumbered`, lines: [], text: preamble }, page, method);
  if (q.options.length < 4 || !q.stem.trim()) return null;
  q.number = null;
  q.confidence = Math.min(q.confidence, 0.5);
  // Its original OCR text is the page text before the first numbered question (confidences are the page's).
  if (ocr) q.ocr = { engine: ocr.engine, text: preamble, minConfidence: ocr.minConfidence, meanConfidence: ocr.meanConfidence, lowLines: [] };
  q.notes = [...(q.notes ?? []), `The printed question number was not read at the top of page ${page}${previous?.number ? ` (after Q${previous.number})` : ""}; set the number before importing.`];
  return q;
}

export function joinPreamble(previous: ExtractedQuestion | null, preamble: string, page: number): ExtractedQuestion | null {
  if (!preamble || !previous || previous.options.length >= 4) return null;
  const merged = blockToQuestion({ section: previous.section, number: previous.number ?? 0, label: previous.label, lines: [], text: `${previous.stem}\n${previous.options.map((o) => `${o.printed} ${o.text}`).join("  ")}\n${preamble}` }, previous.pages[0], previous.method);
  merged.q.pages = [...new Set([...previous.pages, page])];
  merged.q.figures = previous.figures;
  merged.q.notes = [...(merged.q.notes ?? []), "Continues from the previous page."];
  if (previous.ocr) merged.q.ocr = { ...previous.ocr, text: `${previous.ocr.text}\n${preamble}` };
  if (previous.region) merged.q.region = previous.region;
  return merged.q;
}
