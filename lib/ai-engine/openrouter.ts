import "server-only";

/**
 * OpenRouter HTTP client (server-only). Verified against the official API
 * reference on 2026-10-12:
 *   POST /api/v1/chat/completions  — `usage.cost` (USD credits) is always returned;
 *                                    `models` = ordered fallbacks, billed for the
 *                                    model in the response `model` field.
 *   POST /api/v1/images            — dedicated image API, `data[].b64_json`;
 *                                    a failed generation is not billed.
 *   GET  /api/v1/models            — catalog; prices are strings, USD per token.
 *   GET  /api/v1/images/models[/{id}/endpoints] — image models + per-endpoint price lines.
 *   GET  /api/v1/models/{id}/endpoints — per-provider routes of a model, each with its own
 *                                    price, status and supported parameters.
 *   GET  /api/v1/endpoints/zdr     — every Zero-Data-Retention route (seen 2026-10-18).
 *   GET  /api/v1/key               — key limit / usage (USD).
 *   GET  /api/v1/generation?id=    — `data.total_cost` (USD) for reconciliation.
 *
 * The key is sent only in the Authorization header and never logged. Error
 * text from the provider is sanitized before it is stored or shown.
 */

const PROD_BASE = "https://openrouter.ai/api/v1";

/** Loopback-only override for the test suites; production always calls openrouter.ai. */
export function openRouterBase(): string {
  const raw = process.env.OPENROUTER_TEST_BASE_URL ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw) ? `${raw}/api/v1` : PROD_BASE;
}

export type OpenRouterErrorCategory =
  | "auth_invalid"
  | "insufficient_credits"
  | "moderation"
  | "model_unavailable"
  | "no_endpoint"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "network"
  | "bad_request"
  | "empty_response"
  | "truncated";

export const TRANSIENT_OPENROUTER_ERRORS: OpenRouterErrorCategory[] = ["rate_limited", "provider_error", "network"];

export class OpenRouterError extends Error {
  constructor(
    public category: OpenRouterErrorCategory,
    message: string,
    public status: number | null = null,
    /** Set when the provider reported a generation id even though the call failed (cost may exist). */
    public generationId: string | null = null
  ) {
    super(message);
  }
}

export function sanitize(message: string): string {
  return message
    .replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [key]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    // OpenRouter app attribution (optional, documented headers).
    "HTTP-Referer": "https://mocktestseries.in",
    "X-Title": "MockTestSeries.in",
  };
}

function categorize(status: number, message: string): OpenRouterErrorCategory {
  const m = message.toLowerCase();
  if (status === 401) return "auth_invalid";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "moderation";
  if (status === 404 && (m.includes("no endpoints") || m.includes("data policy") || m.includes("no allowed providers") || m.includes("restrictions"))) return "no_endpoint";
  if (status === 404) return "model_unavailable";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "bad_request";
  return "provider_error";
}

export function describeCategory(c: OpenRouterErrorCategory): string {
  switch (c) {
    case "auth_invalid":
      return "The OpenRouter API key was rejected.";
    case "insufficient_credits":
      return "The OpenRouter account has no credits left (or the key's spending limit is reached).";
    case "moderation":
      return "The request was blocked by provider moderation.";
    case "model_unavailable":
      return "The model is not available on OpenRouter.";
    case "no_endpoint":
      return "No provider for this model meets the privacy policy / price ceiling.";
    case "rate_limited":
      return "OpenRouter rate-limited the request.";
    case "timeout":
      return "The request timed out.";
    case "network":
      return "Could not reach OpenRouter.";
    case "bad_request":
      return "OpenRouter rejected the request parameters.";
    case "empty_response":
      return "The model returned an empty response.";
    case "truncated":
      return "The model's output was cut off at the token limit.";
    default:
      return "OpenRouter returned an error.";
  }
}

