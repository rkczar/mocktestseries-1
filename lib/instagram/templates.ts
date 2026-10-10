import { modeOfTemplate, type DesignMode, type PostDesign, type TemplateKey } from "@/lib/instagram/types";

/**
 * Carousel templates. "midnight" is the default and mirrors the live website
 * tokens (app/globals.css dark theme + the active Appearance primary #008209):
 * black page, #171717 cards, white/12% borders, Geist, 1.25rem card radius.
 * The other three are variations for the owner to choose from; none of them
 * changes the website's own design system.
 *
 * AI Studio added two design modes: four more Professional presets and three
 * Handwritten presets (cream notebook paper, Kalam handwriting, blue/black
 * ink, red annotations, yellow highlighter). A template's mode is fixed; the
 * medical content is identical in every template.
 */
export interface SlideTheme {
  key: TemplateKey;
  name: string;
  description: string;
  background: string;
  card: string;
  border: string;
  foreground: string;
  muted: string;
  /** Brand accent — badge fill, progress, rule lines. */
  accent: string;
  /** Text drawn on top of `accent`. */
  accentInk: string;
  /** Correct-answer highlight. */
  correct: string;
  correctSoft: string;
  /** Secondary highlight for "Memory Trick" / "Pearl" labels. */
  highlight: string;
  highlightSoft: string;
  /** Option label bubble. */
  bubble: string;
  /** Card corner radius in px at 1080 wide (website 1.25rem ≈ 20px on a ~430px phone → ~40px here). */
  radius: number;
  mode: DesignMode;
  /** Primary font family: Geist (professional) or Kalam (handwritten). */
  font: "Geist" | "Kalam";
  /** Handwritten paper: ruled (notebook) or grid (graph paper) lines, and the red margin. */
  paper?: { kind: "ruled" | "grid"; line: string; margin: string | null };
  /** Handwritten: red-pen annotation colour and the highlighter fill. */
  annotation?: string;
  marker?: string;
}

