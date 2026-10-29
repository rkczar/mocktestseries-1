import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/secret-cipher";
import { AI_FEATURE_KEYS, type AiFeature } from "@/lib/ai-gateway-config";
import {
  DEFAULT_FEATURE_CONFIG,
  normalizeBudgets,
  normalizeFeatureConfig,
  normalizePrivacy,
  normalizeRuntime,
  type BudgetConfig,
  type FeatureEngineConfig,
  type PrivacyConfig,
  type RuntimeConfig,
} from "@/lib/ai-engine/config";

/**
 * AI Engine settings, stored in the existing `Setting` table and read from the
 * DB on every call (no in-process cache), so a change made on one PM2 worker
 * applies on every worker at once — the same pattern as lib/anthropic-config.ts.
 *
 *   api.openrouter  — encrypted key (lib/secret-cipher.ts, AUTH_SECRET), enabled,
 *                     last connection test and key-limit snapshot. The browser
 *                     only ever sees `keyHint` ("sk-or-••••1234").
 *   ai.engine       — per-feature engine config, budgets, privacy.
 */

export const OPENROUTER_SETTING_KEY = "api.openrouter";
export const ENGINE_SETTING_KEY = "ai.engine";

export interface OpenRouterKeyStatus {
  label: string | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  limitReset: string | null;
  usageUsd: number | null;
  usageDailyUsd: number | null;
  usageMonthlyUsd: number | null;
  isFreeTier: boolean | null;
  at: string;
}

export interface OpenRouterTest {
  ok: boolean;
  category: string;
  message: string;
  at: string;
}

interface StoredOpenRouter {
  enabled?: boolean;
  apiKeyCipher?: string;
  keyHint?: string;
  keySavedAt?: string;
  keySource?: "admin" | "script";
  lastTest?: OpenRouterTest | null;
  keyStatus?: OpenRouterKeyStatus | null;
  lastSyncAt?: string | null;
  lastSyncSummary?: string | null;
  lastError?: { category: string; message: string; at: string } | null;
  lastSuccessAt?: string | null;
  updatedAt?: string;
}

export interface OpenRouterPublicConfig {
  enabled: boolean;
  apiKeyConfigured: boolean;
  keyHint: string | null;
  keySavedAt: string | null;
  keySource: "admin" | "script" | null;
  status: "NOT_CONFIGURED" | "DISABLED" | "UNTESTED" | "CONNECTED" | "ERROR";
  lastTest: OpenRouterTest | null;
  keyStatus: OpenRouterKeyStatus | null;
  lastSyncAt: string | null;
  lastSyncSummary: string | null;
  lastError: { category: string; message: string; at: string } | null;
  lastSuccessAt: string | null;
}

export class EngineConfigError extends Error {}

async function readRow<T>(key: string): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return ((row?.value as T | undefined) ?? {}) as T;
}

