import { prisma } from "@/lib/prisma";
import { AllQuestionsPanelClient } from "./all-questions-panel-client";

export async function AllQuestionsPanel({
  examId,
  status,
  search,
  examYear,
  subjectId,
  topicId,
  subTopicId,
  difficulty,
  source,
  isPyq,
  hasImage,
  reviewRequired,
  importBatchId,
  importedFrom,
  importedTo,
}: {
  examId?: string;
  status?: string;
  search?: string;
  examYear?: string;
  subjectId?: string;
  topicId?: string;
  subTopicId?: string;
  difficulty?: string;
  source?: string;
  isPyq?: string;
  hasImage?: string;
  reviewRequired?: string;
  importBatchId?: string;
  importedFrom?: string;
  importedTo?: string;
}) {
  // Fetch filter options
  const [exams, subjects, topics, subTopics, importBatches] = await Promise.all([
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
    prisma.subTopic.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, topicId: true }
    }),
    prisma.bulkImportRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, label: true, filename: true, createdAt: true },
    }),
  ]);

  const initialFilters = {
    examId: examId || "",
    status: status || "",
    search: search || "",
    examYear: examYear || "",
    subjectId: subjectId || "",
    topicId: topicId || "",
    subTopicId: subTopicId || "",
    difficulty: difficulty || "",
    source: source || "",
    isPyq: isPyq || "",
    hasImage: hasImage || "",
    reviewRequired: reviewRequired || "",
    importBatchId: importBatchId || "",
    importedFrom: importedFrom || "",
    importedTo: importedTo || "",
  };

  return (
    <AllQuestionsPanelClient
      initialFilters={initialFilters}
      filterOptions={{
        exams,
        subjects,
        topics,
        subTopics,
        importBatches: importBatches.map((b) => ({
          id: b.id,
          label: b.label ?? b.filename,
          createdAt: b.createdAt.toISOString(),
        })),
      }}
    />
  );
}
