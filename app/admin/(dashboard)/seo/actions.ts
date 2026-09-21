"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { saveSeoSettings, type SeoSettingsUpdate } from "@/lib/seo-settings";

export interface SeoFormState {
  error?: string;
  success?: boolean;
}

/**
 * Site-wide SEO defaults — MASTER_ADMIN only, enforced server-side (not
 * just a disabled form field) per the same pattern as
 * togglePageVisibilityAction (lib/permissions.ts PAGE_VISIBILITY_MANAGE).
 */
export async function saveSeoSettingsAction(_prev: SeoFormState, formData: FormData): Promise<SeoFormState> {
  const session = await requirePermission(PERMISSIONS.SEO_MANAGE);

  const update: SeoSettingsUpdate = {
    siteName: String(formData.get("siteName") ?? "").trim() || undefined,
    titleTemplate: String(formData.get("titleTemplate") ?? "").trim() || undefined,
    defaultMetaDescription: String(formData.get("defaultMetaDescription") ?? "").trim(),
    canonicalBase: String(formData.get("canonicalBase") ?? "").trim().replace(/\/+$/, ""),
    defaultOgImage: String(formData.get("defaultOgImage") ?? "").trim(),
    siteIndexable: formData.get("siteIndexable") === "on",
    sitemapEnabled: formData.get("sitemapEnabled") === "on",
    twitterHandle: String(formData.get("twitterHandle") ?? "").trim(),
  };

  if (update.titleTemplate && !update.titleTemplate.includes("%s")) {
    return { error: 'Title template must include "%s" as the page-title placeholder.' };
  }

  await saveSeoSettings(update);
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SEO_SETTINGS_SAVED", entityType: "Setting", entityId: "seo.settings", metadata: update },
  });

  revalidatePath("/admin/seo");
  revalidatePath("/");
  revalidatePath("/exams");
  revalidatePath("/sitemap.xml");
  revalidatePath("/robots.txt");
  return { success: true };
}
