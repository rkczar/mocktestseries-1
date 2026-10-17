/**
 * Local extraction of one digital PDF page (text layer + embedded images)
 * into questions, including deterministic figure ↔ stem/option mapping from
 * positions. Pure: the caller supplies the layout read by lib/ai-import/pdf.ts.
 */
import { blockToQuestion, markersOf, orderSegments, scriptFragments, splitQuestions, type Line, type NumberingState } from "@/lib/ai-import/local-parse";
import type { ExtractedFigure, ExtractedQuestion, NBox, PageExtraction } from "@/lib/ai-import/types";

export interface LocalLayout {
  lines: { text: string; box: NBox }[];
  images: { box: NBox }[];
}

interface Positioned {
  q: ExtractedQuestion;
  column: number;
  yStart: number;
  yEnd: number;
  markers: { label: string; x: number; y: number; h: number }[];
  family: string | null;
}

export function parsePdfPageLocal(layout: LocalLayout, page: number, state: NumberingState): PageExtraction & { preamble: string } {
  const segs = layout.lines.map((l) => ({ text: l.text, box: l.box }));
  const lines: Line[] = orderSegments(segs);
  const { blocks, preamble } = splitQuestions(lines, state);
  const reasons: string[] = [];
  const fragments = scriptFragments(segs);
  if (fragments > 0) reasons.push(`${fragments} small text fragment(s) look like subscripts/superscripts the text layer flattened`);

  const positioned: Positioned[] = blocks.map((b, i) => {
    const { q, split } = blockToQuestion(b, page, "LOCAL_PDF");
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
    if (q.confidence < 0.9) reasons.push(`Q${q.label}: ${q.notes?.join(" ") || "low confidence"}`);
    if (q.figures.some((f) => f.confidence < 0.8)) reasons.push(`Q${q.label}: a figure's position does not show clearly which part it belongs to`);
    if (q.type === "OTHER") reasons.push(`Q${q.label}: question type could not be recognized`);
  }
  return { questions, reliable: reasons.length === 0, reasons, preamble: preamble.join("\n").trim() };
}
