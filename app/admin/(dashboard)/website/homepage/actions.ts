"use server";

import { revalidatePath, updateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getOrCreateDraft } from "@/lib/homepage";
import { normalizeStatMetrics } from "@/lib/homepage-field-codec";
import { sanitizeStatisticsContent, validateStatisticsMetrics } from "@/lib/homepage-stat-sanitize";
import type { Prisma } from "@prisma/client";

export async function toggleSectionAction(sectionId: string, isEnabled: boolean) {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  await prisma.homepageSection.update({ where: { id: sectionId }, data: { isEnabled } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_SECTION_TOGGLED", entityType: "HomepageSection", entityId: sectionId, metadata: { isEnabled } },
  });
  revalidatePath("/admin/website/homepage");
}

export async function reorderSectionsAction(orderedSectionIds: string[]) {
  await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  await prisma.$transaction(
    orderedSectionIds.map((id, index) => prisma.homepageSection.update({ where: { id }, data: { order: index } }))
  );
  revalidatePath("/admin/website/homepage");
}

export interface SectionContentFormState {
  error?: string;
  success?: boolean;
}

/** Only sections of the current DRAFT are editable; published/archived versions change only via Publish/Restore. */
async function findDraftSection(sectionId: string) {
  const section = await prisma.homepageSection.findUnique({ where: { id: sectionId }, include: { homepageConfig: { select: { status: true } } } });
  return section?.homepageConfig.status === "DRAFT" ? section : null;
}

type StatModeChange = { label: string; from: string; to: string };

/** Mode switches between the stored and the new STATISTICS content, for the audit log. */
function statModeChanges(before: unknown, after: unknown): StatModeChange[] | undefined {
  const beforeById = new Map(normalizeStatMetrics(before).map((m) => [m.id, m]));
  const changes: StatModeChange[] = [];
  for (const m of normalizeStatMetrics(after)) {
    const prev = beforeById.get(m.id);
    if (prev && prev.mode !== m.mode) changes.push({ label: m.label, from: prev.mode, to: m.mode });
  }
  return changes.length > 0 ? changes : undefined;
}

export async function updateSectionContentAction(
  sectionId: string,
  content: Record<string, unknown>,
  references: Record<string, unknown>
): Promise<SectionContentFormState> {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  } catch (e) {
    if (e instanceof UnauthorizedError) return { error: "Read-only — only the Master Admin can edit the Homepage." };
    throw e;
  }

  const existing = await findDraftSection(sectionId);
  if (!existing) return { error: "This section is no longer part of the current draft. Reload the page and try again." };
  let modeChanges: StatModeChange[] | undefined;

  if (existing.key === "STATISTICS") {
    // Merge onto the stored content: the section-level form and the Platform
    // Stats card editor each send only their own fields, so neither can
    // overwrite the other's saved values with a stale copy.
    const stored = existing.content as Record<string, unknown>;
    content = sanitizeStatisticsContent({ ...stored, ...content });
    const invalid = validateStatisticsMetrics(normalizeStatMetrics(content.metrics));
    if (invalid) return { error: invalid };
    modeChanges = statModeChanges(stored.metrics, content.metrics);
  }

  await prisma.homepageSection.update({
    where: { id: sectionId },
    data: { content: content as Prisma.InputJsonValue, references: references as Prisma.InputJsonValue },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "HOMEPAGE_SECTION_UPDATED",
      entityType: "HomepageSection",
      entityId: sectionId,
      ...(modeChanges ? { metadata: { modeChanges } } : {}),
    },
  });
  revalidatePath("/admin/website/homepage");
  revalidatePath("/");
  return { success: true };
}

/**
 * Admin → Website → Homepage → Platform Stats "Save Changes": writes the
 * section's master visibility and its cards to the DRAFT in one update.
 * CUSTOM values are presentation settings only — nothing but this
 * HomepageSection row is written. Goes live through the normal Publish.
 */
