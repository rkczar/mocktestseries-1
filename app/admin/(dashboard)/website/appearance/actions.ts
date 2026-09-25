"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  BUTTON_RADIUS_OPTIONS,
  CARD_RADIUS_OPTIONS,
  FONT_STACK_MAX_LENGTH,
  HEX_COLOR_RE,
  SHADOW_OPTIONS,
  isValidFontStack,
} from "@/lib/appearance";

const hex = z.string().regex(HEX_COLOR_RE, "Must be a hex color like #0F4C81");
// Font stacks are free text in the form but must be a plain CSS font-family
// list (lib/appearance.ts#isValidFontStack) — they are emitted into <head>.
const fontStack = z
  .string()
  .max(FONT_STACK_MAX_LENGTH)
  .refine(isValidFontStack, "Font stack may only list font names (letters, digits, spaces, hyphens, quotes) or var(--…), separated by commas.");

const schema = z.object({
  primary: hex,
  secondary: hex,
  accent: hex,
  success: hex,
  error: hex,
  warning: hex,
  info: hex,
  headingFont: fontStack,
  bodyFont: fontStack,
  buttonRadius: z.enum(BUTTON_RADIUS_OPTIONS),
  cardRadius: z.enum(CARD_RADIUS_OPTIONS),
  shadowIntensity: z.enum(SHADOW_OPTIONS),
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
