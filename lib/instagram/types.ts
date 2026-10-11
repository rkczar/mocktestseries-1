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
  "PEARLS",
  "MISTAKES",
  "DIAGRAM",
  "TRAP",
  "MEDICAL_IMAGE",
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
  PEARLS: "High-Yield Medical Pearls",
  MISTAKES: "Common Mistakes",
  DIAGRAM: "Medical Concept Diagram",
  TRAP: "How the Examiner Traps You",
  MEDICAL_IMAGE: "Medical Image",
  FOLLOW: "Follow / Join",
};

/** Preset slide counts (each has a recommended layout). Custom layouts may use any count from MIN_SLIDES to MAX_SLIDES. */
export const SLIDE_COUNTS = [3, 4, 5, 6, 7] as const;
export type SlideCount = (typeof SLIDE_COUNTS)[number];
export const DEFAULT_SLIDE_COUNT: SlideCount = 5;
export const MIN_SLIDES = 3;
/** Instagram's carousel limit used by the publisher (lib/instagram/publish.ts CAROUSEL_MAX). */
export const MAX_SLIDES = 10;

/** Recommended order per slide count. The Follow slide is always last. */
export const DEFAULT_LAYOUTS: Record<SlideCount, SlideModule[]> = {
  3: ["QUESTION", "ANSWER", "FOLLOW"],
  4: ["QUESTION", "ANSWER", "EXPLANATION_TRICK", "FOLLOW"],
  5: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "FOLLOW"],
  6: ["HOOK", "QUESTION", "ANSWER", "EXPLANATION_TRICK", "PEARL_REVISION", "FOLLOW"],
  7: ["QUESTION", "ANSWER", "DIAGRAM", "PEARLS", "MISTAKES", "TRAP", "FOLLOW"],
};

/**
 * Templates. The first four are the original brand templates (kept as they
 * were). Professional presets and Handwritten presets were added with the
 * AI Studio; a template's mode is fixed (lib/instagram/templates.ts).
 */
export const TEMPLATE_KEYS = [
  "midnight",
  "academic",
  "clinical",
  "premium",
  "clean-clinical",
  "navy-premium",
  "minimal-infographic",
  "modern-revision",
  "hw-doctor",
  "hw-colorful",
  "hw-diagrams",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export const DEFAULT_TEMPLATE: TemplateKey = "midnight";

export const DESIGN_MODES = ["professional", "handwritten"] as const;
export type DesignMode = (typeof DESIGN_MODES)[number];
export const DESIGN_MODE_LABELS: Record<DesignMode, string> = { professional: "Normal Professional", handwritten: "Human Handwritten" };
export const HANDWRITTEN_TEMPLATES: TemplateKey[] = ["hw-doctor", "hw-colorful", "hw-diagrams"];
export function modeOfTemplate(t: TemplateKey): DesignMode {
  return HANDWRITTEN_TEMPLATES.includes(t) ? "handwritten" : "professional";
}

export const FONT_CHOICES = ["default", "geist", "kalam"] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];
export const FONT_LABELS: Record<FontChoice, string> = { default: "Template default", geist: "Geist (clean sans)", kalam: "Kalam (handwriting)" };

/** Optional per-post colour/font overrides on top of the template. Colours are #rrggbb. */
export interface DesignOverrides {
  background?: string;
  card?: string;
  foreground?: string;
  accent?: string;
  highlight?: string;
  font?: FontChoice;
}
export const OVERRIDE_COLOR_KEYS = ["background", "card", "foreground", "accent", "highlight"] as const;

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
  pearl: 110,
  pearls: 5,
  mistake: 140,
  mistakes: 4,
  keyword: 40,
  keywords: 12,
} as const;

