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
  qb,
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
  /** Serialized list state ("page=4&subjectId=…") the client mirrors into the URL, so Admin Back returns to the same filtered page. */
  qb?: string;
}) {
  // Fetch filter options
  const [exams, subjects, topics, subTopics, importBatches] = await Promise.all([
    prisma.exam.findMany({
      orderBy: { order: "asc" },
      select: { id: true, name: true }
    }),
    prisma.subject.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, examLinks: { where: { isActive: true }, select: { examId: true } } },
    }),
    prisma.topic.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, subjectId: true, examLinks: { where: { isActive: true }, select: { examId: true } } },
    }),
    prisma.subTopic.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, topicId: true, examLinks: { where: { isActive: true }, select: { examId: true } } },
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
  // Restored list state (filters + page) wins over the individual params.
  const restored = new URLSearchParams(qb ?? "");
  for (const key of Object.keys(initialFilters) as (keyof typeof initialFilters)[]) {
    const v = restored.get(key);
    if (v) initialFilters[key] = v;
  }
  const initialPage = Math.max(1, parseInt(restored.get("page") ?? "1", 10) || 1);

  return (
    <AllQuestionsPanelClient
      initialFilters={initialFilters}
      initialPage={initialPage}
      filterOptions={{
        exams,
        // Exam -> linked Subject -> linked Topic -> linked SubTopic cascade.
        subjects: subjects.map(({ examLinks, ...s }) => ({ ...s, examIds: examLinks.map((l) => l.examId) })),
        topics: topics.map(({ examLinks, ...t }) => ({ ...t, examIds: examLinks.map((l) => l.examId) })),
        subTopics: subTopics.map(({ examLinks, ...st }) => ({ ...st, examIds: examLinks.map((l) => l.examId) })),
        importBatches: importBatches.map((b) => ({
          id: b.id,
          label: b.label ?? b.filename,
          createdAt: b.createdAt.toISOString(),
        })),
      }}
    />
  );
}
