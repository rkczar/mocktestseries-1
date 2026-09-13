import "server-only";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { QuestionDifficulty, QuestionStatus, QuestionSource, type Prisma } from "@prisma/client";
import { normalizeQuestionCodeExamCode, questionCodeScope } from "./question-code";

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export interface BulkImportRow {
  rowNumber: number;
  exam: string;
  examYear: string;
  questionCode?: string;
  subject: string;
  topic: string;
  subTopic: string;
  source: string;
  questionText: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: string;
  explanation?: string;
  difficulty: string;
  image?: string;
  status: string;
}

export interface ParsedImportRow {
  rowNumber: number;
  data: BulkImportRow;
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidatedImportRow extends ParsedImportRow {
  resolvedData?: {
    examId: string;
    examCode: string;
    examYear: number;
    subjectId: string;
    topicId: string | null;
    subTopicId: string | null;
    previousYearPaperId: string | null;
    difficulty: QuestionDifficulty;
    status: QuestionStatus;
    source: QuestionSource;
    isDuplicate: boolean;
    duplicateQuestionId?: string;
  };
}

export interface ImportValidationResult {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  rows: ValidatedImportRow[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Column Mapping
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  "exam",
  "examYear",
  "subject",
  "topic",
  "subTopic",
  "source",
  "questionText",
  "optionA",
  "optionB",
  "optionC",
  "optionD",
  "correctAnswer",
  "difficulty",
  "status",
] as const;

const COLUMN_ALIASES: Record<string, string[]> = {
  exam: ["exam", "exam_name", "examination"],
  examYear: ["examYear", "exam_year", "year"],
  questionCode: ["questionCode", "question_code", "code"],
  subject: ["subject", "subject_name"],
  topic: ["topic", "topic_name"],
  subTopic: ["subTopic", "sub_topic", "subtopic"],
  source: ["source"],
  questionText: ["questionText", "question_text", "question", "text"],
  optionA: ["optionA", "option_a", "a"],
  optionB: ["optionB", "option_b", "b"],
  optionC: ["optionC", "option_c", "c"],
  optionD: ["optionD", "option_d", "d"],
  correctAnswer: ["correctAnswer", "correct_answer", "answer", "correct"],
  explanation: ["explanation"],
  difficulty: ["difficulty", "level"],
  image: ["image", "image_url", "imageUrl"],
  status: ["status"],
};

function normalizeColumnName(header: string): string {
  const normalized = header.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.some(alias => alias.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized)) {
      return key;
    }
  }

  return header;
}

// ---------------------------------------------------------------------------
// File Parsing
// ---------------------------------------------------------------------------

export async function parseImportFile(
  file: File
): Promise<{ rows: BulkImportRow[]; errors: string[] }> {
  const errors: string[] = [];
  const filename = file.name.toLowerCase();

  try {
    if (filename.endsWith(".csv")) {
      return await parseCSV(file);
    } else if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
      return await parseExcel(file);
    } else {
      errors.push("Unsupported file format. Please upload CSV, XLS, or XLSX files.");
      return { rows: [], errors };
    }
  } catch (error) {
    errors.push(`Failed to parse file: ${error instanceof Error ? error.message : "Unknown error"}`);
    return { rows: [], errors };
  }
}

async function parseCSV(file: File): Promise<{ rows: BulkImportRow[]; errors: string[] }> {
  const errors: string[] = [];
  const text = await file.text();

  return new Promise((resolve) => {
    Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeColumnName,
      complete: (results: Papa.ParseResult<Record<string, string>>) => {
        const rows = results.data
          .map((row, index) => mapRowData(row, index + 2)) // +2 for header + 1-indexed
          .filter((row): row is BulkImportRow => row !== null);

        if (results.errors.length > 0) {
          errors.push(...results.errors.map((e: Papa.ParseError) => `Row ${e.row}: ${e.message}`));
        }

        resolve({ rows, errors });
      },
      error: (error: Error) => {
        errors.push(`CSV parsing error: ${error.message}`);
        resolve({ rows: [], errors });
      },
    });
  });
}

