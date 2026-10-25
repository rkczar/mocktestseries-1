/**
 * AI Engine — shared, client-safe definitions: per-feature engine settings,
 * budgets, privacy and the pure cost arithmetic. Server code lives next to it
 * (lib/ai-engine/*.ts with `server-only`).
 *
 * The engine sits INSIDE the existing AI Gateway (lib/ai-gateway.ts): a
 * feature whose engine provider is "legacy" keeps running exactly the
 * existing gateway route (Gemini / OpenAI / Claude), so installing the engine
 * changes nothing until a Master Admin switches a feature to OpenRouter.
 */

import type { AiFeature } from "@/lib/ai-gateway-config";

export const ROUTING_MODES = ["cheapest", "manual", "auto"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const ROUTING_MODE_LABELS: Record<RoutingMode, string> = {
  cheapest: "Cheapest Approved",
  manual: "Manual",
  auto: "OpenRouter Auto",
};

export const AUTO_COST_TIERS = ["low", "medium", "high"] as const;
export type AutoCostTier = (typeof AUTO_COST_TIERS)[number];

/** Engine-level feature description: what the feature needs from a model. */
export interface EngineFeatureDef {
  key: AiFeature;
  label: string;
  group: "Student AI" | "Admin AI" | "Instagram" | "Video Studio";
  kind: "text" | "image";
  /** Admin-triggered features need a one-time cost quote; student features never do. */
  trigger: "admin" | "student";
  /** Medical explanations may only use medically approved models. */
  medical: boolean;
  /** Provider calls one admin action makes (Examiner Trap = generate + blind re-solve). */
  callsPerAction: number;
  /** Output-token ceiling the existing code sends per call (sum over calls for the quote). */
  defaultMaxOutputTokens: number;
  /** Fallback input-token estimate when there is no history yet. */
  typicalInputTokens: number;
  /** True when the feature's existing code path is actually called today. */
  inUse: boolean;
}

export const ENGINE_FEATURES: EngineFeatureDef[] = [
  { key: "explanation", label: "Student Ask AI (explanations)", group: "Student AI", kind: "text", trigger: "student", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 1400, typicalInputTokens: 450, inUse: true },
  { key: "variant", label: "Student AI Variants", group: "Student AI", kind: "text", trigger: "student", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 6000, typicalInputTokens: 400, inUse: true },
  { key: "explanation_admin", label: "AI Explanations (admin regenerate)", group: "Admin AI", kind: "text", trigger: "admin", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 1400, typicalInputTokens: 450, inUse: true },
  { key: "variant_admin", label: "Admin AI Variants", group: "Admin AI", kind: "text", trigger: "admin", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 6000, typicalInputTokens: 400, inUse: true },
  { key: "ig_carousel", label: "Instagram Carousel", group: "Instagram", kind: "text", trigger: "admin", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 3000, typicalInputTokens: 950, inUse: true },
  { key: "ig_caption", label: "Instagram Captions", group: "Instagram", kind: "text", trigger: "admin", medical: false, callsPerAction: 1, defaultMaxOutputTokens: 2600, typicalInputTokens: 1450, inUse: true },
  { key: "ig_trap", label: "Instagram Examiner Traps", group: "Instagram", kind: "text", trigger: "admin", medical: true, callsPerAction: 2, defaultMaxOutputTokens: 1900, typicalInputTokens: 700, inUse: true },
  { key: "ig_diagram", label: "Instagram Diagram Planning", group: "Instagram", kind: "text", trigger: "admin", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 1800, typicalInputTokens: 650, inUse: true },
  { key: "ig_image", label: "Instagram Medical Images", group: "Instagram", kind: "image", trigger: "admin", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 0, typicalInputTokens: 0, inUse: true },
  { key: "ig_trends", label: "Instagram Trends", group: "Instagram", kind: "text", trigger: "admin", medical: false, callsPerAction: 1, defaultMaxOutputTokens: 2000, typicalInputTokens: 1500, inUse: true },
  { key: "ig_competitors", label: "Instagram Competitor Analysis", group: "Instagram", kind: "text", trigger: "admin", medical: false, callsPerAction: 1, defaultMaxOutputTokens: 2000, typicalInputTokens: 1500, inUse: true },
  { key: "ig_hashtags", label: "Instagram Hashtags (reserved)", group: "Instagram", kind: "text", trigger: "admin", medical: false, callsPerAction: 1, defaultMaxOutputTokens: 1000, typicalInputTokens: 500, inUse: false },
  { key: "ig_keywords", label: "Instagram Keyword Research (reserved)", group: "Instagram", kind: "text", trigger: "admin", medical: false, callsPerAction: 1, defaultMaxOutputTokens: 1000, typicalInputTokens: 500, inUse: false },
  { key: "video_script", label: "AI Video Studio Script", group: "Video Studio", kind: "text", trigger: "admin", medical: true, callsPerAction: 1, defaultMaxOutputTokens: 4000, typicalInputTokens: 1800, inUse: true },
];

export const ENGINE_FEATURE_MAP = Object.fromEntries(ENGINE_FEATURES.map((f) => [f.key, f])) as Record<AiFeature, EngineFeatureDef>;

/** Shown on the Features page as configuration placeholders only — no engine is built for them. */
export const FUTURE_FEATURES = ["MCQ Generation", "Question Classification", "Topic & Subtopic Tagging", "Question Quality Review", "Bulk AI Processing"] as const;

export interface FeatureEngineConfig {
  /** false = this feature may not call any AI provider (cached content still served). */
  enabled: boolean;
  /** "legacy" = the existing AI Gateway route (Gemini/OpenAI/Claude); "openrouter" = the AI Engine. */
  provider: "legacy" | "openrouter";
  mode: RoutingMode;
  /** Manual mode: the exact OpenRouter model id. */
  model: string | null;
  /** Approved OpenRouter models tried in order when the chosen one fails (OpenRouter `models` fallback). */
  fallbacks: string[];
  /** null = the feature's existing default. */
  maxOutputTokens: number | null;
  timeoutMs: number;
  /** Extra attempts after a transient error (rate limit / provider 5xx). Never after a timeout. */
  maxRetries: number;
  /** Per-request INR ceiling; null = the global text/image limit. */
  maxCostInr: number | null;
  /** Per-feature IST-day INR budget; null = only the platform budget applies. */
  dailyBudgetInr: number | null;
  autoCostTier: AutoCostTier;
}

export const DEFAULT_FEATURE_CONFIG: FeatureEngineConfig = {
  enabled: true,
  provider: "legacy",
  mode: "cheapest",
  model: null,
  fallbacks: [],
  maxOutputTokens: null,
  timeoutMs: 60_000,
  maxRetries: 1,
  maxCostInr: null,
  dailyBudgetInr: null,
  autoCostTier: "low",
};

export const FEATURE_LIMITS = { timeoutMin: 5_000, timeoutMax: 180_000, retriesMax: 2, maxFallbacks: 3, outMin: 64, outMax: 16_000 } as const;

export interface BudgetConfig {
  dailyInr: number;
  monthlyInr: number;
  maxTextRequestInr: number;
  maxImageRequestInr: number;
  /** Alert banner when utilization crosses this percentage. */
  alertPercent: number;
  /** Stops every NEW provider request (OpenRouter and legacy). Cached content is still served. */
  emergencyStop: boolean;
}

export const DEFAULT_BUDGETS: BudgetConfig = {
  dailyInr: 100,
  monthlyInr: 1500,
  maxTextRequestInr: 2,
  maxImageRequestInr: 10,
  alertPercent: 80,
  emergencyStop: false,
};

export interface PrivacyConfig {
  /** OpenRouter provider.data_collection — "deny" excludes providers that store/train on prompts. */
  dataCollection: "deny" | "allow";
  /** OpenRouter provider.zdr — only Zero Data Retention endpoints. */
  zdr: boolean;
}

export const DEFAULT_PRIVACY: PrivacyConfig = { dataCollection: "deny", zdr: false };

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const optNum = (v: unknown, min: number, max: number): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};

