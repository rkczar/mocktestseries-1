import "server-only";
import type { OutputCheck } from "@/lib/ai-engine/structured";
import { getAiSettings, type AiProviderName } from "@/lib/ai-settings";
import { getGeminiApiKey, getGeminiConfig, getGeminiModelCandidates } from "@/lib/gemini-config";
import { getOpenAiApiKey, getOpenAiConfig } from "@/lib/openai-config";
import { getPlatformControls, effectivePlatformControls, pausedMessage } from "@/lib/platform-controls";

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

/**
 * Platform Controls → AI Services (also Lockdown / Maintenance). Refuses a
 * NEW provider generation with an AiNotConfiguredError carrying the public
 * message, so every existing catch site shows it. Cached explanations and
 * stored variants are read before this is reached and stay servable.
 */
export async function assertAiGenerationOpen(): Promise<void> {
  const platform = await getPlatformControls();
  if (!effectivePlatformControls(platform).aiOpen) throw new AiNotConfiguredError(pausedMessage(platform, "ai"));
}

export interface AiGenerationResult {
  text: string;
  /** "anthropic" / "openrouter" only when the AI Gateway routed the call there (lib/ai-gateway.ts, lib/ai-engine). */
  provider: AiProviderName | "anthropic" | "openrouter";
  model: string;
  /** Token usage when the provider reported it (used for the AI Gateway usage/cost log). */
  usage?: { inputTokens: number | null; outputTokens: number | null };
  /** Correlation id shared by every AiGatewayCall row of this request (AI Engine). */
  requestId?: string;
  /** Provider attempts made (AI Engine), and whether a model other than the first choice answered. */
  attempts?: number;
  fallbackUsed?: boolean;
}

export interface AiGenerationOptions {
  temperature: number;
  maxOutputTokens: number;
  /** The caller expects one JSON object: JSON mode is requested on models that support it (AI Engine). */
  json?: boolean;
  /**
   * Output check (lib/ai-engine/structured.ts). An answer that fails it is a failed attempt — logged with its
   * category, never returned — and the AI Engine tries the next compatible model.
   */
  check?: OutputCheck;
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

// Owner policy 2026-11-26: OpenRouter only. Direct Gemini / OpenAI HTTP calls were removed; this refuses.
async function callProvider(resolved: ResolvedProvider, ...rest: unknown[]): Promise<{ text: string; model: string; usage?: AiGenerationResult["usage"] }> {
  void rest;
  throw new AiNotConfiguredError(`Direct ${resolved.name === "gemini" ? "Gemini" : "OpenAI"} calls are disabled: all AI runs through OpenRouter.`);
}

/** True when this one provider (Gemini or OpenAI) has a key and is enabled. Used by the AI Gateway. */
export async function isProviderUsable(name: AiProviderName): Promise<boolean> {
  void name;
  return false; // OpenRouter only: no direct provider is ever usable
}

/**
 * One provider only (no provider-level fallback) — the AI Gateway's building
 * block for admin-configured per-feature routes. `model` overrides the
 * provider's configured model (Gemini: replaces the model pool for this call).
 * Platform Controls' AI pause still applies.
 */
export async function generateWithSingleProvider(
  name: AiProviderName,
  prompt: string,
  opts: AiGenerationOptions,
  o: { model?: string; timeoutMs?: number; deadlineAt?: number } = {}
): Promise<AiGenerationResult> {
  await assertAiGenerationOpen();
  const resolved = await resolveProvider(name);
  if (!resolved) throw new AiNotConfiguredError(`${name === "gemini" ? "Gemini" : "OpenAI"} is not configured or is disabled.`);
  const target = o.model ? { ...resolved, models: [o.model] } : resolved;
  const { text, model, usage } = await callProvider(target, prompt, opts, o.timeoutMs, o.deadlineAt);
  return { text, provider: name, model, usage };
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
  await assertAiGenerationOpen();
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
      const { text, model, usage } = await callProvider(resolved, prompt, opts);
      return { text, provider: resolved.name, model, usage };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("AI request failed.");
    }
  }
  throw lastError ?? new Error("AI request failed.");
}
