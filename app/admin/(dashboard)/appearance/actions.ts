"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { BODY_FONTS, DISPLAY_FONTS } from "@/lib/appearance";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color, e.g. #0F4C81");

const schema = z.object({
  primaryColor: hexColor,
  accentColor: hexColor,
  successColor: hexColor,
  errorColor: hexColor,
  fontDisplay: z.enum(Object.keys(DISPLAY_FONTS) as [string, ...string[]]),
  fontBody: z.enum(Object.keys(BODY_FONTS) as [string, ...string[]]),
  buttonRadiusPx: z.coerce.number().int().min(0).max(24),
});

export async function updateAppearanceAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();

  const parsed = schema.safeParse({
    primaryColor: formData.get("primaryColor"),
    accentColor: formData.get("accentColor"),
    successColor: formData.get("successColor"),
    errorColor: formData.get("errorColor"),
    fontDisplay: formData.get("fontDisplay"),
    fontBody: formData.get("fontBody"),
    buttonRadiusPx: formData.get("buttonRadiusPx"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const existing = await prisma.appearanceSetting.findFirst();
  const data = { ...parsed.data, updatedById: session.user.id };

  if (existing) {
    await prisma.appearanceSetting.update({ where: { id: existing.id }, data });
  } else {
    await prisma.appearanceSetting.create({ data });
  }

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "AppearanceSetting",
    diff: parsed.data,
  });
  updateTag("appearance");
  redirect("/admin/appearance?success=Appearance updated");
}
