import { prisma } from "@/lib/prisma";
import { SECTION_META, SECTION_ORDER } from "@/lib/homepage-sections";
import type { Prisma } from "@prisma/client";

/**
 * Returns the current DRAFT HomepageConfig (with sections), creating one if
 * none exists yet — cloning the live PUBLISHED config's sections if there is
 * one, or seeding the documented defaults (Section 34) otherwise. There is
 * always exactly one DRAFT at a time; edits write to it directly (Section 36).
 */
export async function getOrCreateDraft() {
  const existingDraft = await prisma.homepageConfig.findFirst({
    where: { status: "DRAFT" },
    include: { sections: { orderBy: { order: "asc" } } },
  });
  if (existingDraft) return existingDraft;

  const published = await prisma.homepageConfig.findFirst({
    where: { status: "PUBLISHED" },
    include: { sections: true },
    orderBy: { version: "desc" },
  });

  const latestVersion = await prisma.homepageConfig.aggregate({ _max: { version: true } });
  const nextVersion = (latestVersion._max.version ?? 0) + 1;

  const sectionsData: Prisma.HomepageSectionCreateWithoutHomepageConfigInput[] = published
    ? published.sections.map((s) => ({
        key: s.key,
        isEnabled: s.isEnabled,
        order: s.order,
        content: s.content as Prisma.InputJsonValue,
        references: s.references as Prisma.InputJsonValue,
      }))
    : SECTION_ORDER.map((key, index) => ({
        key,
        isEnabled: true,
        order: index,
        content: SECTION_META[key].defaultContent as Prisma.InputJsonValue,
        references: {},
      }));

  return prisma.homepageConfig.create({
    data: {
      version: nextVersion,
      status: "DRAFT",
      seo: published?.seo ?? {
        title: "Mock Test Series.in — RUHS Rajasthan Medical Officer Exam 2026",
        metaDescription: "Mock tests, previous year papers, and AI-powered explanations for the RUHS Medical Officer Exam 2026.",
      },
      sections: { create: sectionsData },
    },
    include: { sections: { orderBy: { order: "asc" } } },
  });
}

export async function getPublishedHomepage() {
  return prisma.homepageConfig.findFirst({
    where: { status: "PUBLISHED" },
    include: { sections: { orderBy: { order: "asc" } } },
    orderBy: { version: "desc" },
  });
}
