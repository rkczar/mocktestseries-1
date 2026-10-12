"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { validateBackgroundEffectsConfig, type BackgroundEffectsConfig } from "@/lib/background-effects";
import { BACKGROUND_EFFECTS_SETTING_KEY, saveBackgroundEffectsConfig } from "@/lib/background-effects-settings";

export type BackgroundEffectsResult = { ok: true; config: BackgroundEffectsConfig } | { ok: false; error: string };

/**
 * Presentation only — touches nothing but the `ui.background_effects`
 * Setting (never the button glow's `ui.premium_glow`). WEBSITE_MANAGE, like
 * the rest of Appearance: MASTER_ADMIN only; FULL_ADMIN (read-only) is
 * refused here server-side. The whole document is strictly validated, so
 * only allowlisted values and clamped numbers can ever be stored.
 */
export async function saveBackgroundEffectsAction(raw: unknown): Promise<BackgroundEffectsResult> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  const parsed = validateBackgroundEffectsConfig(raw);
  if (!parsed.ok) return parsed;

  await saveBackgroundEffectsConfig(parsed.config);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "BACKGROUND_EFFECTS_SAVED",
      entityType: "Setting",
      entityId: BACKGROUND_EFFECTS_SETTING_KEY,
      metadata: { enabled: parsed.config.enabled, design: parsed.config.design, scope: parsed.config.scope, theme: parsed.config.theme },
    },
  });
  revalidatePath("/", "layout");
  return { ok: true, config: parsed.config };
}
