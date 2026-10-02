import "server-only";
import { prisma } from "@/lib/prisma";
import { getEmailEnvConfig } from "@/lib/email/config";

/**
 * Admin-controlled email switches (Setting "email.settings"). The provider
 * credentials are NOT here — they live only in the environment
 * (lib/email/config.ts).
 *
 * `sendingEnabled` is the "production sending" switch. Off by default: until
 * a MASTER_ADMIN turns it on (which requires a configured provider and one
 * successful test email), automatic emails are recorded as SKIPPED instead of
 * piling up in the queue, and campaigns cannot be sent. Test emails work
 * whenever the provider is configured.
 */

const SETTING_KEY = "email.settings";

export interface EmailSettings {
  sendingEnabled: boolean;
  /** Max emails per second the worker sends (provider rate limit). */
  ratePerSecond: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

const DEFAULTS: EmailSettings = { sendingEnabled: false, ratePerSecond: 2, updatedAt: null, updatedBy: null };

export async function getEmailSettings(): Promise<EmailSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = (row?.value ?? {}) as Partial<EmailSettings>;
  const rate = Number(raw.ratePerSecond);
  return {
    sendingEnabled: raw.sendingEnabled === true,
    ratePerSecond: Number.isFinite(rate) && rate >= 1 && rate <= 10 ? Math.floor(rate) : DEFAULTS.ratePerSecond,
    updatedAt: raw.updatedAt ?? null,
    updatedBy: raw.updatedBy ?? null,
  };
}

export async function saveEmailSettings(update: Pick<EmailSettings, "sendingEnabled" | "ratePerSecond">, adminName: string) {
  const value: EmailSettings = {
    sendingEnabled: update.sendingEnabled,
    ratePerSecond: Math.min(10, Math.max(1, Math.floor(update.ratePerSecond))),
    updatedAt: new Date().toISOString(),
    updatedBy: adminName,
  };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: value as unknown as object },
    update: { value: value as unknown as object },
  });
}

/** Production sending is live only when the admin switch is on AND the provider is configured. */
export async function isProductionSendingLive(): Promise<boolean> {
  if (!getEmailEnvConfig().providerConfigured) return false;
  return (await getEmailSettings()).sendingEnabled;
}

/** A test email has reached the provider at least once (precondition for enabling production sending). */
export async function hasSuccessfulTestEmail(): Promise<boolean> {
  const count = await prisma.emailDeliveryLog.count({ where: { isTest: true, status: { in: ["SENT", "DELIVERED"] } } });
  return count > 0;
}