async function parseExcel(file: File): Promise<{ rows: BulkImportRow[]; errors: string[] }> {
  const errors: string[] = [];
  const buffer = await file.arrayBuffer();

  try {
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

    if (!firstSheet) {
      errors.push("No sheets found in Excel file.");
      return { rows: [], errors };
    }

    const jsonData = XLSX.utils.sheet_to_json<unknown>(firstSheet, {
      header: 1,
      defval: "",
    }) as unknown[][];

    if (jsonData.length < 2) {
      errors.push("Excel file must contain at least a header row and one data row.");
      return { rows: [], errors };
    }

    const headers = jsonData[0].map((h: unknown) => normalizeColumnName(String(h)));
    const rows: BulkImportRow[] = [];

    for (let i = 1; i < jsonData.length; i++) {
      const rowData: Record<string, string> = {};
      headers.forEach((header: string, index: number) => {
        rowData[header] = String((jsonData[i] as unknown[])[index] ?? "").trim();
      });

      const mapped = mapRowData(rowData, i + 1);
      if (mapped) {
        rows.push(mapped);
      }
    }

    return { rows, errors };
  } catch (error) {
    errors.push(`Excel parsing error: ${error instanceof Error ? error.message : "Unknown error"}`);
    return { rows: [], errors };
  }
}

function mapRowData(row: Record<string, string>, rowNumber: number): BulkImportRow | null {
  // Skip completely empty rows
  if (Object.values(row).every((val) => !val || val.trim() === "")) {
    return null;
  }

  return {
    rowNumber,
    exam: row.exam?.trim() || "",
    examYear: row.examYear?.trim() || "",
    questionCode: row.questionCode?.trim() || undefined,
    subject: row.subject?.trim() || "",
    topic: row.topic?.trim() || "",
    subTopic: row.subTopic?.trim() || "",
    source: row.source?.trim() || "",
    questionText: row.questionText?.trim() || "",
    optionA: row.optionA?.trim() || "",
    optionB: row.optionB?.trim() || "",
    optionC: row.optionC?.trim() || "",
    optionD: row.optionD?.trim() || "",
    correctAnswer: row.correctAnswer?.trim().toUpperCase() || "",
    explanation: row.explanation?.trim() || undefined,
    difficulty: row.difficulty?.trim() || "",
    image: row.image?.trim() || undefined,
    status: row.status?.trim() || "",
  };
}

// ---------------------------------------------------------------------------
// Row Validation
// ---------------------------------------------------------------------------

