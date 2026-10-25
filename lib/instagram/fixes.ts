import { planSlides } from "@/lib/instagram/layout";
import { targetFields } from "@/lib/instagram/instructions";
import type { QualityIssue } from "@/lib/instagram/quality";
import type { NormalizeResult } from "@/lib/instagram/text-normalize";
import { MODULE_LABELS, type ContentField, type PostContent, type PostDesign, type SlideModule, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Checks-tab advice + the deterministic part of "Fix This Error" / "Master
 * Fix" (pure; the server wrapper is lib/instagram/repair.ts).
 *
 * Every quality issue gets ONE category and a next action:
 *   A "auto"     — a deterministic, previewed repair of the post's OWN data
 *                  (no AI call): unsupported characters with a
 *                  meaning-preserving replacement, picking an existing hook,
 *                  a smaller text size that makes a slide fit.
 *   B "admin"    — needs the administrator: a printed question number, the
 *                  Question Bank, Settings, a rewrite (optionally "Generate
 *                  with AI" for that one section).
 *   C "medical"  — needs medical review; never auto-resolved.
 *   D "provider" — an AI provider failure (reported by the AI actions, not
 *                  by the gate) with a safe retry.
 * Nothing here ever changes the Question Bank (question, options, answer
 * key, difficulty, taxonomy, paper): Question Bank issues are only reported.
 */

export type IssueCategory = "auto" | "admin" | "medical" | "provider";

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  auto: "Can be fixed automatically",
  admin: "Needs your input",
  medical: "Needs medical review",
  provider: "AI provider problem",
};

/** A section the "Generate with AI" button regenerates (only that section). */
export interface AiTarget {
  kind: "content" | "trap" | "diagram";
  fields: ContentField[];
  label: string;
  instruction?: string;
}

export type IssueAction =
  | { kind: "fix"; label: string }
  | { kind: "question-number" }
  | { kind: "medical-review" }
  | { kind: "refresh-snapshot" }
  | { kind: "tab"; tab: "content" | "design" | "studio"; label: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "none" };

export interface IssueAdvice {
  code: string;
  category: IssueCategory;
  action: IssueAction;
  ai: AiTarget | null;
  /** One sentence: what happens next / what the admin should do. */
  next: string;
}

/** Gate field names (quality.ts `fields` / `drawn`) → the content they come from. */
const DRAWN_FIELDS = ["Hook", "Explanation", "Memory Trick", "Clinical Pearl", "Quick Revision", "High-Yield Pearls", "Common Mistakes", "Diagram", "Final trick", "Medical image", "Examiner Trap"] as const;
type DrawnField = (typeof DRAWN_FIELDS)[number];

const AI_FOR_FIELD: Partial<Record<DrawnField | "Caption", AiTarget>> = {
  Hook: { kind: "content", fields: ["hooks"], label: "hook" },
  Explanation: { kind: "content", fields: ["explanation"], label: "explanation" },
  "Memory Trick": { kind: "content", fields: ["memoryTrick"], label: "memory trick" },
  "Clinical Pearl": { kind: "content", fields: ["clinicalPearl"], label: "clinical pearl" },
  "Quick Revision": { kind: "content", fields: ["quickRevision"], label: "Quick Revision" },
  "High-Yield Pearls": { kind: "content", fields: ["pearls"], label: "high-yield pearls" },
  "Common Mistakes": { kind: "content", fields: ["mistakes"], label: "common mistakes" },
  "Final trick": { kind: "content", fields: ["finalTrick"], label: "final trick" },
  Diagram: { kind: "diagram", fields: [], label: "diagram" },
  "Examiner Trap": { kind: "trap", fields: [], label: "Examiner Trap" },
  Caption: { kind: "content", fields: ["caption", "hashtags"], label: "caption and hashtags" },
};

/** Applies `fn` to every string of one drawn field (lists item by item). */
export function mapDrawnField(c: PostContent, field: DrawnField, fn: (t: string) => string): PostContent {
  const n: PostContent = { ...c };
  switch (field) {
    case "Hook":
      n.hookText = fn(c.hookText);
      n.hooks = c.hooks.map((h) => (h.text === c.hookText ? { ...h, text: n.hookText } : h));
      break;
    case "Explanation":
      n.explanation = fn(c.explanation);
      break;
    case "Memory Trick":
      n.memoryTrick = fn(c.memoryTrick);
      break;
    case "Clinical Pearl":
      n.clinicalPearl = fn(c.clinicalPearl);
      break;
    case "Quick Revision":
      n.quickRevision = c.quickRevision.map(fn);
      break;
    case "High-Yield Pearls":
      n.pearls = c.pearls.map(fn);
      break;
    case "Common Mistakes":
      n.mistakes = c.mistakes.map(fn);
      break;
    case "Final trick":
      n.finalTrick = fn(c.finalTrick);
      break;
    case "Medical image":
      if (c.medicalImage) n.medicalImage = { ...c.medicalImage, title: fn(c.medicalImage.title), memoryTip: fn(c.medicalImage.memoryTip) };
      break;
    case "Diagram":
      if (c.diagram) {
        const d = c.diagram;
        n.diagram = {
          ...d,
          title: fn(d.title),
          footnote: fn(d.footnote),
          nodes: d.nodes.map((x) => ({ ...x, label: fn(x.label), ...(x.note !== undefined ? { note: fn(x.note) } : {}) })),
          edges: d.edges.map((e) => ({ ...e, ...(e.label !== undefined ? { label: fn(e.label) } : {}) })),
          columns: d.columns.map(fn),
          rows: d.rows.map((r) => ({ label: fn(r.label), cells: r.cells.map(fn) })),
          sets: d.sets.map((x) => ({ label: fn(x.label), items: x.items.map(fn) })),
          overlap: d.overlap.map(fn),
        };
      }
      break;
    case "Examiner Trap":
      if (c.trap) {
        const t = c.trap;
        n.trap = { ...t, question: fn(t.question), options: t.options.map((o) => ({ ...o, text: fn(o.text) })), trapExplanation: fn(t.trapExplanation), avoidTip: fn(t.avoidTip) };
      }
      break;
  }
  return n;
}

/** The strings of a drawn field (for previews). */
export function drawnStrings(c: PostContent, field: DrawnField): string[] {
  const out: string[] = [];
  mapDrawnField(c, field, (t) => {
    out.push(t);
    return t;
  });
  return out;
}

export type Normalizer = (text: string, contextual: boolean) => NormalizeResult;

export interface FixContext {
  snapshot: SourceSnapshot;
  content: PostContent;
  design: PostDesign;
  series: "PYQ" | "MOST_MISSED";
  normalize: Normalizer;
  questionEditHref: string;
}

const MIN_SCALE = 0.85;

/** The smallest text-size step (down to the 0.85 minimum) that makes slide `index` fit, or null. */
function fittingScale(ctx: FixContext, index: number): { key: "questionScale" | "bodyScale"; value: number } | null {
  const mod = ctx.design.modules[index];
  const key = mod === "QUESTION" ? "questionScale" : "bodyScale";
  for (let v = Math.round((ctx.design[key] - 0.05) * 100) / 100; v >= MIN_SCALE - 1e-9; v = Math.round((v - 0.05) * 100) / 100) {
    const design = { ...ctx.design, [key]: v };
    const plans = planSlides(ctx.snapshot, ctx.content, design, ctx.series === "MOST_MISSED" ? 2 : 1);
    // The smaller size must fix this slide without making another slide overflow.
    const before = planSlides(ctx.snapshot, ctx.content, ctx.design, ctx.series === "MOST_MISSED" ? 2 : 1);
    if (!plans[index].overflow && plans.every((p, i) => !p.overflow || before[i].overflow)) return { key, value: v };
  }
  return null;
}

const QB = (ctx: FixContext, next: string): Pick<IssueAdvice, "category" | "action" | "ai" | "next"> => ({
  category: "admin",
  action: { kind: "link", href: ctx.questionEditHref, label: "Open in Question Bank" },
  ai: null,
  next,
});

export function adviseIssue(issue: QualityIssue, ctx: FixContext): IssueAdvice {
  const code = issue.code;
  const [head, arg] = code.split(":");
  const base = (a: Pick<IssueAdvice, "category" | "action" | "ai" | "next">): IssueAdvice => ({ code, ...a });

  if (head === "GLYPHS") {
    if (arg === "Question" || (arg ?? "").startsWith("Option ")) return base(QB(ctx, "The question text comes from the Question Bank: fix the character there, then Refresh snapshot."));
    if (arg === "Follow slide settings") return base({ category: "admin", action: { kind: "link", href: "/admin/instagram/settings", label: "Open Settings" }, ai: null, next: "Replace the character in Instagram → Settings." });
    const field = arg as DrawnField;
    const remaining = new Set(drawnStrings(ctx.content, field).flatMap((t) => ctx.normalize(t, true).remaining));
    const ai = AI_FOR_FIELD[field] ?? null;
    if (!remaining.size) return base({ category: "auto", action: { kind: "fix", label: "Fix This Error" }, ai, next: "Each character is replaced by a drawable one with the same meaning (preview first)." });
    return base({ category: "admin", action: { kind: "tab", tab: "content", label: "Edit text" }, ai, next: `${[...remaining].join(" ")} has no safe automatic replacement — rewrite it, or regenerate this section with AI.` });
  }
  if (head === "QB_DIFFICULTY_LEGACY" || head === "QB_DIFFICULTY_UNKNOWN") {
    // Instagram Studio never writes to the Question Bank: this is reported, never "fixed" here.
    return base({ category: "admin", action: { kind: "link", href: ctx.questionEditHref, label: "View in Question Bank" }, ai: null, next: "A Question Bank data issue — Instagram Studio does not change it. It does not block publishing and does not affect the slides." });
  }
  if (head === "SLIDE_MISSING") {
    const index = Number(arg);
    const mod = ctx.design.modules[index] as SlideModule | undefined;
    if (mod === "HOOK" && ctx.content.hooks.length) return base({ category: "auto", action: { kind: "fix", label: "Fix This Error" }, ai: AI_FOR_FIELD.Hook!, next: "Uses the first AI hook option already on this post (no new AI call)." });
    if (mod === "DIAGRAM" || mod === "TRAP" || mod === "MEDICAL_IMAGE") {
      return base({ category: "admin", action: { kind: "tab", tab: "studio", label: "Open Diagram & Trap" }, ai: mod === "DIAGRAM" ? AI_FOR_FIELD.Diagram! : mod === "TRAP" ? AI_FOR_FIELD["Examiner Trap"]! : null, next: `Add the ${MODULE_LABELS[mod]} or remove that slide in Design.` });
    }
    const fields = mod ? targetFields("", mod) : [];
    return base({ category: "admin", action: { kind: "tab", tab: "content", label: "Write it" }, ai: fields.length ? { kind: "content", fields, label: `${mod ? MODULE_LABELS[mod] : "slide"} text` } : null, next: "Write the missing text, or generate only this slide's text with AI." });
  }
  if (head === "SLIDE_OVERFLOW") {
    const index = Number(arg);
    const mod = ctx.design.modules[index] as SlideModule | undefined;
    const fit = fittingScale(ctx, index);
    const fields = mod ? targetFields("", mod).filter((f) => f !== "hashtags" && f !== "caption") : [];
    const ai: AiTarget | null = fields.length ? { kind: "content", fields, label: `shorter ${mod ? MODULE_LABELS[mod] : "slide"} text`, instruction: "Shorten this so it fits on one Instagram slide. Keep every medical fact, the same meaning and the same answer." } : null;
    if (fit) return base({ category: "auto", action: { kind: "fix", label: "Fix This Error" }, ai, next: `A text size of ×${fit.value.toFixed(2)} makes it fit (still phone-readable).` });
    return base({ category: "admin", action: { kind: "tab", tab: "content", label: "Shorten text" }, ai, next: mod === "QUESTION" ? "The question can't be shortened here — remove the Hook headline or use fewer options on this slide." : "Shorten the text, or let AI write a shorter version of only this slide." });
  }
  if (head === "CAPTION_EMPTY" || head === "CAPTION_OUT_OF_SCOPE" || head === "CAPTION_TREND_CLAIM") {
    return base({ category: "admin", action: { kind: "tab", tab: "content", label: "Edit caption" }, ai: { ...AI_FOR_FIELD.Caption!, ...(head !== "CAPTION_EMPTY" ? { instruction: `Rewrite to fix: ${issue.message}` } : {}) }, next: head === "CAPTION_EMPTY" ? "Write a caption, or generate one with AI." : "Rewrite the caption/hashtags, or regenerate them with AI." });
  }
  if (head === "SAFETY") {
    const field = (arg === "Examiner Trap" ? "Examiner Trap" : arg) as DrawnField | "Caption";
    const ai = AI_FOR_FIELD[field] ?? null;
    return base({ category: "admin", action: { kind: "tab", tab: field === "Examiner Trap" || field === "Diagram" ? "studio" : "content", label: "Edit text" }, ai: ai ? { ...ai, instruction: `Rewrite to fix this problem: ${issue.message}` } : null, next: "Content rules can't be fixed automatically — rewrite it, or regenerate only this section with AI." });
  }
  if (head === "TRAP_INVALID" || head === "TRAP_REJECTED" || head === "TRAP_LONG") {
    return base({ category: "admin", action: { kind: "tab", tab: "studio", label: "Open Diagram & Trap" }, ai: AI_FOR_FIELD["Examiner Trap"]!, next: head === "TRAP_LONG" ? "Long traps continue on the next slide automatically; shorten it if you prefer." : "Rework the Examiner Trap question, or remove the trap slide." });
  }
  if (head === "TRAP_CONTINUED") return base({ category: "admin", action: { kind: "none" }, ai: null, next: "Nothing is cut — just check the continuation slide in the preview." });
  if (head === "DIAGRAM_INVALID" || head === "DIAGRAM_OVERFLOW") {
    return base({ category: "admin", action: { kind: "tab", tab: "studio", label: "Open Diagram & Trap" }, ai: AI_FOR_FIELD.Diagram!, next: "Shorten the labels, or regenerate the diagram." });
  }
  if (head === "CAROUSEL_TOO_LONG") return base({ category: "admin", action: { kind: "tab", tab: "design", label: "Open Design" }, ai: null, next: "Remove a slide in Design." });
  if (head === "QUESTION_NUMBER_MISSING" || head === "QUESTION_NUMBER_UNVERIFIED") {
    return base({ category: "admin", action: { kind: "question-number" }, ai: null, next: "Optional — no template requires it. Enter the number printed on the original paper and tick Verified to show it; the stored order is never used." });
  }
  if (head === "SOURCE_CHANGED") return base({ category: "admin", action: { kind: "refresh-snapshot" }, ai: null, next: "Refresh the snapshot, then check the slides still match the edited question." });
  if (head === "FOLLOW_NO_INSTAGRAM" || head === "FOLLOW_NO_TELEGRAM") return base({ category: "admin", action: { kind: "link", href: "/admin/instagram/settings", label: "Open Settings" }, ai: null, next: "Configure it in Instagram → Settings." });
  if (head === "STATS_MISSING" || head === "STATS_SMALL_SAMPLE") return base({ category: "admin", action: { kind: "none" }, ai: null, next: "Information only — decide whether the percentage is worth posting." });
  if (head === "AI_FLAG") return base({ category: "medical", action: { kind: "medical-review" }, ai: null, next: "A medical reviewer decides: correct as written, correct in this exam context, or corrected. The note never resolves on its own." });
  if (head === "AI_CONTENT" || head === "AI_STALE" || head === "DIAGRAM_UNREVIEWED" || head === "TRAP_UNAPPROVED" || head === "TRAP_CHECK" || head === "MEDICAL_IMAGE_REVIEW") {
    return base({ category: "medical", action: { kind: "medical-review" }, ai: null, next: "Check every medical statement against a standard reference, then record the medical review." });
  }
  // Question Bank / scope / question-shape issues: only the Question Bank can change them.
  return base(QB(ctx, "This comes from the question itself — fix it in the Question Bank (Instagram Studio never edits questions)."));
}

// ---- Deterministic repair plan ---------------------------------------------------------

export interface FixChange {
  /** The issue codes this change addresses. */
  codes: string[];
  /** Root-cause group shown in the preview. */
  group: string;
  target: string;
  before: string;
  after: string;
  /** Equivalent = looks the same; contextual/content changes are listed for review. */
  kind: "characters" | "characters-contextual" | "hook" | "text-size";
}

export interface FixPlan {
  content: PostContent;
  design: PostDesign;
  changes: FixChange[];
}

/**
 * Builds the deterministic plan for `codes` (one issue = Fix This Error; all
 * repairable issues = Master Fix). Character fixes are grouped per field,
 * text-size fixes per slide. `cleanStored` also stores the drawable twin of
 * "equivalent" characters the renderer already substitutes (housekeeping in
 * Master Fix — it never changes what a slide shows).
 */
export function planFixes(issues: QualityIssue[], ctx: FixContext, codes: string[] | "all", cleanStored = codes === "all"): FixPlan {
  const wanted = issues.filter((i) => (codes === "all" || codes.includes(i.code)) && adviseIssue(i, ctx).category === "auto");
  let content = ctx.content;
  let design = ctx.design;
  const changes: FixChange[] = [];
  const fieldsDone = new Set<string>();

  const normalizeField = (field: DrawnField, contextual: boolean, issueCode: string | null) => {
    const before = drawnStrings(content, field);
    let replaced = false;
    const next = mapDrawnField(content, field, (t) => {
      const r = ctx.normalize(t, contextual);
      if (r.replacements.length) replaced = true;
      return r.text;
    });
    if (!replaced) return;
    const after = drawnStrings(next, field);
    const reps = before.flatMap((t) => ctx.normalize(t, contextual).replacements);
    const contextualUsed = reps.some((r) => r.cls === "contextual");
    changes.push({
      codes: issueCode ? [issueCode] : [],
      group: contextualUsed ? "Unsupported characters (notation changes — check the wording)" : "Unsupported characters (look the same after the fix)",
      target: field,
      before: before.filter((t, i) => t !== after[i]).join("\n"),
      after: after.filter((t, i) => t !== before[i]).join("\n"),
      kind: contextualUsed ? "characters-contextual" : "characters",
    });
    content = next;
    fieldsDone.add(field);
  };

  for (const issue of wanted) {
    const [head, arg] = issue.code.split(":");
    if (head === "GLYPHS") normalizeField(arg as DrawnField, true, issue.code);
    else if (head === "SLIDE_MISSING" && content.hooks.length && ctx.design.modules[Number(arg)] === "HOOK") {
      const before = content.hookText;
      content = { ...content, hookText: content.hooks[0].text };
      changes.push({ codes: [issue.code], group: "Missing slide text", target: "Hook", before, after: content.hookText, kind: "hook" });
    } else if (head === "SLIDE_OVERFLOW") {
      const fit = fittingScale({ ...ctx, content, design }, Number(arg));
      if (fit && fit.value < design[fit.key]) {
        const before = design[fit.key];
        design = { ...design, [fit.key]: fit.value };
        changes.push({ codes: [issue.code], group: "Text too long for the slide", target: `${fit.key === "questionScale" ? "Question" : "Other slides"} text size`, before: `×${before.toFixed(2)}`, after: `×${fit.value.toFixed(2)}`, kind: "text-size" });
      }
    }
  }
  if (cleanStored) for (const f of DRAWN_FIELDS) if (!fieldsDone.has(f)) normalizeField(f, false, null);
  return { content, design, changes };
}

// ---- Passed checks ----------------------------------------------------------------------

const CHECK_GROUPS: { label: string; prefixes: string[]; when?: (d: PostDesign) => boolean }[] = [
  { label: "Question matches the Question Bank", prefixes: ["SOURCE_"] },
  { label: "Question and options complete", prefixes: ["STEM_", "OPTION", "TYPE_", "IMAGES_", "EQUATIONS_"] },
  { label: "Answer key valid", prefixes: ["ANSWER_KEY"] },
  { label: "Exam scope and attribution", prefixes: ["EXAM_OUT_OF_SCOPE", "NOT_PYQ", "STATS_"] },
  { label: "Printed question number", prefixes: ["QUESTION_NUMBER_"] },
  { label: "Question Bank status and difficulty", prefixes: ["QB_"] },
  { label: "Every slide complete and readable", prefixes: ["SLIDE_", "CAROUSEL_"] },
  { label: "All characters drawable", prefixes: ["GLYPHS"] },
  { label: "Content rules (years, answer leaks, links, claims)", prefixes: ["SAFETY", "CAPTION_OUT_OF_SCOPE", "CAPTION_TREND_CLAIM"] },
  { label: "Caption present", prefixes: ["CAPTION_EMPTY"] },
  { label: "Follow slide configured", prefixes: ["FOLLOW_"] },
  { label: "Diagram valid", prefixes: ["DIAGRAM_"], when: (d) => d.modules.includes("DIAGRAM") },
  { label: "Examiner Trap valid", prefixes: ["TRAP_"], when: (d) => d.modules.includes("TRAP") },
  { label: "Medical review", prefixes: ["AI_", "MEDICAL_IMAGE"] },
];

export function passedChecks(issues: QualityIssue[], design: PostDesign): string[] {
  return CHECK_GROUPS.filter((g) => (g.when ? g.when(design) : true) && !issues.some((i) => g.prefixes.some((p) => i.code.startsWith(p)))).map((g) => g.label);
}

/** The one-line status under the Checks heading. Never claims a medical review that wasn't recorded. */
export function checksStatus(issues: QualityIssue[], advice: IssueAdvice[]): { tone: "ok" | "warning" | "error"; text: string } {
  const errors = issues.filter((i) => i.severity === "error").length;
  const medical = advice.filter((a) => a.category === "medical").length;
  const technical = issues.filter((i) => advice.find((a) => a.code === i.code)?.category !== "medical");
  if (errors) {
    const auto = advice.filter((a) => a.category === "auto" && issues.find((i) => i.code === a.code)?.severity === "error").length;
    return { tone: "error", text: `${errors} blocking issue${errors === 1 ? "" : "s"}${auto ? ` — ${auto} can be fixed automatically (Master Fix)` : ""}.` };
  }
  if (technical.length === 0 && medical) return { tone: "warning", text: "All automatic checks passed. Medical review still required." };
  if (medical) return { tone: "warning", text: "No blocking issues. Some warnings need your input, and medical review is still required." };
  if (technical.length) return { tone: "warning", text: "No blocking issues. Check the warnings below before publishing." };
  return { tone: "ok", text: "All checks passed." };
}
