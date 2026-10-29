/**
 * Normalized AI error codes — shared, client-safe.
 *
 * AiGatewayCall.errorCategory keeps the provider adapter's lowercase category
 * (existing rows stay readable); admin pages and job records show the
 * normalized code below, so one vocabulary covers the AI call, the output
 * check and the later stages (image, render, publish).
 */

export const AI_ERROR_CODES = [
  "PROVIDER_AUTH_ERROR",
  "PROVIDER_CREDITS_EXHAUSTED",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_MODERATION",
  "PROVIDER_ERROR",
  "PROVIDER_DISABLED",
  "NETWORK_ERROR",
  "MODEL_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "INVALID_REQUEST",
  "EMPTY_RESPONSE",
  "TRUNCATED_OUTPUT",
  "INVALID_JSON",
  "NON_ANSWER_MODEL",
  "SCHEMA_VALIDATION_FAILED",
  "NOT_CONFIGURED",
  "VISION_INPUT_ERROR",
  "OCR_EXTRACTION_FAILED",
  "ASSET_GENERATION_FAILED",
  "RENDERING_FAILED",
  "PUBLISHING_FAILED",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

const MAP: Record<string, AiErrorCode> = {
  auth_invalid: "PROVIDER_AUTH_ERROR",
  insufficient_credits: "PROVIDER_CREDITS_EXHAUSTED",
  quota_exhausted: "PROVIDER_CREDITS_EXHAUSTED",
  rate_limited: "PROVIDER_RATE_LIMIT",
  moderation: "PROVIDER_MODERATION",
  provider_error: "PROVIDER_ERROR",
  legacy_disabled: "PROVIDER_DISABLED",
  network: "NETWORK_ERROR",
  model_unavailable: "MODEL_UNAVAILABLE",
  no_endpoint: "MODEL_UNAVAILABLE",
  route_unavailable: "MODEL_UNAVAILABLE",
  timeout: "REQUEST_TIMEOUT",
  deadline: "REQUEST_TIMEOUT",
  bad_request: "INVALID_REQUEST",
  empty_response: "EMPTY_RESPONSE",
  truncated: "TRUNCATED_OUTPUT",
  malformed_response: "INVALID_JSON",
  invalid_json: "INVALID_JSON",
  non_answer: "NON_ANSWER_MODEL",
  schema_invalid: "SCHEMA_VALIDATION_FAILED",
  model_output: "SCHEMA_VALIDATION_FAILED",
  not_configured: "NOT_CONFIGURED",
};

/** Normalized code for a stored category; null when there was no error. Unknown categories → PROVIDER_ERROR. */
export function aiErrorCode(category: string | null | undefined): AiErrorCode | null {
  if (!category) return null;
  if ((AI_ERROR_CODES as readonly string[]).includes(category)) return category as AiErrorCode;
  return MAP[category] ?? "PROVIDER_ERROR";
}

/** True when the failure is in the model's ANSWER (the call itself worked): a different model may succeed. */
export function isOutputFailure(category: string | null | undefined): boolean {
  return ["empty_response", "truncated", "invalid_json", "non_answer", "schema_invalid"].includes(category ?? "");
}
