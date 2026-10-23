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

/**
 * Exams whose stored exam date is not yet officially confirmed. While listed, the
 * homepage shows the date as "tentative". Remove the code once the conducting
 * authority publishes the date (admit card or official schedule).
 */
const TENTATIVE_EXAM_DATES = new Set<string>(["RUHSMO"]);

export function isExamDateTentative(examCode: string): boolean {
  return TENTATIVE_EXAM_DATES.has(examCode);
}

export interface OfficialSource {
  label: string;
  url: string;
  /** What the source confirms, in one line. */
  note: string;
}

/** Official pages and documents for an exam, each checked by hand before it is listed here. */
const OFFICIAL_SOURCES: Record<string, OfficialSource[]> = {
  RUHSMO: [
    {
      label: "Recruitment notification, Medical Officer Direct Recruitment Examination 2026 (ref. 2026/1173, 13 Aug 2026)",
      url: "https://old.ruhsraj.org/cms/uploads/2026/08/MO_600_2435.pdf",
      note: "600 posts of Medical Officer (Medical), the category-wise split, MBBS with Rajasthan Medical Council registration by the date of the written exam, and the 14 Sep–13 Oct 2026 application window.",
    },
    {
      label: "RUHS Medical Officer recruitment portal",
      url: "https://ruhsmomedical.com/",
      note: "Online applications (now closed). Admit cards and exam updates are expected here and on ruhsraj.org.",
    },
    {
      label: "Rajasthan University of Health Sciences (ruhsraj.org)",
      url: "https://ruhsraj.org/",
      note: "The notification directs candidates to this site for all future notices.",
    },
    {
      label: "Final Answer Key, Medical Officer Direct Recruitment Examination 2024",
      url: "https://old.ruhsraj.org/cms/uploads/2025/05/Final_Answer_Key_After_Expert_Opinion__8154.pdf",
      note: "The previous cycle's paper (MODRE-2024), held on 27 April 2025.",
    },
  ],
};

export function getOfficialSources(examCode: string): OfficialSource[] {
  return OFFICIAL_SOURCES[examCode] ?? [];
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
