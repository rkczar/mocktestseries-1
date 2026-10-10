import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/secret-cipher";
import { ClaudeError, callClaude, claudeClient, toClaudeError, type ClaudeEffort, type ClaudeErrorCategory } from "@/lib/anthropic-client";

/**
 * Anthropic Claude provider configuration — Admin → AI Solutions → AI Providers.
 *
 * Same storage pattern as lib/gemini-config.ts / lib/openai-config.ts: one row
 * in the `Setting` table (key `api.anthropic`). The API key is encrypted with
 * AES-256-GCM by lib/secret-cipher.ts, whose key is derived from AUTH_SECRET in
 * the shared server .env — outside the database, the release tree and Git.
 * The database alone can't decrypt it. The plaintext key never leaves the
 * server: the browser only ever sees `keyHint` ("sk-ant-••••1234").
 *
 * Nothing is cached in-process: every read goes to the database, so a key
 * saved, replaced or removed on one PM2 worker is used by every worker on its
 * very next request — no restart, no redeploy.
 *
 * Claude is OFF until a Master Admin saves a key and enables it.
 */

export const ANTHROPIC_SETTING_KEY = "api.anthropic";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const TEST_TIMEOUT_MS = 20_000;
/** Minimum spacing between two connection tests (all workers — stored in the DB). */
export const TEST_COOLDOWN_MS = 10_000;

/**
 * Shown when the live model list has never been fetched (or failed). Current
 * models first. A live "Refresh models" result always takes precedence.
 */
export const CURATED_CLAUDE_MODELS: { id: string; displayName: string }[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
  { id: "claude-opus-5", displayName: "Claude Opus 5" },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
];

export const CLAUDE_EFFORTS: ClaudeEffort[] = ["low", "medium", "high"];

export interface ClaudeTestResult {
  ok: boolean;
  category: ClaudeErrorCategory | "ok";
  message: string;
  at: string;
  checks: { key: "pass" | "fail" | "skip"; model: "pass" | "fail" | "skip"; generation: "pass" | "fail" | "skip" };
  model: string;
}

export interface ClaudeErrorSummary {
  category: string;
  message: string;
  at: string;
}

interface StoredAnthropic {
  enabled?: boolean;
  apiKeyCipher?: string;
  keyHint?: string;
  keySavedAt?: string;
  model?: string;
  effort?: ClaudeEffort;
  availableModels?: { id: string; displayName: string }[];
  availableModelsFetchedAt?: string;
  lastTest?: ClaudeTestResult | null;
  lastSuccessAt?: string | null;
  lastError?: ClaudeErrorSummary | null;
  updatedAt?: string;
}

/** Browser-safe view — never contains the key or its cipher. */
export interface ClaudePublicConfig {
  enabled: boolean;
  apiKeyConfigured: boolean;
  keyHint: string | null;
  keySavedAt: string | null;
  /** Saved key + enabled + last test (if any) not failed on auth. */
  status: "NOT_CONFIGURED" | "DISABLED" | "CONNECTED" | "ERROR" | "UNTESTED";
  model: string;
  effort: ClaudeEffort;
  models: { id: string; displayName: string }[];
  modelsSource: "live" | "curated";
  availableModelsFetchedAt: string | null;
  lastTest: ClaudeTestResult | null;
  lastSuccessAt: string | null;
  lastError: ClaudeErrorSummary | null;
  updatedAt: string | null;
}

async function readStored(): Promise<StoredAnthropic> {
  const row = await prisma.setting.findUnique({ where: { key: ANTHROPIC_SETTING_KEY } });
  return (row?.value as StoredAnthropic | undefined) ?? {};
}

/**
 * Atomic JSON patch of the stored row: sets `set` keys and deletes `remove`
 * keys in ONE statement, so a gateway status write on one worker can never
 * overwrite a key that was just saved/removed on another.
 */
