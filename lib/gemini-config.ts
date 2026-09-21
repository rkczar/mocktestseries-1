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
 */

const SETTING_KEY = "api.gemini";
const CACHE_TTL_MS = 15_000;

export interface ProviderLastTest {
  ok: boolean;
  message: string;
  at: string;
}

export interface GeminiPublicConfig {
  enabled: boolean;
  model: string;
  apiKeyConfigured: boolean;
  configured: boolean;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;
}

interface StoredGemini {
  enabled?: boolean;
  apiKeyCipher?: string;
  model?: string;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
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

function toPublic(raw: StoredGemini): GeminiPublicConfig {
  const envKey = process.env.GEMINI_API_KEY ?? "";
  const apiKeyConfigured = Boolean(decryptSecret(raw.apiKeyCipher) || envKey);
  return {
    enabled: raw.enabled ?? apiKeyConfigured,
    model: raw.model ?? "gemini-flash-latest",
    apiKeyConfigured,
    configured: apiKeyConfigured,
    lastTest: raw.lastTest ?? null,
    updatedAt: raw.updatedAt ?? null,
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
  return (stored || process.env.GEMINI_API_KEY || "").trim() || null;
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
  if (update.model !== undefined) next.model = update.model.trim() || undefined;
  if (update.apiKey !== undefined && update.apiKey.trim()) {
    next.apiKeyCipher = encryptSecret(update.apiKey.trim());
  }
  next.lastTest = null; // credentials changed — a previous test result is stale
  next.updatedAt = new Date().toISOString();

  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: SETTING_KEY, value: next as unknown as object },
  });
  bumpGeminiConfigEpoch();
}

async function recordTest(result: ProviderLastTest): Promise<void> {
  const raw = await readStored();
  raw.lastTest = result;
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: raw as unknown as object },
    create: { key: SETTING_KEY, value: raw as unknown as object },
  });
  bumpGeminiConfigEpoch();
}

/**
 * Validates a Gemini API key with a real, read-only call to the models list
 * endpoint — cheap, makes no generation request, and fails clearly (401/403)
 * when the key is invalid.
 */
export async function testGeminiConnection(): Promise<ProviderLastTest> {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    const result: ProviderLastTest = { ok: false, message: "An API key is required.", at: new Date().toISOString() };
    await recordTest(result);
    return result;
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (res.ok) {
      const result: ProviderLastTest = {
        ok: true,
        message: "Connection successful — the API key is valid.",
        at: new Date().toISOString(),
      };
      await recordTest(result);
      return result;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const result: ProviderLastTest = {
      ok: false,
      message: body.error?.message ? `Google rejected the request: ${body.error.message}` : `Unexpected response (${res.status}).`,
      at: new Date().toISOString(),
    };
    await recordTest(result);
    return result;
  } catch {
    const result: ProviderLastTest = { ok: false, message: "Could not reach the Gemini API.", at: new Date().toISOString() };
    await recordTest(result);
    return result;
  }
}
