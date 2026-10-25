import { correctLabels } from "@/lib/instagram/ai-core";
import { checkText } from "@/lib/instagram/content-safety";
import { checkDiagram } from "@/lib/instagram/diagram";
import { EXCLUDED_TERMS, stripExcluded, type ExamProfile } from "@/lib/instagram/exam-scope";
import { plainText } from "@/lib/instagram/layout";
import {
  CAPTION_STYLES,
  CAPTION_STYLE_LABELS,
  DIAGRAM_KINDS,
  DIAGRAM_LIMITS,
  LIMITS,
  normalizeDiagram,
  normalizeHashtags,
  type CaptionStyle,
  type CaptionVariant,
  type DiagramKind,
  type DiagramSpec,
  type PostContent,
  type SourceSnapshot,
} from "@/lib/instagram/types";
import { normalizeEquivalent } from "@/lib/instagram/text-normalize";

/**
 * Pure prompt builders + response validators for the AI Studio features that
 * go beyond the original carousel text: medical diagram planning and the
 * three caption versions with keywords/hashtags. Provider calls live in
 * lib/instagram/ai-studio.ts (through the AI Gateway).
 */

export const DIAGRAM_PROMPT_VERSION = "ig-diagram-v1";
export const CAPTION_PROMPT_VERSION = "ig-captions-v1";

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sourceBlock(s: SourceSnapshot, explanation: string): string[] {
  return [
    `Question: ${plainText(s.text)}`,
    ...s.options.map((o) => `${o.label}. ${plainText(o.text)}`),
    `Correct answer (official key): ${correctLabels(s).join(", ")}`,
    explanation ? `Reviewed explanation: ${explanation}` : "",
  ].filter(Boolean);
}

// ---- Diagram ---------------------------------------------------------------------------------

const KIND_GUIDE: Record<DiagramKind, string> = {
  flowchart: `"flowchart": clinical decision/management flow. "nodes" (2–${DIAGRAM_LIMITS.nodes}) with ids, "edges" [{from,to,label?}] flowing top-down, max 3 boxes per level, max 5 levels, no loops.`,
  mechanism: `"mechanism": pharmacology mechanism or physiology/pathophysiology pathway as ordered steps. "nodes" (2–${DIAGRAM_LIMITS.nodes}) in order; no edges.`,
  comparison: `"comparison": side-by-side table. "columns": ["Feature", "<A>", "<B>"(, "<C>")], "rows" (2–${DIAGRAM_LIMITS.rows}) [{label, cells: [one per compared column]}].`,
  ddx: `"ddx": differential diagnosis chart. Same shape as comparison: columns = ["Feature", "<Diagnosis 1>", "<Diagnosis 2>"(, "<Diagnosis 3>")], rows = distinguishing features.`,
  venn: `"venn": 2–3 "sets" [{label, items (≤${DIAGRAM_LIMITS.setItems})}] plus "overlap" (1–${DIAGRAM_LIMITS.setItems} items shared by ALL sets).`,
  hub: `"hub": labelled concept map / schematic (anatomy relations, microbiology features). "nodes": first = central concept, then 2–6 labelled branches (relations, features, branches).`,
};

