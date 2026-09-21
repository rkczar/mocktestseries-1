"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { saveWhatsAppShareConfig } from "@/lib/whatsapp-share-config";

export interface WhatsAppShareFormState {
  error?: string;
  success?: boolean;
}

/**
 * Gated behind QUESTIONS_MANAGE — the same permission that already governs
 * every other Question Bank mutation, so FULL_ADMIN's existing read-only
 * status on the Question Bank domain (lib/permissions.ts) applies here too
 * without introducing a new permission key.
 */
export async function saveWhatsAppShareConfigAction(
  _prev: WhatsAppShareFormState,
  formData: FormData
): Promise<WhatsAppShareFormState> {
  const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const template = String(formData.get("template") ?? "").trim();
  if (!template) return { error: "Message template cannot be empty." };

  await saveWhatsAppShareConfig({ enabled, template });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "WHATSAPP_SHARE_CONFIG_SAVED", entityType: "Setting", entityId: "question.whatsapp_share", metadata: { enabled } },
  });

  revalidatePath("/admin/questions");
  return { success: true };
}
