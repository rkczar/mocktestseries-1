import "server-only";
import { prisma } from "@/lib/prisma";
import { BRAND_NAME } from "@/lib/brand";

/**
 * Site-wide SEO defaults (Admin -> SEO) — stored in the existing `Setting`
 * key-value table under `seo.settings`, the same pattern lib/ai-settings.ts
 * uses for `ai.settings`. Per-exam SEO (title/description/slug/public page
 * toggle) already lives on the Exam row itself (see the
 * 20260921120000_add_public_exam_page_and_page_visibility migration) —
 * nothing here duplicates those fields.
 */

const SETTING_KEY = "seo.settings";
const CACHE_TTL_MS = 15_000;

export interface SeoSettings {
  siteName: string;
  titleTemplate: string; // "%s" is replaced with the page's own title
  defaultMetaDescription: string;
  canonicalBase: string;
  defaultOgImage: string;
  siteIndexable: boolean; // global kill-switch: false forces noindex sitewide + empty sitemap
  sitemapEnabled: boolean;
  twitterHandle: string;
}

interface StoredSeoSettings extends Partial<SeoSettings> {
  updatedAt?: string;
}

const DEFAULTS: SeoSettings = {
  siteName: BRAND_NAME,
  titleTemplate: `%s — ${BRAND_NAME}`,
  defaultMetaDescription:
    "Practice with full-length mock tests, previous year papers, and AI-powered explanations — all on one platform.",
  canonicalBase: "https://mocktestseries.in",
  defaultOgImage: "",
  siteIndexable: true,
  sitemapEnabled: true,
  twitterHandle: "",
};

let cache: { fetchedAt: number; value: SeoSettings } | null = null;

export function bumpSeoSettingsEpoch() {
  cache = null;
}

async function readStored(): Promise<StoredSeoSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  return (row.value as StoredSeoSettings) ?? {};
}

export async function getSeoSettings(): Promise<SeoSettings> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const raw = await readStored();
  const value: SeoSettings = { ...DEFAULTS, ...raw };
  cache = { fetchedAt: Date.now(), value };
  return value;
}

export type SeoSettingsUpdate = Partial<SeoSettings>;

export async function saveSeoSettings(update: SeoSettingsUpdate): Promise<void> {
  const raw = await readStored();
  const next: StoredSeoSettings = { ...raw, ...update, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
  bumpSeoSettingsEpoch();
}

export function applyTitleTemplate(template: string, title: string): string {
  return template.includes("%s") ? template.replace("%s", title) : `${title} — ${template}`;
}
