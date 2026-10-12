import "server-only";
import { prisma } from "@/lib/prisma";
import {
  defaultBackgroundEffectsConfig,
  parseBackgroundEffectsConfig,
  scopeCovers,
  type BackgroundEffectsConfig,
  type BgSurface,
} from "@/lib/background-effects";

/**
 * Storage for Background Effects: one JSON document in the existing
 * `Setting` table (same pattern as ui.premium_glow, but its own key — the
 * two never share settings). Cached per worker for CACHE_TTL_MS, so a page
 * render costs at most one small primary-key read every few seconds. A
 * missing row or a failed read means OFF: decoration must never break a page.
 */
export const BACKGROUND_EFFECTS_SETTING_KEY = "ui.background_effects";
const CACHE_TTL_MS = 5_000;

let cache: { fetchedAt: number; value: BackgroundEffectsConfig } | null = null;

export async function getBackgroundEffectsConfig(): Promise<BackgroundEffectsConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  try {
    const row = await prisma.setting.findUnique({ where: { key: BACKGROUND_EFFECTS_SETTING_KEY } });
    const value = row ? parseBackgroundEffectsConfig(row.value) : defaultBackgroundEffectsConfig();
    cache = { fetchedAt: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? defaultBackgroundEffectsConfig();
  }
}

/** The config to render on this surface, or null (OFF / out of scope) — then nothing is rendered at all. */
export async function getBackgroundEffectsFor(surface: BgSurface): Promise<BackgroundEffectsConfig | null> {
  const config = await getBackgroundEffectsConfig();
  return config.enabled && scopeCovers(config.scope, surface) ? config : null;
}

/** Callers validate first (validateBackgroundEffectsConfig) and own the RBAC check. */
export async function saveBackgroundEffectsConfig(config: BackgroundEffectsConfig): Promise<void> {
  const value = { ...config, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: BACKGROUND_EFFECTS_SETTING_KEY },
    update: { value },
    create: { key: BACKGROUND_EFFECTS_SETTING_KEY, value },
  });
  cache = { fetchedAt: Date.now(), value: config };
}
