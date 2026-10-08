import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings } from "@/lib/seo-settings";
import { getPageVisibilityMap } from "@/lib/page-visibility";
import { getExamPyqInsights, pyqYearPath } from "@/lib/exam-pyq-insights";
import { EXAM_INSIGHT_PAGES, getPyqAnalysisMeta, hasPyqAnalysis } from "@/lib/exam-pyq-analysis";
import { getPublicPlanCatalog } from "@/lib/plans-catalog";
import { PLANS_AND_PRICING_PATH } from "@/lib/plans-path";

// Regenerate hourly so exams published/unpublished in Admin appear without a redeploy.
export const revalidate = 3600;

const DEEP_PAGES = ["syllabus", "previous-year-papers", "mock-test-series", "question-bank", "exam-pattern"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [seo, siteUrl, visibility] = await Promise.all([getSeoSettings(), getSiteUrl(), getPageVisibilityMap()]);

  if (!seo.sitemapEnabled || !seo.siteIndexable) return [];

  const isVisible = (key: string) => visibility.get(key) ?? true;

  const entries: MetadataRoute.Sitemap = [];

  // Same form as the homepage canonical (`${siteUrl}/`).
  if (isVisible("homepage")) {
    const published = await prisma.homepageConfig.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { version: "desc" },
      select: { publishedAt: true },
    });
    entries.push({ url: `${siteUrl}/`, lastModified: published?.publishedAt ?? undefined, changeFrequency: "daily", priority: 1 });
  }
  // Same gate as the page's robots meta: listed only while plans are on sale.
  if ((await getPublicPlanCatalog()).planCount > 0) {
    entries.push({ url: `${siteUrl}${PLANS_AND_PRICING_PATH}`, changeFrequency: "weekly", priority: 0.8 });
  }
  if (isVisible("contact")) entries.push({ url: `${siteUrl}/contact`, changeFrequency: "monthly", priority: 0.3 });
  if (isVisible("privacy")) entries.push({ url: `${siteUrl}/privacy`, changeFrequency: "yearly", priority: 0.2 });
  if (isVisible("terms")) entries.push({ url: `${siteUrl}/terms`, changeFrequency: "yearly", priority: 0.2 });
  if (isVisible("refund-policy")) entries.push({ url: `${siteUrl}/refund-policy`, changeFrequency: "yearly", priority: 0.2 });

  if (isVisible("exams-directory")) {
    entries.push({ url: `${siteUrl}/exams`, changeFrequency: "weekly", priority: 0.8 });

    const exams = await prisma.exam.findMany({
      where: { publicPageEnabled: true, publicSlug: { not: null } },
      select: { id: true, publicSlug: true, updatedAt: true },
    });

    for (const exam of exams) {
      entries.push({ url: `${siteUrl}/exams/${exam.publicSlug}`, lastModified: exam.updatedAt, changeFrequency: "weekly", priority: 0.9 });
      for (const deep of DEEP_PAGES) {
        entries.push({
          url: `${siteUrl}/exams/${exam.publicSlug}/${deep}`,
          lastModified: exam.updatedAt,
          changeFrequency: "weekly",
          priority: 0.6,
        });
      }
      // Year pages exist only where the paper clears the non-thin threshold;
      // the page itself 404s otherwise, so the sitemap uses the same rule.
      const insights = await getExamPyqInsights(exam.id);
      for (const year of insights.indexableYears) {
        entries.push({ url: `${siteUrl}${pyqYearPath(exam.publicSlug!, year)}`, lastModified: exam.updatedAt, changeFrequency: "monthly", priority: 0.5 });
      }
      // The analysis pages use the same data gate as the pages themselves (they 404 below it).
      if (hasPyqAnalysis(insights)) {
        const { dataAsOf } = await getPyqAnalysisMeta(exam.id);
        for (const page of Object.values(EXAM_INSIGHT_PAGES)) {
          entries.push({
            url: `${siteUrl}/exams/${exam.publicSlug}/${page}`,
            lastModified: dataAsOf ? new Date(dataAsOf) : exam.updatedAt,
            changeFrequency: "monthly",
            priority: 0.6,
          });
        }
      }
    }
  }

  return entries;
}
