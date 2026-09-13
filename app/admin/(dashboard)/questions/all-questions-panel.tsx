import { prisma } from "@/lib/prisma";
import { AllQuestionsPanelClient } from "./all-questions-panel-client";

export async function AllQuestionsPanel({
  examId,
  status,
  search,
  examYear,
  subjectId,
  topicId,
  difficulty,
  source,
  isPyq
}: {
  examId?: string;
  status?: string;
  search?: string;
  examYear?: string;
  subjectId?: string;
  topicId?: string;
  difficulty?: string;
  source?: string;
  isPyq?: string;
}) {
  // Fetch filter options
  const [exams, subjects, topics] = await Promise.all([
    prisma.exam.findMany({
      orderBy: { order: "asc" },
      select: { id: true, name: true }
    }),
    prisma.subject.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, examId: true }
    }),
    prisma.topic.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, subjectId: true }
    }),
  ]);

  const initialFilters = {
    examId: examId || "",
    status: status || "",
    search: search || "",
    examYear: examYear || "",
    subjectId: subjectId || "",
    topicId: topicId || "",
    difficulty: difficulty || "",
    source: source || "",
    isPyq: isPyq || "",
  };

  return (
    <AllQuestionsPanelClient
      initialFilters={initialFilters}
      filterOptions={{ exams, subjects, topics }}
    />
  );
}
