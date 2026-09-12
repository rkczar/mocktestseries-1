import { prisma } from "@/lib/prisma";
import type { HomepageConfig, HomepageSection, Exam, PreviousYearPaper, TestSeries } from "@prisma/client";
import type { StatMetric } from "@/lib/homepage-field-codec";

export interface ResolvedHomepage {
  seo: { title?: string; metaDescription?: string; canonicalUrl?: string; ogTitle?: string; ogDescription?: string };
  sections: {
    key: HomepageSection["key"];
    isEnabled: boolean;
    order: number;
    content: Record<string, unknown>;
    resolved: {
      exam?: Exam | null;
      exams?: Exam[];
      papers?: PreviousYearPaper[];
      testSeries?: TestSeries[];
      statValues?: { label: string; value: string }[];
    };
  }[];
}

async function resolveStatValue(metric: StatMetric): Promise<string> {
  if (metric.source === "ADMIN_CONFIGURED") return metric.manualValue ?? "";
  switch (metric.dynamicKey) {
    case "examsActive":
      return String(await prisma.exam.count({ where: { isActive: true } }));
    case "previousYearPapers":
      return String(await prisma.previousYearPaper.count({ where: { isActive: true } }));
    case "testSeriesCount":
      return String(await prisma.testSeries.count({ where: { isActive: true } }));
    default:
      return "0";
  }
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
        }

        if (section.key === "UPCOMING_EXAMS" && Array.isArray(references.examIds)) {
          resolved.exams = await prisma.exam.findMany({
            where: { id: { in: references.examIds as string[] }, isActive: true },
            orderBy: { order: "asc" },
          });
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
          const metrics = content.metrics as StatMetric[];
          resolved.statValues = await Promise.all(
            metrics.map(async (m) => ({ label: m.label, value: await resolveStatValue(m) }))
          );
        }

        return { key: section.key, isEnabled: section.isEnabled, order: section.order, content, resolved };
      })
  );

  return { seo: (config.seo as ResolvedHomepage["seo"]) ?? {}, sections };
}