export const TEMPLATES: Record<TemplateKey, SlideTheme> = {
  midnight: {
    key: "midnight",
    name: "Midnight Medical",
    description: "Matches the live website: black background, #171717 cards, brand green #008209.",
    background: "#000000",
    card: "#171717",
    border: "rgba(255,255,255,0.12)",
    foreground: "#f5f5f5",
    muted: "#a3a3a3",
    accent: "#008209",
    accentInk: "#ffffff",
    correct: "#22c55e",
    correctSoft: "rgba(34,197,94,0.14)",
    highlight: "#ea580c",
    highlightSoft: "rgba(234,88,12,0.14)",
    bubble: "#262626",
    radius: 40,
    mode: "professional",
    font: "Geist",
  },
  academic: {
    key: "academic",
    name: "Clean Academic",
    description: "The website's light theme: near-white page, white cards, dark ink. Highest readability.",
    background: "#fbfbfc",
    card: "#ffffff",
    border: "#e6e7ea",
    foreground: "#16171a",
    muted: "#61646b",
    accent: "#008209",
    accentInk: "#ffffff",
    correct: "#15803d",
    correctSoft: "rgba(21,128,61,0.10)",
    highlight: "#c2410c",
    highlightSoft: "rgba(194,65,12,0.08)",
    bubble: "#f1f2f4",
    radius: 40,
    mode: "professional",
    font: "Geist",
  },
  clinical: {
    key: "clinical",
    name: "Clinical Green",
    description: "Deep green-black with teal accents — a calmer medical variant of the brand.",
    background: "#03130f",
    card: "#0a231c",
    border: "rgba(94,234,212,0.18)",
    foreground: "#ecfdf5",
    muted: "#9fbfb4",
    accent: "#0f766e",
    accentInk: "#ffffff",
    correct: "#34d399",
    correctSoft: "rgba(52,211,153,0.14)",
    highlight: "#f59e0b",
    highlightSoft: "rgba(245,158,11,0.14)",
    bubble: "#123128",
    radius: 40,
    mode: "professional",
    font: "Geist",
  },
  premium: {
    key: "premium",
    name: "Premium Dark",
    description: "Black with warm gold detailing for a premium look; brand green kept on the badge.",
    background: "#0a0a0a",
    card: "#141414",
    border: "rgba(234,179,8,0.28)",
    foreground: "#fafafa",
    muted: "#a8a29e",
    accent: "#008209",
    accentInk: "#ffffff",
    correct: "#22c55e",
    correctSoft: "rgba(34,197,94,0.12)",
    highlight: "#eab308",
    highlightSoft: "rgba(234,179,8,0.12)",
    bubble: "#1f1f1f",
    radius: 28,
    mode: "professional",
    font: "Geist",
  },
  "clean-clinical": {
    key: "clean-clinical",
    name: "Clean Clinical",
    description: "White page, soft teal accents and thin rules — a hospital-chart look with maximum readability.",
    background: "#ffffff",
    card: "#f3f8f8",
    border: "#d6e6e6",
    foreground: "#10292b",
    muted: "#5b7476",
    accent: "#0e7c7b",
    accentInk: "#ffffff",
    correct: "#0f8a4f",
    correctSoft: "rgba(15,138,79,0.10)",
    highlight: "#d9480f",
    highlightSoft: "rgba(217,72,15,0.08)",
    bubble: "#e3eeee",
    radius: 24,
    mode: "professional",
    font: "Geist",
  },
  "navy-premium": {
    key: "navy-premium",
    name: "Dark Navy Premium",
    description: "Deep navy with warm gold detailing — premium editorial feel.",
    background: "#0b1530",
    card: "#13214a",
    border: "rgba(212,175,55,0.30)",
    foreground: "#f4f6fb",
    muted: "#a9b3cf",
    accent: "#d4af37",
    accentInk: "#0b1530",
    correct: "#4ade80",
    correctSoft: "rgba(74,222,128,0.12)",
    highlight: "#f5c451",
    highlightSoft: "rgba(245,196,81,0.12)",
    bubble: "#1c2c5c",
    radius: 30,
    mode: "professional",
    font: "Geist",
  },
  "minimal-infographic": {
    key: "minimal-infographic",
    name: "Minimal Medical Infographic",
    description: "Off-white, one blue accent, generous space and hairline borders — infographic style with minimal clutter.",
    background: "#f7f7f4",
    card: "#ffffff",
    border: "#e2e2dc",
    foreground: "#1b1c1f",
    muted: "#6a6c72",
    accent: "#1d4ed8",
    accentInk: "#ffffff",
    correct: "#15803d",
    correctSoft: "rgba(21,128,61,0.08)",
    highlight: "#1d4ed8",
    highlightSoft: "rgba(29,78,216,0.07)",
    bubble: "#eeeeea",
    radius: 16,
    mode: "professional",
    font: "Geist",
  },
  "modern-revision": {
    key: "modern-revision",
    name: "Modern Exam Revision",
    description: "Light grey with vivid violet and orange — energetic, modern revision cards.",
    background: "#f1f1f6",
    card: "#ffffff",
    border: "#dcdcea",
    foreground: "#17162b",
    muted: "#62617a",
    accent: "#6d28d9",
    accentInk: "#ffffff",
    correct: "#059669",
    correctSoft: "rgba(5,150,105,0.10)",
    highlight: "#ea580c",
    highlightSoft: "rgba(234,88,12,0.09)",
    bubble: "#ececf6",
    radius: 32,
    mode: "professional",
    font: "Geist",
  },
  "hw-doctor": {
    key: "hw-doctor",
    name: "Clean Doctor Notes",
    description: "Cream ruled notebook, blue-black ink, red margin and annotations, yellow highlighter.",
    background: "#fbf6e6",
    card: "rgba(255,255,255,0.0)",
    border: "#1f3a7a",
    foreground: "#14244f",
    muted: "#4a5578",
    accent: "#1f3a7a",
    accentInk: "#fbf6e6",
    correct: "#c62828",
    correctSoft: "rgba(255,226,64,0.45)",
    highlight: "#c62828",
    highlightSoft: "rgba(255,226,64,0.40)",
    bubble: "rgba(31,58,122,0.08)",
    radius: 14,
    mode: "handwritten",
    font: "Kalam",
    paper: { kind: "ruled", line: "rgba(66,110,190,0.20)", margin: "rgba(214,48,49,0.45)" },
    annotation: "#c62828",
    marker: "rgba(255,226,64,0.55)",
  },
  "hw-colorful": {
    key: "hw-colorful",
    name: "Colorful Medical Student Notes",
    description: "Cream notebook with green, purple and orange pens and pink/yellow highlights.",
    background: "#fdf8ec",
    card: "rgba(255,255,255,0.0)",
    border: "#6b21a8",
    foreground: "#1d1b33",
    muted: "#5b5675",
    accent: "#15803d",
    accentInk: "#fdf8ec",
    correct: "#b91c1c",
    correctSoft: "rgba(255,170,210,0.45)",
    highlight: "#c2410c",
    highlightSoft: "rgba(255,226,64,0.42)",
    bubble: "rgba(107,33,168,0.08)",
    radius: 18,
    mode: "handwritten",
    font: "Kalam",
    paper: { kind: "ruled", line: "rgba(110,90,200,0.16)", margin: "rgba(236,72,153,0.45)" },
    annotation: "#b91c1c",
    marker: "rgba(255,170,210,0.55)",
  },
  "hw-diagrams": {
    key: "hw-diagrams",
    name: "Hand-Drawn Clinical Diagrams",
    description: "Graph-paper page, dark pencil ink with blue and red annotations — built for hand-drawn diagrams.",
    background: "#f8f6ef",
    card: "rgba(255,255,255,0.0)",
    border: "#2b2b2b",
    foreground: "#232323",
    muted: "#55534d",
    accent: "#1e40af",
    accentInk: "#f8f6ef",
    correct: "#b91c1c",
    correctSoft: "rgba(255,226,64,0.42)",
    highlight: "#1e40af",
    highlightSoft: "rgba(147,197,253,0.35)",
    bubble: "rgba(35,35,35,0.06)",
    radius: 12,
    mode: "handwritten",
    font: "Kalam",
    paper: { kind: "grid", line: "rgba(90,120,160,0.16)", margin: null },
    annotation: "#b91c1c",
    marker: "rgba(255,226,64,0.55)",
  },
};

export function themeFor(key: string | null | undefined): SlideTheme {
  return TEMPLATES[(key as TemplateKey) ?? "midnight"] ?? TEMPLATES.midnight;
}

/** Template + the post's colour/font overrides. */
export function resolveTheme(design: Pick<PostDesign, "template" | "overrides">): SlideTheme {
  const base = themeFor(design.template);
  const o = design.overrides;
  if (!o) return base;
  const t: SlideTheme = { ...base };
  if (o.background) t.background = o.background;
  if (o.card) t.card = o.card;
  if (o.foreground) t.foreground = o.foreground;
  if (o.accent) {
    t.accent = o.accent;
    if (t.mode === "handwritten") t.border = o.accent;
  }
  if (o.highlight) t.highlight = o.highlight;
  if (o.font === "kalam") t.font = "Kalam";
  if (o.font === "geist") t.font = "Geist";
  return t;
}

export function templatesForMode(mode: DesignMode): TemplateKey[] {
  return (Object.keys(TEMPLATES) as TemplateKey[]).filter((k) => modeOfTemplate(k) === mode);
}
