import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOpenRouterApiKey } from "@/lib/ai-engine/settings";
import { parsePrice } from "@/lib/ai-engine/catalog";
import { modelEndpoints, sanitize, zdrEndpoints, type RawEndpoint } from "@/lib/ai-engine/openrouter";
import type { RouteStatus } from "@/lib/ai-import/selection-types";

/**
 * Provider-route metadata for the importer's automatic model selection, read
 * from OpenRouter (never hard-coded): every route of each candidate model with
 * its own price and status (GET /models/{id}/endpoints) and the list of
 * Zero-Data-Retention routes (GET /endpoints/zdr). Both endpoints are public
 * and free. The snapshot is stored in Setting "ai.importer.routes" and is
 * refreshed when an administrator asks for it or when a job is confirmed with
 * a snapshot older than ROUTES_MAX_AGE_MS. A failed read is recorded per model;
 * a model without readable routes is never selected.
 */

export const ROUTES_SETTING_KEY = "ai.importer.routes";
/** Selection refuses route data older than this (prices and route availability change). */
export const ROUTES_MAX_AGE_MS = 6 * 60 * 60_000;
/** At most this many candidate models are looked up per refresh (one request each). */
const MAX_MODELS = 25;

export interface RoutePrice {
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
  /** null = published but unreadable; 0 = not published. */
  image: number | null;
  request: number | null;
  /** Higher prices that apply from a prompt size on (OpenRouter `pricing.overrides`). */
  overrides: { minPromptTokens: number; prompt: number | null; completion: number | null }[];
}

export interface Route {
  provider: string;
  tag: string;
  /** OpenRouter endpoint status (0 = serving normally; other values = degraded / unavailable). */
  status: number | null;
  zdr: boolean;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  /** null = not published. */
  params: string[] | null;
  price: RoutePrice;
}

export interface RouteSnapshot {
  fetchedAt: string;
  zdr: { ok: boolean; error: string | null; count: number };
  models: Record<string, { ok: boolean; error: string | null; routes: Route[] }>;
}

function optionalPrice(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return 0;
  return parsePrice(v);
}

export function toRoute(e: RawEndpoint, zdrTags: Set<string> | null, modelId: string): Route {
  const p = (e.pricing ?? {}) as Record<string, unknown>;
  const overrides = Array.isArray(p.overrides)
    ? (p.overrides as Record<string, unknown>[]).slice(0, 10).map((o) => ({ minPromptTokens: typeof o.min_prompt_tokens === "number" ? o.min_prompt_tokens : 0, prompt: parsePrice(o.prompt), completion: parsePrice(o.completion) }))
    : [];
  const tag = typeof e.tag === "string" ? e.tag.slice(0, 80) : "";
  return {
    provider: typeof e.provider_name === "string" ? e.provider_name.slice(0, 80) : "?",
    tag,
    status: typeof e.status === "number" ? e.status : null,
    zdr: !!zdrTags && zdrTags.has(`${modelId}|${tag}`),
    contextLength: typeof e.context_length === "number" ? e.context_length : null,
    maxCompletionTokens: typeof e.max_completion_tokens === "number" ? e.max_completion_tokens : null,
    params: Array.isArray(e.supported_parameters) ? e.supported_parameters.filter((x): x is string => typeof x === "string").slice(0, 60) : null,
    price: { prompt: parsePrice(p.prompt), completion: parsePrice(p.completion), reasoning: optionalPrice(p.internal_reasoning), image: optionalPrice(p.image), request: optionalPrice(p.request), overrides },
  };
}

/**
 * Text models the selection may consider: on the importer's own list (never the global approval),
 * not disabled, still listed, returning text (image generators excluded).
 */
export async function candidateModels(importerModels: readonly string[]) {
  if (!importerModels.length) return [];
  return prisma.aiModel.findMany({
    where: { id: { in: [...importerModels] }, disabled: false, missingSince: null, isImageModel: false, outputModalities: { has: "text" } },
    orderBy: [{ promptPrice: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    take: MAX_MODELS,
  });
}

/** Reads the routes of every importer model + the ZDR list from OpenRouter and stores the snapshot. */
export async function refreshRoutes(importerModels: readonly string[]): Promise<RouteSnapshot> {
  const apiKey = await getOpenRouterApiKey().catch(() => null);
  const models = await candidateModels(importerModels);
  let zdrTags: Set<string> | null = null;
  const zdr = { ok: false, error: null as string | null, count: 0 };
  try {
    const list = await zdrEndpoints(apiKey);
    zdrTags = new Set(list.filter((e) => typeof e.model_id === "string" && typeof e.tag === "string").map((e) => `${e.model_id}|${e.tag}`));
    zdr.ok = true;
    zdr.count = zdrTags.size;
  } catch (e) {
    zdr.error = sanitize(e instanceof Error ? e.message : "could not be read").slice(0, 200);
  }
  const out: RouteSnapshot["models"] = {};
  for (const m of models) {
    try {
      const eps = await modelEndpoints(apiKey, m.id);
      out[m.id] = { ok: true, error: null, routes: eps.slice(0, 40).map((e) => toRoute(e, zdrTags, m.id)) };
    } catch (e) {
      out[m.id] = { ok: false, error: sanitize(e instanceof Error ? e.message : "could not be read").slice(0, 200), routes: [] };
    }
  }
  const snapshot: RouteSnapshot = { fetchedAt: new Date().toISOString(), zdr, models: out };
  const value = JSON.stringify(snapshot);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${ROUTES_SETTING_KEY}, ${value}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ${value}::jsonb, "updatedAt" = now()`);
  return snapshot;
}

export async function getRouteSnapshot(): Promise<RouteSnapshot | null> {
  const row = await prisma.setting.findUnique({ where: { key: ROUTES_SETTING_KEY } });
  const v = row?.value as RouteSnapshot | null | undefined;
  return v && typeof v.fetchedAt === "string" && v.models && v.zdr ? v : null;
}

export function isStale(s: RouteSnapshot | null, now = Date.now()): boolean {
  return !s || now - new Date(s.fetchedAt).getTime() > ROUTES_MAX_AGE_MS;
}

/** The stored snapshot, refreshed first when it is missing, older than ROUTES_MAX_AGE_MS or lacks a listed model. */
export async function freshRouteSnapshot(importerModels: readonly string[]): Promise<RouteSnapshot> {
  const s = await getRouteSnapshot();
  return isStale(s) || importerModels.some((id) => !s!.models[id]) ? refreshRoutes(importerModels) : s!;
}

export function routeStatus(s: RouteSnapshot | null): RouteStatus {
  return {
    fetchedAt: s?.fetchedAt ?? null,
    stale: isStale(s),
    zdrOk: s ? s.zdr.ok : null,
    zdrError: s?.zdr.error ?? null,
    models: s ? Object.entries(s.models).map(([id, m]) => ({ id, ok: m.ok, routes: m.routes.length, error: m.error })) : [],
  };
}
