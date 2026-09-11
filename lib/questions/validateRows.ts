import "server-only";

import { prisma } from "@/lib/db";

import type { RawRow } from "./parseSpreadsheet";

export type ParsedRow = {
  code: string | null; // null = auto-generate at apply time
  paperYear: number;
  questionNumber: number | null;
  subject: string;
  topic: string;
  subTopic: string | null;
  stem: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: "A" | "B" | "C" | "D";
  explanation: string | null;
  source: string | null;
  difficulty: string | null;
  status: "DRAFT" | "PUBLISHED";
};

export type RowOutcome =
  | { kind: "invalid"; rowNumber: number; errors: string[]; raw: RawRow }
  | { kind: "valid"; rowNumber: number; data: ParsedRow }
  | {
      kind: "duplicate";
      rowNumber: number;
      data: ParsedRow;
      matchType: "code" | "examYearNumber" | "within-file";
      matchedQuestionId?: string;
    };

function parseRow(raw: RawRow): { errors: string[]; data?: ParsedRow } {
  const errors: string[] = [];

  const examYearRaw = raw.ExamYear?.trim();
  const paperYear = Number(examYearRaw);
  if (!examYearRaw) errors.push("ExamYear is required.");
  else if (!Number.isInteger(paperYear) || paperYear < 1990 || paperYear > 2035) {
    errors.push("ExamYear must be a 4-digit year between 1990 and 2035.");
  }

  const subject = raw.Subject?.trim();
  if (!subject) errors.push("Subject is required.");

  const topic = raw.Topic?.trim();
  if (!topic) errors.push("Topic is required.");

  const stem = raw.Question?.trim();
  if (!stem) errors.push("Question text is required.");

  const optionA = raw.OptionA?.trim();
  const optionB = raw.OptionB?.trim();
  const optionC = raw.OptionC?.trim();
  const optionD = raw.OptionD?.trim();
  if (!optionA) errors.push("OptionA is required.");
  if (!optionB) errors.push("OptionB is required.");
  if (!optionC) errors.push("OptionC is required.");
  if (!optionD) errors.push("OptionD is required.");

  const correctRaw = raw.CorrectAnswer?.trim().toUpperCase();
  const correctAnswer = correctRaw as "A" | "B" | "C" | "D";
  if (!correctRaw) errors.push("CorrectAnswer is required.");
  else if (!["A", "B", "C", "D"].includes(correctRaw)) {
    errors.push("CorrectAnswer must be one of A, B, C, D.");
  }

  let questionNumber: number | null = null;
  if (raw.QuestionNumber?.trim()) {
    const n = Number(raw.QuestionNumber.trim());
    if (!Number.isInteger(n) || n <= 0) {
      errors.push("QuestionNumber must be a positive whole number.");
    } else {
      questionNumber = n;
    }
  }

  const status = raw.Status?.trim().toLowerCase() === "published" ? "PUBLISHED" : "DRAFT";

  if (errors.length > 0) return { errors };

  return {
    errors,
    data: {
      code: raw.QuestionCode?.trim() || null,
      paperYear,
      questionNumber,
      subject,
      topic,
      subTopic: raw.SubTopic?.trim() || null,
      stem,
      optionA,
      optionB,
      optionC,
      optionD,
      correctAnswer,
      explanation: raw.Explanation?.trim() || null,
      source: raw.Source?.trim() || null,
      difficulty: raw.Difficulty?.trim() || null,
      status,
    },
  };
}

export async function validateAndClassifyRows(
  rawRows: RawRow[],
  examId: string,
): Promise<RowOutcome[]> {
  const existingCodes = new Set(
    (await prisma.question.findMany({ where: { examId }, select: { code: true } })).map((q) => q.code),
  );
  const existingByExamYearNumber = new Map(
    (
      await prisma.question.findMany({
        where: { examId, questionNumber: { not: null } },
        select: { id: true, paperYear: true, questionNumber: true },
      })
    ).map((q) => [`${q.paperYear}:${q.questionNumber}`, q.id]),
  );
  // Also check codes across ALL exams, since Question.code is globally unique.
  const globalCodes = new Set(
    (await prisma.question.findMany({ select: { code: true } })).map((q) => q.code),
  );

  const seenCodesInFile = new Set<string>();
  const seenExamYearNumberInFile = new Set<string>();

  return rawRows.map((raw, i): RowOutcome => {
    const rowNumber = i + 2; // header is row 1
    const { errors, data } = parseRow(raw);
    if (!data) return { kind: "invalid", rowNumber, errors, raw };

    if (data.code) {
      if (seenCodesInFile.has(data.code)) {
        return { kind: "duplicate", rowNumber, data, matchType: "within-file" };
      }
      seenCodesInFile.add(data.code);

      if (existingCodes.has(data.code) || globalCodes.has(data.code)) {
        return { kind: "duplicate", rowNumber, data, matchType: "code" };
      }
    } else if (data.questionNumber !== null) {
      const key = `${data.paperYear}:${data.questionNumber}`;
      if (seenExamYearNumberInFile.has(key)) {
        return { kind: "duplicate", rowNumber, data, matchType: "within-file" };
      }
      seenExamYearNumberInFile.add(key);

      const matchedQuestionId = existingByExamYearNumber.get(key);
      if (matchedQuestionId) {
        return { kind: "duplicate", rowNumber, data, matchType: "examYearNumber", matchedQuestionId };
      }
    }

    return { kind: "valid", rowNumber, data };
  });
}
