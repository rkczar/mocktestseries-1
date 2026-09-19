import "server-only";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import {
  QuestionDifficulty,
  QuestionStatus,
  QuestionSource,
  ImportRowSeverity,
  type Prisma,
} from "@prisma/client";

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export interface BulkImportRow {
  rowNumber: number;
  exam: string;
  examYear: string;
  questionCode?: string;
  /** Optional dedup aid: the question's number within its source paper. */
  questionNumber?: string;
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
  /** Legacy generic image reference (URL or filename), kept for backward compat. */
  image?: string;
  questionImageFilename?: string;
  optionAImageFilename?: string;
  optionBImageFilename?: string;
  optionCImageFilename?: string;
  optionDImageFilename?: string;
  status: string;
}

export interface ParsedImportRow {
  rowNumber: number;
  data: BulkImportRow;
  /** Pre-database shape validation severity. Refined further by validateWithDatabase/resolveRow. */
  severity: ImportRowSeverity;
  /** Derived convenience flag: true whenever severity !== ERROR. */
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/** A Subject/Topic/SubTopic name from the file that didn't match an existing row. */
export interface UnmappedTaxonomy {
  field: "subject" | "topic" | "subTopic";
  value: string;
}

export interface ResolvedRowData {
  examId: string;
  examCode: string;
  examYear: number;
  /** Null when the Subject name from the file is unmapped — blocks actual Question creation until mapped. */
  subjectId: string | null;
  /** Topic/SubTopic are optional on Question, so unmapped here never blocks import. */
  topicId: string | null;
  subTopicId: string | null;
  previousYearPaperId: string | null;
  difficulty: QuestionDifficulty;
  status: QuestionStatus;
  source: QuestionSource;
  isDuplicate: boolean;
  duplicateQuestionId?: string;
  /** Human-readable reason, e.g. "Same Question Code", "Same paper/question number", "Potential duplicate text". */
  duplicateReason?: string;
}

export interface ValidatedImportRow extends ParsedImportRow {
  resolvedData?: ResolvedRowData;
  unmapped: UnmappedTaxonomy[];
  reviewRequired: boolean;
  /** Per-declared-image-column FOUND/MISSING result, when an image index was supplied. */
  imageMatches?: RowImageMatch[];
}

export interface ImportValidationResult {
  total: number;
  valid: number;
  invalid: number;
  warningCount: number;
  duplicates: number;
  reviewRequiredCount: number;
  rows: ValidatedImportRow[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Column Mapping
// ---------------------------------------------------------------------------

const COLUMN_ALIASES: Record<string, string[]> = {
  exam: ["exam", "exam_name", "examination"],
  examYear: ["examYear", "exam_year", "year"],
  questionCode: ["questionCode", "question_code", "code"],
  questionNumber: ["questionNumber", "question_number", "qno", "q_no", "paperquestionnumber", "paper_question_number"],
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
  questionImageFilename: [
    "questionImageFilename",
    "question_image_filename",
    "questionimage",
    "question_image",
  ],
  optionAImageFilename: [
    "optionAImageFilename",
    "option_a_image_filename",
    "optionaimage",
    "option_a_image",
  ],
  optionBImageFilename: [
    "optionBImageFilename",
    "option_b_image_filename",
    "optionbimage",
    "option_b_image",
  ],
  optionCImageFilename: [
    "optionCImageFilename",
    "option_c_image_filename",
    "optioncimage",
    "option_c_image",
  ],
  optionDImageFilename: [
    "optionDImageFilename",
    "option_d_image_filename",
    "optiondimage",
    "option_d_image",
  ],
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

/** Best-effort file-extension -> ImportFileFormat mapping for BulkImportRun.format. */
export function detectImportFileFormat(filename: string): "CSV" | "XLS" | "XLSX" | "DOCX" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) return "CSV";
  if (lower.endsWith(".xlsx")) return "XLSX";
  if (lower.endsWith(".xls")) return "XLS";
  if (lower.endsWith(".docx")) return "DOCX";
  return null;
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
    questionNumber: row.questionNumber?.trim() || undefined,
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
    questionImageFilename: row.questionImageFilename?.trim() || undefined,
    optionAImageFilename: row.optionAImageFilename?.trim() || undefined,
    optionBImageFilename: row.optionBImageFilename?.trim() || undefined,
    optionCImageFilename: row.optionCImageFilename?.trim() || undefined,
    optionDImageFilename: row.optionDImageFilename?.trim() || undefined,
    status: row.status?.trim() || "",
  };
}

// ---------------------------------------------------------------------------
// Row Validation (shape-level, no DB access)
//
// WARNING vs ERROR rule of thumb: ERROR means the row cannot become a
// Question at all (missing text-critical data or a structurally impossible
// value); WARNING means the row can still be imported (as Draft, or as
// Published once mapped) but needs a human look — missing optional
// metadata, a taxonomy name that doesn't resolve yet, or a referenced image
// that isn't available.
// ---------------------------------------------------------------------------

function severityFromIssues(errors: string[], warnings: string[]): ImportRowSeverity {
  if (errors.length > 0) return ImportRowSeverity.ERROR;
  if (warnings.length > 0) return ImportRowSeverity.WARNING;
  return ImportRowSeverity.VALID;
}

export function validateImportRows(rows: BulkImportRow[]): ParsedImportRow[] {
  return rows.map((row) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields — without these a Question genuinely cannot be created.
    if (!row.exam) errors.push("Exam is required");
    if (!row.examYear) errors.push("Exam Year is required");
    else if (!/^\d{4}$/.test(row.examYear)) errors.push("Exam Year must be a 4-digit year");
    if (!row.subject) errors.push("Subject is required");
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

    // Status validation — unsupported values are an ERROR; missing just defaults.
    if (!row.status) {
      warnings.push("Status not provided, will default to DRAFT");
    } else if (!["DRAFT", "PUBLISHED", "ARCHIVED"].includes(row.status.toUpperCase())) {
      errors.push("Status must be DRAFT, PUBLISHED, or ARCHIVED");
    }

    // Optional metadata — missing is a WARNING, never blocks import (Topic/SubTopic
    // are optional on Question).
    if (!row.topic) warnings.push("Topic not provided");
    if (!row.subTopic) warnings.push("Sub-topic not provided");
    if (!row.source) warnings.push("Source not provided, will default to Question Bank");

    return {
      rowNumber: row.rowNumber,
      data: row,
      severity: severityFromIssues(errors, warnings),
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------
// Image matching (best-effort — see lib/bulk-import-images.ts)
// ---------------------------------------------------------------------------

export interface RowImageMatch {
  field: "question" | "optionA" | "optionB" | "optionC" | "optionD";
  filename: string;
  status: "FOUND" | "MISSING";
  path?: string;
}

const IMAGE_FIELD_MAP: Record<string, RowImageMatch["field"]> = {
  questionImageFilename: "question",
  optionAImageFilename: "optionA",
  optionBImageFilename: "optionB",
  optionCImageFilename: "optionC",
  optionDImageFilename: "optionD",
};

/** Declared image filename columns on a row, regardless of whether they resolve to a real file. */
export function declaredImageFilenames(data: BulkImportRow): { field: RowImageMatch["field"]; filename: string }[] {
  const out: { field: RowImageMatch["field"]; filename: string }[] = [];
  for (const [key, field] of Object.entries(IMAGE_FIELD_MAP)) {
    const value = (data as unknown as Record<string, string | undefined>)[key];
    if (value && value.trim()) out.push({ field, filename: value.trim() });
  }
  return out;
}

/** Matches a row's declared image filenames against a lowercased-filename -> path index. */
export function matchRowImagesSync(data: BulkImportRow, imageIndex: Map<string, string>): RowImageMatch[] {
  return declaredImageFilenames(data).map(({ field, filename }) => {
    const hit = imageIndex.get(filename.toLowerCase());
    return hit ? { field, filename, status: "FOUND" as const, path: hit } : { field, filename, status: "MISSING" as const };
  });
}

// ---------------------------------------------------------------------------
// Database Validation (Hierarchy Resolution + Duplicate Detection)
// ---------------------------------------------------------------------------

export type ValidationDb = Pick<
  Prisma.TransactionClient,
  "exam" | "subject" | "topic" | "subTopic" | "previousYearPaper" | "question" | "bulkImportRow"
>;

interface TaxonomyLookups {
  exams: { id: string; name: string; code: string; year: number | null }[];
  examsByName: Map<string, TaxonomyLookups["exams"][number]>;
  subjects: { id: string; name: string; examId: string }[];
  subjectsByExamAndName: Map<string, TaxonomyLookups["subjects"][number]>;
  topics: { id: string; name: string; subjectId: string }[];
  topicsBySubjectAndName: Map<string, TaxonomyLookups["topics"][number]>;
  subTopics: { id: string; name: string; topicId: string }[];
  subTopicsByTopicAndName: Map<string, TaxonomyLookups["subTopics"][number]>;
  papers: { id: string; examId: string; year: number; title: string }[];
}

export async function buildTaxonomyLookups(db: ValidationDb): Promise<TaxonomyLookups> {
  const [exams, subjects, topics, subTopics, papers] = await Promise.all([
    db.exam.findMany({ select: { id: true, name: true, code: true, year: true } }),
    db.subject.findMany({ select: { id: true, name: true, examId: true } }),
    db.topic.findMany({ select: { id: true, name: true, subjectId: true } }),
    db.subTopic.findMany({ select: { id: true, name: true, topicId: true } }),
    db.previousYearPaper.findMany({ select: { id: true, examId: true, year: true, title: true } }),
  ]);

  const examsByName = new Map(exams.map((e) => [e.name.toLowerCase(), e]));
  const subjectsByExamAndName = new Map<string, (typeof subjects)[0]>();
  subjects.forEach((s) => subjectsByExamAndName.set(`${s.examId}:${s.name.toLowerCase()}`, s));
  const topicsBySubjectAndName = new Map<string, (typeof topics)[0]>();
  topics.forEach((t) => topicsBySubjectAndName.set(`${t.subjectId}:${t.name.toLowerCase()}`, t));
  const subTopicsByTopicAndName = new Map<string, (typeof subTopics)[0]>();
  subTopics.forEach((st) => subTopicsByTopicAndName.set(`${st.topicId}:${st.name.toLowerCase()}`, st));

  return { exams, examsByName, subjects, subjectsByExamAndName, topics, topicsBySubjectAndName, subTopics, subTopicsByTopicAndName, papers };
}

/**
 * Resolves a single parsed row against the DB: exam/subject/topic/subtopic,
 * PYQ paper, duplicate detection, and (if an image index is supplied) image
 * filename matching. Shared by the batch validate route, the single-row
 * revalidate route, and the import route (so all three apply identical
 * rules).
 */
export async function resolveRow(
  db: ValidationDb,
  lookups: TaxonomyLookups,
  parsedRow: ParsedImportRow,
  imageIndex?: Map<string, string>
): Promise<ValidatedImportRow> {
  const errors = [...parsedRow.errors];
  const warnings = [...parsedRow.warnings];
  const unmapped: UnmappedTaxonomy[] = [];
  let reviewRequired = false;
  const data = parsedRow.data;

  if (parsedRow.severity === ImportRowSeverity.ERROR) {
    // Shape-level ERROR already blocks this row; skip DB round-trips.
    return { ...parsedRow, errors, warnings, unmapped, reviewRequired, resolvedData: undefined };
  }

  const { examsByName, subjectsByExamAndName, topicsBySubjectAndName, subTopicsByTopicAndName, topics, subTopics, papers } = lookups;

  const exam = data.exam ? examsByName.get(data.exam.toLowerCase()) : undefined;
  if (!exam) {
    errors.push(`Exam "${data.exam}" not found`);
    return {
      ...parsedRow,
      severity: ImportRowSeverity.ERROR,
      isValid: false,
      errors,
      warnings,
      unmapped,
      reviewRequired,
      resolvedData: undefined,
    };
  }

  // Subject: required data, but an unresolved name is a WARNING (needs mapping), not an ERROR.
  const subject = data.subject ? subjectsByExamAndName.get(`${exam.id}:${data.subject.toLowerCase()}`) : undefined;
  if (data.subject && !subject) {
    unmapped.push({ field: "subject", value: data.subject });
    warnings.push(`Subject "${data.subject}" not found for exam "${exam.name}" — needs mapping before import`);
    reviewRequired = true;
  }

  // Topic: only meaningful once Subject resolves. A name that exists under a
  // *different* subject is a structural ERROR (invalid relationship); a name
  // that doesn't exist anywhere is a WARNING (unmapped).
  let topic: TaxonomyLookups["topics"][number] | undefined;
  if (data.topic) {
    if (subject) {
      topic = topicsBySubjectAndName.get(`${subject.id}:${data.topic.toLowerCase()}`);
      if (!topic) {
        const existsElsewhere = topics.some((t) => t.name.toLowerCase() === data.topic.toLowerCase() && t.subjectId !== subject.id);
        if (existsElsewhere) {
          errors.push(`Topic "${data.topic}" exists but does not belong to subject "${data.subject}"`);
        } else {
          unmapped.push({ field: "topic", value: data.topic });
          warnings.push(`Topic "${data.topic}" not found for subject "${data.subject}" — needs mapping`);
          reviewRequired = true;
        }
      }
    } else {
      unmapped.push({ field: "topic", value: data.topic });
      warnings.push(`Topic "${data.topic}" could not be checked because Subject is unmapped`);
      reviewRequired = true;
    }
  }

  // SubTopic: same pattern, relative to Topic.
  let subTopic: TaxonomyLookups["subTopics"][number] | undefined;
  if (data.subTopic) {
    if (topic) {
      subTopic = subTopicsByTopicAndName.get(`${topic.id}:${data.subTopic.toLowerCase()}`);
      if (!subTopic) {
        const existsElsewhere = subTopics.some(
          (st) => st.name.toLowerCase() === data.subTopic.toLowerCase() && st.topicId !== topic!.id
        );
        if (existsElsewhere) {
          errors.push(`Sub-topic "${data.subTopic}" exists but does not belong to topic "${data.topic}"`);
        } else {
          unmapped.push({ field: "subTopic", value: data.subTopic });
          warnings.push(`Sub-topic "${data.subTopic}" not found for topic "${data.topic}" — needs mapping`);
          reviewRequired = true;
        }
      }
    } else {
      unmapped.push({ field: "subTopic", value: data.subTopic });
      warnings.push(`Sub-topic "${data.subTopic}" could not be checked because Topic is unmapped`);
      reviewRequired = true;
    }
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

  // --- Duplicate detection -------------------------------------------------
  let duplicateQuestionId: string | undefined;
  let duplicateReason: string | undefined;

  if (data.questionCode) {
    const byCode = await db.question.findUnique({ where: { code: data.questionCode }, select: { id: true, code: true } });
    if (byCode) {
      duplicateQuestionId = byCode.id;
      duplicateReason = "Same Question Code";
    }
  }

  if (!duplicateReason && data.questionNumber && previousYearPaperId) {
    // Question has no dedicated questionNumber column, so this is approximated
    // via prior bulk-import history for the same exam (see report note).
    const priorRow = await db.bulkImportRow
      .findFirst({
        where: {
          removedFromImport: false,
          status: { in: ["SUCCESS", "REPLACED"] },
          run: { examId: exam.id },
          questionId: { not: null },
          rawData: { path: ["questionNumber"], equals: data.questionNumber } as unknown as Prisma.JsonFilter,
        },
        select: { questionId: true, questionCode: true },
        orderBy: { createdAt: "desc" },
      })
      .catch(() => null);
    if (priorRow?.questionId) {
      duplicateQuestionId = priorRow.questionId;
      duplicateReason = "Same paper/question number";
    }
  }

  if (!duplicateReason && subject) {
    const existingQuestion = await db.question.findFirst({
      where: { examId: exam.id, subjectId: subject.id, text: data.questionText },
      select: { id: true, code: true },
    });
    if (existingQuestion) {
      duplicateQuestionId = existingQuestion.id;
      duplicateReason = "Potential duplicate text";
    }
  }

  const isDuplicate = !!duplicateReason;
  if (isDuplicate) {
    warnings.push(`Possible duplicate: ${duplicateReason}`);
    reviewRequired = true;
  }

  // --- Image matching -------------------------------------------------------
  let imageMatches: RowImageMatch[] | undefined;
  if (imageIndex) {
    imageMatches = matchRowImagesSync(data, imageIndex);
    for (const match of imageMatches) {
      if (match.status === "MISSING") {
        warnings.push(`${fieldLabel(match.field)} image "${match.filename}" not found — can still be saved as Draft`);
        reviewRequired = true;
      }
    }
  }

  const severity = severityFromIssues(errors, warnings);

  return {
    ...parsedRow,
    severity,
    isValid: severity !== ImportRowSeverity.ERROR,
    errors,
    warnings,
    unmapped,
    reviewRequired,
    imageMatches,
    resolvedData:
      severity === ImportRowSeverity.ERROR
        ? undefined
        : {
            examId: exam.id,
            examCode: exam.code,
            examYear,
            subjectId: subject?.id ?? null,
            topicId: topic?.id ?? null,
            subTopicId: subTopic?.id ?? null,
            previousYearPaperId,
            difficulty,
            status,
            source,
            isDuplicate,
            duplicateQuestionId,
            duplicateReason,
          },
  };
}

function fieldLabel(field: RowImageMatch["field"]): string {
  switch (field) {
    case "question": return "Question";
    case "optionA": return "Option A";
    case "optionB": return "Option B";
    case "optionC": return "Option C";
    case "optionD": return "Option D";
  }
}

export async function validateWithDatabase(
  db: ValidationDb,
  parsedRows: ParsedImportRow[],
  imageIndex?: Map<string, string>
): Promise<ImportValidationResult> {
  const lookups = await buildTaxonomyLookups(db);
  const validatedRows: ValidatedImportRow[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let warningCount = 0;
  let duplicateCount = 0;
  let reviewRequiredCount = 0;
  const globalWarnings: string[] = [];

  for (const parsedRow of parsedRows) {
    const resolved = await resolveRow(db, lookups, parsedRow, imageIndex);
    validatedRows.push(resolved);

    if (resolved.severity === ImportRowSeverity.ERROR) invalidCount++;
    else validCount++;
    if (resolved.severity === ImportRowSeverity.WARNING) warningCount++;
    if (resolved.resolvedData?.isDuplicate) duplicateCount++;
    if (resolved.reviewRequired) reviewRequiredCount++;
  }

  return {
    total: parsedRows.length,
    valid: validCount,
    invalid: invalidCount,
    warningCount,
    duplicates: duplicateCount,
    reviewRequiredCount,
    rows: validatedRows,
    warnings: globalWarnings,
  };
}

// ---------------------------------------------------------------------------
// Row merge helper — admin's inline edits (editedData) overlay onto rawData.
// ---------------------------------------------------------------------------

export function mergeRowData(rawData: unknown, editedData: unknown): BulkImportRow {
  return { ...(rawData as BulkImportRow), ...((editedData as Partial<BulkImportRow>) ?? {}) };
}
