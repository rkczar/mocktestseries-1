import type { AspectRatio } from "@/lib/video-studio/types";

/**
 * AI Video Studio — Design Library (client-safe registry).
 *
 * A design is a set of theme tokens consumed by ONE scene template
 * (lib/video-studio/template.ts). The same template renders the admin's live
 * preview (browser) and the final frames (render worker, headless Chromium),
 * so a preview is exactly what will be rendered — no paid call is needed to
 * show a sample.
 *
 * `status`:
 *  - ready  : renderable from text/diagram/question scenes today.
 *  - later  : needs something not configured yet (licensed images, an
 *             approved image provider, or the AI Video Editor's recorded
 *             footage). Shown in the gallery as "Not available yet", never as
 *             selectable.
 * Render speed is not claimed until it is measured on the worker
 * (`renderNote` says so); cost is local CPU only (no provider charge).
 */

export type AnimationLevel = "none" | "subtle" | "moderate" | "high";
export type Decoration = "none" | "grid" | "blueprint" | "dots" | "ecg" | "paper" | "glow";
export type Motion = "fade" | "rise" | "slide" | "pop" | "zoom";

export interface DesignTheme {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  /** Devanagari face: "noto" (Noto Sans Devanagari) or "kalam" (handwritten). */
  devanagari: "noto" | "kalam";
  titleScale: number;
  radius: number;
  decoration: Decoration;
  motion: Motion;
  subtitleStyle: "clean" | "highlight" | "boxed";
}

export interface VideoDesign {
  key: string;
  name: string;
  description: string;
  bestFor: string[];
  aspects: AspectRatio[];
  animation: AnimationLevel;
  status: "ready" | "later";
  laterReason?: string;
  theme: DesignTheme;
}

const ALL: AspectRatio[] = ["9:16", "1:1", "4:5", "16:9"];

const base: DesignTheme = {
  background: "#0f172a",
  surface: "rgba(255,255,255,0.06)",
  text: "#f8fafc",
  muted: "#cbd5e1",
  accent: "#38bdf8",
  accent2: "#f59e0b",
  devanagari: "noto",
  titleScale: 1,
  radius: 28,
  decoration: "none",
  motion: "rise",
  subtitleStyle: "clean",
};

