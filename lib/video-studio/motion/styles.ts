/**
 * Motion Workflow Studio — style library (client-safe).
 *
 * One style per video, locked from the first frame to the last: the frames,
 * the motion set, the transition and the highlight treatment all come from
 * the style, so a video never mixes looks. The six layouts are independent
 * re-implementations of the six publicly described storyboard styles of the
 * "Motion Graphics Workflow" guide (go.theonlyworkshop.com/get/motion-workflow,
 * read 2026-10-25), adapted to medical teaching. No code, artwork or copy was
 * taken from it — only the publicly described ideas (style lock, one sentence
 * per frame, one motion and one highlighted word per frame, Instagram safe
 * zones, word-timed captions). See docs/ai-video-studio/MOTION-WORKFLOW.md.
 */

export const MOTION_KEYS = ["push_in", "slide_up", "pop", "draw", "count", "stagger", "pan", "flip", "ken_burns"] as const;
export type MotionKey = (typeof MOTION_KEYS)[number];

export const MOTION_LABELS: Record<MotionKey, { label: string; detail: string }> = {
  push_in: { label: "Push in", detail: "The camera moves slowly towards the main element." },
  slide_up: { label: "Slide up", detail: "The main element rises into place." },
  pop: { label: "Pop", detail: "The main element scales in with a small overshoot." },
  draw: { label: "Draw", detail: "Lines and arrows draw themselves, then labels appear." },
  count: { label: "Count up", detail: "A number counts up to its value." },
  stagger: { label: "Build list", detail: "Items appear one after another, in time with the voice." },
  pan: { label: "Camera pan", detail: "The camera travels across the map to the next node." },
  flip: { label: "Card flip", detail: "A card turns to reveal its back (answers, diagnoses)." },
  ken_burns: { label: "Ken Burns", detail: "A slow zoom and drift over a still image." },
};

/** FFmpeg xfade transitions a style may use between frames (whitelisted in the render container). */
export const TRANSITIONS = ["none", "fade", "slideleft", "slideup", "smoothup", "circleopen", "fadeblack"] as const;
export type Transition = (typeof TRANSITIONS)[number];

export type MotionLayout = "map" | "levels" | "case" | "calendar" | "cards" | "photo" | "board" | "kinetic";

export interface MotionPalette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  /** Marker / text colour of the one highlighted word. */
  highlight: string;
  highlightText: string;
  line: string;
}

export interface MotionStyle {
  key: string;
  name: string;
  /** The reference style the idea comes from (credited, not copied). */
  inspiredBy: string;
  /** The one job this style does best. */
  job: string;
  description: string;
  bestFor: string[];
  layout: MotionLayout;
  status: "ready" | "needs_images";
  palette: MotionPalette;
  devanagari: "noto" | "kalam";
  /** Motions the storyboard may use with this style (anything else is replaced). */
  motions: MotionKey[];
  transition: { type: Transition; sec: number };
  highlight: "marker" | "underline" | "box";
  /** Label shown on each frame's tag (Level / Day / Step), if the layout uses one. */
  tagHint: string | null;
  grain: boolean;
}

const LIGHT: MotionPalette = { background: "#f6f6f1", surface: "#ffffff", text: "#111111", muted: "#555555", accent: "#111111", highlight: "#d4f54a", highlightText: "#111111", line: "#bdbdb4" };

