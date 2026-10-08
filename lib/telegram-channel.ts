import "server-only";
import { prisma } from "@/lib/prisma";
import { safeTelegramUrl } from "@/lib/telegram-url";

/**
 * Admin-managed "Join Our Telegram Channel" call to action (Admin -> Website
 * -> Footer -> Telegram Channel). Same storage pattern as
 * lib/whatsapp-support.ts: one `Setting` row read per request, so a saved
 * change applies on the next page load with no rebuild or deploy. No default
 * URL — the CTA stays hidden until an admin saves a valid channel link.
 */

const SETTING_KEY = "website.telegram_channel";

export type TelegramChannelSurface = "homepage" | "dashboard";

export interface TelegramChannelConfig {
  url: string;
  showOnHomepage: boolean;
  showOnDashboard: boolean;
  updatedAt: string | null;
}

interface StoredTelegramChannelConfig {
  url?: string;
  showOnHomepage?: boolean;
  showOnDashboard?: boolean;
  updatedAt?: string;
}

export async function getTelegramChannelConfig(): Promise<TelegramChannelConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = (row?.value as StoredTelegramChannelConfig | undefined) ?? {};
  return {
    url: safeTelegramUrl(raw.url) ?? "",
    showOnHomepage: raw.showOnHomepage ?? false,
    showOnDashboard: raw.showOnDashboard ?? false,
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function saveTelegramChannelConfig(update: Omit<TelegramChannelConfig, "updatedAt">): Promise<void> {
  const next: StoredTelegramChannelConfig = { ...update, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
}

/** The channel link for one surface, or null (CTA hidden): no valid URL, surface switched off, or a settings read failure. */
export async function getPublicTelegramChannel(surface: TelegramChannelSurface): Promise<string | null> {
  const config = await getTelegramChannelConfig().catch(() => null);
  if (!config?.url) return null;
  if (surface === "homepage" && !config.showOnHomepage) return null;
  if (surface === "dashboard" && !config.showOnDashboard) return null;
  return config.url;
}
