import "server-only";
import { getAiSettings, type AiProviderName } from "@/lib/ai-settings";
import { getGeminiApiKey, getGeminiConfig, getGeminiModelCandidates, recordGeminiModelResult } from "@/lib/gemini-config";
import { getOpenAiApiKey, getOpenAiConfig } from "@/lib/openai-config";

/**
 * The single AI text-generation entry point for both lib/ai-explanation.ts
 * and lib/ai-variant.ts. Tries the admin-configured active provider, then
 * the fallback provider if one is set and configured — callers never talk
 * to Gemini/OpenAI directly, so the student UI and the admin surfaces stay
 * decoupled from which provider actually answered (Ask AI spec §2).
 *
 * Within the Gemini provider specifically, a second, model-level fallback
 * chain also runs: primary model, then each admin-enabled fallback model in
 * priority order, stopping at the first model that returns a valid
 * response. This exists because a single hardcoded "latest" alias shares
 * one quota bucket — once that's exhausted every request fails identically
 * with no recourse. See lib/gemini-config.ts#getGeminiModelCandidates.
 */

export class AiNotConfiguredError extends Error {}

export interface AiGenerationResult {
  text: string;
  provider: AiProviderName;
  model: string;
}

export interface AiGenerationOptions {
  temperature: number;
  maxOutputTokens: number;
}

interface ResolvedProvider {
  name: AiProviderName;
  apiKey: string;
  /** Gemini: every candidate model to try, in priority order. Other providers: a single-entry list. */
  models: string[];
}

async function resolveProvider(name: AiProviderName): Promise<ResolvedProvider | null> {
  if (name === "gemini") {
    const config = await getGeminiConfig();
    if (!config.configured || !config.enabled) return null;
    const apiKey = await getGeminiApiKey();
    if (!apiKey) return null;
    const models = await getGeminiModelCandidates();
    if (models.length === 0) return null;
    return { name, apiKey, models };
  }
  const config = await getOpenAiConfig();
  if (!config.configured || !config.enabled) return null;
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) return null;
  return { name, apiKey, models: [config.model] };
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Failure categories a model-level fallback should move past — matches the
 * task's explicit list: model unavailable, provider/model API error,
 * timeout, temporary service failure, rate limit, quota/resource
 * exhaustion, empty response, malformed/invalid generation response.
 * Deliberately does NOT include "the model produced a different answer" —
 * only transport/availability failures land here.
 */
type GeminiErrorCategory =
  | "quota_exhausted"
  | "rate_limited"
  | "model_unavailable"
  | "unsupported_endpoint"
  | "timeout"
  | "provider_error"
  | "empty_response"
  | "malformed_response";

class GeminiModelError extends Error {
  category: GeminiErrorCategory;
  constructor(category: GeminiErrorCategory, message: string) {
    super(message);
    this.category = category;
  }
}

function categorizeGeminiHttpError(status: number, message: string): GeminiErrorCategory {
  const lower = message.toLowerCase();
  if (status === 429 || lower.includes("quota")) return lower.includes("quota") ? "quota_exhausted" : "rate_limited";
  if (status === 404 || lower.includes("not found") || lower.includes("not supported")) return "model_unavailable";
  if (status === 400 && (lower.includes("unsupported") || lower.includes("does not support"))) return "unsupported_endpoint";
  if (status >= 500) return "provider_error";
  return "provider_error";
}

/** True if the text looks like it was attempting a JSON object but got cut off or came out malformed — a real generation failure worth trying the next model, not a legitimate plain-prose answer. */
function looksTruncatedOrMalformed(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return true;
  try {
    JSON.parse(match[0]);
    return false;
  } catch {
    return true;
  }
}

async function callGeminiModel(prompt: string, apiKey: string, model: string, opts: AiGenerationOptions): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: opts.temperature,
            maxOutputTokens: opts.maxOutputTokens,
            // Newer Gemini models spend part of maxOutputTokens on internal
            // "thinking" before writing the actual response — for a short
            // structured-JSON task that reasoning is pure overhead, and left
            // uncapped it was eating the whole token budget and truncating the
            // JSON output mid-string (confirmed against a live account: a
            // COMPLETED explanation whose "concept" field was literally a
            // half-written JSON blob). Ignored by models that don't support it.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new GeminiModelError("timeout", `Gemini model "${model}" timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw new GeminiModelError("provider_error", `Could not reach Gemini for model "${model}".`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = body.error?.message ?? `Gemini request failed (${res.status}).`;
    throw new GeminiModelError(categorizeGeminiHttpError(res.status, message), message);
  }

  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";

  if (!text.trim()) throw new GeminiModelError("empty_response", `Gemini model "${model}" returned an empty response.`);
  if (looksTruncatedOrMalformed(text)) {
    throw new GeminiModelError("malformed_response", `Gemini model "${model}" returned truncated or malformed output.`);
  }
  return text;
}

