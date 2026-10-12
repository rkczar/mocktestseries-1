"use server";

import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { AI_FEATURE_KEYS, type AiFeature } from "@/lib/ai-gateway-config";
import { ENGINE_FEATURE_MAP, MODEL_ID } from "@/lib/ai-engine/config";
import { BULK_FEATURES, cancelQuote, cancelQuotes, createBulkQuote, createQuote, type BulkFeature, type BulkQuoteView, type QuoteView } from "@/lib/ai-engine/quote";

/**
 * AI Cost Preview — server side. Creates a one-time quote for an admin AI
 * action (computed here, never in the browser) and lets the admin cancel it.
 * The permission follows the feature: Instagram → INSTAGRAM_MANAGE, admin
 * explanations / variants → QUESTIONS_MANAGE.
 */

export type QuoteResult = { ok: true; data: QuoteView } | { ok: false; error: string };

const CTX_VALUE = /^[A-Za-z0-9_-]{1,40}$/;

function cleanContext(raw: unknown): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 4)) {
    if (!/^[a-zA-Z]{1,20}$/.test(k)) continue;
    if (v === null) out[k] = null;
    else if (typeof v === "string" && CTX_VALUE.test(v)) out[k] = v;
    else if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 1e9) out[k] = v;
  }
  return out;
}

export async function requestAiQuoteAction(input: {
  feature: string;
  context?: unknown;
  model?: string | null;
  pick?: "cheapest" | null;
  units?: number;
  /** The admin picked a legacy provider for this one request (Instagram provider picker). */
  legacyProvider?: boolean;
  /** Paid model quality evaluation (Master Admin only). */
  evaluation?: boolean;
}): Promise<QuoteResult> {
  const evaluation = input?.evaluation === true;
  const feature = (evaluation ? "explanation_admin" : AI_FEATURE_KEYS.find((f) => f === input?.feature)) as AiFeature | undefined;
  const def = feature ? ENGINE_FEATURE_MAP[feature] : undefined;
  if (!feature || !def || def.trigger !== "admin") return { ok: false, error: "Unknown AI action." };
  let actorId: string | null = null;
  try {
    const session = evaluation
      ? await requirePermission(PERMISSIONS.AI_ENGINE_MANAGE)
      : feature.startsWith("ig_")
        ? await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE)
        : await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    actorId = session.user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return { ok: false, error: "You do not have permission to run this AI action." };
    throw error;
  }
  if (!actorId) return { ok: false, error: "You do not have permission to run this AI action." };
  const model = typeof input.model === "string" && MODEL_ID.test(input.model) ? input.model : null;
  try {
    const quote = await createQuote({
      feature,
      action: feature,
      context: cleanContext(input.context),
      actorId,
      model,
      pick: input.pick === "cheapest" ? "cheapest" : null,
      units: typeof input.units === "number" ? input.units : 1,
      legacyProvider: input.legacyProvider === true,
      evaluation,
    });
    return { ok: true, data: quote };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Could not estimate the cost." };
  }
}

export async function cancelAiQuoteAction(quoteId: string): Promise<{ ok: boolean }> {
  try {
    const session = await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE).catch(() => requirePermission(PERMISSIONS.QUESTIONS_MANAGE));
    if (typeof quoteId === "string" && /^[a-z0-9]{20,40}$/.test(quoteId) && session.user.id) await cancelQuote(quoteId, session.user.id);
  } catch {
    // cancelling is best-effort; an unused quote expires on its own
  }
  return { ok: true };
}

/** Instagram Bulk Studio: one AI Cost Preview for N posts × the chosen AI steps. */
export async function requestBulkQuoteAction(input: { postIds: string[]; features: string[]; legacyProvider?: boolean }): Promise<{ ok: true; data: BulkQuoteView } | { ok: false; error: string }> {
  let actorId: string | null = null;
  try {
    const session = await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
    actorId = session.user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return { ok: false, error: "You do not have permission to run this AI action." };
    throw error;
  }
  if (!actorId) return { ok: false, error: "You do not have permission to run this AI action." };
  const postIds = (Array.isArray(input?.postIds) ? input.postIds : []).filter((x): x is string => typeof x === "string" && CTX_VALUE.test(x)).slice(0, 50);
  const features = (Array.isArray(input?.features) ? input.features : []).filter((f): f is BulkFeature => (BULK_FEATURES as readonly string[]).includes(f));
  try {
    return { ok: true, data: await createBulkQuote({ actorId, postIds, features, legacyProvider: input?.legacyProvider === true }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Could not estimate the cost." };
  }
}

export async function cancelBulkQuotesAction(ids: string[]): Promise<{ ok: boolean }> {
  try {
    const session = await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
    if (Array.isArray(ids) && session.user.id) await cancelQuotes(ids.filter((x): x is string => typeof x === "string"), session.user.id);
  } catch {
    // best-effort; unused quotes expire on their own
  }
  return { ok: true };
}