/** Atomic JSON patch (set + remove keys in one statement) — no lost update across workers. */
async function patchRow(key: string, set: Record<string, unknown>, remove: string[] = []): Promise<void> {
  const patch = JSON.stringify({ ...set, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${key}, ${patch}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ("Setting"."value" - ${remove}::text[]) || ${patch}::jsonb, "updatedAt" = now()`);
}

// ---- OpenRouter provider --------------------------------------------------------------------

export function openRouterKeyHint(key: string): string {
  return `${key.startsWith("sk-or-") ? "sk-or-" : ""}••••${key.slice(-4)}`;
}

/** Format check only — Test Connection is the real check. */
export function checkOpenRouterKeyFormat(key: string): string | null {
  if (!key) return "Paste the API key.";
  if (/\s/.test(key)) return "The key contains spaces or line breaks — copy it again.";
  if (!key.startsWith("sk-or-")) return "An OpenRouter API key starts with sk-or-.";
  if (key.length < 30 || key.length > 300) return "That doesn't look like a complete OpenRouter API key.";
  return null;
}

function toPublic(raw: StoredOpenRouter): OpenRouterPublicConfig {
  const apiKeyConfigured = Boolean(raw.apiKeyCipher && decryptSecret(raw.apiKeyCipher));
  const enabled = raw.enabled === true && apiKeyConfigured;
  const lastTest = raw.lastTest ?? null;
  return {
    enabled,
    apiKeyConfigured,
    keyHint: apiKeyConfigured ? (raw.keyHint ?? "••••") : null,
    keySavedAt: apiKeyConfigured ? (raw.keySavedAt ?? null) : null,
    keySource: apiKeyConfigured ? (raw.keySource ?? "admin") : null,
    status: !apiKeyConfigured ? "NOT_CONFIGURED" : !enabled ? "DISABLED" : !lastTest ? "UNTESTED" : lastTest.ok ? "CONNECTED" : "ERROR",
    lastTest,
    keyStatus: raw.keyStatus ?? null,
    lastSyncAt: raw.lastSyncAt ?? null,
    lastSyncSummary: raw.lastSyncSummary ?? null,
    lastError: raw.lastError ?? null,
    lastSuccessAt: raw.lastSuccessAt ?? null,
  };
}

export async function getOpenRouterConfig(): Promise<OpenRouterPublicConfig> {
  return toPublic(await readRow<StoredOpenRouter>(OPENROUTER_SETTING_KEY));
}

/** Server-only: the decrypted key, whether or not the provider is enabled (Test Connection / model sync). */
export async function getOpenRouterApiKey(): Promise<string | null> {
  const raw = await readRow<StoredOpenRouter>(OPENROUTER_SETTING_KEY);
  return decryptSecret(raw.apiKeyCipher)?.trim() || null;
}

/** The key, only when OpenRouter is enabled for generation. */
export async function resolveOpenRouterKey(): Promise<string | null> {
  const raw = await readRow<StoredOpenRouter>(OPENROUTER_SETTING_KEY);
  if (raw.enabled !== true) return null;
  return decryptSecret(raw.apiKeyCipher)?.trim() || null;
}

export async function saveOpenRouterKey(key: string, source: "admin" | "script" = "admin"): Promise<{ keyHint: string }> {
  const trimmed = key.trim();
  const problem = checkOpenRouterKeyFormat(trimmed);
  if (problem) throw new EngineConfigError(problem);
  const keyHint = openRouterKeyHint(trimmed);
  // A new key is untested and disabled until the admin tests and enables it.
  await patchRow(OPENROUTER_SETTING_KEY, { apiKeyCipher: encryptSecret(trimmed), keyHint, keySavedAt: new Date().toISOString(), keySource: source, enabled: false, lastTest: null, keyStatus: null, lastError: null });
  return { keyHint };
}

export async function removeOpenRouterKey(): Promise<void> {
  await patchRow(OPENROUTER_SETTING_KEY, { enabled: false, lastTest: null, keyStatus: null }, ["apiKeyCipher", "keyHint", "keySavedAt", "keySource"]);
}

export async function setOpenRouterEnabled(enabled: boolean): Promise<OpenRouterPublicConfig> {
  const raw = await readRow<StoredOpenRouter>(OPENROUTER_SETTING_KEY);
  if (enabled) {
    if (!decryptSecret(raw.apiKeyCipher)) throw new EngineConfigError("Save an OpenRouter API key before enabling it.");
    if (!raw.lastTest?.ok) throw new EngineConfigError("Run Test Connection successfully before enabling OpenRouter.");
  }
  await patchRow(OPENROUTER_SETTING_KEY, { enabled });
  return toPublic({ ...raw, enabled });
}

export async function patchOpenRouterState(set: Partial<StoredOpenRouter>): Promise<void> {
  await patchRow(OPENROUTER_SETTING_KEY, set as Record<string, unknown>);
}

// ---- Engine (features, budgets, privacy) ------------------------------------------------------

interface StoredEngine {
  features?: Partial<Record<AiFeature, unknown>>;
  budgets?: unknown;
  privacy?: unknown;
  runtime?: unknown;
  updatedAt?: string;
}

export interface EngineConfig {
  features: Record<AiFeature, FeatureEngineConfig>;
  budgets: BudgetConfig;
  privacy: PrivacyConfig;
  runtime: RuntimeConfig;
  updatedAt: string | null;
}

export async function getEngineConfig(): Promise<EngineConfig> {
  const raw = await readRow<StoredEngine>(ENGINE_SETTING_KEY);
  const features = Object.fromEntries(
    AI_FEATURE_KEYS.map((f) => [f, raw.features?.[f] ? normalizeFeatureConfig(raw.features[f]) : { ...DEFAULT_FEATURE_CONFIG }])
  ) as Record<AiFeature, FeatureEngineConfig>;
  return { features, budgets: normalizeBudgets(raw.budgets), privacy: normalizePrivacy(raw.privacy), runtime: normalizeRuntime(raw.runtime), updatedAt: raw.updatedAt ?? null };
}

export async function saveFeatureConfig(feature: AiFeature, cfg: FeatureEngineConfig): Promise<void> {
  const raw = await readRow<StoredEngine>(ENGINE_SETTING_KEY);
  const features = { ...(raw.features ?? {}), [feature]: normalizeFeatureConfig(cfg) };
  await patchRow(ENGINE_SETTING_KEY, { features });
}

export async function saveBudgets(b: BudgetConfig): Promise<void> {
  await patchRow(ENGINE_SETTING_KEY, { budgets: normalizeBudgets(b) });
}

export async function savePrivacy(p: PrivacyConfig): Promise<void> {
  await patchRow(ENGINE_SETTING_KEY, { privacy: normalizePrivacy(p) });
}

export async function saveRuntime(r: RuntimeConfig): Promise<void> {
  await patchRow(ENGINE_SETTING_KEY, { runtime: normalizeRuntime(r) });
}
