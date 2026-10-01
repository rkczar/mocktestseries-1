import { prisma } from "@/lib/prisma";
import { SECTION_META, SECTION_ORDER } from "@/lib/homepage-sections";
import type { Prisma, HomepageConfig, HomepageSection } from "@prisma/client";

/**
 * Exam-neutral homepage SEO used when no admin SEO is set (new drafts, the
 * no-homepage fallback, and app/page.tsx when the published title is blank).
 * Admin → Website → Homepage → SEO overrides it per published version.
 */
export const DEFAULT_HOMEPAGE_SEO = {
  title: "Mock Test Series – Online Mock Tests & Previous Year Papers",
  metaDescription:
    "Mock Test Series: online mock tests in the real exam pattern, previous year papers, subject-wise practice and AI-powered explanations. Start free, upgrade when you need complete access.",
};

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
  if (existingDraft) return addMissingSections(existingDraft);

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

  const created = await prisma.homepageConfig.create({
    data: {
      version: nextVersion,
      status: "DRAFT",
      seo: published?.seo ?? {
        title: DEFAULT_HOMEPAGE_SEO.title,
        metaDescription: DEFAULT_HOMEPAGE_SEO.metaDescription,
      },
      sections: { create: sectionsData },
    },
    include: { sections: { orderBy: { order: "asc" } } },
  });
  return addMissingSections(created);
}

/**
 * Section types added after a config was first created (e.g. FREE_START,
 * EXAM_GUIDE, FAQ) are appended to the DRAFT — disabled, with their default
 * content — so the admin can see, fill and enable them. Never touches a
 * PUBLISHED config.
 */
async function addMissingSections<T extends HomepageConfig & { sections: HomepageSection[] }>(draft: T): Promise<T> {
  const present = new Set(draft.sections.map((s) => s.key));
  const missing = SECTION_ORDER.filter((key) => !present.has(key));
  if (missing.length === 0) return draft;
  const maxOrder = draft.sections.reduce((max, s) => Math.max(max, s.order), -1);
  await prisma.homepageSection.createMany({
    data: missing.map((key, index) => ({
      homepageConfigId: draft.id,
      key,
      isEnabled: false,
      order: maxOrder + 1 + index,
      content: SECTION_META[key].defaultContent as Prisma.InputJsonValue,
      references: {},
    })),
  });
  return (await prisma.homepageConfig.findUniqueOrThrow({
    where: { id: draft.id },
    include: { sections: { orderBy: { order: "asc" } } },
  })) as T;
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
    seo: { ...DEFAULT_HOMEPAGE_SEO } as Prisma.JsonValue,
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