export const VIDEO_DESIGNS: VideoDesign[] = [
  { key: "medical_classroom", name: "Medical Classroom", description: "Calm teaching board: navy background, clear headings, one idea per frame.", bestFor: ["Teach a Topic", "Exam Revision"], aspects: ALL, animation: "subtle", status: "ready", theme: { ...base, decoration: "grid" } },
  { key: "clinical_case", name: "Clinical Case", description: "Case-file look with a vitals strip and a diagnosis reveal.", bestFor: ["Clinical Case", "Explain an MCQ"], aspects: ALL, animation: "subtle", status: "ready", theme: { ...base, background: "#111827", accent: "#f87171", accent2: "#34d399", decoration: "ecg" } },
  { key: "exam_revision", name: "Exam Revision", description: "High-contrast flash-card frames for rapid high-yield facts.", bestFor: ["Exam Revision", "Question Paper to Video"], aspects: ALL, animation: "moderate", status: "ready", theme: { ...base, background: "#1e1b4b", accent: "#facc15", accent2: "#a78bfa", motion: "pop", subtitleStyle: "highlight" } },
  { key: "diagram_explainer", name: "Diagram Explainer", description: "Boxes-and-arrows flows that build step by step.", bestFor: ["Diagram Explanation", "Mechanisms", "Pathways"], aspects: ALL, animation: "moderate", status: "ready", theme: { ...base, background: "#0b1324", accent: "#22d3ee", accent2: "#f472b6", decoration: "dots", motion: "slide" } },
  { key: "minimal_professional", name: "Minimal Professional", description: "White background, dark type, a single accent colour.", bestFor: ["Any topic", "Awareness"], aspects: ALL, animation: "subtle", status: "ready", theme: { ...base, background: "#ffffff", surface: "#f1f5f9", text: "#0f172a", muted: "#475569", accent: "#2563eb", accent2: "#0ea5e9", motion: "fade" } },
  { key: "motion_graphics", name: "Motion Graphics", description: "Bold shapes and energetic entrances.", bestFor: ["Animated Explainer", "Promotional Reel"], aspects: ALL, animation: "high", status: "ready", theme: { ...base, background: "#020617", accent: "#22c55e", accent2: "#eab308", motion: "pop", decoration: "glow" } },
  { key: "cinematic_educational", name: "Cinematic Educational", description: "Dark gradient, slow push-in, large serif-free titles.", bestFor: ["Medical Awareness", "Storytelling"], aspects: ALL, animation: "moderate", status: "ready", theme: { ...base, background: "linear-gradient(160deg,#0b0f19 0%,#1f2937 100%)", accent: "#fbbf24", accent2: "#60a5fa", motion: "zoom", titleScale: 1.1, decoration: "glow" } },
  { key: "brand_promotion", name: "Brand Promotion", description: "MockTestSeries.in colours with a strong call to action.", bestFor: ["Promotional Reel"], aspects: ALL, animation: "high", status: "ready", theme: { ...base, background: "linear-gradient(150deg,#1d4ed8 0%,#7c3aed 100%)", surface: "rgba(255,255,255,0.12)", accent: "#fde047", accent2: "#ffffff", motion: "pop", subtitleStyle: "boxed" } },
  { key: "medical_blueprint", name: "Medical Blueprint", description: "Technical blueprint grid with thin cyan line-work.", bestFor: ["Diagram Explanation", "Physiology"], aspects: ALL, animation: "moderate", status: "ready", theme: { ...base, background: "#0a2540", surface: "rgba(125,211,252,0.08)", accent: "#7dd3fc", accent2: "#fef08a", decoration: "blueprint", motion: "slide" } },
  { key: "ecg_animation", name: "ECG Animation", description: "Cardiology frames with an animated ECG trace.", bestFor: ["Cardiology", "Clinical Case"], aspects: ALL, animation: "moderate", status: "ready", theme: { ...base, background: "#04130d", accent: "#4ade80", accent2: "#f87171", decoration: "ecg" } },
  { key: "minimal_editorial", name: "Minimal Editorial", description: "Cream paper, editorial typography, handwritten Hindi accents.", bestFor: ["Awareness", "Explainers"], aspects: ALL, animation: "subtle", status: "ready", theme: { ...base, background: "#faf7f0", surface: "#efe9dc", text: "#1c1917", muted: "#57534e", accent: "#b45309", accent2: "#0f766e", devanagari: "kalam", motion: "fade" } },
  { key: "animated_infographic", name: "Animated Infographic", description: "Numbers and bullets that count and build in.", bestFor: ["Statistics", "Exam Revision"], aspects: ALL, animation: "high", status: "ready", theme: { ...base, background: "#0c0a09", accent: "#fb923c", accent2: "#38bdf8", motion: "pop", decoration: "dots" } },
  { key: "dynamic_reel", name: "Dynamic Reel / Dynamic Captions", description: "Fast vertical Reel with highlighted key-phrase captions.", bestFor: ["Promotional Reel", "Hooks"], aspects: ["9:16", "4:5", "1:1"], animation: "high", status: "ready", theme: { ...base, background: "#000000", accent: "#facc15", accent2: "#ec4899", motion: "pop", subtitleStyle: "highlight" } },
  { key: "anatomy_diagram", name: "Anatomy Diagram", description: "Labelled anatomy from approved, licensed images.", bestFor: ["Anatomy"], aspects: ALL, animation: "subtle", status: "later", laterReason: "Needs approved image sources (Question Bank images or licensed artwork) — generated anatomy is never treated as accurate.", theme: { ...base } },
  { key: "paper_collage", name: "Paper Collage", description: "Halftone paper-collage visual metaphors.", bestFor: ["Awareness", "Storytelling"], aspects: ALL, animation: "moderate", status: "later", laterReason: "Needs an approved image provider and a sample-first approval flow.", theme: { ...base, decoration: "paper" } },
  { key: "product_showcase", name: "Product Showcase", description: "Screens of MockTestSeries.in with motion callouts.", bestFor: ["Promotional Reel"], aspects: ALL, animation: "moderate", status: "later", laterReason: "Needs screenshot upload (PDF/image source pipeline).", theme: { ...base } },
  { key: "pip_teacher", name: "Picture-in-Picture Teacher", description: "Your recorded video beside a diagram or slide.", bestFor: ["AI Video Editor"], aspects: ALL, animation: "subtle", status: "later", laterReason: "AI Video Editor — needs the render worker (FFmpeg).", theme: { ...base } },
  { key: "clean_talking_head", name: "Clean Talking Head", description: "Your recording with clean captions, trims and branding.", bestFor: ["AI Video Editor"], aspects: ALL, animation: "subtle", status: "later", laterReason: "AI Video Editor — needs the render worker (FFmpeg).", theme: { ...base } },
  { key: "talking_head_bg", name: "Talking-Head Background Replacement", description: "Blur or replace the background of a recorded video.", bestFor: ["AI Video Editor"], aspects: ALL, animation: "subtle", status: "later", laterReason: "Needs a commercially licensed segmentation model (RVM is GPL-3.0) and the render worker.", theme: { ...base } },
];

export const DESIGN_MAP: Record<string, VideoDesign> = Object.fromEntries(VIDEO_DESIGNS.map((d) => [d.key, d]));

export function readyDesigns(aspect?: AspectRatio): VideoDesign[] {
  return VIDEO_DESIGNS.filter((d) => d.status === "ready" && (!aspect || d.aspects.includes(aspect)));
}

/** Theme overrides an admin may set (validated; anything else is ignored). */
export interface ThemeOverrides {
  accent?: string;
  accent2?: string;
  background?: string;
  text?: string;
  motion?: Motion;
  subtitleStyle?: DesignTheme["subtitleStyle"];
  devanagari?: DesignTheme["devanagari"];
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const MOTIONS: Motion[] = ["fade", "rise", "slide", "pop", "zoom"];

export function applyOverrides(theme: DesignTheme, o: unknown): DesignTheme {
  if (!o || typeof o !== "object") return theme;
  const r = o as Record<string, unknown>;
  const t = { ...theme };
  if (typeof r.accent === "string" && HEX.test(r.accent)) t.accent = r.accent;
  if (typeof r.accent2 === "string" && HEX.test(r.accent2)) t.accent2 = r.accent2;
  if (typeof r.background === "string" && HEX.test(r.background)) t.background = r.background;
  if (typeof r.text === "string" && HEX.test(r.text)) t.text = r.text;
  if (typeof r.motion === "string" && MOTIONS.includes(r.motion as Motion)) t.motion = r.motion as Motion;
  if (r.subtitleStyle === "clean" || r.subtitleStyle === "highlight" || r.subtitleStyle === "boxed") t.subtitleStyle = r.subtitleStyle;
  if (r.devanagari === "noto" || r.devanagari === "kalam") t.devanagari = r.devanagari;
  return t;
}
