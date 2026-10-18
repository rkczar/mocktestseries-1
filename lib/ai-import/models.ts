import "server-only";
import type { AiModel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEngineConfig, getOpenRouterConfig } from "@/lib/ai-engine/settings";
import { peekUsdInr } from "@/lib/ai-engine/fx";
import { usdToInr } from "@/lib/ai-engine/config";
import { IMAGE_TOKENS, PRICE_MARGIN, estimateInputTokens, inputImagePriceUsd, modelProblem, notPricier, worstCaseUsd } from "@/lib/ai-import/ai";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM, KEY_SYSTEM, SOLVE_SYSTEM } from "@/lib/ai-import/prompts";
import type { ImporterSettings } from "@/lib/ai-import/config";
import type { ImporterCatalog, ImporterModelOption, RequestCost } from "@/lib/ai-import/model-options";

/**
 * Model choices for Import Settings, read from the synced OpenRouter catalog
 * (Admin → AI → Models; prices are OpenRouter's published USD prices). Only an
 * APPROVED model without a problem can be selected; the rest of the catalog is
 * listed for search with the reason it cannot be used. Request costs use the
 * same worst-case formula as the runtime guard (lib/ai-import/ai.ts), so the
 * page never shows a maximum the server would not enforce.
 */

/** The largest request of each task, as the worker sends it (output limits from process.ts / keys.ts / post.ts). */
const PROFILES = {
  extract: { system: EXTRACT_SYSTEM, textChars: 12_600, images: 1, maxOut: 8_000 },
  verify: { system: EXTRACT_SYSTEM, textChars: 12_600, images: 1, maxOut: 8_000 },
  solve: { system: SOLVE_SYSTEM, textChars: 1_500, images: 0, maxOut: 600 },
  classify: { system: CLASSIFY_SYSTEM, textChars: 30_000, images: 0, maxOut: 2_500 },
  key: { system: KEY_SYSTEM, textChars: 100, images: 1, maxOut: 4_000 },
} as const;
type Profile = keyof typeof PROFILES;

function requestCost(m: AiModel, profile: Profile, fxRate: number | null): RequestCost {
  const p = PROFILES[profile];
  const content = [{ type: "text" as const, text: "x".repeat(p.textChars) }, ...Array.from({ length: p.images }, () => ({ type: "image_url" as const, image_url: { url: "" } }))];
  const inputTokens = estimateInputTokens(p.system, content);
  const maxUsd = worstCaseUsd([m], inputTokens, p.maxOut, p.images) * PRICE_MARGIN;
  const typicalUsd = worstCaseUsd([m], inputTokens, Math.round(p.maxOut * 0.4), p.images);
  return { inputTokens, maxOutputTokens: p.maxOut, maxUsd, maxInr: usdToInr(maxUsd, fxRate), typicalUsd, typicalInr: usdToInr(typicalUsd, fxRate) };
}

function toOption(m: AiModel, fxRate: number | null): ImporterModelOption {
  const vision = m.inputModalities.includes("image");
  const textProblem = modelProblem(m, false);
  return {
    id: m.id,
    name: m.name,
    vision,
    approved: m.approved,
    // Usable for text tasks / for vision tasks (null = usable).
    problem: textProblem,
    visionProblem: modelProblem(m, true),
    promptPerM: m.promptPrice !== null ? m.promptPrice * 1e6 : null,
    completionPerM: m.completionPrice !== null ? Math.max(m.completionPrice, m.reasoningPrice ?? 0) * 1e6 : null,
    imagePrice: vision ? inputImagePriceUsd(m) : null,
    requestPrice: m.requestPrice,
    context: m.contextLength,
    synced: m.lastSyncedAt.toISOString().slice(0, 10),
    costs: textProblem === null && m.promptPrice !== null && m.completionPrice !== null
      ? {
          extract: vision ? requestCost(m, "extract", fxRate) : null,
          verify: vision ? requestCost(m, "verify", fxRate) : null,
          solve: requestCost(m, "solve", fxRate),
          classify: requestCost(m, "classify", fxRate),
          key: vision ? requestCost(m, "key", fxRate) : null,
        }
      : null,
  };
}

