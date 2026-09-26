"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  WHATSAPP_SUPPORT_LABEL_MAX,
  WHATSAPP_SUPPORT_MESSAGE_MAX,
  normalizeWhatsAppNumber,
  saveWhatsAppSupportConfig,
} from "@/lib/whatsapp-support";

export interface WhatsAppSupportFormState {
  error?: string;
  success?: boolean;
  savedNumber?: string;
}

/**
 * Gated behind WEBSITE_MANAGE, which only MASTER_ADMIN holds — FULL_ADMIN is
 * global read-only (lib/permissions.ts) and is refused here server-side.
 */
export async function saveWhatsAppSupportAction(
  _prev: WhatsAppSupportFormState,
  formData: FormData
): Promise<WhatsAppSupportFormState> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);

  const enabled = formData.get("enabled") === "on";
  const showOnHomepage = formData.get("showOnHomepage") === "on";
  const showInStudentArea = formData.get("showInStudentArea") === "on";
  const rawNumber = String(formData.get("number") ?? "");
  const message = String(formData.get("message") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();

  if (message.length > WHATSAPP_SUPPORT_MESSAGE_MAX) {
    return { error: `Pre-filled message must be at most ${WHATSAPP_SUPPORT_MESSAGE_MAX} characters.` };
  }
  if (label.length > WHATSAPP_SUPPORT_LABEL_MAX) {
    return { error: `Tooltip label must be at most ${WHATSAPP_SUPPORT_LABEL_MAX} characters.` };
  }

  // An empty number is allowed only while the feature is off (the button is
  // hidden anyway); enabling requires a valid number.
  let number = "";
  if (rawNumber.trim() || enabled) {
    const normalized = normalizeWhatsAppNumber(rawNumber);
    if (!normalized.ok) return { error: normalized.error };
    number = normalized.number;
  }

  await saveWhatsAppSupportConfig({ enabled, number, message, label, showOnHomepage, showInStudentArea });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "WHATSAPP_SUPPORT_CONFIG_SAVED",
      entityType: "Setting",
      entityId: "website.whatsapp_support",
      metadata: { enabled, showOnHomepage, showInStudentArea, hasNumber: number !== "" },
    },
  });

  revalidatePath("/", "layout");
  return { success: true, savedNumber: number };
}
