import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/requireAdmin";

const HEADERS = [
  "QuestionNumber",
  "QuestionCode",
  "ExamYear",
  "Subject",
  "Topic",
  "SubTopic",
  "Question",
  "OptionA",
  "OptionB",
  "OptionC",
  "OptionD",
  "CorrectAnswer",
  "Explanation",
  "Source",
  "Difficulty",
  "Status",
];

const SAMPLE_ROW = [
  "1",
  "",
  "2024",
  "Pharmacology",
  "Antiepileptics",
  "Benzodiazepines",
  "Which drug is preferred in status epilepticus?",
  "Phenytoin",
  "Lorazepam",
  "Valproate",
  "Carbamazepine",
  "B",
  "Lorazepam has a longer anticonvulsant duration than diazepam.",
  "2024 paper",
  "Medium",
  "Draft",
];

export async function GET() {
  await requireAdmin();

  const csv = [HEADERS, SAMPLE_ROW]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=question-import-template.csv",
    },
  });
}