export const CONTENT_FIELDS = ["hooks", "explanation", "memoryTrick", "clinicalPearl", "quickRevision", "pearls", "mistakes", "finalTrick", "caption", "hashtags"] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];
export const CONTENT_FIELD_LABELS: Record<ContentField, string> = {
  hooks: "Hooks",
  explanation: "Explanation",
  memoryTrick: "Memory Trick",
  clinicalPearl: "Clinical Pearl",
  quickRevision: "Quick Revision",
  pearls: "High-Yield Pearls",
  mistakes: "Common Mistakes",
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

// ---- Medical diagram (structured spec, drawn by the renderer — never an AI image) -----

export const DIAGRAM_KINDS = ["flowchart", "mechanism", "comparison", "ddx", "venn", "hub"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export const DIAGRAM_KIND_LABELS: Record<DiagramKind, string> = {
  flowchart: "Clinical flowchart",
  mechanism: "Mechanism / pathway (steps)",
  comparison: "Comparison table",
  ddx: "Differential diagnosis chart",
  venn: "Venn diagram",
  hub: "Concept map / labelled schematic",
};

export interface DiagramNode {
  id: string;
  label: string;
  note?: string;
}

export interface DiagramSpec {
  kind: DiagramKind;
  title: string;
  /** flowchart / mechanism / hub (first node = centre). */
  nodes: DiagramNode[];
  /** flowchart only: arrows; empty = nodes in order. */
  edges: { from: string; to: string; label?: string }[];
  /** comparison / ddx: column headers (first = row label column). */
  columns: string[];
  rows: { label: string; cells: string[] }[];
  /** venn: 2 or 3 sets; `overlap` = items shared by all sets. */
  sets: { label: string; items: string[] }[];
  overlap: string[];
  footnote: string;
  /** Admin attestation that a medical reviewer checked every label. Reset by any AI regeneration. */
  reviewed: boolean;
  origin?: ContentOrigin;
}

export const DIAGRAM_LIMITS = { title: 60, label: 42, note: 60, nodes: 7, edges: 10, columns: 3, cell: 60, rows: 6, setItems: 4, item: 32, footnote: 110 } as const;

// ---- Examiner trap (AI variant shown on the TRAP slide; stored on the post only) ------

export const TRAP_LABELS = ["A", "B", "C", "D"] as const;
export interface TrapVariant {
  question: string;
  options: { label: string; text: string }[];
  correct: string;
  /** The most tempting wrong option. */
  tempting: string;
  trapExplanation: string;
  avoidTip: string;
  status: "draft" | "approved" | "rejected";
  /** Validation notes (independent re-solve, originality, relevance). */
  checks: { code: string; ok: boolean; message: string }[];
  origin?: ContentOrigin;
  reviewedAt?: string;
}
/** Recommended lengths (the AI is asked to stay within them; longer text is a warning and continues on an extra slide). */
export const TRAP_LIMITS = { question: 300, option: 110, trapExplanation: 300, avoidTip: 200 } as const;
/** Input sanity ceiling on save — everything up to it is laid out without cutting (lib/instagram/layout.ts trapParts). */
export const TRAP_MAX = { question: 1000, option: 250, trapExplanation: 900, avoidTip: 600 } as const;

// ---- Optional medical image slide (AI-generated or a licensed reference image) -------------

export interface MedicalImageSource {
  kind: "ai" | "reference";
  /** "gemini" for AI images, "wikimedia" for Wikimedia Commons. */
  provider: string;
  model?: string;
  promptVersion?: string;
  /** Reference images: the file page, author and licence (shown on the slide as attribution). */
  pageUrl?: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
  createdAt: string;
}

export interface MedicalImage {
  /** Content-addressed key in the media store (lib/media-storage.ts) — server-owned. */
  key: string;
  width: number;
  height: number;
  /** Shown above the image (editable). */
  title: string;
  /** Short memory tip under the image (editable). */
  memoryTip: string;
  source: MedicalImageSource;
}
export const MEDICAL_IMAGE_LIMITS = { title: 70, memoryTip: 200 } as const;

// ---- Caption versions -------------------------------------------------------------------

export const CAPTION_STYLES = ["professional", "hook", "search"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];
export const CAPTION_STYLE_LABELS: Record<CaptionStyle, string> = {
  professional: "Professional Medical Education",
  hook: "High-Engagement Clinical Hook",
  search: "Instagram Search-Optimized",
};
export interface CaptionVariant {
  style: CaptionStyle;
  caption: string;
  hashtags: string[];
}

export interface PostContent {
  hooks: HookOption[];
  /** The hook actually shown (one of `hooks`, possibly edited). */
  hookText: string;
  explanation: string;
  memoryTrick: string;
  clinicalPearl: string;
  quickRevision: string[];
  pearls: string[];
  mistakes: string[];
  diagram: DiagramSpec | null;
  trap: TrapVariant | null;
  /** The image on the MEDICAL_IMAGE slide (added only after the admin approves a preview). */
  medicalImage: MedicalImage | null;
  /** The latest generated / selected image awaiting Add to Carousel or Skip (cached so a reload never regenerates). */
  imageCandidate: MedicalImage | null;
  captionVariants: CaptionVariant[];
  /** Which caption version is in use (null = written/edited directly). */
  captionStyle: CaptionStyle | null;
  keywords: string[];
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
  /** = modules.length (3 – 10). */
  slideCount: number;
  modules: SlideModule[];
  /** 0.85 – 1.25 multiplier on the question/option text size. */
  questionScale: number;
  /** 0.85 – 1.25 multiplier on the other slides' body text. */
  bodyScale: number;
  overrides?: DesignOverrides;
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

export const POST_STATUSES = ["NOT_CREATED", "DRAFT", "PUBLISHING", "PUBLISHED", "FAILED"] as const;
export type PostStatusLabel = (typeof POST_STATUSES)[number];
export const POST_STATUS_LABELS: Record<PostStatusLabel, string> = {
  NOT_CREATED: "Not Created",
  DRAFT: "Draft",
  PUBLISHING: "Publishing",
  PUBLISHED: "Instagram ✓ Posted",
  FAILED: "Failed",
};

/**
 * The status the Studio shows and works with. The legacy READY value ("Mark
 * Ready" approval, removed) is kept in the database enum for old rows and is
 * treated exactly like DRAFT: publishing needs only the final confirmation.
 */
export type StudioPostStatus = "DRAFT" | "PUBLISHING" | "PUBLISHED" | "FAILED";
export function studioStatus(s: "DRAFT" | "READY" | "PUBLISHING" | "PUBLISHED" | "FAILED"): StudioPostStatus {
  return s === "READY" ? "DRAFT" : s;
}

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

const clampNum = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
};

/** Returns an error message, or null when the module order is valid. */
export function validateModules(modules: readonly string[]): string | null {
  if (modules.length < MIN_SLIDES || modules.length > MAX_SLIDES) return `A carousel has ${MIN_SLIDES} to ${MAX_SLIDES} slides.`;
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
  const presetCount = ((SLIDE_COUNTS as readonly number[]).includes(r.slideCount as number) ? r.slideCount : DEFAULT_SLIDE_COUNT) as SlideCount;
  const finalModules = validModules ?? [...DEFAULT_LAYOUTS[presetCount]];
  const overrides = normalizeOverrides(r.overrides);
  return {
    template,
    slideCount: finalModules.length,
    modules: finalModules,
    questionScale: clampNum(r.questionScale, 0.85, 1.25, 1),
    bodyScale: clampNum(r.bodyScale, 0.85, 1.25, 1),
    ...(overrides ? { overrides } : {}),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Keeps only valid #rrggbb colours and a known font; undefined when nothing is overridden. */
export function normalizeOverrides(raw: unknown): DesignOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: DesignOverrides = {};
  for (const k of OVERRIDE_COLOR_KEYS) if (typeof r[k] === "string" && HEX.test(r[k] as string)) out[k] = (r[k] as string).toLowerCase();
  if ((FONT_CHOICES as readonly string[]).includes(r.font as string) && r.font !== "default") out.font = r.font as FontChoice;
  return Object.keys(out).length ? out : undefined;
}

export function emptyContent(): PostContent {
  return {
    hooks: [],
    hookText: "",
    explanation: "",
    memoryTrick: "",
    clinicalPearl: "",
    quickRevision: [],
    pearls: [],
    mistakes: [],
    diagram: null,
    trap: null,
    medicalImage: null,
    imageCandidate: null,
    captionVariants: [],
    captionStyle: null,
    keywords: [],
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
    pearls: strList(r.pearls),
    mistakes: strList(r.mistakes),
    diagram: normalizeDiagram(r.diagram),
    trap: normalizeTrap(r.trap),
    medicalImage: normalizeMedicalImage(r.medicalImage),
    imageCandidate: normalizeMedicalImage(r.imageCandidate),
    captionVariants: normalizeCaptionVariants(r.captionVariants),
    captionStyle: (CAPTION_STYLES as readonly string[]).includes(r.captionStyle as string) ? (r.captionStyle as CaptionStyle) : null,
    keywords: strList(r.keywords),
    finalTrick: str(r.finalTrick),
    showFinalTrick: r.showFinalTrick === true,
    caption: str(r.caption),
    hashtags: strList(r.hashtags),
    origin: { ...origin, kind: (["empty", "ai", "existing-explanation", "manual"] as const).includes(origin.kind) ? origin.kind : "empty" },
    aiFlags: strList(r.aiFlags),
  };
}

function originOf(v: unknown): ContentOrigin | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as ContentOrigin;
  return (["empty", "ai", "existing-explanation", "manual"] as const).includes(o.kind) ? { ...o } : undefined;
}

/** Shape-normalizes a stored/submitted diagram (no length checks — lib/instagram/diagram.ts validates). */
export function normalizeDiagram(raw: unknown): DiagramSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!(DIAGRAM_KINDS as readonly string[]).includes(r.kind as string)) return null;
  const nodes = Array.isArray(r.nodes)
    ? (r.nodes as unknown[]).flatMap((n, i) => {
        const x = (n ?? {}) as Record<string, unknown>;
        const label = str(x.label).trim();
        if (!label) return [];
        const note = str(x.note).trim();
        return [{ id: str(x.id).trim() || `n${i + 1}`, label, ...(note ? { note } : {}) }];
      })
    : [];
  const edges = Array.isArray(r.edges)
    ? (r.edges as unknown[]).flatMap((e) => {
        const x = (e ?? {}) as Record<string, unknown>;
        const from = str(x.from).trim();
        const to = str(x.to).trim();
        if (!from || !to) return [];
        const label = str(x.label).trim();
        return [{ from, to, ...(label ? { label } : {}) }];
      })
    : [];
  const rows = Array.isArray(r.rows)
    ? (r.rows as unknown[]).flatMap((row) => {
        const x = (row ?? {}) as Record<string, unknown>;
        const label = str(x.label).trim();
        return label ? [{ label, cells: strList(x.cells).map((c) => c.trim()) }] : [];
      })
    : [];
  const sets = Array.isArray(r.sets)
    ? (r.sets as unknown[]).flatMap((set) => {
        const x = (set ?? {}) as Record<string, unknown>;
        const label = str(x.label).trim();
        return label ? [{ label, items: strList(x.items).map((c) => c.trim()).filter(Boolean) }] : [];
      })
    : [];
  return {
    kind: r.kind as DiagramKind,
    title: str(r.title).trim(),
    nodes,
    edges,
    columns: strList(r.columns).map((c) => c.trim()),
    rows,
    sets,
    overlap: strList(r.overlap).map((c) => c.trim()).filter(Boolean),
    footnote: str(r.footnote).trim(),
    reviewed: r.reviewed === true,
    origin: originOf(r.origin),
  };
}