export async function importerModelCatalog(): Promise<ImporterCatalog> {
  const [openrouter, engine, fx, rows] = await Promise.all([
    getOpenRouterConfig(),
    getEngineConfig(),
    peekUsdInr(), // read-only: never fetches or stores a rate
    // Text-returning models only (image generators are never importer models).
    prisma.aiModel.findMany({ where: { outputModalities: { has: "text" }, isImageModel: false }, orderBy: [{ approved: "desc" }, { promptPrice: "asc" }, { id: "asc" }] }),
  ]);
  const options = rows.map((m) => toOption(m, fx.rate));
  const lastSync = rows.reduce<Date | null>((a, m) => (!a || m.lastSyncedAt > a ? m.lastSyncedAt : a), null);
  return {
    provider: {
      // Never the key or any part of it: only whether one is installed and the connection state.
      status: openrouter.status,
      keyInstalled: openrouter.apiKeyConfigured,
      enabled: openrouter.enabled,
      lastTestOk: openrouter.lastTest?.ok ?? null,
      lastTestAt: openrouter.lastTest?.at ?? null,
      lastTestMessage: openrouter.lastTest && !openrouter.lastTest.ok ? openrouter.lastTest.message.slice(0, 200) : null,
      keyLimitUsd: openrouter.keyStatus?.limitUsd ?? null,
      keyRemainingUsd: openrouter.keyStatus?.limitRemainingUsd ?? null,
      keyStatusAt: openrouter.keyStatus?.at ?? null,
      emergencyStop: engine.budgets.emergencyStop,
    },
    catalog: {
      models: rows.length,
      approved: options.filter((o) => o.approved).length,
      usableVision: options.filter((o) => o.approved && o.visionProblem === null).length,
      usableText: options.filter((o) => o.approved && o.problem === null).length,
      lastSyncAt: lastSync?.toISOString() ?? openrouter.lastSyncAt ?? null,
    },
    fx: { rate: fx.rate, rateDate: fx.rateDate, source: fx.source, stale: fx.stale, unavailableReason: fx.unavailableReason },
    imageTokens: IMAGE_TOKENS,
    priceMargin: PRICE_MARGIN,
    options,
  };
}

const SLOTS: { key: "extract" | "verify" | "classify" | "key"; label: string; vision: boolean }[] = [
  { key: "extract", label: "Extraction model", vision: true },
  { key: "verify", label: "Independent verification model", vision: true },
  { key: "classify", label: "Topic classification model", vision: false },
  { key: "key", label: "Answer-key reading model", vision: true },
];

/**
 * Server-side check before Import Settings are saved: every selected model must exist in the
 * catalog, be approved and usable for its task (vision where pages are read), with a fixed price.
 * `raw` is what the browser sent, so an ID dropped by normalization is reported, not silently cleared.
 */
export async function importerSettingsProblems(raw: unknown, next: ImporterSettings): Promise<string[]> {
  const problems: string[] = [];
  const sent = ((raw ?? {}) as { models?: Record<string, unknown> }).models ?? {};
  const ids = [...SLOTS.map((s) => next.models[s.key]), ...next.models.extractFallbacks].filter((x): x is string => !!x);
  const rows = new Map((await prisma.aiModel.findMany({ where: { id: { in: ids } } })).map((r) => [r.id, r]));
  for (const s of SLOTS) {
    const was = sent[s.key];
    if (typeof was === "string" && was.trim() && next.models[s.key] === null) problems.push(`${s.label}: “${was.slice(0, 120)}” is not a valid OpenRouter model ID.`);
    const id = next.models[s.key];
    if (!id) continue;
    const p = modelProblem(rows.get(id), s.vision);
    if (p) problems.push(`${s.label}: ${id} — ${p}.`);
  }
  const sentFallbacks = Array.isArray(sent.extractFallbacks) ? sent.extractFallbacks : [];
  for (const f of sentFallbacks) {
    const id = typeof f === "string" ? f.trim() : "";
    if (id && id !== next.models.extract && !next.models.extractFallbacks.includes(id)) problems.push(`Fallback extraction model: “${id.slice(0, 120)}” is not a valid OpenRouter model ID.`);
  }
  const extract = next.models.extract ? rows.get(next.models.extract) : undefined;
  for (const id of next.models.extractFallbacks) {
    const row = rows.get(id);
    const p = modelProblem(row, true);
    if (p) problems.push(`Fallback extraction model: ${id} — ${p}.`);
    // The runtime drops a fallback priced above the extraction model (never a pricier model): say so now.
    else if (extract && row && !notPricier(row, extract)) {
      problems.push(`Fallback extraction model: ${id} costs more than the extraction model, so it would never be used. Choose a model priced at or below the extraction model, or none.`);
    }
  }
  if (next.budget.maxRequestInr > next.budget.maxJobInr) problems.push(`The maximum per AI request (₹${next.budget.maxRequestInr}) cannot be above the hard limit per job (₹${next.budget.maxJobInr}).`);
  if (next.budget.totalInr !== null && next.budget.maxJobInr > next.budget.totalInr) problems.push(`The hard limit per job (₹${next.budget.maxJobInr}) cannot be above the all-time importer budget (₹${next.budget.totalInr}).`);
  return problems;
}
