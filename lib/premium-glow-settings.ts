import "server-only";
import { prisma } from "@/lib/prisma";
import { defaultPremiumGlowConfig, parsePremiumGlowConfig, type PremiumGlowConfig } from "@/lib/premium-glow";

/**
 * Storage for Premium Glow Effects: one JSON document in the existing
 * `Setting` key-value table, the same pattern as platform.controls and
 * ai.settings. Read once per page render by the root layout (never per
 * button) and cached per worker for CACHE_TTL_MS, so every PM2 worker shows
 * an admin change within that window without a redeploy. A missing row or
 * a failed read renders the defaults (the shipped glow) — presentation
 * must never break a page.
 */
export const PREMIUM_GLOW_SETTING_KEY = "ui.premium_glow";
const CACHE_TTL_MS = 5_000;

let cache: { fetchedAt: number; value: PremiumGlowConfig } | null = null;

export async function getPremiumGlowConfig(): Promise<PremiumGlowConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  try {
    const row = await prisma.setting.findUnique({ where: { key: PREMIUM_GLOW_SETTING_KEY } });
    const value = row ? parsePremiumGlowConfig(row.value) : defaultPremiumGlowConfig();
    cache = { fetchedAt: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? defaultPremiumGlowConfig();
  }
}

/** Callers validate first (validatePremiumGlowConfig) and own the RBAC check. */
export async function savePremiumGlowConfig(config: PremiumGlowConfig): Promise<void> {
  const value = { ...config, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: PREMIUM_GLOW_SETTING_KEY },
    update: { value },
    create: { key: PREMIUM_GLOW_SETTING_KEY, value },
  });
  cache = { fetchedAt: Date.now(), value: config };
}
