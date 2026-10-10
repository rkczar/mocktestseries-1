import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin Anthropic Messages API caller used by the AI Gateway (lib/ai-gateway.ts)
 * and the Admin "Test Connection" (lib/anthropic-config.ts). Uses the official
 * SDK with the key passed per call — the key is loaded from the encrypted
 * `api.anthropic` Setting at call time, so a key saved in the Admin Panel works
 * on every PM2 worker immediately, with no restart.
 *
 * Errors are mapped to a small set of categories with human-readable messages
 * that never contain the key.
 */

export type ClaudeErrorCategory =
  | "not_configured"
  | "auth_invalid"
  | "permission"
  | "billing"
  | "model_unavailable"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "network"
  | "invalid_request"
  | "refused"
  | "truncated"
  | "empty_response"
  | "provider_error";

export class ClaudeError extends Error {
  category: ClaudeErrorCategory;
  status: number | null;
  constructor(category: ClaudeErrorCategory, message: string, status: number | null = null) {
    super(message);
    this.category = category;
    this.status = status;
  }
}

/** Categories worth retrying / moving to a fallback for. */
export const TRANSIENT_CLAUDE_ERRORS: ClaudeErrorCategory[] = ["rate_limited", "overloaded", "timeout", "network", "provider_error"];

/**
 * Tests only: an http://127.0.0.1:<port> mock of the Anthropic API. Anything
 * else is ignored, so production can only ever talk to api.anthropic.com.
 */
export function anthropicBaseUrl(): string | undefined {
  const raw = process.env.ANTHROPIC_TEST_BASE_URL ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw) ? raw : undefined;
}

export function claudeClient(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({ apiKey, baseURL: anthropicBaseUrl(), timeout: timeoutMs, maxRetries: 0 });
}

/** Removes anything that looks like a credential from a provider message, and bounds its length. */
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function apiMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { message?: unknown; type?: unknown } } | undefined;
  const msg = typeof body?.error?.message === "string" ? body.error.message : error.message;
  return sanitizeProviderMessage(String(msg ?? ""));
}

/** Maps any thrown SDK error to a ClaudeError with an admin-readable message. */
export function toClaudeError(error: unknown, model: string): ClaudeError {
  if (error instanceof ClaudeError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeError("timeout", "Claude did not answer in time (timeout).");
  if (error instanceof Anthropic.APIConnectionError) return new ClaudeError("network", "Could not reach the Anthropic API (network error).");
  if (error instanceof Anthropic.APIError) {
    const msg = apiMessage(error);
    const lower = msg.toLowerCase();
    const status = typeof error.status === "number" ? error.status : null;
    if (error instanceof Anthropic.AuthenticationError) return new ClaudeError("auth_invalid", "The Anthropic API key is invalid or has been revoked.", status);
    if (error instanceof Anthropic.PermissionDeniedError) return new ClaudeError("permission", `The API key is valid but not permitted to do this (${msg || "permission error"}).`, status);
    if (error instanceof Anthropic.NotFoundError) return new ClaudeError("model_unavailable", `Model "${model}" is not available to this API key (it may be retired or not enabled for your organization).`, status);
    if (error instanceof Anthropic.RateLimitError) return new ClaudeError("rate_limited", "Anthropic rate limit reached — try again shortly.", status);
    if (status === 402 || lower.includes("credit balance") || lower.includes("billing") || lower.includes("purchase credits")) {
      return new ClaudeError("billing", "The API key is valid, but the Anthropic account has no available credit or billing is not set up.", status);
    }
    if (error instanceof Anthropic.BadRequestError) {
      if (lower.includes("model")) return new ClaudeError("model_unavailable", `Model "${model}" was rejected: ${msg}`, status);
      return new ClaudeError("invalid_request", `Anthropic rejected the request: ${msg}`, status);
    }
    if (status === 529 || lower.includes("overloaded")) return new ClaudeError("overloaded", "Anthropic is temporarily overloaded — try again shortly.", status);
    return new ClaudeError("provider_error", `Anthropic API error${status ? ` (${status})` : ""}${msg ? `: ${msg}` : ""}.`, status);
  }
  return new ClaudeError("provider_error", "Unexpected error while calling Claude.");
}

/** Models that accept output_config.effort. Older models (e.g. Haiku 4.5) reject it. */
export function supportsEffort(model: string): boolean {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|haiku-5|fable|mythos)/.test(model);
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model);
}

export type ClaudeEffort = "low" | "medium" | "high";

export interface ClaudeCallResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * One Messages API call. Thinking is left at the model default (adaptive on
 * current models); `effort` bounds how much it thinks. `max_tokens` leaves room
 * for thinking on top of the expected answer length.
 */
export async function callClaude(params: {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  effort: ClaudeEffort;
}): Promise<ClaudeCallResult> {
  const client = claudeClient(params.apiKey, params.timeoutMs);
  const maxTokens = Math.min(16000, Math.max(4096, params.maxOutputTokens * 4));
  const base = {
    model: params.model,
    max_tokens: maxTokens,
    messages: [{ role: "user" as const, content: params.prompt }],
    ...(supportsEffort(params.model) ? { output_config: { effort: params.effort } } : {}),
  };
  let response: { content: { type: string; text?: string }[]; stop_reason: string | null; model: string; usage?: { input_tokens?: number; output_tokens?: number } };
  try {
    response = supportsServerFallback(params.model)
      ? await client.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(base);
  } catch (error) {
    throw toClaudeError(error, params.model);
  }
  if (response.stop_reason === "refusal") throw new ClaudeError("refused", "Claude declined this request (safety refusal).");
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw response.stop_reason === "max_tokens"
      ? new ClaudeError("truncated", "Claude ran out of output tokens before answering.")
      : new ClaudeError("empty_response", "Claude returned an empty response.");
  }
  return { text, model: response.model || params.model, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
}
