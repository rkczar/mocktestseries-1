/**
 * Officially sourced facts for the two Rajasthan Food Safety Officer papers (RPSC). Every value here is
 * transcribed from an RPSC document whose SHA-256 is recorded below (files supplied by the owner on
 * 2026-11-12 are byte-identical to RPSC's published copies). Nothing is inferred: if a fact is not in
 * these documents it is not in this file. Used by the paper PDF builder (answer-key appendix,
 * deleted-question labels) and the FSO public pages.
 *
 * Answer keys use RPSC's numbering 1–4 ("RES"); 0 = deleted by RPSC ("*" in the key).
 */

export interface FsoPaperFacts {
  year: number;
  examName: string;
  bookletCode: string;
  heldOn: string; // DD-MM-YYYY as printed
  durationMinutes: number;
  totalQuestions: number;
  totalMarks: number;
  negativeMarking: string;
  keyType: "MODEL" | "FINAL";
  keyIssuedOn: string;
  keyLabel: string;
  deleted: number[];
  /** 150 entries, index 0 = Q1. */
  answers: number[];
  sources: { label: string; sha256: string }[];
  /**
   * Printed question numbers whose question is stored ONCE in the bank under another paper (the
   * identical question appeared in both papers). Source: production question-bank audit 2026-11-12
   * (2022 Q92 = 2019 Q43), not an RPSC document; the builder prints the stored question at this number.
   */
  reused?: Record<number, { year: number; question: number }>;
}

const parseKey = (s: string) => s.trim().split(/\s+/).map((t) => (t === "*" ? 0 : Number(t)));

export const FSO_PAPERS: Record<2019 | 2022, FsoPaperFacts> = {
  2019: {
    year: 2019,
    examName: "Food Safety Officer Screening Test 2019",
    bookletCode: "OSF-91",
    heldOn: "25-11-2019",
    durationMinutes: 180,
    totalQuestions: 150,
    totalMarks: 150,
    negativeMarking: "One-third (1/3) of the marks of a question for each wrong answer",
    keyType: "MODEL",
    keyIssuedOn: "20-12-2019",
    keyLabel: "RPSC Model Answer Key, issued 20-12-2019 (provisional)",
    deleted: [71],
    answers: parseKey(`
      4 4 4 1 3 3 4 1 3 1 1 1 2 4 1 1 2 1 3 2 4 2 3 2 3
      4 2 1 3 3 4 1 2 3 1 4 2 3 2 3 4 3 2 3 3 2 1 1 1 1
      2 3 4 1 3 3 1 4 3 1 1 1 3 2 1 2 1 2 1 1 * 1 4 2 3
      1 3 2 2 1 1 2 3 1 3 1 3 4 4 3 3 3 2 2 4 3 4 2 4 3
      1 1 1 3 4 1 2 3 1 2 4 4 1 3 3 1 4 3 3 4 3 2 1 2 2
      4 2 4 4 3 2 3 4 4 3 1 4 4 1 2 1 1 3 3 1 1 4 1 1 2`),
    sources: [{ label: "RPSC FSO Screening Test-2019 Model Key (20-12-2019)", sha256: "4d043998134bf2461dd8e3f10841076eb6bec4acf84ca6824ecd3458424b9dec" }],
  },
  2022: {
    year: 2022,
    examName: "Food Safety Officer (Medical and Health Services Deptt.) Comp. Exam 2022 — G.K. and Concerned Subject",
    bookletCode: "OSF-32",
    heldOn: "27-06-2023",
    durationMinutes: 150,
    totalQuestions: 150,
    totalMarks: 150,
    negativeMarking: "One-third (1/3) of the marks of a question for each wrong answer",
    keyType: "FINAL",
    keyIssuedOn: "29-07-2024",
    keyLabel: "RPSC Final Answer Key, published 29-07-2024",
    deleted: [16, 43, 50, 72, 106, 130],
    reused: { 92: { year: 2019, question: 43 } },
    answers: parseKey(`
      2 1 4 3 4 2 1 3 3 2 2 3 4 3 2 * 2 4 2 2 4 1 3 4 3 1 2 4 3 3 3 1 1 3 3 2 1 4 1 3 3 3 * 4 2 4 2 2 4 *
      2 2 2 2 2 1 3 2 3 3 3 1 4 4 1 1 1 4 2 1 4 * 3 3 3 4 1 1 4 3 4 2 4 3 4 1 3 1 3 4 1 1 2 1 4 2 1 1 2 2
      2 4 2 3 4 * 4 1 2 1 1 4 3 4 2 2 4 3 4 3 1 2 4 4 4 2 3 3 3 * 2 4 1 2 3 4 4 3 2 2 2 1 2 3 1 1 1 2 1 2`),
    sources: [
      { label: "RPSC FSO Comp. Exam 2022 Final Answer Key (29-07-2024)", sha256: "8b632053c026794c0d508da40020ae67ddfc4c15ebff2c2918c538a8c17dcfbe" },
      { label: "RPSC FSO 2022 question booklet OSF-32 (uploaded on rpsc.rajasthan.gov.in)", sha256: "38e4819eae9f7e146439ffcf0fc135f88eb4e67904e1387c4ee413c818f941cf" },
    ],
  },
};

export function fsoPaperFacts(year: number): FsoPaperFacts | null {
  return year === 2019 || year === 2022 ? FSO_PAPERS[year] : null;
}
