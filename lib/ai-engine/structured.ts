/**
 * Structured (JSON) output for every AI feature — pure, no provider calls.
 *
 * One reader for model answers that must be a single JSON object:
 *  - accepts surrounding whitespace, a BOM, one ```json fenced block, and short
 *    chatter before/after the object (models add it even in JSON mode);
 *  - finds the object with a structural scan (strings and escapes respected),
 *    never a greedy regular expression, so `{…} text {…}` cannot be glued;
 *  - tells apart an EMPTY answer, an object that was CUT OFF, text that is not
 *    JSON, a classifier verdict that is not an answer at all, and an object
 *    that fails the operation's own schema check.
 *
 * Nothing here repairs or invents content: a failed parse is reported with its
 * category, and the AI Engine moves on to a compatible fallback model
 * (lib/ai-engine/engine.ts). A caller never stores an invalid answer as success.
 */

export type StructuredFailure = "empty_response" | "truncated" | "invalid_json" | "non_answer" | "schema_invalid";

export type ParseOutcome<T> = { ok: true; value: T; wrapped: boolean } | { ok: false; category: StructuredFailure; message: string };

/** Answer validation hook passed with a request: ok, or the failure category and an admin-readable reason. */
export type OutputCheck = (text: string) => { ok: true } | { ok: false; category: StructuredFailure; message: string };

export const STRUCTURED_MESSAGES: Record<StructuredFailure, string> = {
  empty_response: "The model returned an empty answer.",
  truncated: "The model's JSON answer was cut off before it ended.",
  invalid_json: "The model's answer was not valid JSON.",
  non_answer: "The model returned a classification verdict instead of an answer (it is not a text-generation model).",
  schema_invalid: "The model's JSON did not have the required fields.",
};

/** Text that is only a safety/moderation verdict ("User Safety: safe", "Response Safety: unsafe", "safe", "unsafe\nS1"). */
export function isClassifierVerdict(text: string): boolean {
  const t = text.trim();
  if (/^(?:\{\s*")?(?:user|response|prompt)\s+safety"?\s*:/i.test(t)) return true;
  return /^(?:safe|unsafe)(?:\s*\n\s*[A-Z]\d+(?:\s*,\s*[A-Z]\d+)*)?\.?$/i.test(t);
}

function unwrapFence(t: string): { body: string; wrapped: boolean } {
  if (!t.startsWith("```")) return { body: t, wrapped: false };
  const firstNl = t.indexOf("\n");
  if (firstNl < 0) return { body: t.slice(3), wrapped: true };
  const inner = t.slice(firstNl + 1);
  const close = inner.lastIndexOf("```");
  return { body: close >= 0 ? inner.slice(0, close) : inner, wrapped: true };
}

/** Start/end index of the first balanced top-level object from `start`; end = -1 when it never closes. */
function scanObject(t: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Most chatter a model may put around the object before the answer counts as prose, not JSON. */
const MAX_CHATTER = 400;

export function extractJsonObject(raw: string | null | undefined): ParseOutcome<Record<string, unknown>> {
  const fail = (category: StructuredFailure, detail?: string): ParseOutcome<Record<string, unknown>> => ({ ok: false, category, message: detail ? `${STRUCTURED_MESSAGES[category]} ${detail}` : STRUCTURED_MESSAGES[category] });
  const t0 = (raw ?? "").replace(/^﻿/, "").trim();
  if (!t0) return fail("empty_response");
  if (isClassifierVerdict(t0)) return fail("non_answer", `(“${t0.slice(0, 40)}”)`);
  const { body, wrapped: fenced } = unwrapFence(t0);
  const t = body.trim();
  const start = t.indexOf("{");
  if (start < 0) return fail("invalid_json", "It contains no JSON object.");
  if (start > MAX_CHATTER) return fail("invalid_json", "The JSON object is buried in prose.");
  const end = scanObject(t, start);
  if (end < 0) return fail("truncated");
  const trailing = t.slice(end + 1).replace(/```\s*$/, "").trim();
  if (trailing.length > MAX_CHATTER) return fail("invalid_json", "There is long text after the JSON object.");
  let value: unknown;
  try {
    value = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return fail("invalid_json", e instanceof Error ? `(${e.message.slice(0, 80)})` : "");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_json", "The top-level value is not an object.");
  if (Object.keys(value).some((k) => /safety$/i.test(k)) && Object.keys(value).length <= 3) return fail("non_answer");
  return { ok: true, value: value as Record<string, unknown>, wrapped: fenced || start > 0 || trailing.length > 0 };
}

/**
 * Builds the engine's output check from an operation's own validator: the
 * answer must be one JSON object (above) AND pass `validate`, which returns
 * null when the object is acceptable or the reason it is not.
 */
export function jsonCheck(validate: (obj: Record<string, unknown>) => string | null): OutputCheck {
  return (text) => {
    const r = extractJsonObject(text);
    if (!r.ok) return { ok: false, category: r.category, message: r.message };
    const why = validate(r.value);
    return why ? { ok: false, category: "schema_invalid", message: `${STRUCTURED_MESSAGES.schema_invalid} ${why}` } : { ok: true };
  };
}

// ---- Small field checks shared by the operation schemas -----------------------------------------

export function nonEmptyString(v: unknown, max?: number): boolean {
  return typeof v === "string" && v.trim().length > 0 && (max === undefined || v.trim().length <= max);
}

export function stringArray(v: unknown, min = 0, max = Number.POSITIVE_INFINITY): boolean {
  return Array.isArray(v) && v.length >= min && v.length <= max && v.every((x) => typeof x === "string");
}
