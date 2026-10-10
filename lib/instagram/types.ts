/**
 * Instagram Content Studio — shared shapes and pure helpers (client + server safe).
 *
 * A post is: a frozen SourceSnapshot of one question (never edited here), the
 * editable PostContent (hooks, trick, explanation, caption …) and PostDesign
 * (template, slide count, module order, font scale). Every content/design
 * change is a new InstagramPostRevision, so nothing is ever silently lost.
 */

export const SLIDE_MODULES = [
  "HOOK",
  "QUESTION",
  "ANSWER",
  "EXPLANATION",
  "MEMORY_TRICK",
  "EXPLANATION_TRICK",
  "PEARL_REVISION",
  "FOLLOW",
] as const;
export type SlideModule = (typeof SLIDE_MODULES)[number];

export const MODULE_LABELS: Record<SlideModule, string> = {
  HOOK: "Hook",
  QUESTION: "Question",
  ANSWER: "Answer",
  EXPLANATION: "Explanation",
  MEMORY_TRICK: "Memory Trick + Pearl",
  EXPLANATION_TRICK: "Explanation + Memory Trick",
  PEARL_REVISION: "Clinical Pearl + Quick Revision",
  FOLLOW: "Follow / Join",
};

export const SLIDE_COUNTS = [3, 4, 5, 6] as const;
export type SlideCount = (typeof SLIDE_COUNTS)[number];
export const DEFAULT_SLIDE_COUNT: SlideCount = 5;

/** Recommended order per slide count. The Follow slide is always last. */
export const DEFAULT_LAYOUTS: Record<SlideCount, SlideModule[]> = {
  3: ["QUESTION", "ANSWER", "FOLLOW"],
  4: ["QUESTION", "ANSWER", "EXPLANATION_TRICK", "FOLLOW"],
  5: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "FOLLOW"],
  6: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "PEARL_REVISION", "FOLLOW"],
};

export const TEMPLATE_KEYS = ["midnight", "academic", "clinical", "premium"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const DEFAULT_TEMPLATE: TemplateKey = "midnight";

export const HOOK_STYLES = ["curiosity", "challenge", "memory"] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];
export const HOOK_STYLE_LABELS: Record<HookStyle, string> = {
  curiosity: "Curiosity Hook",
  challenge: "Exam Challenge Hook",
  memory: "Memory Trick Hook",
};

export interface HookOption {
  style: HookStyle;
  text: string;
}

/** Hard caps — keep every slide readable on a phone. Enforced on save and on AI output. */
export const LIMITS = {
  hook: 90,
  explanation: 420,
  memoryTrick: 200,
  clinicalPearl: 220,
  quickRevisionItem: 90,
  quickRevisionItems: 4,
  finalTrick: 120,
  caption: 2000,
  hashtags: 15,
} as const;

export const CONTENT_FIELDS = ["hooks", "explanation", "memoryTrick", "clinicalPearl", "quickRevision", "finalTrick", "caption", "hashtags"] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];
export const CONTENT_FIELD_LABELS: Record<ContentField, string> = {
  hooks: "Hooks",
  explanation: "Explanation",
  memoryTrick: "Memory Trick",
  clinicalPearl: "Clinical Pearl",
  quickRevision: "Quick Revision",
  finalTrick: "Final-slide trick",
  caption: "Caption",
  hashtags: "Hashtags",
};

export interface ContentOrigin {
  kind: "empty" | "ai" | "existing-explanation" | "manual";
  provider?: string;
  model?: string;
  promptVersion?: string;
  generatedAt?: string;
}

export interface PostContent {
  hooks: HookOption[];
  /** The hook actually shown (one of `hooks`, possibly edited). */
  hookText: string;
  explanation: string;
  memoryTrick: string;
  clinicalPearl: string;
  quickRevision: string[];
  finalTrick: string;
  showFinalTrick: boolean;
  caption: string;
  hashtags: string[];
  origin: ContentOrigin;
  /** Uncertainty notes reported by the AI ("confidence: medium — …"). Shown as review warnings. */
  aiFlags: string[];
}

export interface PostDesign {
  template: TemplateKey;
  slideCount: SlideCount;
  modules: SlideModule[];
  /** 0.85 – 1.25 multiplier on the question/option text size. */
  questionScale: number;
  /** 0.85 – 1.25 multiplier on the other slides' body text. */
  bodyScale: number;
}

export interface SnapshotOption {
  label: string;
  text: string;
  isCorrect: boolean;
}

/** The question exactly as it was in the Question Bank when the draft was created. Read-only. */
export interface SourceSnapshot {
  questionId: string;
  code: string;
  text: string;
  contentFormat: string;
  questionType: string;
  options: SnapshotOption[];
  examId: string;
  examName: string;
  examCode: string;
  paperId: string | null;
  paperTitle: string | null;
  paperYear: number | null;
  paperCode: string | null;
  /** More than one paper in the same exam + year → the slide also names the paper. */
  paperSharesYear: boolean;
  /** Position in the paper's stored order (createdAt, code — the order the PYQ test uses). NOT the printed number. */
  importPosition: number | null;
  subjectName: string;
  topicName: string | null;
  hasImages: boolean;
  status: string;
  reviewRequired: boolean;
  reviewReason: string | null;
  aiExplanation: { status: string; isStale: boolean; reviewed: boolean } | null;
  capturedAt: string;
}

/** MOST_MISSED: Question Insights numbers captured at draft creation (never edited, never AI-written). */
export interface SeriesStats {
  attempts: number;
  wrong: number;
  wrongPct: number;
  rangeLabel: string;
  headlineSuffix: string;
  rangePreset: string;
  capturedAt: string;
}

