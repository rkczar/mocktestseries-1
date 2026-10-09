import "server-only";
import { generateWithAi, type AiGenerationResult } from "@/lib/ai-provider";
import { checkText } from "@/lib/instagram/content-safety";
import { IG_PROMPT_VERSION, buildPrompt, correctLabels, parseAiResponse } from "@/lib/instagram/ai-core";
import type { AiReference } from "@/lib/instagram/snapshot";
import { CONTENT_FIELD_LABELS, LIMITS, type ContentField, type PostContent, type SeriesStats, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Instagram content generation through the platform's single AI entry point
 * (lib/ai-provider.ts — honours Platform Controls' AI pause and the admin's
 * provider settings). The provider call is injectable so tests never need a
 * key. Output is validated (lib/instagram/ai-core.ts) and only ever merged
 * into the post's own content — never into the Question Bank or the student
 * AI explanation cache.
 */

export type Generator = (prompt: string, opts: { temperature: number; maxOutputTokens: number }) => Promise<AiGenerationResult>;

export interface GenerationOutcome {
  content: PostContent;
  changed: ContentField[];
  rejected: { field: ContentField; reason: string }[];
  flags: string[];
  summary: string;
}

export async function generateContent(params: {
  snapshot: SourceSnapshot;
  series: "PYQ" | "MOST_MISSED";
  stats: SeriesStats | null;
  current: PostContent;
  targets: ContentField[];
  instruction?: string;
  reference: AiReference | null;
  allowedDomains: string[];
  generator?: Generator;
}): Promise<GenerationOutcome> {
  const prompt = buildPrompt({
    snapshot: params.snapshot,
    series: params.series,
    stats: params.stats,
    targets: params.targets,
    current: params.current,
    instruction: params.instruction,
    reference: params.reference,
  });
  const gen = params.generator ?? generateWithAi;
  const result = await gen(prompt, { temperature: params.instruction ? 0.6 : 0.5, maxOutputTokens: 2048 });
  const parsed = parseAiResponse(result.text, params.snapshot, params.targets, params.allowedDomains);
  if (parsed.fatal) throw new Error(parsed.fatal);

  const next: PostContent = { ...params.current, ...parsed.patch };
  const changed = Object.keys(parsed.patch) as ContentField[];
  if (parsed.patch.hooks?.length) {
    const prevTexts = params.current.hooks.map((h) => h.text);
    if (!params.current.hookText.trim() || prevTexts.includes(params.current.hookText)) next.hookText = parsed.patch.hooks[0].text;
  }
  if (changed.length) {
    next.origin = { kind: "ai", provider: result.provider, model: result.model, promptVersion: IG_PROMPT_VERSION, generatedAt: new Date().toISOString() };
    next.aiFlags = [...new Set([...(params.targets.length >= 6 ? [] : params.current.aiFlags), ...parsed.flags])].slice(0, 6);
  }
  const summary = changed.length
    ? `Updated ${changed.map((f) => CONTENT_FIELD_LABELS[f]).join(", ")}.${parsed.rejected.length ? ` Rejected: ${parsed.rejected.map((r) => CONTENT_FIELD_LABELS[r.field]).join(", ")}.` : ""}`
    : "The AI output was rejected by the safety checks — nothing changed.";
  return { content: next, changed, rejected: parsed.rejected, flags: parsed.flags, summary };
}

/**
 * Prefill from the question's existing (student-facing) AI explanation —
 * no new AI call. The text still passes the same safety checks and stays
 * flagged as AI content that needs medical review.
 */
export function prefillFromReference(snapshot: SourceSnapshot, current: PostContent, ref: AiReference): { content: PostContent; used: string[]; skipped: string[] } {
  const ctx = { paperYear: snapshot.paperYear, correctLabels: correctLabels(snapshot), optionLabels: snapshot.options.map((o) => o.label) };
  const ok = (t: string | undefined, max: number) => Boolean(t && t.length <= max && checkText(t, ctx).length === 0);
  const next: PostContent = { ...current };
  const used: string[] = [];
  const skipped: string[] = [];
  if (ref.concept) {
    if (ok(ref.concept, LIMITS.explanation)) {
      next.explanation = ref.concept;
      used.push("Explanation");
    } else skipped.push("Explanation");
  }
  if (ref.memoryTrick) {
    if (ok(ref.memoryTrick, LIMITS.memoryTrick)) {
      next.memoryTrick = ref.memoryTrick;
      used.push("Memory Trick");
    } else skipped.push("Memory Trick");
  }
  const points = (ref.pointsToRemember ?? []).filter((p) => ok(p, LIMITS.quickRevisionItem)).slice(0, LIMITS.quickRevisionItems);
  if (points.length) {
    next.quickRevision = points;
    used.push("Quick Revision");
  } else if (ref.pointsToRemember?.length) skipped.push("Quick Revision");
  if (used.length) {
    next.origin = { kind: "existing-explanation", generatedAt: new Date().toISOString() };
    if (!ref.reviewed) next.aiFlags = [...new Set([...current.aiFlags, "Copied from the student AI explanation, which no admin has reviewed yet"])];
  }
  return { content: next, used, skipped };
}
