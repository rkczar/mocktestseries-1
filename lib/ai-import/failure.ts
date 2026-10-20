/**
 * Why an importer AI request (or a page / answer-key reading built on it)
 * failed, in words an administrator can act on. Client-safe and pure: the
 * worker stores `failureMessage(kind, detail)` as the page / file error, and
 * the job screens group failures by `failureKindOf(errorMessage)`.
 */
import type { OpenRouterErrorCategory } from "@/lib/ai-engine/openrouter";

export const FAILURE_KINDS = ["rate_limited", "route_unavailable", "bad_request", "image_unsupported", "budget", "model_output", "provider", "paid_ai_off"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Stable message prefix per kind (also how a stored message is classified again). */
export const FAILURE_LABELS: Record<FailureKind, string> = {
  rate_limited: "Rate limited by the provider",
  route_unavailable: "Provider route unavailable",
  bad_request: "Invalid request",
  image_unsupported: "Image input not supported",
  budget: "Cost or credit limit",
  model_output: "Model output failure",
  provider: "Provider error",
  paid_ai_off: "Paid AI is off",
};

export const FAILURE_ADVICE: Record<FailureKind, string> = {
  rate_limited: "The provider refused the request for now (HTTP 429). Models with a published price of ₹0 share tight provider limits. Wait a few minutes, then use Retry — finished pages are not read or charged again.",
  route_unavailable: "No provider route can serve this model under the privacy and price settings right now. Refresh provider routes in Import Settings or choose another importer model, then use Retry.",
  bad_request: "The provider rejected the request parameters. Check the model in Import Settings (Test Models), then use Retry.",
  image_unsupported: "The model or its route does not accept page images. Choose a model that reads images (Import Settings → Model Assistant), then use Retry.",
  budget: "The OpenRouter credit or key spending limit, the per-request limit, or the amount kept for student Ask AI stopped the request. Check the key's credit at OpenRouter and the AI Cost Center, then use Retry — finished pages are not read or charged again.",
  model_output: "The model answered, but not in the expected format (empty, cut off or malformed). Use Retry once; if it repeats, choose another model for this task.",
  provider: "The provider failed or timed out. Use Retry once; if it repeats, check the provider status.",
  paid_ai_off: "Paid AI was switched off in Import Settings, so no further AI request was sent. Switch it on and use Retry to continue.",
};

/** Kind of an OpenRouter error category (null = not an OpenRouter failure). */
export function kindOfCategory(c: OpenRouterErrorCategory, message = ""): FailureKind {
  switch (c) {
    case "rate_limited":
      return "rate_limited";
    case "no_endpoint":
      return /image/i.test(message) ? "image_unsupported" : "route_unavailable";
    case "model_unavailable":
      return "route_unavailable";
    case "bad_request":
      return /image|vision|multimodal/i.test(message) ? "image_unsupported" : "bad_request";
    case "empty_response":
    case "truncated":
      return "model_output";
    case "insufficient_credits":
      return "budget";
    default:
      return "provider";
  }
}

export function failureMessage(kind: FailureKind, detail: string): string {
  const d = detail.trim();
  return `${FAILURE_LABELS[kind]}: ${d}${/[.!?)]$/.test(d) ? "" : "."}`;
}

/** Classifies a stored page / file error message (null = no recognizable kind, e.g. an older message). */
export function failureKindOf(message: string | null | undefined): FailureKind | null {
  if (!message) return null;
  for (const k of FAILURE_KINDS) if (message.startsWith(`${FAILURE_LABELS[k]}:`)) return k;
  // Messages written before these labels existed.
  if (/rate-limited the request/i.test(message)) return "rate_limited";
  return null;
}

/** "32 rate limited by the provider, 1 model output failure" (largest group first). */
export function summarizeFailures(messages: (string | null)[]): { text: string; kinds: Partial<Record<FailureKind | "other", number>> } {
  const kinds: Partial<Record<FailureKind | "other", number>> = {};
  for (const m of messages) {
    const k = failureKindOf(m) ?? "other";
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  const text = Object.entries(kinds)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `${n} ${k === "other" ? "other error" : FAILURE_LABELS[k as FailureKind].toLowerCase()}`)
    .join(", ");
  return { text, kinds };
}
