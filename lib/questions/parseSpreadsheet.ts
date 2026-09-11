import "server-only";

import * as XLSX from "xlsx";

export type RawRow = Record<string, string>;

// Common real-world header variants, normalized to the canonical names used throughout the
// import pipeline. See QUESTION-BANK.md's "Header aliasing" note.
const HEADER_ALIASES: Record<string, string> = {
  "q.no": "QuestionNumber",
  "qno": "QuestionNumber",
  "q no": "QuestionNumber",
  "question number": "QuestionNumber",
  "questionnumber": "QuestionNumber",
  "code": "QuestionCode",
  "question code": "QuestionCode",
  "questioncode": "QuestionCode",
  "exam year": "ExamYear",
  "year": "ExamYear",
  "examyear": "ExamYear",
  "subject": "Subject",
  "topic": "Topic",
  "sub topic": "SubTopic",
  "subtopic": "SubTopic",
  "sub-topic": "SubTopic",
  "question": "Question",
  "question text": "Question",
  "stem": "Question",
  "opt a": "OptionA",
  "option a": "OptionA",
  "optiona": "OptionA",
  "opt b": "OptionB",
  "option b": "OptionB",
  "optionb": "OptionB",
  "opt c": "OptionC",
  "option c": "OptionC",
  "optionc": "OptionC",
  "opt d": "OptionD",
  "option d": "OptionD",
  "optiond": "OptionD",
  "correct answer": "CorrectAnswer",
  "correct": "CorrectAnswer",
  "answer": "CorrectAnswer",
  "correctanswer": "CorrectAnswer",
  "explanation": "Explanation",
  "source": "Source",
  "difficulty": "Difficulty",
  "status": "Status",
};

function normalizeHeader(header: string) {
  const key = header.trim().toLowerCase();
  return HEADER_ALIASES[key] ?? header.trim();
}

/**
 * Parses a CSV or XLSX/XLS buffer into normalized rows. Uses SheetJS (xlsx) for both formats —
 * accepted, admin-only trust boundary (see final report: the public `xlsx` package carries
 * known ReDoS/prototype-pollution advisories with no patched release on npm; this endpoint is
 * gated behind admin auth + file-type/size validation, not exposed to public uploads).
 */
export function parseSpreadsheet(buffer: Buffer, fileName: string): RawRow[] {
  const isCsv = fileName.toLowerCase().endsWith(".csv");
  const workbook = isCsv
    ? XLSX.read(buffer.toString("utf-8"), { type: "string" })
    : XLSX.read(buffer, { type: "buffer" });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

  return rows.map((row) => {
    const normalized: RawRow = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[normalizeHeader(key)] = String(value ?? "").trim();
    }
    return normalized;
  });
}
