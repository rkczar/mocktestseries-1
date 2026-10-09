import {
  LIMITS,
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

  // Provenance is server-owned: never accept it from the client.
  const textChanged = TEXT_FIELDS.some((f) => f.key !== "caption" && c[f.key] !== previous[f.key]) || c.quickRevision.join("\n") !== previous.quickRevision.join("\n");
  c.origin = textChanged && previous.origin.kind === "empty" ? { kind: "manual" } : previous.origin;
  c.aiFlags = previous.aiFlags;
  return { ok: true, value: c };
}

export function checkDesignInput(raw: unknown): Checked<PostDesign> {
  const r = (raw ?? {}) as { modules?: unknown };
  if (Array.isArray(r.modules)) {
    const problem = validateModules(r.modules.filter((m): m is string => typeof m === "string"));
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, value: normalizeDesign(raw) };
}
