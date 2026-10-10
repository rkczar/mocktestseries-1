import "server-only";
import { generateForFeature } from "@/lib/ai-gateway";
import type { AiGenerationResult } from "@/lib/ai-provider";
import type { AiFeature, GatewayProvider } from "@/lib/ai-gateway-config";
import { CAPTION_PROMPT_VERSION, DIAGRAM_PROMPT_VERSION, buildCaptionPrompt, buildDiagramPrompt, parseCaptions, parseDiagram, type TrendEvidence } from "@/lib/instagram/ai-studio-core";
import { examProfile } from "@/lib/instagram/exam-scope";
import { StudioError } from "@/lib/instagram/posts";
import { TRAP_PROMPT_VERSION, buildSolvePrompt, buildTrapPrompt, checkTrap, parseSolve, parseTrap, trapChecks } from "@/lib/instagram/trap";
import type { ContentOrigin, DiagramKind, PostContent, SourceSnapshot, TrapVariant } from "@/lib/instagram/types";

/**
 * AI Studio generation (diagram, examiner trap, caption versions). Every call
 * goes through the AI Gateway with its own feature key, so the admin can route
 * e.g. traps to Claude and captions to Gemini. Results only ever change the
 * post's own content (a new revision) — never the Question Bank or answer key.
 * The provider call is injectable for tests.
 */

export type StudioGenerator = (feature: AiFeature, prompt: string, opts: { temperature: number; maxOutputTokens: number }) => Promise<AiGenerationResult>;

export function gatewayGenerator(ctx: { actorId?: string | null; provider?: GatewayProvider | null }): StudioGenerator {
  return (feature, prompt, opts) => generateForFeature(feature, prompt, opts, { actorId: ctx.actorId, providerOverride: ctx.provider ?? null });
}

const origin = (r: AiGenerationResult, promptVersion: string): ContentOrigin => ({ kind: "ai", provider: r.provider, model: r.model, promptVersion, generatedAt: new Date().toISOString() });

export async function generateDiagram(params: { snapshot: SourceSnapshot; content: PostContent; kind: DiagramKind | "auto"; instruction?: string; gen: StudioGenerator }): Promise<{ content: PostContent; summary: string }> {
  const profile = examProfile(params.snapshot.examName, params.snapshot.examCode);
  const prompt = buildDiagramPrompt({ snapshot: params.snapshot, explanation: params.content.explanation, kind: params.kind, profile, instruction: params.instruction });
  const r = await params.gen("ig_diagram", prompt, { temperature: 0.3, maxOutputTokens: 1800 });
  const parsed = parseDiagram(r.text, params.snapshot, params.kind);
  if (!parsed.ok) throw new StudioError(`${parsed.error} Nothing was changed.`);
  const content: PostContent = {
    ...params.content,
    diagram: { ...parsed.diagram, reviewed: false, origin: origin(r, DIAGRAM_PROMPT_VERSION) },
    aiFlags: [...new Set([...params.content.aiFlags, ...parsed.flags])].slice(0, 8),
  };
  return { content, summary: `Diagram generated (${parsed.diagram.kind}). Check every label, then mark it reviewed.` };
}

export async function generateTrap(params: { snapshot: SourceSnapshot; content: PostContent; instruction?: string; gen: StudioGenerator }): Promise<{ content: PostContent; summary: string }> {
  const s = params.snapshot;
  const profile = examProfile(s.examName, s.examCode);
  const r = await params.gen("ig_trap", buildTrapPrompt({ snapshot: s, explanation: params.content.explanation, profile, instruction: params.instruction }), { temperature: 0.7, maxOutputTokens: 1600 });
  const parsed = parseTrap(r.text);
  if (!parsed.ok) throw new StudioError(`${parsed.error} Nothing was changed.`);
  const structural = checkTrap({ ...parsed.trap, status: "draft", checks: [] });
  if (structural.length) throw new StudioError(`The AI trap question failed validation: ${structural.slice(0, 2).join(" ")} Nothing was changed.`);

  // Independent blind re-solve (no key shown) — a disagreement is flagged, never silently accepted.
  let solve: ReturnType<typeof parseSolve> = null;
  try {
    const sr = await params.gen("ig_trap", buildSolvePrompt(parsed.trap), { temperature: 0, maxOutputTokens: 300 });
    solve = parseSolve(sr.text);
  } catch {
    solve = null;
  }
  const trap: TrapVariant = {
    ...parsed.trap,
    status: "draft",
    checks: trapChecks(parsed.trap, s, params.content.explanation, { confidence: parsed.confidence, concerns: parsed.concerns }, solve),
    origin: origin(r, TRAP_PROMPT_VERSION),
  };
  const failed = trap.checks.filter((c) => !c.ok);
  return {
    content: { ...params.content, trap },
    summary: failed.length ? `Trap question generated — ${failed.length} check(s) need your attention before approval.` : "Trap question generated and passed the automatic checks. Review and approve it.",
  };
}

export async function generateCaptions(params: {
  snapshot: SourceSnapshot;
  content: PostContent;
  evidence: TrendEvidence[];
  allowedDomains: string[];
  websiteLabel: string;
  instruction?: string;
  gen: StudioGenerator;
}): Promise<{ content: PostContent; summary: string; evidenceUsed: string[] }> {
  const profile = examProfile(params.snapshot.examName, params.snapshot.examCode);
  const prompt = buildCaptionPrompt({ snapshot: params.snapshot, content: params.content, profile, evidence: params.evidence, instruction: params.instruction, websiteLabel: params.websiteLabel });
  const r = await params.gen("ig_caption", prompt, { temperature: 0.7, maxOutputTokens: 2600 });
  const parsed = parseCaptions(r.text, params.snapshot, params.allowedDomains, params.evidence);
  if ("error" in parsed) throw new StudioError(`${parsed.error} Nothing was changed.`);
  if (!parsed.variants.length) throw new StudioError(`All three caption versions were rejected (${parsed.rejected.map((x) => `${x.style}: ${x.reason}`).join("; ")}). Nothing was changed.`);
  const next: PostContent = { ...params.content, captionVariants: parsed.variants, keywords: parsed.keywords.length ? parsed.keywords : params.content.keywords };
  // Fill an empty caption with the first version; never overwrite text the admin already has.
  if (!next.caption.trim()) {
    next.caption = parsed.variants[0].caption;
    next.hashtags = parsed.variants[0].hashtags;
    next.captionStyle = parsed.variants[0].style;
  }
  const summary = `${parsed.variants.length} caption version(s) ready${parsed.rejected.length ? ` (rejected: ${parsed.rejected.map((x) => `${x.style} — ${x.reason}`).join("; ")})` : ""}. ${
    parsed.evidenceUsed.length ? `Used ${parsed.evidenceUsed.length} evidence item(s).` : params.evidence.length ? "No trend evidence was cited." : "No trend evidence exists yet, so no trend claims were made."
  }`;
  return { content: next, summary, evidenceUsed: parsed.evidenceUsed };
}

export { CAPTION_PROMPT_VERSION };