/** OpenRouter model ids: "vendor/name[:variant]". */
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,60}\/[A-Za-z0-9._:-]{1,100}$/;

export function normalizeFeatureConfig(raw: unknown): FeatureEngineConfig {
  const r = (raw ?? {}) as Partial<FeatureEngineConfig>;
  const model = typeof r.model === "string" && MODEL_ID.test(r.model.trim()) ? r.model.trim() : null;
  const fallbacks = Array.isArray(r.fallbacks)
    ? [...new Set(r.fallbacks.filter((m): m is string => typeof m === "string" && MODEL_ID.test(m.trim())).map((m) => m.trim()))].filter((m) => m !== model).slice(0, FEATURE_LIMITS.maxFallbacks)
    : [];
  return {
    enabled: r.enabled !== false,
    provider: r.provider === "openrouter" ? "openrouter" : "legacy",
    mode: (ROUTING_MODES as readonly string[]).includes(r.mode as string) ? (r.mode as RoutingMode) : "cheapest",
    model,
    fallbacks,
    maxOutputTokens: optNum(r.maxOutputTokens, FEATURE_LIMITS.outMin, FEATURE_LIMITS.outMax),
    timeoutMs: Math.round(num(r.timeoutMs, FEATURE_LIMITS.timeoutMin, FEATURE_LIMITS.timeoutMax, DEFAULT_FEATURE_CONFIG.timeoutMs)),
    maxRetries: Math.round(num(r.maxRetries, 0, FEATURE_LIMITS.retriesMax, DEFAULT_FEATURE_CONFIG.maxRetries)),
    maxCostInr: optNum(r.maxCostInr, 0.01, 10_000),
    dailyBudgetInr: optNum(r.dailyBudgetInr, 0, 1_000_000),
    autoCostTier: (AUTO_COST_TIERS as readonly string[]).includes(r.autoCostTier as string) ? (r.autoCostTier as AutoCostTier) : "low",
  };
}

