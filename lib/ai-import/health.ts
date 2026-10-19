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

/** Provider answers meaning "no route can serve this request" (OpenRouter 404: parameters, data policy, price ceiling, ZDR). */
export const REFUSED_CATEGORIES = ["no_endpoint", "model_unavailable"];

/**
 * Whether the model must not be used now for a job because OpenRouter refused that job's most recent request(s)
 * to it as unservable (null = usable). Measured history of the JOB (importerModelHealth with its jobId), applied
 * by Reconfigure, replacement and the re-check before each request, so a refused model is not tried again and
 * again for the same job; other jobs and settings (privacy can differ) are not affected.
 */
export function routeRefusal(h: ModelHealth | undefined, now = Date.now()): string | null {
  if (!h || !h.consecutiveRefused || !h.lastRefusedAt) return null;
  const at = new Date(h.lastRefusedAt).getTime();
  if (now - at > RATE_LIMIT_AVOID_MS) return null;
  return `OpenRouter refused its last ${h.consecutiveRefused} importer request(s) because no provider route could serve them (latest ${h.lastRefusedAt.slice(0, 16).replace("T", " ")} UTC${h.lastRefusal ? `: “${h.lastRefusal}”` : ""}), so it is not used again until ${new Date(at + RATE_LIMIT_AVOID_MS).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `jobId`: only that import job's requests (its refusal history); otherwise every importer request. */
export async function importerModelHealth(ids: readonly string[], now = Date.now(), jobId?: string): Promise<Record<string, ModelHealth>> {
  if (!ids.length) return {};
  const ofJob = jobId ? (await prisma.aiImportAiCall.findMany({ where: { jobId, createdAt: { gte: new Date(now - HEALTH_WINDOW_MS) } }, select: { requestId: true } })).map((r) => r.requestId) : null;
  if (ofJob && !ofJob.length) return {};
  const rows = await prisma.aiGatewayCall.findMany({
    where: { feature: { startsWith: IMPORTER_FEATURE_PREFIX }, model: { in: [...ids] }, createdAt: { gte: new Date(now - HEALTH_WINDOW_MS) }, ...(ofJob ? { requestId: { in: [...new Set(ofJob)] } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { model: true, ok: true, errorCategory: true, errorSummary: true, createdAt: true },
    take: 2_000,
  });
  const out: Record<string, ModelHealth> = {};
  for (const r of rows) {
    const h = (out[r.model] ??= { requests: 0, ok: 0, rateLimited: 0, consecutiveRateLimited: 0, streakOpen: true, lastRateLimitedAt: null, lastOkAt: null, consecutiveRefused: 0, refusedOpen: true, lastRefusedAt: null, lastRefusal: null });
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
    if (h.refusedOpen) {
      if (r.errorCategory && REFUSED_CATEGORIES.includes(r.errorCategory)) {
        h.consecutiveRefused++;
        h.lastRefusedAt ??= r.createdAt.toISOString();
        h.lastRefusal ??= r.errorSummary ? r.errorSummary.slice(0, 120) : null;
      } else h.refusedOpen = false;
    }
  }
  return out;
}
