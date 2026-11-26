import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secret-cipher";

/**
 * Gemini AI configuration, stored in the existing `Setting` key-value table
 * under the key `api.gemini` — same storage/encryption pattern as
 * lib/auth-provider-config.ts. The API key is AES-256-GCM encrypted at rest
 * and never returned to the browser; the admin UI only ever sees a boolean
 * "configured" status and a last-test result.
 *
 * Precedence: a saved DB value wins; GEMINI_API_KEY acts as the bootstrap on
 * a fresh install and as a fallback if nothing has been saved yet.
 *
 * Model pool: rather than a single hardcoded "latest" model alias (which
 * silently rides on whatever Google points that alias at, and shares one
 * account-wide quota bucket), the admin discovers the models actually
 * available to this API key (listCompatibleGeminiModels, a real
 * models.list call) and enables a subset into a pool. generateWithAi
 * (lib/ai-provider.ts) always tries `primaryModel` first, then
 * `fallbackModels` in the admin-set order, stopping at the first model that
 * returns a valid response — never a random rotation.
 */

const SETTING_KEY = "api.gemini";
const CACHE_TTL_MS = 15_000;

export interface ProviderLastTest {
  ok: boolean;
  message: string;
  at: string;
}

export interface GeminiModelHealth {
  modelId: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCategory: string | null;
  lastErrorMessage: string | null;
  lastLatencyMs: number | null;
}

export interface GeminiPublicConfig {
  enabled: boolean;
  /** Legacy single-model field — kept as the seed for primaryModel on first read of an install that predates the model pool. */
  model: string;
  apiKeyConfigured: boolean;
  configured: boolean;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;

  /** Models this API key was last confirmed to support generateContent for (from the last "Refresh Available Models"). Empty until an admin refreshes at least once. */
  availableModels: { id: string; displayName: string }[];
  availableModelsFetchedAt: string | null;
  /** Admin-enabled subset of availableModels that Ask AI/Variants are allowed to use at all. */
  enabledModels: string[];
  /** First model tried for every new (uncached) generation. */
  primaryModel: string;
  /** Tried in order, only after primaryModel fails, stopping at the first success. */
  fallbackModels: string[];
  /** Per-model health, keyed by model id — never includes API keys. */
  modelHealth: Record<string, GeminiModelHealth>;
}

interface StoredGemini {
  enabled?: boolean;
  apiKeyCipher?: string;
  model?: string;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
  availableModels?: { id: string; displayName: string }[];
  availableModelsFetchedAt?: string;
  enabledModels?: string[];
  primaryModel?: string;
  fallbackModels?: string[];
  modelHealth?: Record<string, GeminiModelHealth>;
}

let cache: { fetchedAt: number; value: GeminiPublicConfig } | null = null;

export function bumpGeminiConfigEpoch() {
  cache = null;
}

async function readStored(): Promise<StoredGemini> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  return (row.value as StoredGemini) ?? {};
}

async function writeStored(next: StoredGemini): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
  bumpGeminiConfigEpoch();
}

function toPublic(raw: StoredGemini): GeminiPublicConfig {
  const apiKeyConfigured = Boolean(decryptSecret(raw.apiKeyCipher));
  const legacyModel = raw.model ?? "gemini-flash-latest";
  // An install that predates the model pool (or one where the admin never
  // touched it) has no primaryModel yet — seed it from the legacy single
  // `model` field so generation still has somewhere to start.
  const primaryModel = raw.primaryModel ?? legacyModel;
  return {
    enabled: raw.enabled ?? apiKeyConfigured,
    model: legacyModel,
    apiKeyConfigured,
    configured: apiKeyConfigured,
    lastTest: raw.lastTest ?? null,
    updatedAt: raw.updatedAt ?? null,
    availableModels: raw.availableModels ?? [],
    availableModelsFetchedAt: raw.availableModelsFetchedAt ?? null,
    enabledModels: raw.enabledModels ?? (primaryModel ? [primaryModel] : []),
    primaryModel,
    fallbackModels: raw.fallbackModels ?? [],
    modelHealth: raw.modelHealth ?? {},
  };
}

/** Front-end-safe Gemini config. Cached in-process for 15s. */
export async function getGeminiConfig(): Promise<GeminiPublicConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const raw = await readStored();
  const value = toPublic(raw);
  cache = { fetchedAt: Date.now(), value };
  return value;
}

/** Server-only: decrypted Gemini API key (DB first, env fallback). */
export async function getGeminiApiKey(): Promise<string | null> {
  const raw = await readStored();
  const stored = raw.apiKeyCipher ? decryptSecret(raw.apiKeyCipher) : null;
  return (stored || "").trim() || null;
}

/**
 * The ordered list of model ids a NEW (uncached) Gemini generation should
 * try: primary first, then each fallback in the admin-set priority order —
 * de-duplicated and restricted to models the admin has actually enabled, so
 * a model that was disabled (or dropped from availableModels on a refresh)
 * can never be silently used. Falls back to the legacy single `model` field
 * when no pool has been configured yet, so an unmigrated install keeps
 * working exactly as before.
 */