export function buildDiagramPrompt(params: { snapshot: SourceSnapshot; explanation: string; kind: DiagramKind | "auto"; profile: ExamProfile; instruction?: string }): string {
  const s = params.snapshot;
  const kinds = params.kind === "auto" ? DIAGRAM_KINDS : [params.kind];
  return [
    "You plan ONE medical concept diagram for an Instagram teaching carousel. You do not draw — you return a structured JSON spec; the app draws the boxes, arrows and labels exactly as you write them.",
    `Exam: ${s.examName} (${params.profile.label}). Subject: ${s.subjectName}${s.topicName ? ` / ${s.topicName}` : ""}.`,
    "",
    ...sourceBlock(s, params.explanation),
    "",
    params.kind === "auto" ? "Choose the diagram type that best teaches the concept behind this question:" : "Diagram type:",
    ...kinds.map((k) => `- ${KIND_GUIDE[k]}`),
    "",
    "Rules:",
    `- Short labels: title ≤ ${DIAGRAM_LIMITS.title} chars, box labels ≤ ${DIAGRAM_LIMITS.label}, notes ≤ ${DIAGRAM_LIMITS.note}, table cells ≤ ${DIAGRAM_LIMITS.cell}, Venn items ≤ ${DIAGRAM_LIMITS.item}, footnote ≤ ${DIAGRAM_LIMITS.footnote}.`,
    "- Only standard textbook facts that you are certain about. Never invent findings, values or statistics. Never describe an image, scan, slide or photograph — this is a schematic.",
    "- The diagram must agree with the official answer.",
    "- English only. No years, book titles or page numbers.",
    params.instruction ? `Admin instruction (follow it, write in English): ${params.instruction.trim().slice(0, 400)}` : "",
    "",
    'Return ONLY JSON: {"kind": "...", "title": "...", "nodes": [{"id":"n1","label":"...","note":"optional"}], "edges": [], "columns": [], "rows": [], "sets": [], "overlap": [], "footnote": "optional short note", "confidence": "high|medium|low", "concerns": []}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export type DiagramParse = { ok: true; diagram: DiagramSpec; flags: string[] } | { ok: false; error: string };

export function parseDiagram(text: string, snapshot: SourceSnapshot, kind: DiagramKind | "auto"): DiagramParse {
  const data = extractJson(normalizeEquivalent(text));
  if (!data) return { ok: false, error: "The AI response was not valid JSON." };
  const spec = normalizeDiagram({ ...data, reviewed: false });
  if (!spec) return { ok: false, error: "The AI did not return a supported diagram type." };
  if (kind !== "auto" && spec.kind !== kind) return { ok: false, error: `The AI returned a ${spec.kind} instead of a ${kind}.` };
  const problems = checkDiagram(spec);
  if (problems.length) return { ok: false, error: `The diagram failed validation: ${problems.slice(0, 3).join(" ")}` };
  const ctx = { paperYear: snapshot.paperYear, correctLabels: correctLabels(snapshot), optionLabels: snapshot.options.map((o) => o.label) };
  const all = [spec.title, spec.footnote, ...spec.nodes.flatMap((n) => [n.label, n.note ?? ""]), ...spec.rows.flatMap((r) => [r.label, ...r.cells]), ...spec.sets.flatMap((x) => [x.label, ...x.items]), ...spec.overlap].join("\n");
  const safety = checkText(all, ctx);
  if (safety.length) return { ok: false, error: `The diagram failed the safety checks: ${safety.map((p) => p.message).join(" ")}` };
  if (/\b(histolog|radiograph|x-ray image|ct image|mri image|photomicrograph|biopsy image)\b/i.test(all) && /\bshows?\b/i.test(all)) {
    return { ok: false, error: "The diagram describes a clinical image — only schematics are allowed. Nothing was changed." };
  }
  const confidence = typeof data.confidence === "string" ? data.confidence.toLowerCase() : "unknown";
  const concerns = (Array.isArray(data.concerns) ? data.concerns : []).filter((c): c is string => typeof c === "string").slice(0, 3);
  const flags = confidence === "high" ? concerns : [`Diagram AI confidence is ${confidence}${concerns.length ? `: ${concerns.join("; ")}` : ""}`];
  return { ok: true, diagram: spec, flags };
}

// ---- Captions, keywords, hashtags ---------------------------------------------------------

/** A trend/competitor/performance signal with its source — only real, stored evidence is ever passed in. */
export interface TrendEvidence {
  id: string;
  kind: "OWN_PERFORMANCE" | "PLATFORM" | "REFERENCE";
  summary: string;
  source: string;
  observedAt: string | null;
  quality: "high" | "medium" | "low";
}

export function buildCaptionPrompt(params: { snapshot: SourceSnapshot; content: PostContent; profile: ExamProfile; evidence: TrendEvidence[]; instruction?: string; websiteLabel: string }): string {
  const s = params.snapshot;
  const c = params.content;
  const ev = params.evidence.slice(0, 12);
  return [
    "You write Instagram captions for MockTestSeries.in (medical exam preparation). Write THREE editable caption versions for one carousel.",
    `Exam: ${s.examName} (${params.profile.label}). Subject: ${s.subjectName}${s.topicName ? ` / ${s.topicName}` : ""}.${s.paperYear ? ` Previous year paper: ${s.paperYear}.` : " Not a previous-year question — never call it a PYQ."}`,
    `Exam keywords you may use: ${params.profile.keywords.join(", ")}. Exam hashtags you may use: ${params.profile.hashtags.join(" ")}.`,
    "",
    ...sourceBlock(s, c.explanation),
    c.pearls.length ? `High-yield pearls on the slides: ${c.pearls.join(" | ")}` : "",
    "",
    ev.length
      ? ["Evidence you may use (real, stored data — cite nothing else):", ...ev.map((e) => `- [${e.id}] (${e.kind}, ${e.quality} quality, ${e.source}${e.observedAt ? `, ${e.observedAt.slice(0, 10)}` : ""}) ${e.summary}`)].join("\n")
      : "No trend evidence is available. Do NOT say anything is trending, viral or popular.",
    "",
    "Versions:",
    `1. "professional" — ${CAPTION_STYLE_LABELS.professional}: calm, precise teaching tone.`,
    `2. "hook" — ${CAPTION_STYLE_LABELS.hook}: opens with a short clinical hook or challenge; high engagement, still factual.`,
    `3. "search" — ${CAPTION_STYLE_LABELS.search}: first line and body use the natural search phrases an aspirant would type (exam + topic + "MCQ"/"PYQ"), no stuffing.`,
    "Each caption: strong opening line, short educational description, exam-specific keywords used naturally, ONE engagement question (e.g. \"Comment your answer\"), a save/share line, and a line inviting them to practise at " + params.websiteLabel + ".",
    `Rules: English only; each caption ≤ ${LIMITS.caption} characters, no hashtags inside the caption text; 8–${LIMITS.hashtags} relevant hashtags per version; never copy competitor captions; never say a question is repeated/guaranteed/asked every year; no invented statistics; never mention NEET UG, NCERT, school or board exams; say "trending" only if an evidence line above supports it and name that topic.`,
    `Also return 5–${LIMITS.keywords} "keywords" (search phrases, each ≤ ${LIMITS.keyword} characters) and "evidenceUsed": the evidence ids you relied on.`,
    params.instruction ? `Admin instruction (follow it, write in English): ${params.instruction.trim().slice(0, 400)}` : "",
    "",
    'Return ONLY JSON: {"versions": [{"style":"professional","caption":"...","hashtags":["#..."]},{"style":"hook",...},{"style":"search",...}], "keywords": ["..."], "evidenceUsed": ["..."]}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface CaptionParse {
  variants: CaptionVariant[];
  keywords: string[];
  rejected: { style: CaptionStyle; reason: string }[];
  evidenceUsed: string[];
}

export function parseCaptions(text: string, snapshot: SourceSnapshot, allowedDomains: string[], evidence: TrendEvidence[]): CaptionParse | { error: string } {
  const data = extractJson(text);
  if (!data) return { error: "The AI response was not valid JSON." };
  const ctx = { paperYear: snapshot.paperYear, correctLabels: correctLabels(snapshot), optionLabels: snapshot.options.map((o) => o.label) };
  const out: CaptionParse = { variants: [], keywords: [], rejected: [], evidenceUsed: [] };
  const versions = Array.isArray(data.versions) ? data.versions : [];
  for (const style of CAPTION_STYLES) {
    const v = versions.find((x) => (x as { style?: string })?.style === style) as { caption?: unknown; hashtags?: unknown } | undefined;
    const caption = typeof v?.caption === "string" ? v.caption.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim() : "";
    if (!caption) {
      out.rejected.push({ style, reason: "missing" });
      continue;
    }
    if (caption.length > LIMITS.caption) {
      out.rejected.push({ style, reason: `too long (${caption.length}/${LIMITS.caption})` });
      continue;
    }
    const problems = checkText(caption, ctx, { strictYears: true, allowedDomains });
    if (problems.length) {
      out.rejected.push({ style, reason: problems.map((p) => p.message).join(" ") });
      continue;
    }
    if (EXCLUDED_TERMS.test(caption)) {
      out.rejected.push({ style, reason: "mentions NEET UG / school-level terms" });
      continue;
    }
    if (/\b(trending|viral)\b/i.test(caption) && evidence.length === 0) {
      out.rejected.push({ style, reason: 'claims something is "trending" with no trend evidence' });
      continue;
    }
    const tags = stripExcluded(normalizeHashtags((Array.isArray(v?.hashtags) ? v!.hashtags : []).filter((h): h is string => typeof h === "string")));
    out.variants.push({ style, caption, hashtags: tags });
  }
  out.keywords = stripExcluded(
    (Array.isArray(data.keywords) ? data.keywords : [])
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.replace(/\s+/g, " ").trim())
      .filter((k) => k && k.length <= LIMITS.keyword)
  ).slice(0, LIMITS.keywords);
  const ids = new Set(evidence.map((e) => e.id));
  out.evidenceUsed = (Array.isArray(data.evidenceUsed) ? data.evidenceUsed : []).filter((x): x is string => typeof x === "string" && ids.has(x));
  return out;
}
