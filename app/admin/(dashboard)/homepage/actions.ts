"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const contentSchema = z.object({
  heroEyebrow: z.string().trim().min(1, "Required"),
  heroHeading: z.string().trim().min(1, "Required"),
  heroDescription: z.string().trim().min(1, "Required"),
  finalCtaHeading: z.string().trim().min(1, "Required"),
  finalCtaBody: z.string().trim().min(1, "Required"),
  finalCtaNote: z.string().trim().optional(),
});

export async function updateHomepageContentAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();

  const parsed = contentSchema.safeParse({
    heroEyebrow: formData.get("heroEyebrow"),
    heroHeading: formData.get("heroHeading"),
    heroDescription: formData.get("heroDescription"),
    finalCtaHeading: formData.get("finalCtaHeading"),
    finalCtaBody: formData.get("finalCtaBody"),
    finalCtaNote: formData.get("finalCtaNote") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const existing = await prisma.homepageContent.findFirst();
  const data = { ...parsed.data, updatedById: session.user.id };

  if (existing) {
    await prisma.homepageContent.update({ where: { id: existing.id }, data });
  } else {
    await prisma.homepageContent.create({ data });
  }

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "HomepageContent",
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/homepage?tab=content&success=Saved");
}

const sectionRowSchema = z.object({
  key: z.string(),
  order: z.coerce.number().int(),
  isVisible: z.coerce.boolean(),
});

export async function updateSectionsAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();

  const keys = formData.getAll("key") as string[];
  const rows = keys.map((key) =>
    sectionRowSchema.parse({
      key,
      order: formData.get(`order_${key}`),
      isVisible: formData.get(`isVisible_${key}`) === "on",
    }),
  );

  await prisma.$transaction(
    rows.map((row) =>
      prisma.homepageSection.update({
        where: { key: row.key },
        data: { order: row.order, isVisible: row.isVisible },
      }),
    ),
  );

  await writeAuditLog({
    adminId: session.user.id,
    action: "reorder",
    entity: "HomepageSection",
    diff: rows,
  });
  updateTag("homepage");
  redirect("/admin/homepage?tab=sections&success=Saved");
}

const ctaSchema = z.object({
  slot: z.string(),
  label: z.string().trim().min(1, "Label is required"),
  href: z.string().trim().min(1, "Link is required"),
  variant: z.enum(["primary", "secondary", "accent", "ghost"]),
  isActive: z.coerce.boolean(),
});

export async function updateCtaButtonAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();

  const parsed = ctaSchema.safeParse({
    slot: formData.get("slot"),
    label: formData.get("label"),
    href: formData.get("href"),
    variant: formData.get("variant"),
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await prisma.ctaButton.upsert({
    where: { slot: parsed.data.slot },
    update: parsed.data,
    create: parsed.data,
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "CtaButton",
    entityId: parsed.data.slot,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/homepage?tab=ctas&success=Saved");
}
