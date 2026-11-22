/**
 * Provider fallback chains of the AI Question Importer — client-safe definitions (types, recommended chains, parsing).
 * Transports: lib/ai-import/direct-providers.ts (server only).
 */
export const CHAIN_PROVIDERS = ["openrouter", "anthropic", "gemini", "openai"] as const;
export type ChainProvider = (typeof CHAIN_PROVIDERS)[number];
export interface ChainEntry {
  provider: ChainProvider;
  /** Catalog id (vendor/model) — also the price source (AiModel row). */
  model: string;
}
export const PROVIDER_LABELS: Record<ChainProvider, string> = { openrouter: "OpenRouter", anthropic: "Anthropic (direct)", gemini: "Google Gemini (direct)", openai: "OpenAI (direct)" };

/** The vendor's own API name of a catalog id, or null when the provider cannot serve that model directly. */
export function directModelName(provider: ChainProvider, id: string): string | null {
  const [vendor, name] = id.split("/");
  if (!name) return null;
  if (provider === "openrouter") return id;
  if (name.includes(":")) return null; // :free / :batch variants exist only on OpenRouter
  if (provider === "anthropic") return vendor === "anthropic" ? name.replace(/\./g, "-") : null;
  if (provider === "gemini") return vendor === "google" && name.startsWith("gemini") ? name : null;
  if (provider === "openai") return vendor === "openai" ? name : null;
  return null;
}

/** Category of a direct provider's HTTP error (same meaning as OpenRouter's categories). */
/**
 * Recommended specialist models (owner 2026-11-22: strong primaries, independent vendors). The PRIMARY of each role runs
 * through OpenRouter (job plan: routes, price, privacy checks); its chain starts with the SAME model through the vendor's
 * own key (an OpenRouter key limit or outage then changes nothing), then other vendors. Reading (Google) and
 * verification (OpenAI) never share a vendor; the key reader (Anthropic Sonnet) is independent of the question reader.
 * shortcut: the choice is a judgement call, not benchmarked — replace with the benchmark winners once it has run.
 */
export const RECOMMENDED_PRIMARIES: Record<"extract" | "key" | "verify" | "classify", string> = {
  extract: "google/gemini-3.1-pro-preview",
  key: "anthropic/claude-sonnet-5.5",
  verify: "anthropic/claude-opus-5.5",
  classify: "anthropic/claude-opus-5.5",
};
/**
 * Chains (2026-11-22 production): each starts with its primary through the vendor's own key. Reading stays on Google
 * and verification on Anthropic (never the same vendor — enforced in ai.ts chainCall too); GPT-5.4 entries are used
 * once OpenRouter (key limit) or the OpenAI key (401) is restored.
 */
export const RECOMMENDED_CHAINS: Record<"extract" | "key" | "verify" | "classify", ChainEntry[]> = {
  extract: [
    { provider: "gemini", model: "google/gemini-3.1-pro-preview" },
    { provider: "gemini", model: "google/gemini-2.5-pro" },
    { provider: "openrouter", model: "openai/gpt-5.4" },
    { provider: "openai", model: "openai/gpt-5.4" },
  ],
  key: [
    { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" },
    { provider: "gemini", model: "google/gemini-3.1-pro-preview" },
    { provider: "anthropic", model: "anthropic/claude-opus-5.5" },
    { provider: "openrouter", model: "openai/gpt-5.4" },
  ],
  verify: [
    { provider: "anthropic", model: "anthropic/claude-opus-5.5" },
    { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" },
    { provider: "openrouter", model: "openai/gpt-5.4" },
    { provider: "openai", model: "openai/gpt-5.4" },
  ],
  classify: [
    { provider: "anthropic", model: "anthropic/claude-opus-5.5" },
    { provider: "gemini", model: "google/gemini-3.1-pro-preview" },
    { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" },
    { provider: "openrouter", model: "openai/gpt-5.4" },
  ],
};

/** A model's vendor ("google/gemini-3.1-pro" → "google"). */
export const vendorOf = (id: string | null | undefined) => (id ?? "").split("/")[0];

/** Every model the recommended configuration uses (to approve for the importer). */
export const RECOMMENDED_MODEL_IDS = [...new Set([...Object.values(RECOMMENDED_PRIMARIES), ...Object.values(RECOMMENDED_CHAINS).flat().map((e) => e.model)])];

/** Stored chains, cleaned: known providers, catalog-looking ids, a provider that can serve the model, at most 4 per role. */
export function normalizeChains(raw: unknown): Record<keyof typeof RECOMMENDED_CHAINS, ChainEntry[]> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const out = {} as Record<keyof typeof RECOMMENDED_CHAINS, ChainEntry[]>;
  for (const role of Object.keys(RECOMMENDED_CHAINS) as (keyof typeof RECOMMENDED_CHAINS)[]) {
    const list = src && Array.isArray(src[role]) ? (src[role] as unknown[]) : null;
    if (!list) {
      out[role] = RECOMMENDED_CHAINS[role].map((e) => ({ ...e }));
      continue;
    }
    const seen = new Set<string>();
    out[role] = list
      .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
      .filter((e): e is { provider: ChainProvider; model: string } => CHAIN_PROVIDERS.includes(e.provider as ChainProvider) && typeof e.model === "string" && /^[a-z0-9-]+\/[\w.:-]+$/i.test(e.model) && !!directModelName(e.provider as ChainProvider, e.model as string))
      .filter((e) => (seen.has(`${e.provider}|${e.model}`) ? false : (seen.add(`${e.provider}|${e.model}`), true)))
      .slice(0, 4)
      .map((e) => ({ provider: e.provider, model: e.model }));
  }
  return out;
}

/** Parses "provider:vendor/model" lines (Import Settings text box). Unknown lines are reported, never guessed. */
export function parseChainText(text: string): { entries: ChainEntry[]; problems: string[] } {
  const entries: ChainEntry[] = [];
  const problems: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(openrouter|anthropic|gemini|openai)\s*[:|]\s*([a-z0-9-]+\/[\w.:-]+)$/i.exec(line);
    if (!m) problems.push(`“${line.slice(0, 80)}” is not “provider: vendor/model”.`);
    else if (!directModelName(m[1].toLowerCase() as ChainProvider, m[2])) problems.push(`${m[1]} cannot serve ${m[2]}.`);
    else entries.push({ provider: m[1].toLowerCase() as ChainProvider, model: m[2] });
  }
  return { entries, problems };
}

export const chainText = (entries: ChainEntry[]) => entries.map((e) => `${e.provider}: ${e.model}`).join("\n");