export function validateImportRows(rows: BulkImportRow[]): ParsedImportRow[] {
  return rows.map((row) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!row.exam) errors.push("Exam is required");
    if (!row.examYear) errors.push("Exam Year is required");
    else if (!/^\d{4}$/.test(row.examYear)) errors.push("Exam Year must be a 4-digit year");
    if (!row.subject) errors.push("Subject is required");
    if (!row.topic) errors.push("Topic is required");
    if (!row.subTopic) errors.push("Sub-topic is required");
    if (!row.source) errors.push("Source is required");
    if (!row.questionText) errors.push("Question Text is required");
    if (!row.optionA) errors.push("Option A is required");
    if (!row.optionB) errors.push("Option B is required");
    if (!row.optionC) errors.push("Option C is required");
    if (!row.optionD) errors.push("Option D is required");

    // Correct answer validation
    if (!row.correctAnswer) {
      errors.push("Correct Answer is required");
    } else if (!["A", "B", "C", "D"].includes(row.correctAnswer)) {
      errors.push("Correct Answer must be A, B, C, or D");
    }

    // Difficulty validation
    if (!row.difficulty) {
      errors.push("Difficulty is required");
    } else if (!["EASY", "MEDIUM", "HARD"].includes(row.difficulty.toUpperCase())) {
      errors.push("Difficulty must be EASY, MEDIUM, or HARD");
    }

    // Status validation
    if (!row.status) {
      warnings.push("Status not provided, will default to DRAFT");
    } else if (!["DRAFT", "PUBLISHED", "ARCHIVED"].includes(row.status.toUpperCase())) {
      errors.push("Status must be DRAFT, PUBLISHED, or ARCHIVED");
    }

    return {
      rowNumber: row.rowNumber,
      data: row,
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Database Validation (Hierarchy Resolution)
// ---------------------------------------------------------------------------

type ValidationDb = Pick<
  Prisma.TransactionClient,
  "exam" | "subject" | "topic" | "subTopic" | "previousYearPaper" | "question"
>;

export async function validateWithDatabase(
  db: ValidationDb,
  parsedRows: ParsedImportRow[]
): Promise<ImportValidationResult> {
  const validatedRows: ValidatedImportRow[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  const globalWarnings: string[] = [];

  // Fetch all exams, subjects, topics, subtopics, and papers for efficient lookups
  const [exams, subjects, topics, subTopics, papers] = await Promise.all([
    db.exam.findMany({ select: { id: true, name: true, code: true, year: true } }),
    db.subject.findMany({ select: { id: true, name: true, examId: true } }),
    db.topic.findMany({ select: { id: true, name: true, subjectId: true } }),
    db.subTopic.findMany({ select: { id: true, name: true, topicId: true } }),
    db.previousYearPaper.findMany({ select: { id: true, examId: true, year: true, title: true } }),
  ]);

  const examsByName = new Map(exams.map((e) => [e.name.toLowerCase(), e]));
  const subjectsByExamAndName = new Map<string, typeof subjects[0]>();
  subjects.forEach((s) => {
    subjectsByExamAndName.set(`${s.examId}:${s.name.toLowerCase()}`, s);
  });
  const topicsBySubjectAndName = new Map<string, typeof topics[0]>();
  topics.forEach((t) => {
    topicsBySubjectAndName.set(`${t.subjectId}:${t.name.toLowerCase()}`, t);
  });
  const subTopicsByTopicAndName = new Map<string, typeof subTopics[0]>();
  subTopics.forEach((st) => {
    subTopicsByTopicAndName.set(`${st.topicId}:${st.name.toLowerCase()}`, st);
  });

  for (const parsedRow of parsedRows) {
    const validated: ValidatedImportRow = { ...parsedRow };

    if (!parsedRow.isValid) {
      invalidCount++;
      validatedRows.push(validated);
      continue;
    }

    const { data } = parsedRow;
    const errors: string[] = [...parsedRow.errors];
    const warnings: string[] = [...parsedRow.warnings];

    // Resolve exam
    const exam = examsByName.get(data.exam.toLowerCase());
    if (!exam) {
      errors.push(`Exam "${data.exam}" not found`);
      invalidCount++;
      validated.isValid = false;
      validated.errors = errors;
      validatedRows.push(validated);
      continue;
    }

    // Resolve subject (must belong to exam)
    const subject = subjectsByExamAndName.get(`${exam.id}:${data.subject.toLowerCase()}`);
    if (!subject) {
      errors.push(`Subject "${data.subject}" not found for exam "${data.exam}"`);
      invalidCount++;
      validated.isValid = false;
      validated.errors = errors;
      validatedRows.push(validated);
      continue;
    }

    // Resolve topic (must belong to subject)
    const topic = topicsBySubjectAndName.get(`${subject.id}:${data.topic.toLowerCase()}`);
    if (!topic) {
      errors.push(`Topic "${data.topic}" not found for subject "${data.subject}"`);
      invalidCount++;
      validated.isValid = false;
      validated.errors = errors;
      validatedRows.push(validated);
      continue;
    }

    // Resolve subtopic (must belong to topic)
    const subTopic = subTopicsByTopicAndName.get(`${topic.id}:${data.subTopic.toLowerCase()}`);
    if (!subTopic) {
      errors.push(`Sub-topic "${data.subTopic}" not found for topic "${data.topic}"`);
      invalidCount++;
      validated.isValid = false;
      validated.errors = errors;
      validatedRows.push(validated);
      continue;
    }

    const examYear = parseInt(data.examYear, 10);
    const difficulty = data.difficulty.toUpperCase() as QuestionDifficulty;
    const status = (data.status?.toUpperCase() || "DRAFT") as QuestionStatus;

    // Resolve PYQ paper if source indicates it's a PYQ
    let previousYearPaperId: string | null = null;
    let source: QuestionSource = QuestionSource.QUESTION_BANK;

    if (data.source.toUpperCase() === "PYQ" || data.source.toLowerCase().includes("previous year")) {
      source = QuestionSource.PYQ;
      const paper = papers.find((p) => p.examId === exam.id && p.year === examYear);
      if (paper) {
        previousYearPaperId = paper.id;
      } else {
        warnings.push(`No PYQ paper found for ${exam.name} ${examYear}, will create as QUESTION_BANK`);
        source = QuestionSource.QUESTION_BANK;
      }
    }

    // Check for duplicate by text content (simple check for now)
    const existingQuestion = await db.question.findFirst({
      where: {
        examId: exam.id,
        subjectId: subject.id,
        text: data.questionText,
      },
      select: { id: true, code: true },
    });

    const isDuplicate = !!existingQuestion;
    if (isDuplicate) {
      duplicateCount++;
      warnings.push(`Duplicate found: ${existingQuestion!.code}`);
    }

    validated.resolvedData = {
      examId: exam.id,
      examCode: exam.code,
      examYear,
      subjectId: subject.id,
      topicId: topic.id,
      subTopicId: subTopic.id,
      previousYearPaperId,
      difficulty,
      status,
      source,
      isDuplicate,
      duplicateQuestionId: existingQuestion?.id,
    };

    validated.errors = errors;
    validated.warnings = warnings;
    validCount++;
    validatedRows.push(validated);
  }

  return {
    total: parsedRows.length,
    valid: validCount,
    invalid: invalidCount,
    duplicates: duplicateCount,
    rows: validatedRows,
    warnings: globalWarnings,
  };
}
