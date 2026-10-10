import { checkDiagram } from "@/lib/instagram/diagram";
import { checkTrap } from "@/lib/instagram/trap";
import { stripExcluded } from "@/lib/instagram/exam-scope";
import {
  LIMITS,
  type DiagramSpec,
  type TrapVariant,
  normalizeContent,
  normalizeDesign,
  normalizeHashtags,
  validateModules,
  type PostContent,
  type PostDesign,
} from "@/lib/instagram/types";

/**
 * Server-side validation of content/design arriving from the editor. The
 * client is never trusted: shapes are normalized, every text cap is
 * enforced (rejected, never silently cut), hashtags are normalized, and the
 * slide order must be valid. `origin`/`aiFlags` are kept from the server's
 * copy unless the text actually changed — an admin edit turns the origin to
 * "manual" for the fields they typed, but AI flags stay until the content is
 * regenerated or the admin clears them by reviewing.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const TEXT_FIELDS: { key: "hookText" | "explanation" | "memoryTrick" | "clinicalPearl" | "finalTrick" | "caption"; label: string; max: number }[] = [
  { key: "hookText", label: "Hook", max: LIMITS.hook },
  { key: "explanation", label: "Explanation", max: LIMITS.explanation },
  { key: "memoryTrick", label: "Memory Trick", max: LIMITS.memoryTrick },
  { key: "clinicalPearl", label: "Clinical Pearl", max: LIMITS.clinicalPearl },
  { key: "finalTrick", label: "Final-slide trick", max: LIMITS.finalTrick },
  { key: "caption", label: "Caption", max: LIMITS.caption },
];

const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

export function checkContentInput(raw: unknown, previous: PostContent): Checked<PostContent> {
  const c = normalizeContent(raw);
  for (const f of TEXT_FIELDS) {
    c[f.key] = f.key === "caption" ? clean(c[f.key]) : clean(c[f.key]).replace(/\s+/g, " ");
    if (c[f.key].length > f.max) return { ok: false, error: `${f.label} is too long (${c[f.key].length}/${f.max} characters).` };
  }
  c.hooks = c.hooks.slice(0, 3).map((h) => ({ ...h, text: clean(h.text).replace(/\s+/g, " ") }));
  if (c.hooks.some((h) => h.text.length > LIMITS.hook)) return { ok: false, error: `A hook option is too long (max ${LIMITS.hook} characters).` };
  c.quickRevision = c.quickRevision.map((x) => clean(x).replace(/\s+/g, " ")).filter(Boolean);
  if (c.quickRevision.length > LIMITS.quickRevisionItems) return { ok: false, error: `Quick Revision has at most ${LIMITS.quickRevisionItems} points.` };
  const longPoint = c.quickRevision.find((x) => x.length > LIMITS.quickRevisionItem);
  if (longPoint) return { ok: false, error: `A Quick Revision point is too long (${longPoint.length}/${LIMITS.quickRevisionItem} characters).` };
  c.hashtags = normalizeHashtags(c.hashtags);

  for (const [key, label, maxItems, maxLen] of [
    ["pearls", "High-Yield Pearls", LIMITS.pearls, LIMITS.pearl],
    ["mistakes", "Common Mistakes", LIMITS.mistakes, LIMITS.mistake],
  ] as const) {
    c[key] = c[key].map((x) => clean(x).replace(/\s+/g, " ")).filter(Boolean);
    if (c[key].length > maxItems) return { ok: false, error: `${label}: at most ${maxItems} points.` };
    const long = c[key].find((x) => x.length > maxLen);
    if (long) return { ok: false, error: `A ${label} point is too long (${long.length}/${maxLen} characters).` };
  }
  c.keywords = stripExcluded(c.keywords.map((k) => clean(k).replace(/\s+/g, " ")).filter(Boolean));
  if (c.keywords.length > LIMITS.keywords) return { ok: false, error: `At most ${LIMITS.keywords} keywords.` };
  if (c.keywords.some((k) => k.length > LIMITS.keyword)) return { ok: false, error: `A keyword is longer than ${LIMITS.keyword} characters.` };

  // Diagram: size limits are enforced on save; review state is server-owned and resets on any change.
  if (c.diagram) {
    const sizeErrors = checkDiagram(c.diagram).filter((m) => /too long|At most|more than/.test(m));
    if (sizeErrors.length) return { ok: false, error: `Diagram: ${sizeErrors[0]}` };
    c.diagram = { ...c.diagram, reviewed: Boolean(previous.diagram?.reviewed) && sameDiagram(c.diagram, previous.diagram), origin: previous.diagram?.origin ?? { kind: "manual" } };
  }
  // Trap: approval and automatic checks are server-owned; an edit sends it back to draft.
  if (c.trap) {
    const sizeErrors = checkTrap(c.trap).filter((m) => /too long/.test(m));
    if (sizeErrors.length) return { ok: false, error: `Examiner Trap: ${sizeErrors[0]}` };
    const prev = previous.trap;
    if (!prev) c.trap = { ...c.trap, status: "draft", checks: [{ code: "MANUAL", ok: false, message: "Written by hand — no automatic checks ran." }], origin: { kind: "manual" } };
    else if (sameTrap(c.trap, prev)) c.trap = { ...c.trap, status: prev.status, checks: prev.checks, origin: prev.origin, ...(prev.reviewedAt ? { reviewedAt: prev.reviewedAt } : {}) };
    else {
      const checks = prev.checks.filter((x) => x.code !== "EDITED");
      c.trap = { ...c.trap, status: "draft", checks: [...checks, { code: "EDITED", ok: false, message: "Edited by an admin after the automatic checks — re-verify the answer." }], origin: prev.origin };
    }
  }
  c.captionVariants = previous.captionVariants;

  // Provenance is server-owned: never accept it from the client.
  const textChanged = TEXT_FIELDS.some((f) => f.key !== "caption" && c[f.key] !== previous[f.key]) || c.quickRevision.join("\n") !== previous.quickRevision.join("\n");
  c.origin = textChanged && previous.origin.kind === "empty" ? { kind: "manual" } : previous.origin;
  c.aiFlags = previous.aiFlags;
  return { ok: true, value: c };
}

function diagramKey(d: DiagramSpec) {
  return JSON.stringify({ ...d, reviewed: null, origin: null });
}
function sameDiagram(a: DiagramSpec, b: DiagramSpec | null): boolean {
  return Boolean(b) && diagramKey(a) === diagramKey(b!);
}
function sameTrap(a: TrapVariant, b: TrapVariant): boolean {
  const k = (t: TrapVariant) => JSON.stringify([t.question, t.options, t.correct, t.tempting, t.trapExplanation, t.avoidTip]);
  return k(a) === k(b);
}

export function checkDesignInput(raw: unknown): Checked<PostDesign> {
  const r = (raw ?? {}) as { modules?: unknown };
  if (Array.isArray(r.modules)) {
    const problem = validateModules(r.modules.filter((m): m is string => typeof m === "string"));
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: normalizeDesign(raw) };
}