async function request<T>(apiKey: string | null, path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number }): Promise<{ data: T; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${openRouterBase()}${path}`, {
      method: init.method ?? "GET",
      headers: apiKey ? headers(apiKey) : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new OpenRouterError("timeout", `OpenRouter did not answer within ${Math.round(init.timeoutMs / 1000)} s.`);
    throw new OpenRouterError("network", "Could not reach OpenRouter.");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const err = (body as { error?: { message?: string; code?: number } } | null)?.error;
  if (!res.ok || err) {
    const message = sanitize(err?.message ?? `OpenRouter request failed (${res.status}).`);
    const status = !res.ok ? res.status : typeof err?.code === "number" ? err.code : 500;
    const genId = (body as { id?: unknown } | null)?.id;
    throw new OpenRouterError(categorize(status, message), message, status, typeof genId === "string" ? genId : null);
  }
  if (body === null) throw new OpenRouterError("provider_error", "OpenRouter returned a response that is not JSON.", res.status);
  return { data: body as T, status: res.status };
}

// ---- Chat completions ------------------------------------------------------------------------

export interface ProviderPreferences {
  sort?: "price";
  /** USD per MILLION tokens (OpenRouter max_price convention). */
  max_price?: { prompt?: number; completion?: number; request?: number; image?: number };
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
}

/** One part of a multimodal user message (AI Question Importer: page images). */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ChatParams {
  apiKey: string;
  /** Single model, or `models` for OpenRouter-side fallbacks (first = preferred). */
  models: string[];
  prompt: string;
  /** Optional multimodal content; when set it is sent INSTEAD of `prompt` (text-only callers never set it). */
  content?: ChatContentPart[];
  /** Optional system message (the importer's fixed rules; document text never goes here). */
  system?: string;
  maxTokens: number;
  temperature: number;
  provider: ProviderPreferences;
  timeoutMs: number;
  /** OpenRouter Auto: plugin settings. */
  autoRouter?: { costTier: "low" | "medium" | "high"; allowedModels?: string[] };
  /** Optional reasoning control for models whose routes accept `reasoning` (AI Question Importer only). */
  reasoning?: { effort: "low" | "medium" | "high"; exclude?: boolean } | { max_tokens: number; exclude?: boolean };
  /** Optional structured output (AI Question Importer only): JSON mode or a JSON Schema, sent only to routes that accept it. */
  responseFormat?: { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: unknown } };
}

export interface ChatResult {
  generationId: string | null;
  model: string;
  text: string;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** USD; null when OpenRouter did not report a cost. */
  costUsd: number | null;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export async function chatCompletion(p: ChatParams): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    messages: p.content || p.system ? [...(p.system ? [{ role: "system", content: p.system }] : []), { role: "user", content: p.content ?? p.prompt }] : [{ role: "user", content: p.prompt }],
    max_tokens: p.maxTokens,
    temperature: p.temperature,
    provider: p.provider,
  };
  if (p.reasoning) body.reasoning = p.reasoning;
  if (p.responseFormat) body.response_format = p.responseFormat;
  if (p.models.length === 1) body.model = p.models[0];
  else {
    body.model = p.models[0];
    body.models = p.models;
  }
  if (p.autoRouter) {
    body.model = "openrouter/auto";
    delete body.models;
    body.plugins = [{ id: "auto-router", cost_tier: p.autoRouter.costTier, ...(p.autoRouter.allowedModels?.length ? { allowed_models: p.autoRouter.allowedModels } : {}) }];
  }
  const { data } = await request<ChatResponse>(p.apiKey, "/chat/completions", { method: "POST", body, timeoutMs: p.timeoutMs });
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? "";
  const result: ChatResult = {
    generationId: typeof data.id === "string" ? data.id : null,
    model: typeof data.model === "string" && data.model ? data.model : p.models[0],
    text,
    finishReason: choice?.finish_reason ?? null,
    inputTokens: typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null,
    outputTokens: typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null,
    costUsd: typeof data.usage?.cost === "number" && Number.isFinite(data.usage.cost) && data.usage.cost >= 0 ? data.usage.cost : null,
  };
  return result;
}

// ---- Images ----------------------------------------------------------------------------------

export interface ImageParams {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution: string;
  provider: ProviderPreferences;
  timeoutMs: number;
}

export interface ImageResult {
  generationId: string | null;
  model: string;
  bytes: Buffer;
  mediaType: string | null;
  costUsd: number | null;
}

export async function generateImage(p: ImageParams): Promise<ImageResult> {
  const { data } = await request<{ id?: string; model?: string; data?: { b64_json?: string; media_type?: string }[]; usage?: { cost?: number } }>(p.apiKey, "/images", {
    method: "POST",
    body: { model: p.model, prompt: p.prompt, aspect_ratio: p.aspectRatio, resolution: p.resolution, n: 1, provider: p.provider },
    timeoutMs: p.timeoutMs,
  });
  const item = data.data?.find((d) => typeof d.b64_json === "string" && d.b64_json.length > 0);
  if (!item?.b64_json) throw new OpenRouterError("empty_response", "OpenRouter returned no image.", 200, typeof data.id === "string" ? data.id : null);
  return {
    generationId: typeof data.id === "string" ? data.id : null,
    model: typeof data.model === "string" && data.model ? data.model : p.model,
    bytes: Buffer.from(item.b64_json, "base64"),
    mediaType: item.media_type ?? null,
    costUsd: typeof data.usage?.cost === "number" && Number.isFinite(data.usage.cost) && data.usage.cost >= 0 ? data.usage.cost : null,
  };
}

// ---- Catalog / key / generation ------------------------------------------------------------

export interface RawModel {
  id: string;
  name?: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, string | number | unknown>;
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[] | Record<string, unknown>;
  expiration_date?: string | null;
  endpoints?: string;
}

export async function listTextModels(apiKey: string | null): Promise<RawModel[]> {
  const { data } = await request<{ data?: RawModel[] }>(apiKey, "/models", { timeoutMs: 30_000 });
  return Array.isArray(data.data) ? data.data : [];
}

export async function listImageModels(apiKey: string | null): Promise<RawModel[]> {
  const { data } = await request<{ data?: RawModel[] }>(apiKey, "/images/models", { timeoutMs: 30_000 });
  return Array.isArray(data.data) ? data.data : [];
}

export interface ImagePriceLine {
  billable: string;
  unit: string;
  cost_usd: number;
  variant?: string;
}

export async function imageModelEndpoints(apiKey: string | null, id: string): Promise<{ provider: string; pricing: ImagePriceLine[] }[]> {
  const safe = id.split("/").map(encodeURIComponent).join("/");
  const { data } = await request<{ endpoints?: { provider_name?: string; pricing?: ImagePriceLine[] }[] }>(apiKey, `/images/models/${safe}/endpoints`, { timeoutMs: 20_000 });
  return (data.endpoints ?? []).map((e) => ({ provider: e.provider_name ?? "?", pricing: Array.isArray(e.pricing) ? e.pricing.filter((l) => typeof l?.cost_usd === "number") : [] }));
}

/** One provider route of a text model (GET /models/{id}/endpoints, GET /endpoints/zdr). Prices are USD strings per token. */
export interface RawEndpoint {
  model_id?: string;
  provider_name?: string;
  tag?: string;
  status?: number;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  max_prompt_tokens?: number | null;
  supported_parameters?: string[];
  pricing?: Record<string, unknown>;
}

/** Every provider route of one text model, with its own price (public endpoint; the key is sent when present). */
export async function modelEndpoints(apiKey: string | null, id: string): Promise<RawEndpoint[]> {
  const safe = id.split("/").map(encodeURIComponent).join("/");
  const { data } = await request<{ data?: { endpoints?: RawEndpoint[] } }>(apiKey, `/models/${safe}/endpoints`, { timeoutMs: 20_000 });
  return Array.isArray(data.data?.endpoints) ? data.data!.endpoints! : [];
}

/** Every Zero-Data-Retention route OpenRouter currently offers (public endpoint). */
export async function zdrEndpoints(apiKey: string | null): Promise<RawEndpoint[]> {
  const { data } = await request<{ data?: RawEndpoint[] }>(apiKey, "/endpoints/zdr", { timeoutMs: 30_000 });
  return Array.isArray(data.data) ? data.data : [];
}

export async function getKeyInfo(apiKey: string): Promise<{
  label: string | null;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  usage: number | null;
  usage_daily: number | null;
  usage_monthly: number | null;
  is_free_tier: boolean | null;
}> {
  const { data } = await request<{ data?: Record<string, unknown> }>(apiKey, "/key", { timeoutMs: 15_000 });
  const d = data.data ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    label: typeof d.label === "string" ? d.label.slice(0, 80) : null,
    limit: n(d.limit),
    limit_remaining: n(d.limit_remaining),
    limit_reset: typeof d.limit_reset === "string" ? d.limit_reset : null,
    usage: n(d.usage),
    usage_daily: n(d.usage_daily),
    usage_monthly: n(d.usage_monthly),
    is_free_tier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
  };
}

export async function getGenerationCost(apiKey: string, id: string): Promise<{ costUsd: number | null; model: string | null }> {
  const { data } = await request<{ data?: { total_cost?: number; model?: string } }>(apiKey, `/generation?id=${encodeURIComponent(id)}`, { timeoutMs: 15_000 });
  const c = data.data?.total_cost;
  return { costUsd: typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null, model: data.data?.model ?? null };
}

// ---- Speech (text-to-speech) and transcription — AI Video Studio ----------------------------
//
//   POST /api/v1/audio/speech          { model, input, voice, response_format: "mp3", instructions?, provider? }
//                                      → raw audio bytes (no JSON, no usage block in the body).
//   POST /api/v1/audio/transcriptions  { model, input_audio: { data, format }, language?, response_format:
//                                        "verbose_json", timestamp_granularities: ["word","segment"] }
//                                      → { text, words?, segments?, usage: { cost, seconds } }.
// Verified against openrouter.ai/openapi.json on 2026-10-24.

export interface SpeechParams {
  apiKey: string;
  model: string;
  voice: string;
  input: string;
  instructions?: string;
  provider: ProviderPreferences;
  timeoutMs: number;
}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
  /** OpenRouter generation id when the response carries one in a header (cost lookup); null otherwise. */
  generationId: string | null;
}

const MAX_SPEECH_BYTES = 40 * 1024 * 1024;

export async function createSpeech(p: SpeechParams): Promise<SpeechResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${openRouterBase()}/audio/speech`, {
      method: "POST",
      headers: headers(p.apiKey),
      body: JSON.stringify({ model: p.model, input: p.input, voice: p.voice, response_format: "mp3", ...(p.instructions ? { instructions: p.instructions } : {}), provider: p.provider }),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") throw new OpenRouterError("timeout", `OpenRouter did not answer within ${Math.round(p.timeoutMs / 1000)} s.`);
    throw new OpenRouterError("network", "Could not reach OpenRouter.");
  }
  try {
    const type = res.headers.get("content-type") ?? "";
    const genId = res.headers.get("x-generation-id") ?? res.headers.get("openrouter-generation-id");
    if (!res.ok || type.includes("json")) {
      const text = await res.text();
      let err: { message?: string; code?: number } | undefined;
      try {
        err = (JSON.parse(text) as { error?: { message?: string; code?: number } }).error;
      } catch {
        err = undefined;
      }
      const message = sanitize(err?.message ?? `OpenRouter speech request failed (${res.status}).`);
      const status = !res.ok ? res.status : typeof err?.code === "number" ? err.code : 500;
      throw new OpenRouterError(categorize(status, message), message, status, genId);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SPEECH_BYTES) throw new OpenRouterError("provider_error", "The speech response is larger than allowed.");
    if (buf.length < 64) throw new OpenRouterError("empty_response", describeCategory("empty_response"), res.status, genId);
    return { audio: buf, contentType: type || "audio/mpeg", generationId: genId && /^[A-Za-z0-9_-]{4,120}$/.test(genId) ? genId : null };
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscriptionParams {
  apiKey: string;
  model: string;
  audioBase64: string;
  format: "mp3" | "wav";
  language?: string;
  provider: ProviderPreferences;
  timeoutMs: number;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  words: TranscriptWord[];
  segments: { start: number; end: number; text: string }[];
  costUsd: number | null;
  seconds: number | null;
  generationId: string | null;
}

export async function createTranscription(p: TranscriptionParams): Promise<TranscriptionResult> {
  const { data } = await request<{
    id?: string;
    text?: string;
    words?: { word?: unknown; start?: unknown; end?: unknown }[];
    segments?: { start?: unknown; end?: unknown; text?: unknown }[];
    usage?: { cost?: unknown; seconds?: unknown };
  }>(p.apiKey, "/audio/transcriptions", {
    method: "POST",
    body: {
      model: p.model,
      input_audio: { data: p.audioBase64, format: p.format },
      ...(p.language ? { language: p.language } : {}),
      response_format: "verbose_json",
      timestamp_granularities: ["word", "segment"],
      provider: p.provider,
    },
    timeoutMs: p.timeoutMs,
  });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const words = (Array.isArray(data.words) ? data.words : [])
    .map((w) => ({ word: typeof w.word === "string" ? w.word.slice(0, 80) : "", start: n(w.start) ?? -1, end: n(w.end) ?? -1 }))
    .filter((w) => w.word && w.start >= 0 && w.end >= w.start);
  const segments = (Array.isArray(data.segments) ? data.segments : [])
    .map((s) => ({ start: n(s.start) ?? -1, end: n(s.end) ?? -1, text: typeof s.text === "string" ? s.text.slice(0, 600) : "" }))
    .filter((s) => s.text && s.start >= 0 && s.end >= s.start);
  return { text: typeof data.text === "string" ? data.text : "", words, segments, costUsd: n(data.usage?.cost), seconds: n(data.usage?.seconds), generationId: typeof data.id === "string" ? data.id : null };
}

/** Transcription (speech-to-text) models with their price — free catalog read. */
export async function listTranscriptionModels(apiKey: string | null): Promise<RawModel[]> {
  const { data } = await request<{ data?: RawModel[] }>(apiKey, "/models?output_modalities=transcription", { timeoutMs: 30_000 });
  return data.data ?? [];
}