export const POST_STATUSES = ["NOT_CREATED", "DRAFT", "READY", "PUBLISHING", "PUBLISHED", "FAILED"] as const;
export type PostStatusLabel = (typeof POST_STATUSES)[number];
export const POST_STATUS_LABELS: Record<PostStatusLabel, string> = {
  NOT_CREATED: "Not Created",
  DRAFT: "Draft",
  READY: "Ready",
  PUBLISHING: "Publishing",
  PUBLISHED: "Instagram ✓ Posted",
  FAILED: "Failed",
};

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

const clampNum = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
};

/** Returns an error message, or null when the module order is valid. */
export function validateModules(modules: readonly string[]): string | null {
  if (!(SLIDE_COUNTS as readonly number[]).includes(modules.length)) return "A carousel has 3 to 6 slides.";
  if (modules.some((m) => !(SLIDE_MODULES as readonly string[]).includes(m))) return "Unknown slide type.";
  if (new Set(modules).size !== modules.length) return "Each slide type can be used once.";
  if (modules[modules.length - 1] !== "FOLLOW") return "The Follow / Join slide must be the last slide.";
  const q = modules.indexOf("QUESTION");
  const a = modules.indexOf("ANSWER");
  if (q < 0 || a < 0) return "The Question and Answer slides are required.";
  if (a < q) return "The Answer slide must come after the Question slide.";
  if (modules.includes("EXPLANATION_TRICK") && (modules.includes("EXPLANATION") || modules.includes("MEMORY_TRICK"))) {
    return "Use either the combined Explanation + Memory Trick slide or the separate slides, not both.";
  }
  return null;
}

export function defaultDesign(template: TemplateKey = DEFAULT_TEMPLATE, slideCount: SlideCount = DEFAULT_SLIDE_COUNT): PostDesign {
  return { template, slideCount, modules: [...DEFAULT_LAYOUTS[slideCount]], questionScale: 1, bodyScale: 1 };
}

export function normalizeDesign(raw: unknown): PostDesign {
  const r = (raw ?? {}) as Partial<PostDesign>;
  const template = (TEMPLATE_KEYS as readonly string[]).includes(r.template as string) ? (r.template as TemplateKey) : DEFAULT_TEMPLATE;
  const modules = Array.isArray(r.modules) ? (r.modules.filter((m) => typeof m === "string") as SlideModule[]) : [];
  const validModules = validateModules(modules) === null ? modules : null;
  const slideCount = (validModules?.length ?? ((SLIDE_COUNTS as readonly number[]).includes(r.slideCount as number) ? r.slideCount : DEFAULT_SLIDE_COUNT)) as SlideCount;
  return {
    template,
    slideCount,
    modules: validModules ?? [...DEFAULT_LAYOUTS[slideCount]],
    questionScale: clampNum(r.questionScale, 0.85, 1.25, 1),
    bodyScale: clampNum(r.bodyScale, 0.85, 1.25, 1),
  };
}

export function emptyContent(): PostContent {
  return {
    hooks: [],
    hookText: "",
    explanation: "",
    memoryTrick: "",
    clinicalPearl: "",
    quickRevision: [],
    finalTrick: "",
    showFinalTrick: false,
    caption: "",
    hashtags: [],
    origin: { kind: "empty" },
    aiFlags: [],
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function normalizeContent(raw: unknown): PostContent {
  const r = (raw ?? {}) as Record<string, unknown>;
  const hooks = Array.isArray(r.hooks)
    ? (r.hooks as unknown[])
        .map((h) => h as Partial<HookOption>)
        .filter((h) => (HOOK_STYLES as readonly string[]).includes(h?.style as string) && typeof h?.text === "string")
        .map((h) => ({ style: h.style as HookStyle, text: h.text as string }))
    : [];
  const origin = (r.origin ?? {}) as ContentOrigin;
  return {
    hooks,
    hookText: str(r.hookText),
    explanation: str(r.explanation),
    memoryTrick: str(r.memoryTrick),
    clinicalPearl: str(r.clinicalPearl),
    quickRevision: strList(r.quickRevision),
    finalTrick: str(r.finalTrick),
    showFinalTrick: r.showFinalTrick === true,
    caption: str(r.caption),
    hashtags: strList(r.hashtags),
    origin: { ...origin, kind: (["empty", "ai", "existing-explanation", "manual"] as const).includes(origin.kind) ? origin.kind : "empty" },
    aiFlags: strList(r.aiFlags),
  };
}

/** Normalizes a hashtag list: '#' prefix, letters/digits/underscore only, de-duplicated (case-insensitive), capped. */
export function normalizeHashtags(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    for (const part of raw.split(/[\s,]+/)) {
      const core = part.replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");
      if (core.length < 2 || core.length > 40) continue;
      const key = core.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`#${core}`);
    }
  }
  return out.slice(0, LIMITS.hashtags);
}

/** The modules a field appears on — used to map "regenerate this slide" to content fields. */
export const MODULE_FIELDS: Record<SlideModule, ContentField[]> = {
  HOOK: ["hooks"],
  QUESTION: ["hooks"],
  ANSWER: ["explanation"],
  EXPLANATION: ["explanation"],
  MEMORY_TRICK: ["memoryTrick", "clinicalPearl"],
  EXPLANATION_TRICK: ["explanation", "memoryTrick"],
  PEARL_REVISION: ["clinicalPearl", "quickRevision"],
  FOLLOW: ["finalTrick"],
};

/** Final caption text as it would be posted: caption body + hashtags. */
export function composeCaption(content: Pick<PostContent, "caption" | "hashtags">): string {
  const tags = content.hashtags.join(" ");
  return [content.caption.trim(), tags].filter(Boolean).join("\n\n");
}