export async function saveStatisticsCardsAction(
  sectionId: string,
  input: { showSection: boolean; metrics: unknown }
): Promise<SectionContentFormState> {
  let session;
  try {
    session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  } catch (e) {
    if (e instanceof UnauthorizedError) return { error: "Read-only — only the Master Admin can change Homepage Stats." };
    throw e;
  }

  const existing = await findDraftSection(sectionId);
  if (!existing || existing.key !== "STATISTICS") {
    return { error: "This section is no longer part of the current draft. Reload the page and try again." };
  }

  const stored = existing.content as Record<string, unknown>;
  const content = sanitizeStatisticsContent({ ...stored, metrics: input.metrics });
  const invalid = validateStatisticsMetrics(normalizeStatMetrics(content.metrics));
  if (invalid) return { error: invalid };
  const isEnabled = input.showSection === true;
  const modeChanges = statModeChanges(stored.metrics, content.metrics);

  await prisma.homepageSection.update({
    where: { id: sectionId },
    data: { isEnabled, content: content as Prisma.InputJsonValue },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "HOMEPAGE_SECTION_UPDATED",
      entityType: "HomepageSection",
      entityId: sectionId,
      metadata: { platformStats: true, isEnabled, ...(modeChanges ? { modeChanges } : {}) },
    },
  });
  revalidatePath("/admin/website/homepage");
  revalidatePath("/admin/website/homepage/preview");
  return { success: true };
}

export async function refreshHomepageStatisticsAction() {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  updateTag("homepage-statistics");
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_STATISTICS_REFRESHED", entityType: "HomepageConfig", entityId: "global" },
  });
  revalidatePath("/admin/website/homepage");
  revalidatePath("/");
}

export async function publishHomepageAction() {
  const session = await requirePermission(PERMISSIONS.HOMEPAGE_PUBLISH);

  const draft = await getOrCreateDraft();

  await prisma.$transaction(async (tx) => {
    await tx.homepageConfig.updateMany({ where: { status: "PUBLISHED" }, data: { status: "ARCHIVED" } });
    await tx.homepageConfig.update({
      where: { id: draft.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), createdBy: session.user.id },
    });
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_PUBLISHED", entityType: "HomepageConfig", entityId: draft.id, metadata: { version: draft.version } },
  });

  revalidatePath("/admin/website/homepage");
  revalidatePath("/");
  // A fresh DRAFT for future edits is created lazily next time the builder loads.
}

export async function restoreVersionAction(configId: string) {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);

  const source = await prisma.homepageConfig.findUniqueOrThrow({
    where: { id: configId },
    include: { sections: true },
  });

  const currentDraft = await prisma.homepageConfig.findFirst({ where: { status: "DRAFT" } });
  if (currentDraft) {
    await prisma.homepageSection.deleteMany({ where: { homepageConfigId: currentDraft.id } });
    await prisma.homepageSection.createMany({
      data: source.sections.map((s) => ({
        homepageConfigId: currentDraft.id,
        key: s.key,
        isEnabled: s.isEnabled,
        order: s.order,
        content: s.content as Prisma.InputJsonValue,
        references: s.references as Prisma.InputJsonValue,
      })),
    });
    await prisma.homepageConfig.update({ where: { id: currentDraft.id }, data: { seo: source.seo as Prisma.InputJsonValue } });
  }

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_VERSION_RESTORED", entityType: "HomepageConfig", entityId: configId, metadata: { restoredVersion: source.version } },
  });

  revalidatePath("/admin/website/homepage");
}

export interface SeoFormState {
  error?: string;
  success?: boolean;
}

export async function updateSeoAction(_prev: SeoFormState, formData: FormData): Promise<SeoFormState> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  const draft = await getOrCreateDraft();

  const seo = {
    title: String(formData.get("title") ?? ""),
    metaDescription: String(formData.get("metaDescription") ?? ""),
    canonicalUrl: String(formData.get("canonicalUrl") ?? "") || undefined,
    ogTitle: String(formData.get("ogTitle") ?? "") || undefined,
    ogDescription: String(formData.get("ogDescription") ?? "") || undefined,
  };

  await prisma.homepageConfig.update({ where: { id: draft.id }, data: { seo } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_SEO_UPDATED", entityType: "HomepageConfig", entityId: draft.id },
  });
  revalidatePath("/admin/website/homepage");
  return { success: true };
}