export const MOTION_STYLES: MotionStyle[] = [
  {
    key: "concept_map",
    name: "Concept Map Journey",
    inspiredBy: "One Take",
    job: "Explaining a pathway or three linked ideas in one picture",
    description: "One continuous camera move over a map of connected nodes — each sentence travels to the next node — then a pull-back shows the whole map.",
    bestFor: ["Diagram explainers", "Pathways and mechanisms", "Classifications"],
    layout: "map",
    status: "ready",
    palette: { ...LIGHT },
    devanagari: "noto",
    motions: ["pan", "draw", "push_in"],
    transition: { type: "none", sec: 0 },
    highlight: "marker",
    tagHint: null,
    grain: false,
  },
  {
    key: "level_up",
    name: "Level Up Revision",
    inspiredBy: "Levels",
    job: "Teaching a process or a revision list as a game",
    description: "Learning shown as levels with a progress bar and hearts; the final level is a boss question from the Question Bank.",
    bestFor: ["Exam revision", "MCQ explainers", "Step-by-step processes"],
    layout: "levels",
    status: "ready",
    palette: { background: "#fbfbf7", surface: "#ffffff", text: "#141414", muted: "#5b5b5b", accent: "#141414", highlight: "#c7f03d", highlightText: "#141414", line: "#d0d0c8" },
    devanagari: "noto",
    motions: ["pop", "slide_up", "stagger", "flip"],
    transition: { type: "slideleft", sec: 0.35 },
    highlight: "marker",
    tagHint: "Level 1 / Level 2 / Boss",
    grain: false,
  },
  {
    key: "case_story",
    name: "Clinical Case Story",
    inspiredBy: "The Profile",
    job: "One (fictional) patient, from presentation to diagnosis",
    description: "A case file that follows one illustrative patient: complaint, key finding, the reveal, the next step — told in the patient's timeline.",
    bestFor: ["Clinical cases", "Diagnosis reveals"],
    layout: "case",
    status: "ready",
    palette: { background: "#0f1115", surface: "#1b1f27", text: "#f4f4f2", muted: "#a7adb8", accent: "#ff7a59", highlight: "#ff7a59", highlightText: "#0f1115", line: "#363c48" },
    devanagari: "noto",
    motions: ["slide_up", "push_in", "flip", "stagger"],
    transition: { type: "fadeblack", sec: 0.4 },
    highlight: "underline",
    tagHint: "Presentation / Finding / Diagnosis / Next step",
    grain: true,
  },
  {
    key: "time_course",
    name: "Time-Course Calendar",
    inspiredBy: "Three Days",
    job: "Anything that changes over hours or days",
    description: "A tear-off calendar carries the story across time points (Hour 0, Hour 6, Day 3…) — ideal for marker kinetics, drug timelines and disease course.",
    bestFor: ["Marker timelines", "Pharmacokinetics", "Natural history of disease"],
    layout: "calendar",
    status: "ready",
    palette: { background: "#f3efe6", surface: "#fffdf8", text: "#1d1b16", muted: "#6b665a", accent: "#c2410c", highlight: "#fde68a", highlightText: "#1d1b16", line: "#d6cfbf" },
    devanagari: "kalam",
    motions: ["flip", "count", "slide_up", "stagger"],
    transition: { type: "slideup", sec: 0.35 },
    highlight: "marker",
    tagHint: "Hour 0 / Hour 6 / Day 3",
    grain: false,
  },
  {
    key: "big_sentence",
    name: "Big Sentence Cards",
    inspiredBy: "Crisp Original",
    job: "Fast revision reels and promos",
    description: "One big sentence on top, one card below (a diagram, a stat, a list or a question) with a lime shadow — fast, high-contrast, readable on a phone.",
    bestFor: ["Revision reels", "Promotional videos", "High-yield facts"],
    layout: "cards",
    status: "ready",
    palette: { background: "#ffffff", surface: "#ffffff", text: "#0b0b0b", muted: "#4b4b4b", accent: "#0b0b0b", highlight: "#c6f432", highlightText: "#0b0b0b", line: "#0b0b0b" },
    devanagari: "noto",
    motions: ["pop", "slide_up", "count", "stagger", "draw"],
    transition: { type: "smoothup", sec: 0.3 },
    highlight: "box",
    tagHint: null,
    grain: false,
  },
  {
    key: "photo_story",
    name: "Photo Story",
    inspiredBy: "Studio Film",
    job: "Real images with calm subtitles",
    description: "Your uploaded images full-bleed with a slow Ken Burns move, film grain and calm word-timed subtitles. Needs your own (licensed) images — no AI footage is generated.",
    bestFor: ["Awareness videos", "Image explainers", "Promotional videos"],
    layout: "photo",
    status: "needs_images",
    palette: { background: "#000000", surface: "rgba(0,0,0,0.55)", text: "#ffffff", muted: "#d4d4d4", accent: "#ffffff", highlight: "#facc15", highlightText: "#000000", line: "#ffffff" },
    devanagari: "noto",
    motions: ["ken_burns", "push_in"],
    transition: { type: "fade", sec: 0.5 },
    highlight: "underline",
    tagHint: null,
    grain: true,
  },
  /**
   * Styles added 2026-10-29 (Media Studio Phase 3). Original CSS only (no GSAP, no copied artwork): the
   * whiteboard "writes" its headline and draws each box's outline with a marker; kinetic typography lands
   * each on-screen word at the second it is spoken. Both are plain CSS keyframes, so the render container
   * seeks them frame by frame like every other style.
   */
  {
    key: "whiteboard",
    name: "Whiteboard Draw",
    inspiredBy: "Classroom whiteboard teaching",
    job: "Teaching a concept the way a teacher explains it on a board",
    description: "A clean whiteboard: the headline is written in marker as it is spoken, boxes and arrows draw themselves, and the key word is underlined in red.",
    bestFor: ["Concept explainers", "Pathways and mechanisms", "Step-by-step teaching"],
    layout: "board",
    status: "ready",
    palette: { background: "#fbfbf8", surface: "#ffffff", text: "#1f2937", muted: "#4b5563", accent: "#1d4ed8", highlight: "#dc2626", highlightText: "#ffffff", line: "#1f2937" },
    devanagari: "kalam",
    motions: ["draw", "stagger", "count"],
    transition: { type: "fade", sec: 0.35 },
    highlight: "underline",
    tagHint: null,
    grain: false,
  },
  {
    key: "kinetic_type",
    name: "Kinetic Typography",
    inspiredBy: "Kinetic type reels",
    job: "High-energy revision lines where the words themselves are the visual",
    description: "Big bold words land one by one in time with the voice — slam, slide and drop — with the key word largest in colour. Best for short, punchy facts.",
    bestFor: ["Revision reels", "Mnemonics", "One-line high-yield facts"],
    layout: "kinetic",
    status: "ready",
    palette: { background: "#0b0b12", surface: "#171723", text: "#f8f8f2", muted: "#a1a1b5", accent: "#7cf0c5", highlight: "#ffd23f", highlightText: "#0b0b12", line: "#34344a" },
    devanagari: "noto",
    motions: ["pop", "slide_up", "stagger", "count"],
    transition: { type: "slideup", sec: 0.3 },
    highlight: "box",
    tagHint: null,
    grain: false,
  },
];

export const MOTION_STYLE_MAP: Record<string, MotionStyle> = Object.fromEntries(MOTION_STYLES.map((s) => [s.key, s]));

/** Relative luminance contrast ratio (WCAG 2) of two #rrggbb colours; null when either is not a plain hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const x = lum(a);
  const y = lum(b);
  if (x === null || y === null) return null;
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
}
