import "server-only";
import { getAiSettings, type AiProviderName } from "@/lib/ai-settings";
import { getGeminiApiKey, getGeminiConfig } from "@/lib/gemini-config";
import { getOpenAiApiKey, getOpenAiConfig } from "@/lib/openai-config";

/**
 * The single AI text-generation entry point for both lib/ai-explanation.ts
 * and lib/ai-variant.ts. Tries the admin-configured active provider, then
 * the fallback provider if one is set and configured — callers never talk
 * to Gemini/OpenAI directly, so the student UI and the admin surfaces stay
 * decoupled from which provider actually answered (Ask AI spec §2).
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
  model: string;
}

async function resolveProvider(name: AiProviderName): Promise<ResolvedProvider | null> {
  if (name === "gemini") {
    const config = await getGeminiConfig();
    if (!config.configured || !config.enabled) return null;
    const apiKey = await getGeminiApiKey();
    if (!apiKey) return null;
    return { name, apiKey, model: config.model };
  }
  const config = await getOpenAiConfig();
  if (!config.configured || !config.enabled) return null;
  const apiKey = await getOpenAiApiKey();
  if (!apiKey) return null;
  return { name, apiKey, model: config.model };
}

async function callGemini(prompt: string, apiKey: string, model: string, opts: AiGenerationOptions): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens },
      }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ? `Gemini rejected the request: ${body.error.message}` : `Gemini request failed (${res.status}).`);
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
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

async function callProvider(resolved: ResolvedProvider, prompt: string, opts: AiGenerationOptions): Promise<string> {
  return resolved.name === "gemini"
    ? callGemini(prompt, resolved.apiKey, resolved.model, opts)
    : callOpenAi(prompt, resolved.apiKey, resolved.model, opts);
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
 * failing the whole request.
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
      const text = await callProvider(resolved, prompt, opts);
      return { text, provider: resolved.name, model: resolved.model };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("AI request failed.");
    }
  }
  throw lastError ?? new Error("AI request failed.");
}