async function patchStored(set: Partial<StoredAnthropic>, remove: (keyof StoredAnthropic)[] = []): Promise<void> {
  const patch = JSON.stringify({ ...set, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${ANTHROPIC_SETTING_KEY}, ${patch}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ("Setting"."value" - ${remove as string[]}::text[]) || ${patch}::jsonb, "updatedAt" = now()`);
}

/** "sk-ant-••••1234" — enough to recognise which key is saved, useless to an attacker. */
export function keyHintFor(key: string): string {
  const prefix = key.startsWith("sk-ant-") ? "sk-ant-" : "";
  return `${prefix}••••${key.slice(-4)}`;
}

/** Returns an error message for an obviously wrong key, or null. Format only — the real check is Test Connection. */
export function checkKeyFormat(key: string): string | null {
  if (!key) return "Paste the API key.";
  if (/\s/.test(key)) return "The key contains spaces or line breaks — copy it again.";
  if (!key.startsWith("sk-ant-")) return "An Anthropic API key starts with sk-ant-.";
  if (key.startsWith("sk-ant-admin")) return "That is an Admin API key. Create a normal API key in the Anthropic Console instead.";
  if (key.length < 30 || key.length > 300) return "That doesn't look like a complete Anthropic API key.";
  return null;
}

function toPublic(raw: StoredAnthropic): ClaudePublicConfig {
  const apiKeyConfigured = Boolean(raw.apiKeyCipher && decryptSecret(raw.apiKeyCipher));
  const enabled = raw.enabled === true;
  const live = raw.availableModels?.length ? raw.availableModels : null;
  const lastTest = raw.lastTest ?? null;
  const status: ClaudePublicConfig["status"] = !apiKeyConfigured
    ? "NOT_CONFIGURED"
    : !enabled
      ? "DISABLED"
      : !lastTest
        ? "UNTESTED"
        : lastTest.ok
          ? "CONNECTED"
          : "ERROR";
  return {
    enabled,
    apiKeyConfigured,
    keyHint: apiKeyConfigured ? (raw.keyHint ?? "••••") : null,
    keySavedAt: apiKeyConfigured ? (raw.keySavedAt ?? null) : null,
    status,
    model: raw.model || DEFAULT_CLAUDE_MODEL,
    effort: raw.effort && CLAUDE_EFFORTS.includes(raw.effort) ? raw.effort : "low",
    models: live ?? CURATED_CLAUDE_MODELS,
    modelsSource: live ? "live" : "curated",
    availableModelsFetchedAt: raw.availableModelsFetchedAt ?? null,
    lastTest,
    lastSuccessAt: raw.lastSuccessAt ?? null,
    lastError: raw.lastError ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export async function getClaudeConfig(): Promise<ClaudePublicConfig> {
  return toPublic(await readStored());
}

/** Server-only: the decrypted key, or null. Read from the DB on every call (no cache). */
export async function getClaudeApiKey(): Promise<string | null> {
  const raw = await readStored();
  return decryptSecret(raw.apiKeyCipher)?.trim() || null;
}

/** What the gateway needs to call Claude, or null when Claude must not be used. */
export async function resolveClaude(): Promise<{ apiKey: string; model: string; effort: ClaudeEffort } | null> {
  const raw = await readStored();
  if (raw.enabled !== true) return null;
  const apiKey = decryptSecret(raw.apiKeyCipher)?.trim();
  if (!apiKey) return null;
  const pub = toPublic(raw);
  return { apiKey, model: pub.model, effort: pub.effort };
}

/** Save or replace the key (validated format), encrypted. Resets the test state — the new key is untested. */
export async function saveClaudeKey(key: string): Promise<{ keyHint: string }> {
  const trimmed = key.trim();
  const problem = checkKeyFormat(trimmed);
  if (problem) throw new ClaudeConfigError(problem);
  const keyHint = keyHintFor(trimmed);
  await patchStored({ apiKeyCipher: encryptSecret(trimmed), keyHint, keySavedAt: new Date().toISOString(), lastTest: null, lastError: null, availableModels: [] }, ["availableModelsFetchedAt"]);
  return { keyHint };
}

/** Remove the key. Claude is also disabled; model choice and history stay. */
export async function removeClaudeKey(): Promise<void> {
  await patchStored({ enabled: false, lastTest: null }, ["apiKeyCipher", "keyHint", "keySavedAt"]);
}

export class ClaudeConfigError extends Error {}

export async function saveClaudeSettings(update: { enabled?: boolean; model?: string; effort?: ClaudeEffort }): Promise<ClaudePublicConfig> {
  const raw = await readStored();
  const next: Partial<StoredAnthropic> = {};
  if (update.model !== undefined) {
    const model = update.model.trim();
    if (!/^claude-[a-z0-9.-]{2,60}$/.test(model)) throw new ClaudeConfigError("Choose a Claude model.");
    const pub = toPublic(raw);
    if (pub.modelsSource === "live" && !pub.models.some((m) => m.id === model)) {
      throw new ClaudeConfigError(`Model "${model}" is not in the list of models available to this key. Refresh the model list or pick another.`);
    }
    next.model = model;
  }
  if (update.effort !== undefined) {
    if (!CLAUDE_EFFORTS.includes(update.effort)) throw new ClaudeConfigError("Invalid effort level.");
    next.effort = update.effort;
  }
  if (update.enabled !== undefined) {
    if (update.enabled && !decryptSecret(raw.apiKeyCipher)) throw new ClaudeConfigError("Save an API key before enabling Claude.");
    next.enabled = update.enabled;
  }
  await patchStored(next);
  return toPublic({ ...raw, ...next });
}

/** Records a sanitized gateway failure / success on the provider card. */
export async function recordClaudeOutcome(outcome: { ok: true } | { ok: false; category: string; message: string }): Promise<void> {
  if (outcome.ok) await patchStored({ lastSuccessAt: new Date().toISOString() });
  else await patchStored({ lastError: { category: outcome.category, message: outcome.message.slice(0, 300), at: new Date().toISOString() } });
}

/**
 * Real, server-side connection test:
 *  1. GET /v1/models — validates the key without generating anything (no cost),
 *     and refreshes the list of models this key can use.
 *  2. Checks the selected model is in that list.
 *  3. One tiny Messages call (a few output tokens) on the selected model — the
 *     only way to detect "valid key, but no credit / no access to this model".
 * Bounded timeouts; rate-limited across workers by the stored last-test time.
 */
export async function testClaudeConnection(opts: { skipGeneration?: boolean } = {}): Promise<ClaudeTestResult> {
  const raw = await readStored();
  const pub = toPublic(raw);
  const at = new Date().toISOString();
  const model = pub.model;
  const result = (r: Omit<ClaudeTestResult, "at" | "model">): ClaudeTestResult => ({ ...r, at, model });

  if (raw.lastTest?.at && Date.now() - Date.parse(raw.lastTest.at) < TEST_COOLDOWN_MS) {
    throw new ClaudeConfigError("A connection test just ran — wait a few seconds and try again.");
  }
  const apiKey = decryptSecret(raw.apiKeyCipher)?.trim();
  if (!apiKey) {
    return result({ ok: false, category: "not_configured", message: "No API key is saved. Paste your Anthropic API key and click Save first.", checks: { key: "skip", model: "skip", generation: "skip" } });
  }
  // Claim the cooldown slot before calling out, so parallel clicks on other workers back off.
  await patchStored({ lastTest: { ok: false, category: "provider_error", message: "Test in progress…", at, checks: { key: "skip", model: "skip", generation: "skip" }, model } });

  let final: ClaudeTestResult;
  const live: { id: string; displayName: string }[] = [];
  try {
    const client = claudeClient(apiKey, TEST_TIMEOUT_MS);
    for await (const m of client.models.list({ limit: 100 })) {
      if (typeof m.id === "string" && m.id.startsWith("claude-")) live.push({ id: m.id, displayName: m.display_name || m.id });
      if (live.length >= 100) break;
    }
  } catch (error) {
    const e = toClaudeError(error, model);
    final = result({ ok: false, category: e.category, message: e.message, checks: { key: e.category === "auth_invalid" ? "fail" : "skip", model: "skip", generation: "skip" } });
    await finishTest(final, null, null);
    return final;
  }

  const modelListed = live.length === 0 || live.some((m) => m.id === model);
  if (!modelListed) {
    final = result({
      ok: false,
      category: "model_unavailable",
      message: `The API key is valid, but model "${model}" is not available to it. Choose one of the ${live.length} available models and test again.`,
      checks: { key: "pass", model: "fail", generation: "skip" },
    });
    await finishTest(final, live, null);
    return final;
  }
  if (opts.skipGeneration) {
    final = result({ ok: true, category: "ok", message: `The API key is valid. ${live.length} Claude models are available.`, checks: { key: "pass", model: "pass", generation: "skip" } });
    await finishTest(final, live, at);
    return final;
  }
  try {
    await callClaude({ apiKey, model, prompt: "Reply with the single word OK.", maxOutputTokens: 16, timeoutMs: TEST_TIMEOUT_MS, effort: "low" });
    final = result({ ok: true, category: "ok", message: `Connected. The API key is valid and "${model}" answered a test request.`, checks: { key: "pass", model: "pass", generation: "pass" } });
    await finishTest(final, live, at);
  } catch (error) {
    const e = error instanceof ClaudeError ? error : toClaudeError(error, model);
    // max_tokens on a 16-token probe still proves the key, billing and model access work.
    if (e.category === "truncated") {
      final = result({ ok: true, category: "ok", message: `Connected. The API key is valid and "${model}" answered a test request.`, checks: { key: "pass", model: "pass", generation: "pass" } });
      await finishTest(final, live, at);
    } else {
      final = result({ ok: false, category: e.category, message: e.message, checks: { key: e.category === "auth_invalid" ? "fail" : "pass", model: e.category === "model_unavailable" ? "fail" : "pass", generation: "fail" } });
      await finishTest(final, live, null);
    }
  }
  return final;
}

async function finishTest(result: ClaudeTestResult, live: { id: string; displayName: string }[] | null, successAt: string | null) {
  const patch: Partial<StoredAnthropic> = { lastTest: result };
  if (live && live.length) {
    patch.availableModels = live;
    patch.availableModelsFetchedAt = result.at;
  }
  if (successAt) patch.lastSuccessAt = successAt;
  if (!result.ok) patch.lastError = { category: result.category, message: result.message, at: result.at };
  await patchStored(patch);
}
