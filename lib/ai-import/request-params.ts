/**
 * Provider-specific request parameters for importer calls — pure functions (no server imports), tested in
 * scripts/verify-ai-import-request-params.ts.
 *
 * Reasoning: every model publishes whether its reasoning can be switched off ("mandatory") and which effort levels it
 * accepts (OpenRouter `reasoning`, stored as AiModel.reasoning by the catalog sync). 2026-11-11: the importer always
 * sent effort "none"; Gemini 4 and Claude Opus 5.5 refuse that ("Reasoning is mandatory"), so no page could be read
 * with them. The effort sent is now the lowest one every model of the request accepts, never one it does not list.
 *
 * Structured output: Anthropic refuses a JSON Schema with more than 16 union-typed parameters (type arrays / anyOf);
 * the extract schema had 20 (production) / 21 (bilingual). The schema is checked before it is sent.
 */

export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

/** The published reasoning block of one model; null = not published / catalog not synced since the column existed. */
export interface ReasoningMeta {
  mandatory?: boolean;
  supported_efforts?: string[];
  default_effort?: string;
}

export function asReasoningMeta(v: unknown): ReasoningMeta | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return {
    mandatory: r.mandatory === true,
    ...(Array.isArray(r.supported_efforts) ? { supported_efforts: r.supported_efforts.filter((e): e is string => typeof e === "string") } : {}),
    ...(typeof r.default_effort === "string" ? { default_effort: r.default_effort } : {}),
  };
}

/** Efforts one model accepts: its published list; "everything" when unknown (legacy behaviour), minus "none" when mandatory. */
function accepted(meta: ReasoningMeta | null): Set<Effort> | "unknown" {
  if (!meta) return "unknown";
  const list = meta.supported_efforts?.length ? EFFORT_ORDER.filter((e) => meta.supported_efforts!.includes(e)) : null;
  if (list) return new Set(list.filter((e) => !(meta.mandatory && e === "none")));
  return "unknown";
}

/**
 * The `reasoning` request parameter for the models of one request (requested + OpenRouter fallbacks), or null when
 * none of them takes the parameter. `wanted` is the importer's choice: "none" (reading / structuring) or "low"
 * (an answer opinion). Rule: the lowest effort ≥ wanted that EVERY model with a published list accepts; when no
 * effort ≥ wanted is common, the highest common one below it; a mandatory model is never sent "none". A mandatory
 * model without a published list gets no effort word at all (its provider default, bounded by max_tokens).
 */
export function reasoningParam(metas: (ReasoningMeta | null)[], wanted: "none" | "low"): { effort?: Effort; exclude: true } | null {
  if (!metas.length) return null;
  const sets = metas.map(accepted);
  const mandatoryUnknownList = metas.some((m) => m?.mandatory && !m.supported_efforts?.length);
  let common: Effort[] = [...EFFORT_ORDER];
  for (const s of sets) if (s !== "unknown") common = common.filter((e) => s.has(e));
  if (mandatoryUnknownList) common = common.filter((e) => e !== "none");
  const w = EFFORT_ORDER.indexOf(wanted);
  const up = common.find((e) => EFFORT_ORDER.indexOf(e) >= w);
  const down = [...common].reverse().find((e) => EFFORT_ORDER.indexOf(e) < w);
  const effort = up ?? down;
  if (!effort) return mandatoryUnknownList || metas.some((m) => m?.mandatory) ? { exclude: true } : null;
  if (mandatoryUnknownList && sets.every((s) => s === "unknown")) return { exclude: true };
  return { effort, exclude: true };
}

/** Number of parameters with a type array or anyOf/oneOf in a JSON Schema (Anthropic's structured-output limit is 16). */
export function unionParameterCount(schema: unknown): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (Array.isArray(o.type) || "anyOf" in o || "oneOf" in o) n++;
    Object.values(o).forEach(walk);
  };
  walk(schema);
  return n;
}
export const ANTHROPIC_UNION_LIMIT = 16;

/**
 * Checks a request against what the models publish BEFORE it is sent (nothing is sent on a problem). Returns the
 * problem in plain words, or null.
 */
export function requestProblem(req: { models: { id: string; reasoning: ReasoningMeta | null; supportedParameters: string[] }[]; reasoning: { effort?: string } | null; schema: unknown | null }): string | null {
  // At least one model of the request must take the parameter (OpenRouter's require_parameters drops the routes of the
  // others, e.g. a requested model without reasoning whose fallback has it — 2026-10-25 behaviour, kept).
  if (req.reasoning && req.models.length && !req.models.some((m) => m.supportedParameters.includes("reasoning"))) return `${req.models.map((m) => m.id).join(", ")} do${req.models.length === 1 ? "es" : ""} not accept a reasoning parameter`;
  for (const m of req.models) {
    if (req.reasoning) {
      const e = req.reasoning.effort;
      if (e !== undefined) {
        if (m.reasoning?.mandatory && e === "none") return `${m.id} cannot switch reasoning off (mandatory)`;
        const list = m.reasoning?.supported_efforts;
        if (list?.length && !list.includes(e)) return `${m.id} does not accept reasoning effort "${e}" (accepts ${list.join(", ")})`;
      }
    }
    if (req.schema && m.id.startsWith("anthropic/")) {
      const n = unionParameterCount(req.schema);
      if (n > ANTHROPIC_UNION_LIMIT) return `the answer schema has ${n} union-typed parameters; ${m.id} accepts at most ${ANTHROPIC_UNION_LIMIT}`;
    }
  }
  return null;
}
