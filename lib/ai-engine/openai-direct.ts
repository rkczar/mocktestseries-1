import "server-only";
import type { ChatContentPart, ChatResult } from "@/lib/ai-engine/openrouter";
import { OpenRouterError, sanitize } from "@/lib/ai-engine/openrouter";

/**
 * Direct OpenAI Chat Completions for the AI Question Importer (an optional route next to OpenRouter, chosen per
 * request by lib/ai-import/ai.ts). Same request shape as the OpenRouter call: system + user content, an output limit,
 * optional JSON Schema output and reasoning effort. OpenAI returns no price, so the caller prices the reported tokens
 * (cached input at the cached rate). The key is passed in by the server; it is never logged (errors are sanitized).
 * Tests: OPENAI_TEST_BASE_URL (loopback only) points it at a mock.
 */
// Owner policy 2026-11-26: OpenRouter only. The real OpenAI host was removed; only a loopback test mock is accepted.
export function openAiBase(): string {
  const raw = process.env.OPENAI_TEST_BASE_URL ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw)) return `${raw}/v1`;
  throw new OpenRouterError("bad_request", "Direct OpenAI calls are disabled: all AI runs through OpenRouter.");
}

/** Importer catalogue id ("openai/gpt-…", the OpenRouter name) → the OpenAI API model name. Null when not an OpenAI model. */
export function openAiModelName(id: string): string | null {
  const m = /^openai\/([A-Za-z0-9._:-]+)$/.exec(id);
  return m ? m[1] : null;
}

export interface OpenAiChatParams {
  apiKey: string;
  model: string;
  system: string;
  content: ChatContentPart[];
  maxTokens: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: unknown } };
  timeoutMs: number;
}

export async function openAiDirectChat(p: OpenAiChatParams): Promise<ChatResult & { cachedTokens: number | null }> {
  const body: Record<string, unknown> = {
    model: p.model,
    // The fixed rules first and identical across requests: OpenAI caches a repeated prompt prefix automatically.
    messages: [{ role: "system", content: p.system }, { role: "user", content: p.content }],
    // Current OpenAI models take max_completion_tokens (max_tokens is refused by reasoning models).
    max_completion_tokens: p.maxTokens,
  };
  if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
  if (p.responseFormat) body.response_format = p.responseFormat;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), p.timeoutMs);
  let res: Response;
  let data: {
    id?: string;
    model?: string;
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string };
  };
  try {
    res = await fetch(`${openAiBase()}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` }, body: JSON.stringify(body), signal: ctrl.signal });
    data = (await res.json().catch(() => ({}))) as typeof data;
  } catch (e) {
    const timeout = e instanceof Error && e.name === "AbortError";
    // Same error type as the OpenRouter route, so the importer's retry / stop rules apply unchanged.
    throw new OpenRouterError(timeout ? "timeout" : "network", timeout ? `OpenAI did not answer within ${Math.round(p.timeoutMs / 1000)} s.` : "OpenAI could not be reached.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const msg = sanitize(data.error?.message ?? `HTTP ${res.status}`).slice(0, 300);
    const category = res.status === 429 ? (/quota|billing/i.test(msg) ? "insufficient_credits" : "rate_limited") : res.status === 401 || res.status === 403 ? "auth_invalid" : res.status >= 500 ? "provider_error" : res.status === 404 ? "model_unavailable" : "bad_request";
    throw new OpenRouterError(category, `OpenAI refused the request (${res.status}): ${msg}`, res.status, null, null);
  }
  const choice = data.choices?.[0];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    generationId: typeof data.id === "string" ? data.id : null,
    model: typeof data.model === "string" && data.model ? `openai/${data.model}` : `openai/${p.model}`,
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? null,
    inputTokens: num(data.usage?.prompt_tokens),
    outputTokens: num(data.usage?.completion_tokens),
    cachedTokens: num(data.usage?.prompt_tokens_details?.cached_tokens),
    costUsd: null,
  };
}

/** USD of a finished request from the catalogue price (USD per token); cached input at its own rate when published. */
export function directCostUsd(price: { prompt: number; completion: number; cacheRead?: number | null }, usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null }): number | null {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
  return (usage.inputTokens - cached) * price.prompt + cached * (price.cacheRead ?? price.prompt) + usage.outputTokens * price.completion;
}
