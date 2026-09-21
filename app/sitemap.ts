import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings } from "@/lib/seo-settings";
import { getPageVisibilityMap } from "@/lib/page-visibility";

const DEEP_PAGES = ["syllabus", "previous-year-papers", "mock-tests", "question-bank", "exam-pattern"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [seo, siteUrl, visibility] = await Promise.all([getSeoSettings(), getSiteUrl(), getPageVisibilityMap()]);

  if (!seo.sitemapEnabled || !seo.siteIndexable) return [];

  const isVisible = (key: string) => visibility.get(key) ?? true;

  const entries: MetadataRoute.Sitemap = [];

  if (isVisible("homepage")) entries.push({ url: siteUrl, changeFrequency: "daily", priority: 1 });
  if (isVisible("contact")) entries.push({ url: `${siteUrl}/contact`, changeFrequency: "monthly", priority: 0.3 });
  if (isVisible("privacy")) entries.push({ url: `${siteUrl}/privacy`, changeFrequency: "yearly", priority: 0.2 });
  if (isVisible("terms")) entries.push({ url: `${siteUrl}/terms`, changeFrequency: "yearly", priority: 0.2 });

  if (isVisible("exams-directory")) {
    entries.push({ url: `${siteUrl}/exams`, changeFrequency: "weekly", priority: 0.8 });

    const exams = await prisma.exam.findMany({
      where: { publicPageEnabled: true, publicSlug: { not: null } },
      select: { publicSlug: true, updatedAt: true },
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
    }
  }

  return entries;
}
