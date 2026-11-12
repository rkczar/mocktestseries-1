import "server-only";
import { prisma } from "@/lib/prisma";
import { editorialPagePaths } from "@/lib/exam-editorial-pages";

export interface ImportantTopic {
  topicId: string;
  topic: string;
  subject: string | null;
  total: number;
  byYear: { year: number; count: number }[];
}

/** Below this the page would be thin, so it 404s and stays out of the sitemap. */
export const IMPORTANT_TOPICS_MIN = 8;

/**
 * Topics asked most often in the exam's ACTIVE previous year papers (published questions only), with
 * per-year counts. Counted from the question bank's own classification; a past count, not a forecast.
 */
export async function getImportantTopics(examId: string, limit = 25): Promise<ImportantTopic[]> {
  const rows = await prisma.question.findMany({
    where: { examId, status: "PUBLISHED", topicId: { not: null }, previousYearPaper: { isActive: true } },
    select: { topicId: true, topic: { select: { name: true } }, subject: { select: { name: true } }, previousYearPaper: { select: { year: true } } },
  });
  const map = new Map<string, ImportantTopic & { years: Map<number, number> }>();
  for (const r of rows) {
    const t = map.get(r.topicId!) ?? { topicId: r.topicId!, topic: r.topic?.name ?? "", subject: r.subject?.name ?? null, total: 0, byYear: [], years: new Map() };
    t.total += 1;
    const y = r.previousYearPaper!.year;
    t.years.set(y, (t.years.get(y) ?? 0) + 1);
    map.set(r.topicId!, t);
  }
  return [...map.values()]
    .filter((t) => t.total >= 2)
    .sort((a, b) => b.total - a.total || a.topic.localeCompare(b.topic))
    .slice(0, limit)
    .map(({ years, ...t }) => ({ ...t, byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count })) }));
}

/** The exam's extra pages that exist right now (Important Topics only above its data gate). */
export async function availableEditorialPaths(exam: { id: string; code: string }): Promise<string[]> {
  const paths = editorialPagePaths(exam.code);
  if (!paths.includes("important-topics")) return paths;
  const enough = (await getImportantTopics(exam.id)).length >= IMPORTANT_TOPICS_MIN;
  return enough ? paths : paths.filter((p) => p !== "important-topics");
}
