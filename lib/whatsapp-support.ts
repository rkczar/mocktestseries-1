import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Admin-managed floating WhatsApp Support button (Admin -> Website -> Footer
 * -> WhatsApp Support). Stored in the existing `Setting` key-value table —
 * same pattern as lib/whatsapp-share-config.ts — and read per request, so a
 * saved change applies on the next page load with no rebuild or deploy.
 *
 * There is deliberately NO default phone number: until an admin saves a
 * valid number the button stays hidden everywhere.
 */

const SETTING_KEY = "website.whatsapp_support";

export const DEFAULT_WHATSAPP_SUPPORT_MESSAGE = "Hi MockTestSeries.in Team, I need help regarding my test/preparation.";
export const DEFAULT_WHATSAPP_SUPPORT_LABEL = "Chat with Us";
export const WHATSAPP_SUPPORT_MESSAGE_MAX = 500;
export const WHATSAPP_SUPPORT_LABEL_MAX = 40;

/** "public" = the homepage and every PublicPageShell page (/exams, /contact, /privacy, /terms). */
export type WhatsAppSupportSurface = "public" | "student";

export interface WhatsAppSupportConfig {
  enabled: boolean;
  /** Digits only, country code first (e.g. 91XXXXXXXXXX); "" when unset. */
  number: string;
  message: string;
  label: string;
  /** Homepage + public pages (key name kept for stored-config compatibility). */
  showOnHomepage: boolean;
  showInStudentArea: boolean;
  updatedAt: string | null;
}

interface StoredWhatsAppSupportConfig {
  enabled?: boolean;
  number?: string;
  message?: string;
  label?: string;
  showOnHomepage?: boolean;
  showInStudentArea?: boolean;
  updatedAt?: string;
}

export type NormalizeResult = { ok: true; number: string } | { ok: false; error: string };

/**
 * Normalizes an admin-entered WhatsApp number to the digits-only form that
 * https://wa.me/<number> requires. Accepts common formatting ("+91 98765
 * 43210", "0091-98765-43210", "(91) 98765 43210") and rejects anything else
 * rather than guessing. The country code is required: a bare 10-digit local
 * number is refused because it would silently resolve to the wrong country.
 */
export function normalizeWhatsAppNumber(input: string): NormalizeResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter a WhatsApp number." };
  if (!/^[+\d\s().-]+$/.test(raw)) {
    return { ok: false, error: "The number may only contain digits, spaces, +, -, ( and )." };
  }
  if (raw.indexOf("+") > 0 || raw.split("+").length > 2) {
    return { ok: false, error: "A + is only allowed at the start of the number." };
  }
  const hadPrefix = raw.startsWith("+") || raw.replace(/[\s().-]/g, "").startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!hadPrefix && digits.length <= 10) {
    return { ok: false, error: "Include the country code (for example 91 for India)." };
  }
  if (digits.startsWith("0")) return { ok: false, error: "The country code cannot start with 0." };
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: "A WhatsApp number with country code is 8 to 15 digits." };
  }
  return { ok: true, number: digits };
}

function isValidStoredNumber(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{7,14}$/.test(value);
}

export async function getWhatsAppSupportConfig(): Promise<WhatsAppSupportConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = (row?.value as StoredWhatsAppSupportConfig | undefined) ?? {};
  return {
    enabled: raw.enabled ?? false,
    number: isValidStoredNumber(raw.number) ? raw.number : "",
    message: raw.message?.trim() || DEFAULT_WHATSAPP_SUPPORT_MESSAGE,
    label: raw.label?.trim() || DEFAULT_WHATSAPP_SUPPORT_LABEL,
    showOnHomepage: raw.showOnHomepage ?? true,
    showInStudentArea: raw.showInStudentArea ?? true,
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function saveWhatsAppSupportConfig(update: Omit<WhatsAppSupportConfig, "updatedAt">): Promise<void> {
  const next: StoredWhatsAppSupportConfig = {
    enabled: update.enabled,
    number: update.number,
    message: update.message.trim() || DEFAULT_WHATSAPP_SUPPORT_MESSAGE,
    label: update.label.trim() || DEFAULT_WHATSAPP_SUPPORT_LABEL,
    showOnHomepage: update.showOnHomepage,
    showInStudentArea: update.showInStudentArea,
    updatedAt: new Date().toISOString(),
  };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
}

export function buildWhatsAppSupportHref(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

/**
 * The only thing public pages ever receive: the ready-made wa.me link and the
 * tooltip label — never the rest of the admin config. Returns null (button
 * hidden) when the feature is off, the surface is switched off, or no valid
 * number is saved.
 */
export async function getPublicWhatsAppSupport(
  surface: WhatsAppSupportSurface
): Promise<{ href: string; label: string } | null> {
  // A support widget must never take a page down with it: on a settings read
  // failure the button is simply not rendered.
  const config = await getWhatsAppSupportConfig().catch(() => null);
  if (!config || !config.enabled || !config.number) return null;
  if (surface === "public" && !config.showOnHomepage) return null;
  if (surface === "student" && !config.showInStudentArea) return null;
  return { href: buildWhatsAppSupportHref(config.number, config.message), label: config.label };
}
