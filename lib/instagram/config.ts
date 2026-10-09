import "server-only";
import { prisma } from "@/lib/prisma";
import { getOfficialInstagram } from "@/lib/omr-sheet";
import { getTelegramChannelConfig } from "@/lib/telegram-channel";
import { safeTelegramUrl } from "@/lib/telegram-url";
import { DEFAULT_SLIDE_COUNT, DEFAULT_TEMPLATE, SLIDE_COUNTS, TEMPLATE_KEYS, normalizeHashtags, type SlideCount, type TemplateKey } from "@/lib/instagram/types";

/**
 * Admin → Instagram → Settings, stored in the existing `Setting` table under
 * `instagram.studio` (same pattern as lib/telegram-channel.ts). Social links
 * are never hardcoded: when the studio has no value of its own, the handle
 * comes from the PUBLISHED homepage footer's Instagram URL and the Telegram
 * link from Admin → Website → Telegram — the same values the live site shows.
 */

const SETTING_KEY = "instagram.studio";
export const WEBSITE_URL_DEFAULT = "https://mocktestseries.in";
export const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export interface StoredStudioSettings {
  instagramHandle?: string;
  telegramUrl?: string;
  telegramName?: string;
  websiteUrl?: string;
  ctaHeadline?: string;
  ctaDescription?: string;
  footerText?: string;
  showInstagram?: boolean;
  showTelegram?: boolean;
  showWebsite?: boolean;
  showSaveShare?: boolean;
  defaultTemplate?: TemplateKey;
  defaultSlideCount?: SlideCount;
  defaultHashtags?: string[];
  /** Per-exam badge text override, keyed by Exam.id. */
  examBadges?: Record<string, string>;
  updatedAt?: string;
}

export interface StudioSettings {
  instagramHandle: string;
  instagramSource: "studio" | "footer" | "none";
  telegramUrl: string;
  telegramSource: "studio" | "website" | "none";
  telegramName: string;
  websiteUrl: string;
  websiteLabel: string;
  ctaHeadline: string;
  ctaDescription: string;
  footerText: string;
  showInstagram: boolean;
  showTelegram: boolean;
  showWebsite: boolean;
  showSaveShare: boolean;
  defaultTemplate: TemplateKey;
  defaultSlideCount: SlideCount;
  defaultHashtags: string[];
  examBadges: Record<string, string>;
  updatedAt: string | null;
}

export const STUDIO_DEFAULTS = {
  ctaHeadline: "Daily PYQs & Medical MCQs",
  ctaDescription: "Follow for one high-yield previous year question every day.",
  footerText: "Practice full mock tests at",
  telegramName: "Telegram Channel",
};

export const TEXT_LIMITS = { ctaHeadline: 48, ctaDescription: 110, footerText: 48, telegramName: 40, examBadge: 40 };

async function readStored(): Promise<StoredStudioSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  return (row?.value as StoredStudioSettings | undefined) ?? {};
}

export function websiteLabel(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname)).replace(/\/$/, "");
  } catch {
    return "mocktestseries.in";
  }
}

export async function getStudioSettings(): Promise<StudioSettings> {
  const [raw, footerIg, telegram] = await Promise.all([readStored(), getOfficialInstagram(), getTelegramChannelConfig()]);
  const studioHandle = raw.instagramHandle && HANDLE_PATTERN.test(raw.instagramHandle) ? raw.instagramHandle : "";
  const footerHandle = footerIg?.handle.replace(/^@/, "") ?? "";
  const studioTelegram = safeTelegramUrl(raw.telegramUrl) ?? "";
  const websiteUrl = raw.websiteUrl?.startsWith("https://") ? raw.websiteUrl : WEBSITE_URL_DEFAULT;
  return {
    instagramHandle: studioHandle || footerHandle,
    instagramSource: studioHandle ? "studio" : footerHandle ? "footer" : "none",
    telegramUrl: studioTelegram || telegram.url || "",
    telegramSource: studioTelegram ? "studio" : telegram.url ? "website" : "none",
    telegramName: raw.telegramName?.trim() || STUDIO_DEFAULTS.telegramName,
    websiteUrl,
    websiteLabel: websiteLabel(websiteUrl),
    ctaHeadline: raw.ctaHeadline?.trim() || STUDIO_DEFAULTS.ctaHeadline,
    ctaDescription: raw.ctaDescription?.trim() || STUDIO_DEFAULTS.ctaDescription,
    footerText: raw.footerText?.trim() || STUDIO_DEFAULTS.footerText,
    showInstagram: raw.showInstagram ?? true,
    showTelegram: raw.showTelegram ?? true,
    showWebsite: raw.showWebsite ?? true,
    showSaveShare: raw.showSaveShare ?? true,
    defaultTemplate: (TEMPLATE_KEYS as readonly string[]).includes(raw.defaultTemplate as string) ? (raw.defaultTemplate as TemplateKey) : DEFAULT_TEMPLATE,
    defaultSlideCount: (SLIDE_COUNTS as readonly number[]).includes(raw.defaultSlideCount as number) ? (raw.defaultSlideCount as SlideCount) : DEFAULT_SLIDE_COUNT,
    defaultHashtags: normalizeHashtags(raw.defaultHashtags ?? []),
    examBadges: raw.examBadges ?? {},
    updatedAt: raw.updatedAt ?? null,
  };
}

/** Domains a caption may link to: the website and (if set) Telegram. */
export function allowedCaptionDomains(s: StudioSettings): string[] {
  const out = ["mocktestseries.in"];
  try {
    out.push(new URL(s.websiteUrl).hostname.replace(/^www\./, ""));
  } catch {}
  if (s.telegramUrl) out.push("t.me");
  if (s.instagramHandle) out.push("instagram.com");
  return [...new Set(out)];
}

export async function saveStudioSettings(next: StoredStudioSettings): Promise<void> {
  const value = { ...next, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: value as object },
    create: { key: SETTING_KEY, value: value as object },
  });
}

export { SETTING_KEY as INSTAGRAM_SETTING_KEY };
