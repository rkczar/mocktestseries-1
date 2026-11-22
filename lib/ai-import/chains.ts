/**
 * Model fallback chains of the AI Question Importer — client-safe definitions (types, recommended chains, parsing).
 * Owner rule (2026-11-22): OpenRouter is the ONLY transport. A chain is a list of models, all sent through OpenRouter;
 * entries saved earlier with a direct provider (anthropic / gemini / openai) are read as the same model via OpenRouter.
 */
export const CHAIN_PROVIDERS = ["openrouter"] as const;
export type ChainProvider = (typeof CHAIN_PROVIDERS)[number];
export interface ChainEntry {
  provider: ChainProvider;
  /** Catalog id (vendor/model) — also the price source (AiModel row). */
  model: string;
}
export const PROVIDER_LABELS: Record<ChainProvider, string> = { openrouter: "OpenRouter" };

/**
 * Recommended specialist models (owner 2026-11-22: strong but cost-effective, all via OpenRouter). Reading (Google) and
 * independent verification (OpenAI) never share a vendor; the key reader (Anthropic) is independent of the question reader.
 * shortcut: the choice is a judgement call, not benchmarked — replace with the benchmark winners once it has run.
 */
export const RECOMMENDED_PRIMARIES: Record<"extract" | "key" | "verify" | "classify", string> = {
  extract: "google/gemini-3.1-pro-preview",
  key: "anthropic/claude-sonnet-5.5",
  verify: "openai/gpt-5.4",
  classify: "anthropic/claude-sonnet-5.5",
};
/** Chains: the primary first, then other vendors. ai.ts chainCall also skips any model of the other role's vendor. */
export const RECOMMENDED_CHAINS: Record<"extract" | "key" | "verify" | "classify", ChainEntry[]> = {
  extract: [
    { provider: "openrouter", model: "google/gemini-3.1-pro-preview" },
    { provider: "openrouter", model: "openai/gpt-5.4" },
    { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
  ],
  key: [
    { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
    { provider: "openrouter", model: "google/gemini-3.1-pro-preview" },
    { provider: "openrouter", model: "openai/gpt-5.4" },
  ],
  verify: [
    { provider: "openrouter", model: "openai/gpt-5.4" },
    { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
    { provider: "openrouter", model: "anthropic/claude-opus-5.5" },
  ],
  classify: [
    { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
    { provider: "openrouter", model: "google/gemini-3-flash-preview" },
    { provider: "openrouter", model: "openai/gpt-5.4-mini" },
  ],
};

/** A model's vendor ("google/gemini-3.1-pro" → "google"). */
export const vendorOf = (id: string | null | undefined) => (id ?? "").split("/")[0];

/** Every model the recommended configuration uses (to approve for the importer). */
export const RECOMMENDED_MODEL_IDS = [...new Set([...Object.values(RECOMMENDED_PRIMARIES), ...Object.values(RECOMMENDED_CHAINS).flat().map((e) => e.model)])];

const MODEL_ID = /^[a-z0-9-]+\/[\w.:-]+$/i;

/** Stored chains, cleaned: catalog-looking ids, each model once, at most 4 per role — always via OpenRouter. */
export function normalizeChains(raw: unknown): Record<keyof typeof RECOMMENDED_CHAINS, ChainEntry[]> {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const out = {} as Record<keyof typeof RECOMMENDED_CHAINS, ChainEntry[]>;
  for (const role of Object.keys(RECOMMENDED_CHAINS) as (keyof typeof RECOMMENDED_CHAINS)[]) {
    const list = src && Array.isArray(src[role]) ? (src[role] as unknown[]) : null;
    if (!list) {
      out[role] = RECOMMENDED_CHAINS[role].map((e) => ({ ...e }));
      continue;
    }
    // Any saved provider (old direct entries included) is ignored: the model is used through OpenRouter.
    const models = list.map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).model : null)).filter((m): m is string => typeof m === "string" && MODEL_ID.test(m));
    out[role] = [...new Set(models)].slice(0, 4).map((model) => ({ provider: "openrouter" as const, model }));
  }
  return out;
}

/** Parses one model per line ("vendor/model", optionally "openrouter: vendor/model"). Unknown lines are reported, never guessed. */
export function parseChainText(text: string): { entries: ChainEntry[]; problems: string[] } {
  const entries: ChainEntry[] = [];
  const problems: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(?:([a-z]+)\s*[:|]\s*)?([a-z0-9-]+\/[\w.:-]+)$/i.exec(line);
    if (!m) problems.push(`“${line.slice(0, 80)}” is not “vendor/model”.`);
    else if (m[1] && m[1].toLowerCase() !== "openrouter") problems.push(`${m[1]}: direct provider APIs are not used — every model runs through OpenRouter (write just ${m[2]}).`);
    else entries.push({ provider: "openrouter", model: m[2] });
  }
  return { entries, problems };
}

export const chainText = (entries: ChainEntry[]) => entries.map((e) => e.model).join("\n");