export async function getGeminiModelCandidates(): Promise<string[]> {
  const config = await getGeminiConfig();
  const enabled = new Set(config.enabledModels.length > 0 ? config.enabledModels : [config.primaryModel]);
  const ordered = [config.primaryModel, ...config.fallbackModels].filter((m) => enabled.has(m));
  const deduped = Array.from(new Set(ordered));
  return deduped.length > 0 ? deduped : [config.model];
}

export interface GeminiConfigUpdate {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
}

export async function saveGeminiConfig(update: GeminiConfigUpdate): Promise<void> {
  const raw = await readStored();
  const next: StoredGemini = { ...raw };
  if (update.enabled !== undefined) next.enabled = update.enabled;
  if (update.model !== undefined && update.model.trim()) {
    next.model = update.model.trim();
    // Keep the legacy field and the pool's primary model in sync when there
    // is no pool configured yet — once an admin explicitly sets a pool via
    // saveGeminiModelPool, that call owns primaryModel going forward.
    if (!raw.primaryModel) next.primaryModel = next.model;
  }
  if (update.apiKey !== undefined && update.apiKey.trim()) {
    next.apiKeyCipher = encryptSecret(update.apiKey.trim());
  }
  next.lastTest = null; // credentials changed — a previous test result is stale
  next.updatedAt = new Date().toISOString();

  await writeStored(next);
}

export interface GeminiModelPoolUpdate {
  enabledModels: string[];
  primaryModel: string;
  fallbackModels: string[];
}

/**
 * MASTER_ADMIN-only (enforced by the caller action, PERMISSIONS check) —
 * saves which models are enabled and the primary/fallback priority order.
 * Validates internally so a stale/compromised client can't smuggle in a
 * model id we never discovered as compatible: every id here must be one of
 * the last-refreshed availableModels.
 */
export async function saveGeminiModelPool(update: GeminiModelPoolUpdate): Promise<void> {
  const raw = await readStored();
  const compatible = new Set((raw.availableModels ?? []).map((m) => m.id));

  const enabledModels = Array.from(new Set(update.enabledModels.filter((m) => compatible.has(m))));
  const enabledSet = new Set(enabledModels);
  if (enabledModels.length === 0) {
    throw new Error("At least one model must stay enabled.");
  }
  const primaryModel = enabledSet.has(update.primaryModel) ? update.primaryModel : enabledModels[0];
  const fallbackModels = Array.from(new Set(update.fallbackModels.filter((m) => enabledSet.has(m) && m !== primaryModel))).slice(0, 4);

  const next: StoredGemini = { ...raw, enabledModels, primaryModel, fallbackModels, model: primaryModel };
  next.updatedAt = new Date().toISOString();
  await writeStored(next);
}


/**
 * Fetches the models this API key can use for our Ask AI system —
 * generateContent support only, per the real, live models.list response
 * (never a hardcoded/guessed list of model names). Persists the result as
 * availableModels so saveGeminiModelPool can validate against it, and seeds
 * enabledModels/primaryModel on the very first refresh so a freshly
 * connected key isn't left with an empty pool.
 */
export async function refreshAvailableGeminiModels(): Promise<{ id: string; displayName: string }[]> {
  // Owner policy 2026-11-26: no direct Google request. Gemini models are listed in AI → Models (OpenRouter).
  throw new Error("Direct provider calls are disabled: all AI runs through OpenRouter (AI → Providers → OpenRouter).");
}

/** Records a single model's outcome for the Admin AI Settings health table. Never logs the API key or the raw prompt/response. */
export async function recordGeminiModelResult(
  modelId: string,
  outcome: { ok: boolean; errorCategory?: string; errorMessage?: string; latencyMs: number }
): Promise<void> {
  // Re-read right before writing (rather than reusing an earlier read) to
  // minimize — not eliminate — lost updates from concurrent generations
  // landing on this same low-write-volume settings row.
  const raw = await readStored();
  const existing = raw.modelHealth?.[modelId] ?? {
    modelId,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCategory: null,
    lastErrorMessage: null,
    lastLatencyMs: null,
  };
  const now = new Date().toISOString();
  const entry: GeminiModelHealth = outcome.ok
    ? { ...existing, lastSuccessAt: now, lastLatencyMs: outcome.latencyMs }
    : {
        ...existing,
        lastFailureAt: now,
        lastErrorCategory: outcome.errorCategory ?? "unknown",
        lastErrorMessage: outcome.errorMessage ?? null,
        lastLatencyMs: outcome.latencyMs,
      };

  await writeStored({ ...raw, modelHealth: { ...(raw.modelHealth ?? {}), [modelId]: entry } });
}

/**
 * Validates a Gemini API key with a real, read-only call to the models list
 * endpoint — cheap, makes no generation request, and fails clearly (401/403)
 * when the key is invalid.
 */
export async function testGeminiConnection(): Promise<ProviderLastTest> {
  return { ok: false, message: "Direct provider calls are disabled: all AI runs through OpenRouter (AI → Providers → OpenRouter).", at: new Date().toISOString() };
}