export function normalizeBudgets(raw: unknown): BudgetConfig {
  const r = (raw ?? {}) as Partial<BudgetConfig>;
  return {
    dailyInr: num(r.dailyInr, 0, 10_000_000, DEFAULT_BUDGETS.dailyInr),
    monthlyInr: num(r.monthlyInr, 0, 100_000_000, DEFAULT_BUDGETS.monthlyInr),
    maxTextRequestInr: num(r.maxTextRequestInr, 0.01, 100_000, DEFAULT_BUDGETS.maxTextRequestInr),
    maxImageRequestInr: num(r.maxImageRequestInr, 0.01, 100_000, DEFAULT_BUDGETS.maxImageRequestInr),
    alertPercent: Math.round(num(r.alertPercent, 1, 100, DEFAULT_BUDGETS.alertPercent)),
    emergencyStop: r.emergencyStop === true,
  };
}

export function normalizePrivacy(raw: unknown): PrivacyConfig {
  const r = (raw ?? {}) as Partial<PrivacyConfig>;
  return { dataCollection: r.dataCollection === "allow" ? "allow" : "deny", zdr: r.zdr === true };
}

// ---- Pure cost arithmetic ---------------------------------------------------------------------

/** The catalog fields cost estimation needs (subset of the AiModel row). */
export interface PricedModel {
  id: string;
  promptPrice: number | null;
  completionPrice: number | null;
  reasoningPrice: number | null;
  requestPrice: number | null;
  imageUnit: string | null;
  imageUnitCostUsd: number | null;
  imageUnitsPerImage: number | null;
}

/**
 * Worst-case USD for one text call: every prompt token + every allowed output
 * token at the higher of the completion / reasoning price, plus any per-request
 * fee. null when the model has no published price (never treated as free).
 */
export function textCallMaxUsd(m: PricedModel, inputTokens: number, maxOutputTokens: number): number | null {
  if (m.promptPrice === null || m.completionPrice === null || m.promptPrice < 0 || m.completionPrice < 0) return null;
  const out = Math.max(m.completionPrice, m.reasoningPrice ?? 0);
  return inputTokens * m.promptPrice + maxOutputTokens * out + (m.requestPrice ?? 0);
}

/** Typical USD for one text call (expected output, not the ceiling). */
export function textCallTypicalUsd(m: PricedModel, inputTokens: number, outputTokens: number): number | null {
  if (m.promptPrice === null || m.completionPrice === null || m.promptPrice < 0 || m.completionPrice < 0) return null;
  return inputTokens * m.promptPrice + outputTokens * m.completionPrice + (m.requestPrice ?? 0);
}

/**
 * USD for one generated image, from the endpoint's own price line:
 * unit "image" is exact; "megapixel" uses the requested size; "token" needs the
 * admin's units-per-image assumption. null = cannot be estimated reliably.
 */
export function imageMaxUsd(m: PricedModel, megapixels: number): number | null {
  if (m.imageUnitCostUsd === null || m.imageUnitCostUsd < 0) return null;
  if (m.imageUnit === "image") return m.imageUnitCostUsd + (m.requestPrice ?? 0);
  if (m.imageUnit === "megapixel") return m.imageUnitCostUsd * megapixels + (m.requestPrice ?? 0);
  if (m.imageUnitsPerImage && m.imageUnitsPerImage > 0) return m.imageUnitCostUsd * m.imageUnitsPerImage + (m.requestPrice ?? 0);
  return null;
}

/** Conservative token estimate from text length (English/medical text averages ~4 chars per token; 3 over-counts on purpose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function usdToInr(usd: number | null, rate: number | null): number | null {
  if (usd === null || rate === null) return null;
  return Math.round(usd * rate * 10_000) / 10_000;
}

export function formatInr(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.01) return "< ₹0.01";
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.0001) return "< $0.0001";
  return `$${v.toFixed(v < 0.01 ? 4 : v < 1 ? 3 : 2)}`;
}

/** USD per token → USD per million tokens, for display. */
export function perMillion(v: number | null): string {
  if (v === null || v < 0) return "—";
  const m = v * 1_000_000;
  return `$${m < 0.01 ? m.toFixed(4) : m < 10 ? m.toFixed(3) : m.toFixed(2)}`;
}
