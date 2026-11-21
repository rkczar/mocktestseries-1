import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Switches for the optional Admin "Login with OTP" (Admin → Settings → Security), stored in the `Setting` table
 * under `security.admin_otp_login` as { enabled (Email OTP), mobileEnabled (Mobile OTP) }. Each OFF when missing,
 * malformed or unreadable; the two are independent.
 * 15 s in-process cache per PM2 worker (same pattern as lib/student-device-settings.ts).
 * Password login never reads this switch.
 */

export const ADMIN_OTP_SETTING_KEY = "security.admin_otp_login";
const CACHE_TTL_MS = 15_000;

export interface AdminOtpMethods {
  /** Email OTP (stored as `enabled` — the original single switch). */
  email: boolean;
  /** Mobile OTP (MSG91 SMS, optional WhatsApp re-delivery). */
  mobile: boolean;
}
const OFF: AdminOtpMethods = { email: false, mobile: false };

let cache: { fetchedAt: number; value: AdminOtpMethods } | null = null;

/** Both methods; each is ON only when stored as boolean true. Missing / malformed / unreadable → OFF. */
export async function getAdminOtpMethods(): Promise<AdminOtpMethods> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  let value = OFF;
  try {
    const row = await prisma.setting.findUnique({ where: { key: ADMIN_OTP_SETTING_KEY } });
    const v = row?.value as { enabled?: unknown; mobileEnabled?: unknown } | null;
    value = { email: v?.enabled === true, mobile: v?.mobileEnabled === true };
  } catch (error) {
    // Read failure → OFF (fail closed); not cached, so the next request retries.
    console.warn("[admin-otp] switch unreadable, treating as OFF", { reason: error instanceof Error ? error.message.slice(0, 80) : "error" });
    return OFF;
  }
  cache = { fetchedAt: Date.now(), value };
  return value;
}

/** Email OTP switch (kept for existing callers). */
export async function isAdminOtpLoginEnabled(): Promise<boolean> {
  return (await getAdminOtpMethods()).email;
}

export async function saveAdminOtpMethods(next: AdminOtpMethods): Promise<void> {
  const value = { enabled: next.email, mobileEnabled: next.mobile };
  await prisma.setting.upsert({ where: { key: ADMIN_OTP_SETTING_KEY }, create: { key: ADMIN_OTP_SETTING_KEY, value }, update: { value } });
  cache = { fetchedAt: Date.now(), value: { ...next } };
}

/** Email switch only; the mobile switch keeps its stored value. */
export async function saveAdminOtpLoginEnabled(enabled: boolean): Promise<void> {
  cache = null;
  const current = await getAdminOtpMethods();
  await saveAdminOtpMethods({ ...current, email: enabled });
}

/** Test hook: drop the in-process cache. */
export function clearAdminOtpLoginCache() {
  cache = null;
}
