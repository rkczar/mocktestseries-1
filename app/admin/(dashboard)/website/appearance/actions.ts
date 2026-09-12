"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #0F4C81");

const schema = z.object({
  primary: hex,
  secondary: hex,
  accent: hex,
  success: hex,
  error: hex,
  warning: hex,
  info: hex,
  headingFont: z.string().min(2).max(300),
  bodyFont: z.string().min(2).max(300),
  buttonRadius: z.string().min(1).max(20),
  cardRadius: z.string().min(1).max(20),
  shadowIntensity: z.enum(["none", "sm", "md"]),
});

export interface AppearanceFormState {
  error?: string;
  success?: boolean;
}

export async function saveAppearanceAction(
  _prev: AppearanceFormState,
  formData: FormData
): Promise<AppearanceFormState> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);

  const parsed = schema.safeParse({
    primary: formData.get("primary"),
    secondary: formData.get("secondary"),
    accent: formData.get("accent"),
    success: formData.get("success"),
    error: formData.get("error"),
    warning: formData.get("warning"),
    info: formData.get("info"),
    headingFont: formData.get("headingFont"),
    bodyFont: formData.get("bodyFont"),
    buttonRadius: formData.get("buttonRadius"),
    cardRadius: formData.get("cardRadius"),
    shadowIntensity: formData.get("shadowIntensity"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.appearanceConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });

  const config = await prisma.appearanceConfig.create({
    data: {
      isActive: true,
      colors: {
        primary: parsed.data.primary,
        secondary: parsed.data.secondary,
        accent: parsed.data.accent,
        success: parsed.data.success,
        error: parsed.data.error,
        warning: parsed.data.warning,
        info: parsed.data.info,
      },
      fonts: { heading: parsed.data.headingFont, body: parsed.data.bodyFont },
      buttonStyle: { radius: parsed.data.buttonRadius },
      componentStyle: { cardRadius: parsed.data.cardRadius, shadowIntensity: parsed.data.shadowIntensity },
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "APPEARANCE_CHANGED", entityType: "AppearanceConfig", entityId: config.id },
  });

  revalidatePath("/", "layout");
  return { success: true };
}
