/**
 * One OCR-read page → documented outcome + questions (pure; the importer and the regression suite run exactly this).
 *
 * Outcomes (stored on AiImportPage.outcome):
 *   OCR             questions read from the OCR text
 *   BLANK_VERIFIED  no OCR text AND almost no ink on the rendered page
 *   INSTRUCTIONS    cover / instructions / rough-work page: explained, holds no questions by design
 *   NO_QUESTIONS    text was read but no numbered question was found — must be checked (blocks completion)
 *   NEEDS_REVIEW    ink on the page but no readable text (a figure-only or unreadable page) — must be checked
 * A page is never "blank" just because a PDF has no text layer.
 */
import { BLANK_INK_BELOW, layoutOcrPage, nonQuestionPage, OCR_REVIEW_BELOW, type OcrPage, type PageLayoutResult } from "@/lib/ai-import/ocr-layout";
import { parsePdfPageLocal } from "@/lib/ai-import/pdf-local";
import type { NumberingState } from "@/lib/ai-import/local-parse";
import type { PageExtraction } from "@/lib/ai-import/types";

export type PageOutcome = "TEXT_LAYER" | "OCR" | "AI" | "BLANK_VERIFIED" | "INSTRUCTIONS" | "NO_QUESTIONS" | "NEEDS_REVIEW" | "FAILED";

/** Outcomes that explain a page fully; any other outcome (or none) keeps a paper from completing. */
export const EXPLAINED_OUTCOMES: readonly PageOutcome[] = ["TEXT_LAYER", "OCR", "AI", "BLANK_VERIFIED", "INSTRUCTIONS"];

export interface OcrPageResult {
  outcome: PageOutcome;
  reason: string;
  layout: PageLayoutResult;
  extraction: (PageExtraction & { preamble: string }) | null;
}

export function readOcrPage(page: OcrPage, pageNumber: number, state: NumberingState): OcrPageResult {
  const layout = layoutOcrPage(page);
  const texts = layout.lines.map((l) => l.text);
  const chars = texts.join("").replace(/\s+/g, "").length;
  if (chars < 3) {
    return page.ink < BLANK_INK_BELOW
      ? { outcome: "BLANK_VERIFIED", reason: `blank: ${(page.ink * 100).toFixed(2)}% ink and no text found by OCR`, layout, extraction: null }
      : { outcome: "NEEDS_REVIEW", reason: `${(page.ink * 100).toFixed(1)}% of the page has ink but OCR found no text — a figure-only or unreadable page; check it`, layout, extraction: null };
  }
  const nq = nonQuestionPage(texts);
  if (nq) return { outcome: "INSTRUCTIONS", reason: nq.why, layout, extraction: null };
  const extraction = parsePdfPageLocal({ lines: layout.lines, images: [] }, pageNumber, state, { gutter: layout.gutter, ocr: { engine: page.engine, reviewBelow: OCR_REVIEW_BELOW } });
  if (!extraction.questions.length) {
    return { outcome: "NO_QUESTIONS", reason: extraction.preamble ? "text was read but no numbered question starts on this page (continuation text only?) — check it" : "text was read but no numbered question was found — check it", layout, extraction };
  }
  const nums = extraction.questions.map((q) => q.number).filter((n): n is number => n !== null);
  return { outcome: "OCR", reason: `${extraction.questions.length} question(s)${nums.length ? ` (Q${Math.min(...nums)}–Q${Math.max(...nums)})` : ""}, OCR confidence ${(layout.meanConfidence * 100).toFixed(1)}%${layout.lowLines ? `, ${layout.lowLines} uncertain line(s)` : ""}`, layout, extraction };
}
