import "server-only";
import { prisma } from "@/lib/prisma";
import { IMPORTER_FEATURE_PREFIX } from "@/lib/ai-import/config";
import type { ModelHealth } from "@/lib/ai-import/selection-types";

/**
 * Recent importer request history per model, from the platform AI call log
 * (AiGatewayCall rows of the "qimport_*" features; the AI Engine's own health
 * never counts importer calls). Measured facts only: it never says how good a
 * model is, only whether its provider recently accepted or refused requests.
 */

/** History window shown and used. */
export const HEALTH_WINDOW_MS = 24 * 60 * 60_000;
/** Automatic selection skips a model whose last RATE_LIMIT_AVOID_AFTER importer requests were all rate-limited… */
export const RATE_LIMIT_AVOID_AFTER = 2;
/** …within this long after the latest of them. */
export const RATE_LIMIT_AVOID_MS = 6 * 60 * 60_000;

/** Whether automatic selection should avoid the model now (null = no). */
export function rateLimitAvoidance(h: ModelHealth | undefined, now = Date.now()): string | null {
  if (!h || h.consecutiveRateLimited < RATE_LIMIT_AVOID_AFTER || !h.lastRateLimitedAt) return null;
  const at = new Date(h.lastRateLimitedAt).getTime();
  if (now - at > RATE_LIMIT_AVOID_MS) return null;
  return `its provider rate-limited its last ${h.consecutiveRateLimited} importer request(s) (latest ${h.lastRateLimitedAt.slice(0, 16).replace("T", " ")} UTC), so automatic selection skips it until ${new Date(at + RATE_LIMIT_AVOID_MS).toISOString().slice(0, 16).replace("T", " ")} UTC — choose it under Manual override to try it again`;
}

export async function importerModelHealth(ids: readonly string[], now = Date.now()): Promise<Record<string, ModelHealth>> {
  if (!ids.length) return {};
  const rows = await prisma.aiGatewayCall.findMany({
    where: { feature: { startsWith: IMPORTER_FEATURE_PREFIX }, model: { in: [...ids] }, createdAt: { gte: new Date(now - HEALTH_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { model: true, ok: true, errorCategory: true, createdAt: true },
    take: 2_000,
  });
  const out: Record<string, ModelHealth> = {};
  for (const r of rows) {
    const h = (out[r.model] ??= { requests: 0, ok: 0, rateLimited: 0, consecutiveRateLimited: 0, streakOpen: true, lastRateLimitedAt: null, lastOkAt: null });
    h.requests++;
    if (r.ok) h.ok++;
    const limited = r.errorCategory === "rate_limited";
    if (limited) {
      h.rateLimited++;
      h.lastRateLimitedAt ??= r.createdAt.toISOString();
    }
    if (r.ok) h.lastOkAt ??= r.createdAt.toISOString();
    // Newest first: count rate-limited answers until the first answer that was not one.
    if (h.streakOpen) {
      if (limited) h.consecutiveRateLimited++;
      else h.streakOpen = false;
    }
  }
  return out;
}
