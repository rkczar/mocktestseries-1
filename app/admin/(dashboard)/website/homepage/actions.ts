"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getOrCreateDraft } from "@/lib/homepage";
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

export async function updateSectionContentAction(
  sectionId: string,
  content: Record<string, unknown>,
  references: Record<string, unknown>
): Promise<SectionContentFormState> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  await prisma.homepageSection.update({
    where: { id: sectionId },
    data: { content: content as Prisma.InputJsonValue, references: references as Prisma.InputJsonValue },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "HOMEPAGE_SECTION_UPDATED", entityType: "HomepageSection", entityId: sectionId },
  });
  revalidatePath("/admin/website/homepage");
  return { success: true };
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
