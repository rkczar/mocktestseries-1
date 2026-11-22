import "server-only";
/**
 * Provider fallback chain transports (two-step importer, 2026-11-22). Each fallback entry names a catalog model
 * ("anthropic/claude-sonnet-5.5") and the provider that serves it: OpenRouter, or the vendor directly with its OWN key
 * (Admin → AI → Providers), so an OpenRouter key limit or outage does not stop the importer. Errors are thrown as
 * OpenRouterError with the same categories, so one set of rules (ai.ts chainCall) handles every provider.
 */
import { OpenRouterError, categorize, sanitize, type ChatContentPart, type ChatResult, type OpenRouterErrorCategory } from "@/lib/ai-engine/openrouter";
import { anthropicBaseUrl } from "@/lib/anthropic-client";
import { openAiDirectChat } from "@/lib/ai-engine/openai-direct";
import { PROVIDER_LABELS, directModelName, type ChainProvider } from "@/lib/ai-import/chains";
export * from "@/lib/ai-import/chains";

export function directCategory(status: number, message: string): OpenRouterErrorCategory {
  if (status === 429) return /quota|billing|credit|exhausted|spend/i.test(message) ? "insufficient_credits" : "rate_limited";
  if (status === 529 || status >= 500) return "provider_error";
  if (status === 400 && /api key|api_key/i.test(message)) return "auth_invalid";
  if (status === 400 && /credit balance|billing|quota/i.test(message)) return "insufficient_credits";
  return categorize(status, message);
}

function geminiBase(): string {
  const raw = process.env.GEMINI_TEST_BASE_URL ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw) ? raw : "https://generativelanguage.googleapis.com";
}

/** data:image/png;base64,xxx → parts; anything else is refused (the importer only sends inline page images). */
function inlineImage(url: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!m) throw new OpenRouterError("bad_request", "A direct provider needs inline (base64) images.");
  return { mime: m[1], data: m[2] };
}

export interface DirectRequest {
  system: string;
  content: ChatContentPart[];
  maxTokens: number;
  json: boolean;
  timeoutMs: number;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, who: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    // The whole body read is inside the deadline (2026-10 lesson: headers-only timeouts let bodies stream for minutes).
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  } catch (e) {
    const timeout = e instanceof Error && e.name === "AbortError";
    throw new OpenRouterError(timeout ? "timeout" : "network", timeout ? `${who} did not answer within ${Math.round(timeoutMs / 1000)} s.` : `${who} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}

function fail(who: string, status: number, data: Record<string, unknown>): never {
  const err = data.error as { message?: string } | undefined;
  const msg = sanitize(err?.message ?? `HTTP ${status}`).slice(0, 300);
  throw new OpenRouterError(directCategory(status, msg), `${who} refused the request (${status}): ${msg}`, status, null, null);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

async function anthropicChat(key: string, model: string, r: DirectRequest): Promise<ChatResult> {
  const content = r.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : (() => { const i = inlineImage(p.image_url.url); return { type: "image", source: { type: "base64", media_type: i.mime, data: i.data } }; })()));
  const { status, data } = await postJson(`${anthropicBaseUrl() ?? "https://api.anthropic.com"}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model, max_tokens: r.maxTokens, system: r.system, messages: [{ role: "user", content }] }, r.timeoutMs, "Anthropic");
  if (status >= 300) fail("Anthropic", status, data);
  const blocks = (data.content as { type?: string; text?: string }[] | undefined) ?? [];
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const stop = data.stop_reason as string | undefined;
  return { generationId: typeof data.id === "string" ? data.id : null, model: `anthropic/${model}`, text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""), finishReason: stop === "max_tokens" ? "length" : stop ?? null, inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens), costUsd: null };
}

async function geminiChat(key: string, model: string, r: DirectRequest): Promise<ChatResult> {
  const parts = r.content.map((p) => (p.type === "text" ? { text: p.text } : (() => { const i = inlineImage(p.image_url.url); return { inline_data: { mime_type: i.mime, data: i.data } }; })()));
  const body = { system_instruction: { parts: [{ text: r.system }] }, contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: r.maxTokens, temperature: 0, thinkingConfig: { thinkingLevel: "low" }, ...(r.json ? { responseMimeType: "application/json" } : {}) } };
  const { status, data } = await postJson(`${geminiBase()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key }, body, r.timeoutMs, "Gemini");
  if (status >= 300) fail("Gemini", status, data);
  const cand = ((data.candidates as { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] | undefined) ?? [])[0];
  const usage = (data.usageMetadata ?? {}) as Record<string, unknown>;
  // Content blocked by Google's safety filters is moderation, not a format failure.
  if (!cand && (data.promptFeedback as { blockReason?: string } | undefined)?.blockReason) throw new OpenRouterError("moderation", `Gemini blocked the request (${(data.promptFeedback as { blockReason: string }).blockReason}).`);
  const out = num(usage.candidatesTokenCount);
  const thoughts = num(usage.thoughtsTokenCount) ?? 0;
  return { generationId: null, model: `google/${model}`, text: (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join(""), finishReason: cand?.finishReason === "MAX_TOKENS" ? "length" : cand?.finishReason === "SAFETY" ? "content_filter" : cand?.finishReason ?? null, inputTokens: num(usage.promptTokenCount), outputTokens: out === null ? null : out + thoughts, costUsd: null };
}

/** One request to a direct provider (never OpenRouter; ai.ts sends OpenRouter entries through its own client). */
export async function directChat(provider: Exclude<ChainProvider, "openrouter">, key: string, catalogId: string, r: DirectRequest): Promise<ChatResult> {
  const model = directModelName(provider, catalogId);
  if (!model) throw new OpenRouterError("model_unavailable", `${PROVIDER_LABELS[provider]} cannot serve ${catalogId}.`);
  if (provider === "anthropic") return anthropicChat(key, model, r);
  if (provider === "gemini") return geminiChat(key, model, r);
  return openAiDirectChat({ apiKey: key, model, system: r.system, content: r.content, maxTokens: r.maxTokens, timeoutMs: r.timeoutMs, ...(r.json ? { responseFormat: { type: "json_object" as const } } : {}) });
}

