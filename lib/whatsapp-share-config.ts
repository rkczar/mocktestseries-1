import "server-only";
import { prisma } from "@/lib/prisma";
import { DEFAULT_WHATSAPP_SHARE_TEMPLATE } from "@/lib/whatsapp-share-template";

/**
 * Admin-controlled template for the student Review page's WhatsApp Share
 * action (Section 16). Stored in the existing `Setting` key-value table —
 * same pattern as lib/gemini-config.ts / lib/razorpay-config.ts — rather than
 * a dedicated table, since it's a single small config object with no
 * relational shape of its own.
 */

const SETTING_KEY = "question.whatsapp_share";

export interface WhatsAppShareConfig {
  enabled: boolean;
  template: string;
  updatedAt: string | null;
}

interface StoredWhatsAppShareConfig {
  enabled?: boolean;
  template?: string;
  updatedAt?: string;
}

export async function getWhatsAppShareConfig(): Promise<WhatsAppShareConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = (row?.value as StoredWhatsAppShareConfig | undefined) ?? {};
  return {
    enabled: raw.enabled ?? false,
    template: raw.template?.trim() || DEFAULT_WHATSAPP_SHARE_TEMPLATE,
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function saveWhatsAppShareConfig(update: { enabled: boolean; template: string }): Promise<void> {
  const next: StoredWhatsAppShareConfig = {
    enabled: update.enabled,
    template: update.template.trim() || DEFAULT_WHATSAPP_SHARE_TEMPLATE,
    updatedAt: new Date().toISOString(),
  };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
}

export { renderWhatsAppShareText, WHATSAPP_SHARE_PLACEHOLDERS, DEFAULT_WHATSAPP_SHARE_TEMPLATE } from "@/lib/whatsapp-share-template";
