import { prisma } from "@/lib/prisma";
import type { HomepageConfig, HomepageSection, Exam, PreviousYearPaper, TestSeries } from "@prisma/client";
import { normalizeStatMetrics, normalizeUpcomingExams, type StatMetric, type UpcomingExamConfig } from "@/lib/homepage-field-codec";
import { getHomepageStatistics } from "@/lib/homepage-statistics";

export interface ResolvedStatValue {
  label: string;
  value: string;
  description?: string;
  icon?: string;
  badge?: string;
  link?: string;
  mode: StatMetric["mode"];
}

export interface ResolvedExamStats {
  mockTests: number;
  previousYearPapers: number;
  questionBank: number;
  aiExplanations: number;
}

export interface ResolvedHomepage {
  seo: { title?: string; metaDescription?: string; canonicalUrl?: string; ogTitle?: string; ogDescription?: string };
  sections: {
    key: HomepageSection["key"];
    isEnabled: boolean;
    order: number;
    content: Record<string, unknown>;
    resolved: {
      exam?: Exam | null;
      examStats?: ResolvedExamStats | null;
      upcomingExams?: { exam: Exam; config: UpcomingExamConfig }[];
      papers?: PreviousYearPaper[];
      testSeries?: TestSeries[];
      statValues?: ResolvedStatValue[];
    };
  }[];
}

function resolveStatValue(metric: StatMetric, stats: Awaited<ReturnType<typeof getHomepageStatistics>>): string {
  if (metric.mode === "LIVE") {
    return metric.dynamicKey ? String(stats.values[metric.dynamicKey] ?? 0) : "0";
  }
  if (metric.mode === "DEMO") return metric.demoValue ?? "";
  return metric.manualValue ?? "";
}

async function resolveExamStats(examId: string): Promise<ResolvedExamStats> {
  const [exam, aiExplanations] = await Promise.all([
    prisma.exam.findUnique({
      where: { id: examId },
      include: { _count: { select: { mockTests: true, previousYearPapers: true, questions: true } } },
    }),
    prisma.aIExplanation.count({ where: { question: { examId } } }),
  ]);

  return {
    mockTests: exam?._count.mockTests ?? 0,
    previousYearPapers: exam?._count.previousYearPapers ?? 0,
    questionBank: exam?._count.questions ?? 0,
    aiExplanations,
  };
}

export async function resolveHomepage(config: HomepageConfig & { sections: HomepageSection[] }): Promise<ResolvedHomepage> {
  const sections = await Promise.all(
    config.sections
      .sort((a, b) => a.order - b.order)
      .map(async (section) => {
        const content = section.content as Record<string, unknown>;
        const references = (section.references as Record<string, unknown>) ?? {};
        const resolved: ResolvedHomepage["sections"][number]["resolved"] = {};

        if (section.key === "FEATURED_EXAM" && typeof references.examId === "string") {
          const exam = await prisma.exam.findUnique({ where: { id: references.examId } });
          resolved.exam = exam && exam.isActive ? exam : null;
          if (resolved.exam) {
            resolved.examStats = await resolveExamStats(resolved.exam.id);
          }
        }

        if (section.key === "UPCOMING_EXAMS") {
          const configs = normalizeUpcomingExams(content.exams, references.examIds).filter((c) => c.enabled);
          if (configs.length > 0) {
            const exams = await prisma.exam.findMany({
              where: { id: { in: configs.map((c) => c.examId) }, isActive: true },
            });
            const examById = new Map(exams.map((e) => [e.id, e]));
            resolved.upcomingExams = configs
              .map((config) => {
                const exam = examById.get(config.examId);
                return exam ? { exam, config } : null;
              })
              .filter((entry): entry is { exam: Exam; config: UpcomingExamConfig } => entry !== null);
          }
        }

        if (section.key === "PREVIOUS_YEAR_PAPERS" && Array.isArray(references.paperIds)) {
          resolved.papers = await prisma.previousYearPaper.findMany({
            where: { id: { in: references.paperIds as string[] }, isActive: true },
            orderBy: { year: "desc" },
          });
        }

        if (section.key === "TEST_SERIES" && Array.isArray(references.testSeriesIds)) {
          resolved.testSeries = await prisma.testSeries.findMany({
            where: { id: { in: references.testSeriesIds as string[] }, isActive: true },
          });
        }

        if (section.key === "STATISTICS" && Array.isArray(content.metrics)) {
          const stats = await getHomepageStatistics();
          const metrics = normalizeStatMetrics(content.metrics).filter((m) => m.enabled);
          resolved.statValues = metrics.map((m) => ({
            label: m.label,
            value: resolveStatValue(m, stats),
            description: m.description,
            icon: m.icon,
            badge: m.badge,
            link: m.link,
            mode: m.mode,
          }));
        }

        return { key: section.key, isEnabled: section.isEnabled, order: section.order, content, resolved };
      })
  );

  return { seo: (config.seo as ResolvedHomepage["seo"]) ?? {}, sections };
}
