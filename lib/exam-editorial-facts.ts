/**
 * Small editorial facts the Exam / PreviousYearPaper rows can't hold, keyed
 * by Exam.code: the short name students search with, and officially sourced
 * notes about specific papers. Add a paper note only with an official
 * source: a paper's year label is its recruitment cycle, which can differ
 * from the date the exam was held.
 */

const EXAM_SHORT_NAMES: Record<string, string> = {
  RUHSMO: "RUHS MO",
  "RUHS-FSO": "Rajasthan FSO",
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

// Rajasthan Food Safety Officer (RPSC). URLs and facts checked against RPSC's listing on 2026-11-12
// (multi-exam FSO audit, findings/06-official-facts.md); the PDFs' SHA-256 are in lib/fso-official.ts.
OFFICIAL_SOURCES["RUHS-FSO"] = [
  {
    label: "Detailed Advertisement No. 11/2022-23, Food Safety Officer (21 Oct 2022)",
    url: "https://rpsc.rajasthan.gov.in/Static/RecruitmentAdvertisements/AEF2AEAF0A7645B785B846E207D99386.pdf",
    note: "The latest FSO advertisement: 200 posts, eligibility, Pay Matrix Level L-11, age limits and the 150-question scheme with 1/3 negative marking.",
  },
  {
    label: "Syllabus, FSO Competitive Exam 2022",
    url: "https://rpsc.rajasthan.gov.in/Static/Syllabus/A07BD974-0617-43FE-9E15-188FA9DCF003.pdf",
    note: "Part A General Knowledge of Rajasthan (40 questions) and Part B Concerned Subject (110 questions).",
  },
  {
    label: "Final Answer Key, FSO Comp. Exam 2022 (29 Jul 2024)",
    url: "https://rpsc.rajasthan.gov.in/Static/AnswerKeys/9EAD9D7D-1B82-4FC5-8FFD-E3C1A8D69E21.pdf",
    note: "Exam held 27-06-2023; questions 16, 43, 50, 72, 106 and 130 deleted.",
  },
  {
    label: "Model Answer Key, FSO Screening Test 2019 (20 Dec 2019)",
    url: "https://rpsc.rajasthan.gov.in/Static/AnswerKeys/BB3447EC-2204-438D-8949-327521A87BF7.pdf",
    note: "Screening test held 25-11-2019; question 71 deleted. No final key for 2019 is listed by RPSC.",
  },
  {
    label: "Rajasthan Public Service Commission (rpsc.rajasthan.gov.in)",
    url: "https://rpsc.rajasthan.gov.in/",
    note: "RPSC publishes every FSO advertisement, exam date, answer key and result. No FSO advertisement has been published after 21-10-2022 (checked 12 Nov 2026).",
  },
];

/** Who the official sources come from, for headings ("Official RUHS notices and sources"). */
const AUTHORITY_SHORT: Record<string, string> = { RUHSMO: "RUHS", "RUHS-FSO": "RPSC" };

export function examAuthorityShort(examCode: string): string | null {
  return AUTHORITY_SHORT[examCode] ?? null;
}

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

PAPER_NOTES["RUHS-FSO"] = {
  // RPSC's Final Answer Key for the FSO Comp. Exam 2022 is headed "Exam Date : 27-06-2023".
  2022: {
    cycle: "FSO Comp. Exam 2022 (Advt. No. 11/2022-23)",
    heldOn: "27 June 2023",
    heldMonth: "June 2023",
    sourceLabel: "RPSC Final Answer Key, FSO Comp. Exam 2022",
    sourceUrl: "https://rpsc.rajasthan.gov.in/Static/AnswerKeys/9EAD9D7D-1B82-4FC5-8FFD-E3C1A8D69E21.pdf",
  },
};

export function getPaperNote(examCode: string, year: number): PaperNote | null {
  return PAPER_NOTES[examCode]?.[year] ?? null;
}