/**
 * Tries each candidate model in order (primary, then fallbacks), stopping
 * at the first success — never calls a later model once one has succeeded,
 * and never retries a model more than once for this logical request. Every
 * attempt's outcome is recorded server-side (model id, ok/fail, error
 * category, latency — never the API key or prompt/response text) for the
 * Admin AI Settings model-health table.
 */
async function callGeminiWithModelFallback(
  prompt: string,
  apiKey: string,
  models: string[],
  opts: AiGenerationOptions
): Promise<{ text: string; model: string }> {
  let lastError: Error | null = null;
  for (const model of models) {
    const startedAt = Date.now();
    try {
      const text = await callGeminiModel(prompt, apiKey, model, opts);
      await recordGeminiModelResult(model, { ok: true, latencyMs: Date.now() - startedAt });
      return { text, model };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (error instanceof GeminiModelError) {
        await recordGeminiModelResult(model, { ok: false, errorCategory: error.category, errorMessage: error.message, latencyMs });
      } else {
        await recordGeminiModelResult(model, {
          ok: false,
          errorCategory: "provider_error",
          errorMessage: error instanceof Error ? error.message : "Unknown error.",
          latencyMs,
        });
      }
      lastError = error instanceof Error ? error : new Error("Gemini request failed.");
    }
  }
  throw lastError ?? new Error("Gemini request failed.");
}

async function callOpenAi(prompt: string, apiKey: string, model: string, opts: AiGenerationOptions): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: opts.temperature,
      max_tokens: opts.maxOutputTokens,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ? `OpenAI rejected the request: ${body.error.message}` : `OpenAI request failed (${res.status}).`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callProvider(resolved: ResolvedProvider, prompt: string, opts: AiGenerationOptions): Promise<{ text: string; model: string }> {
  if (resolved.name === "gemini") {
    return callGeminiWithModelFallback(prompt, resolved.apiKey, resolved.models, opts);
  }
  const text = await callOpenAi(prompt, resolved.apiKey, resolved.models[0], opts);
  return { text, model: resolved.models[0] };
}

/** True if at least one provider (active or fallback) is configured and enabled — used to gate before attempting generation. */
export async function isAiGenerationConfigured(): Promise<boolean> {
  const settings = await getAiSettings();
  if (!settings.askAiEnabled) return false;
  const candidates = candidateOrder(settings.activeProvider, settings.fallbackProvider);
  for (const name of candidates) {
    if (await resolveProvider(name)) return true;
  }
  return false;
}

function candidateOrder(active: AiProviderName, fallback: AiProviderName | "none"): AiProviderName[] {
  const order: AiProviderName[] = [active];
  if (fallback !== "none" && fallback !== active) order.push(fallback);
  return order;
}

/**
 * Tries the active provider, then the fallback (if configured), in order.
 * Throws AiNotConfiguredError only when NEITHER is usable; a mid-call
 * failure on the active provider falls through to the fallback rather than
 * failing the whole request. For Gemini, "the active provider" itself first
 * runs its own model-level fallback chain (see callGeminiWithModelFallback)
 * before this outer loop ever reaches the OpenAI fallback provider.
 */
export async function generateWithAi(prompt: string, opts: AiGenerationOptions): Promise<AiGenerationResult> {
  const settings = await getAiSettings();
  if (!settings.askAiEnabled) {
    throw new AiNotConfiguredError("Ask AI is currently disabled by an admin.");
  }

  const candidates = candidateOrder(settings.activeProvider, settings.fallbackProvider);
  const resolvedCandidates: ResolvedProvider[] = [];
  for (const name of candidates) {
    const resolved = await resolveProvider(name);
    if (resolved) resolvedCandidates.push(resolved);
  }
  if (resolvedCandidates.length === 0) {
    throw new AiNotConfiguredError("AI isn't configured yet. An admin needs to add a provider API key under AI → Settings.");
  }

  let lastError: Error | null = null;
  for (const resolved of resolvedCandidates) {
    try {
      const { text, model } = await callProvider(resolved, prompt, opts);
      return { text, provider: resolved.name, model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("AI request failed.");
    }
  }
  throw lastError ?? new Error("AI request failed.");
}
