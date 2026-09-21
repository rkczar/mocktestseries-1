import { prisma } from "@/lib/prisma";
import { SECTION_META, SECTION_ORDER } from "@/lib/homepage-sections";
import type { Prisma, HomepageConfig, HomepageSection } from "@prisma/client";

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
        title: "MockTestSeries.in — Mock Tests, Previous Year Papers & AI Explanations",
        metaDescription:
          "Practice with full-length mock tests, previous year papers, and AI-powered explanations for RUHS Medical Officer, NEET UG, and more — all on one platform.",
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

/**
 * In-memory, never-persisted config built straight from SECTION_META's
 * defaults — the same source getOrCreateDraft() seeds a new draft from. Used
 * only when no admin has published a Homepage yet, so the public site never
 * renders blank. Not a second source of truth: change the defaults in
 * lib/homepage-sections.ts and both this fallback and every new draft pick
 * it up.
 */
export function getFallbackHomepage(): HomepageConfig & { sections: HomepageSection[] } {
  const now = new Date();
  return {
    id: "fallback",
    version: 0,
    status: "DRAFT",
    seo: {
      title: "MockTestSeries.in — Mock Tests, Previous Year Papers & AI Explanations",
      metaDescription:
        "Practice with full-length mock tests, previous year papers, and AI-powered explanations for RUHS Medical Officer, NEET UG, and more — all on one platform.",
    } as Prisma.JsonValue,
    publishedAt: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    sections: SECTION_ORDER.map((key, index) => ({
      id: `fallback-${key}`,
      homepageConfigId: "fallback",
      key,
      isEnabled: true,
      order: index,
      content: SECTION_META[key].defaultContent as Prisma.JsonValue,
      references: {} as Prisma.JsonValue,
      createdAt: now,
      updatedAt: now,
    })),
  };
}
