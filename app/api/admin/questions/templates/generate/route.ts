import { NextRequest, NextResponse } from "next/server";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { QuestionDifficulty, QuestionStatus, QuestionSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import {
  COLUMN_BY_KEY,
  COLUMN_DEFS,
  REQUIRED_CORE_KEYS,
  validateSelection,
  type FileFormat,
} from "@/app/admin/(dashboard)/questions/templates/presets";

/**
 * Question Templates — file generation.
 *
 * Read-only: no database writes. Per the RBAC design, FULL_ADMIN can "View
 * Templates" without QUESTIONS_MANAGE, so this route only requires *some*
 * authenticated admin session (getAdminSession), not a specific permission.
 */

interface GenerateBody {
  format: FileFormat;
  columns: string[];
  presetId?: string;
  examId?: string;
  subjectId?: string;
  year?: string;
  paperId?: string;
}

function isFileFormat(value: unknown): value is FileFormat {
  return value === "csv" || value === "xlsx";
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: GenerateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isFileFormat(body.format)) {
    return NextResponse.json({ error: "format must be 'csv' or 'xlsx'" }, { status: 400 });
  }

  const requestedColumns = Array.isArray(body.columns) ? body.columns.filter((c) => typeof c === "string") : [];
  // Server-side source of truth: always include required-core columns
  // regardless of what the client sent, and drop anything unrecognized.
  const columnKeys = COLUMN_DEFS.map((c) => c.key).filter(
    (k) => requestedColumns.includes(k) || (REQUIRED_CORE_KEYS as readonly string[]).includes(k)
  );

  const check = validateSelection(columnKeys);
  if (!check.ok) {
    return NextResponse.json(
      { error: `Missing required column(s): ${check.missingLabels.join(", ")}` },
      { status: 400 }
    );
  }

  const columns = columnKeys.map((k) => COLUMN_BY_KEY[k]).filter(Boolean);

  // Optional exam context — re-fetched server-side rather than trusting
  // client-supplied names, so VALID VALUES always reflects the real DB.
  let examName = "";
  let examYear = "";
  let subjectName = "";
  let topicNames: string[] = [];
  let subTopicNames: string[] = [];

  if (body.examId) {
    const exam = await prisma.exam.findUnique({
      where: { id: body.examId },
      select: {
        name: true,
        subjects: {
          select: {
            id: true,
            name: true,
            topics: { select: { name: true, subTopics: { select: { name: true } } } },
          },
        },
      },
    });
    if (exam) {
      examName = exam.name;
      if (body.year) examYear = body.year;

      if (body.subjectId) {
        const subject = exam.subjects.find((s) => s.id === body.subjectId);
        if (subject) {
          subjectName = subject.name;
          topicNames = subject.topics.map((t) => t.name);
          subTopicNames = subject.topics.flatMap((t) => t.subTopics.map((st) => st.name));
        }
      } else {
        topicNames = exam.subjects.flatMap((s) => s.topics.map((t) => t.name));
        subTopicNames = exam.subjects.flatMap((s) => s.topics.flatMap((t) => t.subTopics.map((st) => st.name)));
      }
    }
  }

  const headers = columns.map((c) => c.header);

  const exampleRow = buildExampleRow(columns.map((c) => c.key), {
    examName,
    examYear,
    subjectName,
  });

  const blankRow = columns.map(() => "");

  const filenamePart = examName ? examName.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "question-template";
  const filename = `${filenamePart}.${body.format}`;

  if (body.format === "csv") {
    const csv = Papa.unparse([headers, blankRow], { header: false });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // XLSX — 4 sheets: QUESTIONS, INSTRUCTIONS, VALID VALUES, EXAMPLE ROW.
  const workbook = XLSX.utils.book_new();

  const questionsSheet = XLSX.utils.aoa_to_sheet([headers, blankRow]);
  XLSX.utils.book_append_sheet(workbook, questionsSheet, "QUESTIONS");

  const instructionsRows: (string | undefined)[][] = [
    ["Column", "Requirement", "Instructions"],
    ...columns.map((c) => [
      c.header,
      (REQUIRED_CORE_KEYS as readonly string[]).includes(c.key) ? "REQUIRED" : "OPTIONAL",
      c.instructions,
    ]),
  ];
  const instructionsSheet = XLSX.utils.aoa_to_sheet(instructionsRows);
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "INSTRUCTIONS");

  const validValuesRows: (string | number)[][] = [["Field", "Valid Values"]];
  validValuesRows.push(["Difficulty", Object.values(QuestionDifficulty).join(", ")]);
  validValuesRows.push(["Status", Object.values(QuestionStatus).join(", ")]);
  validValuesRows.push(["Source", Object.values(QuestionSource).join(", ")]);
  validValuesRows.push(["Correct Answer", "A, B, C, D"]);
  if (examName) {
    validValuesRows.push(["Exam", examName]);
    if (subjectName) validValuesRows.push(["Subject", subjectName]);
    if (topicNames.length) validValuesRows.push(["Topic", topicNames.join(", ")]);
    if (subTopicNames.length) validValuesRows.push(["SubTopic", subTopicNames.join(", ")]);
  }
  const validValuesSheet = XLSX.utils.aoa_to_sheet(validValuesRows);
  XLSX.utils.book_append_sheet(workbook, validValuesSheet, "VALID VALUES");

  const exampleSheet = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
  XLSX.utils.book_append_sheet(workbook, exampleSheet, "EXAMPLE ROW");

  const fileData = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
  const fileBlob = new Blob([fileData as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  return new NextResponse(fileBlob, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Builds one fully-filled, realistic example row for the given column keys. */
function buildExampleRow(
  keys: string[],
  ctx: { examName: string; examYear: string; subjectName: string }
): string[] {
  const examples: Record<string, string> = {
    questionCode: "",
    exam: ctx.examName || "RUHS Medical Officer",
    examYear: ctx.examYear || "2024",
    paperCode: "Paper I",
    questionNumber: "1",
    subject: ctx.subjectName || "General Medicine",
    topic: "Cardiology",
    subTopic: "Hypertension",
    questionType: "MCQ",
    questionText: "Which of the following is the first-line drug for essential hypertension?",
    optionA: "Amlodipine",
    optionB: "Paracetamol",
    optionC: "Amoxicillin",
    optionD: "Cetirizine",
    correctAnswer: "A",
    explanation: "Amlodipine, a calcium channel blocker, is a first-line antihypertensive per current guidelines.",
    difficulty: "MEDIUM",
    source: "QUESTION_BANK",
    status: "DRAFT",
    hasQuestionImage: "TRUE",
    questionImageFilename: "q001.png",
    optionAImageFilename: "",
    optionBImageFilename: "",
    optionCImageFilename: "",
    optionDImageFilename: "",
    sourcePdfPage: "12",
    reviewRequired: "TRUE",
    reviewReason: "Verify option text against source PDF scan quality",
  };

  return keys.map((k) => examples[k] ?? "");
}
