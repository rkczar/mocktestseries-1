import "server-only";
import { Prisma, type AiModel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { MODEL_ID, type PricedModel } from "@/lib/ai-engine/config";
import { imageModelEndpoints, listImageModels, listTextModels, sanitize, type RawModel } from "@/lib/ai-engine/openrouter";
import { getOpenRouterApiKey, patchOpenRouterState } from "@/lib/ai-engine/settings";

/**
 * OpenRouter model catalog (table AiModel). "Sync models" copies ids, limits,
 * modalities and prices from the OpenRouter Models API — nothing is hard-coded.
 * Admin flags (approved, medically approved, disabled, notes, units per image)
 * survive every sync. A model the API stops listing gets `missingSince` and is
 * skipped by the router. Image prices come from each image model's endpoint
 * price lines, fetched only for approved image models (or on demand), so a
 * sync is 2 requests + one per approved image model.
 */

export class CatalogError extends Error {}

/** OpenRouter price strings → USD per unit; "-1" (variable price, e.g. openrouter/auto) and garbage → null. */
export function parsePrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function params(sp: RawModel["supported_parameters"]): string[] {
  if (Array.isArray(sp)) return sp.filter((x): x is string => typeof x === "string").slice(0, 60);
  if (sp && typeof sp === "object") return Object.keys(sp).slice(0, 60);
  return [];
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
}

export interface SyncResult {
  text: number;
  image: number;
  added: number;
  updated: number;
  missing: number;
  imagePricesRefreshed: number;
  at: string;
}

/** Cheapest output-image price line across an image model's endpoints (base variant preferred). */
export function pickImagePrice(endpoints: { provider: string; pricing: { billable: string; unit: string; cost_usd: number; variant?: string }[] }[]): { unit: string; costUsd: number } | null {
  let best: { unit: string; costUsd: number } | null = null;
  const rank = (u: string) => (u === "image" ? 0 : u === "megapixel" ? 1 : 2);
  for (const e of endpoints) {
    const lines = e.pricing.filter((l) => l.billable === "output_image" && Number.isFinite(l.cost_usd) && l.cost_usd >= 0);
    const base = lines.filter((l) => !l.variant || /^(1k|base|standard|default)$/i.test(l.variant));
    for (const l of base.length ? base : lines) {
      // Compare like with like: prefer exactly-priced units, then the lower price.
      if (!best || rank(l.unit) < rank(best.unit) || (rank(l.unit) === rank(best.unit) && l.cost_usd < best.costUsd)) best = { unit: l.unit, costUsd: l.cost_usd };
    }
  }
  return best;
}

export async function refreshImagePrice(id: string, apiKey?: string | null): Promise<AiModel> {
  const key = apiKey === undefined ? await getOpenRouterApiKey() : apiKey;
  const eps = await imageModelEndpoints(key, id);
  const best = pickImagePrice(eps);
  return prisma.aiModel.update({
    where: { id },
    data: { imageUnit: best?.unit ?? null, imageUnitCostUsd: best?.costUsd ?? null, pricingRaw: { endpoints: eps } as unknown as Prisma.InputJsonValue },
  });
}

export async function syncCatalog(): Promise<SyncResult> {
  const apiKey = await getOpenRouterApiKey(); // the Models API is public; the key (if any) is sent for accurate availability
  let text: RawModel[];
  let images: RawModel[];
  try {
    [text, images] = await Promise.all([listTextModels(apiKey), listImageModels(apiKey)]);
  } catch (error) {
    const message = sanitize(error instanceof Error ? error.message : "sync failed");
    await patchOpenRouterState({ lastError: { category: "sync", message, at: new Date().toISOString() } });
    throw new CatalogError(`Model sync failed: ${message}`);
  }
  if (text.length === 0) throw new CatalogError("Model sync failed: OpenRouter returned an empty model list. Nothing was changed.");

  const now = new Date();
  const rows = new Map<string, Prisma.AiModelCreateInput>();
  for (const m of text) {
    if (typeof m.id !== "string" || !MODEL_ID.test(m.id)) continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    rows.set(m.id, {
      id: m.id,
      name: (m.name ?? m.id).slice(0, 120),
      vendor: m.id.split("/")[0],
      contextLength: typeof m.context_length === "number" ? m.context_length : null,
      maxCompletionTokens: typeof m.top_provider?.max_completion_tokens === "number" ? m.top_provider.max_completion_tokens : null,
      inputModalities: strArr(m.architecture?.input_modalities),
      outputModalities: strArr(m.architecture?.output_modalities),
      supportedParameters: params(m.supported_parameters),
      promptPrice: parsePrice(p.prompt),
      completionPrice: parsePrice(p.completion),
      reasoningPrice: parsePrice(p.internal_reasoning),
      requestPrice: parsePrice(p.request),
      pricingRaw: p as Prisma.InputJsonValue,
      isImageModel: false,
      expirationDate: typeof m.expiration_date === "string" ? m.expiration_date.slice(0, 10) : null,
      lastSyncedAt: now,
    });
  }
  for (const m of images) {
    if (typeof m.id !== "string" || !MODEL_ID.test(m.id)) continue;
    const prev = rows.get(m.id);
    rows.set(m.id, {
      ...(prev ?? {
        id: m.id,
        name: (m.name ?? m.id).slice(0, 120),
        vendor: m.id.split("/")[0],
        contextLength: null,
        maxCompletionTokens: null,
        supportedParameters: params(m.supported_parameters),
        promptPrice: null,
        completionPrice: null,
        reasoningPrice: null,
        requestPrice: null,
        expirationDate: null,
        lastSyncedAt: now,
      }),
      inputModalities: strArr(m.architecture?.input_modalities),
      outputModalities: strArr(m.architecture?.output_modalities),
      isImageModel: true,
    });
  }

  const existing = await prisma.aiModel.findMany({ select: { id: true, approved: true, isImageModel: true } });
  const known = new Set(existing.map((e) => e.id));
  const toCreate = [...rows.values()].filter((r) => !known.has(r.id));
  const toUpdate = [...rows.values()].filter((r) => known.has(r.id));
  // Batches keep each transaction short on the small VPS.
  if (toCreate.length) await prisma.aiModel.createMany({ data: toCreate as Prisma.AiModelCreateManyInput[], skipDuplicates: true });
  for (let i = 0; i < toUpdate.length; i += 100) {
    await prisma.$transaction(
      toUpdate.slice(i, i + 100).map((r) => {
        // Admin-owned fields (approved, medicallyApproved, disabled, notes, imageUnitsPerImage) and image price lines are not overwritten.
        const { id, ...data } = r;
        return prisma.aiModel.update({ where: { id }, data: { ...data, missingSince: null } });
      })
    );
  }
  const missing = await prisma.aiModel.updateMany({ where: { id: { notIn: [...rows.keys()] }, missingSince: null }, data: { missingSince: now } });

  let imagePricesRefreshed = 0;
  for (const m of existing.filter((e) => e.approved && rows.get(e.id)?.isImageModel)) {
    try {
      await refreshImagePrice(m.id, apiKey);
      imagePricesRefreshed++;
    } catch {
      // keep the previous price line; the Models page shows its age
    }
  }

  const result: SyncResult = {
    text: text.length,
    image: images.length,
    added: toCreate.length,
    updated: toUpdate.length,
    missing: missing.count,
    imagePricesRefreshed,
    at: now.toISOString(),
  };
  await patchOpenRouterState({ lastSyncAt: result.at, lastSyncSummary: `${result.text} text + ${result.image} image models (${result.added} new, ${result.missing} no longer listed)` });
  return result;
}

export function toPriced(m: Pick<AiModel, "id" | "promptPrice" | "completionPrice" | "reasoningPrice" | "requestPrice" | "imageUnit" | "imageUnitCostUsd" | "imageUnitsPerImage">): PricedModel {
  return {
    id: m.id,
    promptPrice: m.promptPrice,
    completionPrice: m.completionPrice,
    reasoningPrice: m.reasoningPrice,
    requestPrice: m.requestPrice,
    imageUnit: m.imageUnit,
    imageUnitCostUsd: m.imageUnitCostUsd,
    imageUnitsPerImage: m.imageUnitsPerImage,
  };
}

export interface ModelFilter {
  q?: string;
  vendor?: string;
  kind?: "text" | "image" | "all";
  status?: "approved" | "medical" | "all";
  maxPromptPerM?: number | null;
  capability?: "structured" | "reasoning" | "any";
  take?: number;
  skip?: number;
}

export async function listCatalog(f: ModelFilter) {
  const where: Prisma.AiModelWhereInput = {};
  if (f.q) where.OR = [{ id: { contains: f.q, mode: "insensitive" } }, { name: { contains: f.q, mode: "insensitive" } }];
  if (f.vendor) where.vendor = f.vendor;
  if (f.kind === "image") where.isImageModel = true;
  if (f.kind === "text") where.outputModalities = { has: "text" };
  if (f.status === "approved") where.approved = true;
  if (f.status === "medical") where.medicallyApproved = true;
  if (typeof f.maxPromptPerM === "number") where.promptPrice = { lte: f.maxPromptPerM / 1_000_000 };
  if (f.capability === "structured") where.supportedParameters = { hasSome: ["response_format", "structured_outputs"] };
  if (f.capability === "reasoning") where.supportedParameters = { has: "reasoning" };
  const [rows, total, vendors] = await Promise.all([
    prisma.aiModel.findMany({ where, orderBy: [{ approved: "desc" }, { promptPrice: { sort: "asc", nulls: "last" } }, { id: "asc" }], take: f.take ?? 60, skip: f.skip ?? 0 }),
    prisma.aiModel.count({ where }),
    prisma.aiModel.groupBy({ by: ["vendor"], _count: { _all: true }, orderBy: { vendor: "asc" } }),
  ]);
  return { rows, total, vendors: vendors.map((v) => ({ vendor: v.vendor, count: v._count._all })) };
}
