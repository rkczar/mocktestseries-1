/**
 * Small editorial facts the Exam / PreviousYearPaper rows can't hold, keyed
 * by Exam.code: the short name students search with, and officially sourced
 * notes about specific papers. Add a paper note only with an official
 * source: a paper's year label is its recruitment cycle, which can differ
 * from the date the exam was held.
 */

const EXAM_SHORT_NAMES: Record<string, string> = {
  RUHSMO: "RUHS MO",
};

/** "RUHS MO" for RUHSMO; otherwise the caller's fallback (usually the display name without its year). */
export function examShortName(examCode: string, fallback: string): string {
  return EXAM_SHORT_NAMES[examCode] ?? fallback;
}

export interface PaperNote {
  /** Official name of the recruitment exam the paper belongs to. */
  cycle: string;
  /** The date the exam was held, as displayed. */
  heldOn: string;
  /** Short form for titles, e.g. "April 2025". */
  heldMonth: string;
  sourceLabel: string;
  sourceUrl: string;
}

const PAPER_NOTES: Record<string, Record<number, PaperNote>> = {
  RUHSMO: {
    // RUHS's Final Answer Key for MODRE-2024 is headed "Examination date: 27/04/25";
    // 98 of its question stems match this site's 2024 paper (checked 2026-10-04).
    2024: {
      cycle: "MODRE-2024",
      heldOn: "27 April 2025",
      heldMonth: "April 2025",
      sourceLabel: "RUHS Final Answer Key, Medical Officer Direct Recruitment Examination-2024",
      sourceUrl: "https://old.ruhsraj.org/cms/uploads/2025/05/Final_Answer_Key_After_Expert_Opinion__8154.pdf",
    },
  },
};

export function getPaperNote(examCode: string, year: number): PaperNote | null {
  return PAPER_NOTES[examCode]?.[year] ?? null;
}