export function normalizeTrap(raw: unknown): TrapVariant | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const options = Array.isArray(r.options)
    ? (r.options as unknown[]).map((o) => {
        const x = (o ?? {}) as Record<string, unknown>;
        return { label: str(x.label).trim().toUpperCase(), text: str(x.text).trim() };
      })
    : [];
  const checks = Array.isArray(r.checks)
    ? (r.checks as unknown[]).flatMap((c) => {
        const x = (c ?? {}) as Record<string, unknown>;
        return typeof x.code === "string" ? [{ code: x.code, ok: x.ok === true, message: str(x.message) }] : [];
      })
    : [];
  return {
    question: str(r.question).trim(),
    options,
    correct: str(r.correct).trim().toUpperCase(),
    tempting: str(r.tempting).trim().toUpperCase(),
    trapExplanation: str(r.trapExplanation).trim(),
    avoidTip: str(r.avoidTip).trim(),
    status: r.status === "approved" || r.status === "rejected" ? r.status : "draft",
    checks,
    origin: originOf(r.origin),
    ...(typeof r.reviewedAt === "string" ? { reviewedAt: r.reviewedAt } : {}),
  };
}

export function normalizeMedicalImage(raw: unknown): MedicalImage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const src = (r.source ?? {}) as Record<string, unknown>;
  const key = str(r.key);
  if (!key || (src.kind !== "ai" && src.kind !== "reference")) return null;
  const opt = (k: string) => (typeof src[k] === "string" && src[k] ? { [k]: src[k] as string } : {});
  return {
    key,
    width: typeof r.width === "number" ? r.width : 0,
    height: typeof r.height === "number" ? r.height : 0,
    title: str(r.title),
    memoryTip: str(r.memoryTip),
    source: { kind: src.kind, provider: str(src.provider), createdAt: str(src.createdAt), ...opt("model"), ...opt("promptVersion"), ...opt("pageUrl"), ...opt("author"), ...opt("license"), ...opt("licenseUrl") },
  };
}

export function normalizeCaptionVariants(raw: unknown): CaptionVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptionVariant[] = [];
  for (const v of raw) {
    const x = (v ?? {}) as Record<string, unknown>;
    if (!(CAPTION_STYLES as readonly string[]).includes(x.style as string) || typeof x.caption !== "string") continue;
    if (out.some((o) => o.style === x.style)) continue;
    out.push({ style: x.style as CaptionStyle, caption: x.caption, hashtags: normalizeHashtags(strList(x.hashtags)) });
  }
  return out;
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
  PEARLS: ["pearls"],
  MISTAKES: ["mistakes"],
  DIAGRAM: [],
  TRAP: [],
  MEDICAL_IMAGE: [],
  FOLLOW: ["finalTrick"],
};

/** Final caption text as it would be posted: caption body + hashtags. */
export function composeCaption(content: Pick<PostContent, "caption" | "hashtags">): string {
  const tags = content.hashtags.join(" ");
  return [content.caption.trim(), tags].filter(Boolean).join("\n\n");
}
