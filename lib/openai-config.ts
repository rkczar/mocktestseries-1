import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secret-cipher";

/**
 * OpenAI configuration — same storage/encryption pattern as
 * lib/gemini-config.ts (Setting key `api.openai`, AES-256-GCM encrypted key,
 * DB-first with an env bootstrap). This is the fallback provider: see
 * lib/ai-provider.ts for the primary/fallback selection that actually calls
 * Gemini and/or OpenAI.
 */

const SETTING_KEY = "api.openai";
const CACHE_TTL_MS = 15_000;

export interface ProviderLastTest {
  ok: boolean;
  message: string;
  at: string;
}

export interface OpenAiPublicConfig {
  enabled: boolean;
  model: string;
  apiKeyConfigured: boolean;
  configured: boolean;
  lastTest: ProviderLastTest | null;
  updatedAt: string | null;
}

interface StoredOpenAi {
  enabled?: boolean;
  apiKeyCipher?: string;
  model?: string;
  lastTest?: ProviderLastTest | null;
  updatedAt?: string;
}

let cache: { fetchedAt: number; value: OpenAiPublicConfig } | null = null;

export function bumpOpenAiConfigEpoch() {
  cache = null;
}

async function readStored(): Promise<StoredOpenAi> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return {};
  return (row.value as StoredOpenAi) ?? {};
}

function toPublic(raw: StoredOpenAi): OpenAiPublicConfig {
  const envKey = process.env.OPENAI_API_KEY ?? "";
  const apiKeyConfigured = Boolean(decryptSecret(raw.apiKeyCipher) || envKey);
  return {
    enabled: raw.enabled ?? apiKeyConfigured,
    model: raw.model ?? "gpt-4o-mini",
    apiKeyConfigured,
    configured: apiKeyConfigured,
    lastTest: raw.lastTest ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/** Front-end-safe OpenAI config. Cached in-process for 15s. */
export async function getOpenAiConfig(): Promise<OpenAiPublicConfig> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const raw = await readStored();
  const value = toPublic(raw);
  cache = { fetchedAt: Date.now(), value };
  return value;
}

/** Server-only: decrypted OpenAI API key (DB first, env fallback). */
export async function getOpenAiApiKey(): Promise<string | null> {
  const raw = await readStored();
  const stored = raw.apiKeyCipher ? decryptSecret(raw.apiKeyCipher) : null;
  return (stored || process.env.OPENAI_API_KEY || "").trim() || null;
}

export interface OpenAiConfigUpdate {
  enabled?: boolean;
  apiKey?: string;
  model?: string;
}

export async function saveOpenAiConfig(update: OpenAiConfigUpdate): Promise<void> {
  const raw = await readStored();
  const next: StoredOpenAi = { ...raw };
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
  bumpOpenAiConfigEpoch();
}

async function recordTest(result: ProviderLastTest): Promise<void> {
  const raw = await readStored();
  raw.lastTest = result;
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value: raw as unknown as object },
    create: { key: SETTING_KEY, value: raw as unknown as object },
  });
  bumpOpenAiConfigEpoch();
}

/**
 * Validates an OpenAI API key with a real, read-only call to the models list
 * endpoint — cheap, makes no generation request, and fails clearly (401)
 * when the key is invalid.
 */
export async function testOpenAiConnection(): Promise<ProviderLastTest> {
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) {
    const result: ProviderLastTest = { ok: false, message: "An API key is required.", at: new Date().toISOString() };
    await recordTest(result);
    return result;
  }
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
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
      message: body.error?.message ? `OpenAI rejected the request: ${body.error.message}` : `Unexpected response (${res.status}).`,
      at: new Date().toISOString(),
    };
    await recordTest(result);
    return result;
  } catch {
    const result: ProviderLastTest = { ok: false, message: "Could not reach the OpenAI API.", at: new Date().toISOString() };
    await recordTest(result);
    return result;
  }
}
