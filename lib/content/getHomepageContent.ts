import { unstable_cache } from "next/cache";

import { prisma } from "@/lib/db";

import type { HomepageContentDTO } from "./types";

async function loadHomepageContent(): Promise<HomepageContentDTO> {
  const now = new Date();

  const [content, sections, ctaButtons, announcement, featuredExams, popularTestSeries, upcomingExams] =
    await Promise.all([
      prisma.homepageContent.findFirst(),
      prisma.homepageSection.findMany({ orderBy: { order: "asc" } }),
      prisma.ctaButton.findMany({ where: { isActive: true } }),
      prisma.announcement.findFirst({
        where: {
          isActive: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          ],
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.exam.findMany({
        where: { isFeatured: true, status: { not: "ARCHIVED" } },
        orderBy: { order: "asc" },
      }),
      prisma.testSeries.findMany({
        where: { isPopular: true },
        orderBy: { order: "asc" },
      }),
      prisma.upcomingExam.findMany({
        where: { isVisible: true },
        orderBy: [{ examDate: "asc" }, { order: "asc" }],
      }),
    ]);

  return {
    heroEyebrow: content?.heroEyebrow ?? "",
    heroHeading: content?.heroHeading ?? "",
    heroDescription: content?.heroDescription ?? "",
    finalCtaHeading: content?.finalCtaHeading ?? "",
    finalCtaBody: content?.finalCtaBody ?? "",
    finalCtaNote: content?.finalCtaNote ?? null,
    sectionVisibility: Object.fromEntries(sections.map((s) => [s.key, s.isVisible])),
    ctaButtons: Object.fromEntries(
      ctaButtons.map((b) => [
        b.slot,
        { label: b.label, href: b.href, variant: b.variant as "primary" | "secondary" | "accent" | "ghost" },
      ]),
    ),
    announcement: announcement
      ? {
          tag: announcement.tag,
          message: announcement.message,
          linkLabel: announcement.linkLabel,
          linkHref: announcement.linkHref,
        }
      : null,
    featuredExams: featuredExams.map((exam) => ({
      slug: exam.slug,
      title: exam.title,
      description: exam.description,
      status: exam.status,
      metaChips: exam.metaChips,
    })),
    popularTestSeries: popularTestSeries.map((series) => ({
      slug: series.slug,
      kind: series.kind,
      title: series.title,
      description: series.description,
      metaLabel: series.metaLabel,
    })),
    upcomingExams: upcomingExams.map((exam) => ({
      id: exam.id,
      title: exam.title,
      subtitle: exam.subtitle,
      dateLabel: exam.dateLabel,
      examDate: exam.examDate,
      status: exam.status,
      statusTone: exam.statusTone as "success" | "accent" | "neutral",
      actionLabel: exam.actionLabel,
      actionHref: exam.actionHref,
    })),
  };
}

export const getHomepageContent = unstable_cache(loadHomepageContent, ["homepage-content"], {
  tags: ["homepage"],
});
