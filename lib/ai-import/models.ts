import "server-only";
import type { AiModel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEngineConfig, getOpenRouterConfig } from "@/lib/ai-engine/settings";
import { getGeminiConfig } from "@/lib/gemini-config";
import { peekUsdInr } from "@/lib/ai-engine/fx";
import { usdToInr } from "@/lib/ai-engine/config";
import { IMAGE_TOKENS, PRICE_MARGIN, estimateInputTokens, inputImagePriceUsd, modelProblem, notPricier, worstCaseUsd } from "@/lib/ai-import/ai";
import { SOLVE_SYSTEM } from "@/lib/ai-import/prompts";
import { MAX_IMPORTER_MODELS, PILOT_LIMITS, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { PROFILES as SELECT_PROFILES, computeModelPlan } from "@/lib/ai-import/select";
import { getRouteSnapshot, routeStatus } from "@/lib/ai-import/routes";
import type { ImporterCatalog, ImporterModelOption, RequestCost } from "@/lib/ai-import/model-options";

/**
 * Import Settings data: the automatic model choice per task (lib/ai-import/select.ts)
 * and, for the manual override, the synced OpenRouter catalog (Admin → AI →
 * Models; prices are OpenRouter's published USD prices). Only an APPROVED model
 * without a problem can be selected; the rest of the catalog is listed for
 * search with the reason it cannot be used. Request costs use the
 * same worst-case formula as the runtime guard (lib/ai-import/ai.ts), so the
 * page never shows a maximum the server would not enforce.
 */

/** Cost columns of the model list: the selection profiles plus the small text-only answer opinion. */
const PROFILES = { ...SELECT_PROFILES, solve: { system: SOLVE_SYSTEM, textChars: 1_500, images: 0, maxOut: 600 } } as const;
type Profile = keyof typeof PROFILES;

function requestCost(m: AiModel, profile: Profile, fxRate: number | null): RequestCost {
  const p = PROFILES[profile];
  const content = [{ type: "text" as const, text: "x".repeat(p.textChars) }, ...Array.from({ length: p.images }, () => ({ type: "image_url" as const, image_url: { url: "" } }))];
  const inputTokens = estimateInputTokens(p.system, content);
  const maxUsd = worstCaseUsd([m], inputTokens, p.maxOut, p.images) * PRICE_MARGIN;
  const typicalUsd = worstCaseUsd([m], inputTokens, Math.round(p.maxOut * 0.4), p.images);
  return { inputTokens, maxOutputTokens: p.maxOut, maxUsd, maxInr: usdToInr(maxUsd, fxRate), typicalUsd, typicalInr: usdToInr(typicalUsd, fxRate) };
}

function toOption(m: AiModel, fxRate: number | null, importerModels: readonly string[]): ImporterModelOption {
  const vision = m.inputModalities.includes("image");
  // Problems other than list membership (the page applies its current, possibly unsaved, list itself).
  const textProblem = modelProblem(m, false, [m.id]);
  return {
    id: m.id,
    name: m.name,
    vision,
    // On the importer's own list (the global AI → Models approval is shown for information only).
    approved: importerModels.includes(m.id),
    globallyApproved: m.approved,
    // Usable for text tasks / for vision tasks (null = usable).
    problem: textProblem,
    visionProblem: modelProblem(m, true, [m.id]),
    promptPerM: m.promptPrice !== null ? m.promptPrice * 1e6 : null,
    completionPerM: m.completionPrice !== null ? Math.max(m.completionPrice, m.reasoningPrice ?? 0) * 1e6 : null,
    imagePrice: vision ? inputImagePriceUsd(m) : null,
    requestPrice: m.requestPrice,
    context: m.contextLength,
    synced: m.lastSyncedAt.toISOString().slice(0, 10),
    vendor: m.vendor,
    params: { reasoning: m.supportedParameters.includes("reasoning"), structuredOutput: m.supportedParameters.includes("response_format") || m.supportedParameters.includes("structured_outputs") },
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

export async function importerModelCatalog(forSettings?: ImporterSettings): Promise<ImporterCatalog> {
  const settings = forSettings ?? (await getImporterSettings());
  const [openrouter, engine, fx, rows, plan, snapshot, gemini] = await Promise.all([
    getOpenRouterConfig(),
    getEngineConfig(),
    peekUsdInr(), // read-only: never fetches or stores a rate
    // Text-returning models only (image generators are never importer models).
    prisma.aiModel.findMany({ where: { outputModalities: { has: "text" }, isImageModel: false }, orderBy: [{ approved: "desc" }, { promptPrice: "asc" }, { id: "asc" }] }),
    // The automatic choice for these settings, from the stored route snapshot (no OpenRouter call here).
    computeModelPlan(settings, { refresh: false }),
    getRouteSnapshot(),
    // Display only: an unreadable Gemini setting must not break the importer's settings page.
    getGeminiConfig().catch(() => ({ configured: false, enabled: false })),
  ]);
  const options = rows.map((m) => toOption(m, fx.rate, settings.importerModels));
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
    // State only (never the key): the importer does not send requests through the direct Gemini API.
    gemini: { configured: gemini.configured, enabled: gemini.enabled },
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
    plan,
    routes: routeStatus(snapshot),
    pilot: { ...PILOT_LIMITS },
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
  // The importer's own model list: real catalog text models only (an id dropped by normalization is reported).
  const sentList = ((raw ?? {}) as { importerModels?: unknown }).importerModels;
  if (Array.isArray(sentList)) {
    for (const x of sentList) {
      const id = typeof x === "string" ? x.trim() : "";
      if (!next.importerModels.includes(id)) problems.push(`Importer models: “${String(x).slice(0, 120)}” is not a valid OpenRouter model ID${sentList.length > MAX_IMPORTER_MODELS ? ` (or the list is longer than ${MAX_IMPORTER_MODELS})` : ""}.`);
    }
  }
  if (next.importerModels.length) {
    const listed = new Map((await prisma.aiModel.findMany({ where: { id: { in: next.importerModels } } })).map((r) => [r.id, r]));
    for (const id of next.importerModels) {
      const r = listed.get(id);
      if (!r) problems.push(`Importer models: ${id} is not in the model catalog (sync Admin → AI → Models).`);
      else if (r.isImageModel || !r.outputModalities.includes("text")) problems.push(`Importer models: ${id} does not return text (image-generation models cannot read papers).`);
    }
  }
  // Automatic selection: manual model fields are kept for a later override but not used, so not checked.
  if (next.selection.mode === "auto") return problems;
  const sent = ((raw ?? {}) as { models?: Record<string, unknown> }).models ?? {};
  const ids = [...SLOTS.map((s) => next.models[s.key]), ...next.models.extractFallbacks].filter((x): x is string => !!x);
  const rows = new Map((await prisma.aiModel.findMany({ where: { id: { in: ids } } })).map((r) => [r.id, r]));
  for (const s of SLOTS) {
    const was = sent[s.key];
    if (typeof was === "string" && was.trim() && next.models[s.key] === null) problems.push(`${s.label}: “${was.slice(0, 120)}” is not a valid OpenRouter model ID.`);
    const id = next.models[s.key];
    if (!id) continue;
    const p = modelProblem(rows.get(id), s.vision, next.importerModels);
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
    const p = modelProblem(row, true, next.importerModels);
    if (p) problems.push(`Fallback extraction model: ${id} — ${p}.`);
    // The runtime drops a fallback priced above the extraction model (never a pricier model): say so now.
    else if (extract && row && !notPricier(row, extract)) {
      problems.push(`Fallback extraction model: ${id} costs more than the extraction model, so it would never be used. Choose a model priced at or below the extraction model, or none.`);
    }
  }
  return problems;
}
