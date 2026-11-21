import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Emergency switch for the optional Admin "Login with OTP" (Admin → Settings → Security), stored in the
 * `Setting` table under `security.admin_otp_login` as { enabled }. OFF when missing, malformed or unreadable.
 * 15 s in-process cache per PM2 worker (same pattern as lib/student-device-settings.ts).
 * Password login never reads this switch.
 */

export const ADMIN_OTP_SETTING_KEY = "security.admin_otp_login";
const CACHE_TTL_MS = 15_000;

let cache: { fetchedAt: number; value: boolean } | null = null;

export async function isAdminOtpLoginEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  let value = false;
  try {
    const row = await prisma.setting.findUnique({ where: { key: ADMIN_OTP_SETTING_KEY } });
    value = (row?.value as { enabled?: unknown } | null)?.enabled === true;
  } catch (error) {
    // Read failure → OFF (fail closed); not cached, so the next request retries.
    console.warn("[admin-otp] switch unreadable, treating as OFF", { reason: error instanceof Error ? error.message.slice(0, 80) : "error" });
    return false;
  }
  cache = { fetchedAt: Date.now(), value };
  return value;
}

export async function saveAdminOtpLoginEnabled(enabled: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: ADMIN_OTP_SETTING_KEY },
    create: { key: ADMIN_OTP_SETTING_KEY, value: { enabled } },
    update: { value: { enabled } },
  });
  cache = { fetchedAt: Date.now(), value: enabled };
}

/** Test hook: drop the in-process cache. */
export function clearAdminOtpLoginCache() {
  cache = null;
}
