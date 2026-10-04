"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { defaultPremiumGlowConfig, validatePremiumGlowConfig, type PremiumGlowConfig } from "@/lib/premium-glow";
import { PREMIUM_GLOW_SETTING_KEY, savePremiumGlowConfig } from "@/lib/premium-glow-settings";

export type GlowEffectsResult = { ok: true; config: PremiumGlowConfig } | { ok: false; error: string };

/**
 * Presentation only — touches nothing but the `ui.premium_glow` Setting.
 * SETTINGS_MANAGE is MASTER_ADMIN-only; FULL_ADMIN (global read-only) is
 * refused here server-side, not merely shown a disabled form.
 */
export async function saveGlowEffectsAction(raw: unknown): Promise<GlowEffectsResult> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = validatePremiumGlowConfig(raw);
  if (!parsed.ok) return parsed;

  await savePremiumGlowConfig(parsed.config);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "PREMIUM_GLOW_SAVED",
      entityType: "Setting",
      entityId: PREMIUM_GLOW_SETTING_KEY,
      metadata: { ...parsed.config },
    },
  });
  revalidatePath("/", "layout");
  return { ok: true, config: parsed.config };
}

export async function resetGlowEffectsAction(): Promise<GlowEffectsResult> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const config = defaultPremiumGlowConfig();
  await savePremiumGlowConfig(config);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "PREMIUM_GLOW_RESET",
      entityType: "Setting",
      entityId: PREMIUM_GLOW_SETTING_KEY,
      metadata: { ...config },
    },
  });
  revalidatePath("/", "layout");
  return { ok: true, config };
}
