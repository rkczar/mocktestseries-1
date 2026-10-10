/**
 * AI Gateway — shared, client-safe definitions (feature list, route shape,
 * price table). The server side lives in lib/ai-gateway.ts.
 */

export const GATEWAY_PROVIDERS = ["gemini", "openai", "anthropic"] as const;
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<GatewayProvider, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
};

export const AI_FEATURES = [
  { key: "explanation", label: "AI Explanation", group: "Student AI" },
  { key: "variant", label: "AI Variant", group: "Student AI" },
  { key: "ig_carousel", label: "Instagram Carousel Content", group: "Instagram" },
  { key: "ig_trap", label: "Examiner Trap Generation", group: "Instagram" },
  { key: "ig_diagram", label: "Medical Diagram Planning", group: "Instagram" },
  { key: "ig_caption", label: "Caption Generation", group: "Instagram" },
  { key: "ig_hashtags", label: "Hashtag Generation", group: "Instagram" },
  { key: "ig_keywords", label: "Keyword Research", group: "Instagram" },
  { key: "ig_trends", label: "Trend Analysis", group: "Instagram" },
  { key: "ig_competitors", label: "Competitor Content Analysis", group: "Instagram" },
] as const;
export type AiFeature = (typeof AI_FEATURES)[number]["key"];
export const AI_FEATURE_KEYS = AI_FEATURES.map((f) => f.key) as AiFeature[];
export const FEATURE_LABELS = Object.fromEntries(AI_FEATURES.map((f) => [f.key, f.label])) as Record<AiFeature, string>;

/**
 * - "inherit": exactly the existing production behaviour (AI Settings → active
 *   provider, then fallback provider). Every feature starts here, so nothing
 *   changes until an admin configures a route.
 * - "custom": primary → first fallback → second fallback, with the limits below.
 */
export interface FeatureRoute {
  mode: "inherit" | "custom";
  primary: GatewayProvider;
  fallback1: GatewayProvider | "none";
  fallback2: GatewayProvider | "none";
  /** Per-provider model override for this feature; empty = the provider's configured model. */
  models: Partial<Record<GatewayProvider, string>>;
  timeoutMs: number;
  /** Extra attempts on the same provider for transient errors (timeout, rate limit, overload). */
  maxRetries: number;
  /** Successful calls per IST day; null = no cap. */
  dailyCap: number | null;
}

export const DEFAULT_ROUTE: FeatureRoute = {
  mode: "inherit",
  primary: "gemini",
  fallback1: "none",
  fallback2: "none",
  models: {},
  timeoutMs: 60_000,
  maxRetries: 1,
  dailyCap: null,
};

export const ROUTE_LIMITS = { timeoutMin: 5_000, timeoutMax: 180_000, retriesMax: 3, capMax: 100_000 } as const;

/** USD per 1M tokens. Estimates only (list prices); the admin can override any row. */
export interface ModelPrice {
  input: number;
  output: number;
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export function estimateCost(prices: Record<string, ModelPrice>, model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  const p = prices[model];
  if (!p || inputTokens === null || outputTokens === null) return null;
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 1_000_000) / 1_000_000;
}

function provider(v: unknown, allowNone: true): GatewayProvider | "none";
function provider(v: unknown, allowNone: false): GatewayProvider;
function provider(v: unknown, allowNone: boolean): GatewayProvider | "none" {
  if ((GATEWAY_PROVIDERS as readonly string[]).includes(v as string)) return v as GatewayProvider;
  return allowNone ? "none" : "gemini";
}

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** Normalizes a stored/submitted route. Fallbacks never repeat the primary or each other. */
export function normalizeRoute(raw: unknown): FeatureRoute {
  const r = (raw ?? {}) as Partial<FeatureRoute>;
  const primary = provider(r.primary, false);
  let fallback1 = provider(r.fallback1, true);
  let fallback2 = provider(r.fallback2, true);
  if (fallback1 === primary) fallback1 = "none";
  if (fallback2 === primary || fallback2 === fallback1) fallback2 = "none";
  if (fallback1 === "none" && fallback2 !== "none") [fallback1, fallback2] = [fallback2, "none"];
  const models: Partial<Record<GatewayProvider, string>> = {};
  for (const p of GATEWAY_PROVIDERS) {
    const m = (r.models as Record<string, unknown> | undefined)?.[p];
    if (typeof m === "string" && /^[A-Za-z0-9._:\/-]{2,80}$/.test(m.trim())) models[p] = m.trim();
  }
  const cap = r.dailyCap === null || r.dailyCap === undefined || (r.dailyCap as unknown) === "" ? null : clampInt(r.dailyCap, 1, ROUTE_LIMITS.capMax, 100);
  return {
    mode: r.mode === "custom" ? "custom" : "inherit",
    primary,
    fallback1,
    fallback2,
    models,
    timeoutMs: clampInt(r.timeoutMs, ROUTE_LIMITS.timeoutMin, ROUTE_LIMITS.timeoutMax, DEFAULT_ROUTE.timeoutMs),
    maxRetries: clampInt(r.maxRetries, 0, ROUTE_LIMITS.retriesMax, DEFAULT_ROUTE.maxRetries),
    dailyCap: cap,
  };
}

export function routeChain(route: FeatureRoute): GatewayProvider[] {
  return [route.primary, route.fallback1, route.fallback2].filter((p): p is GatewayProvider => p !== "none");
}
