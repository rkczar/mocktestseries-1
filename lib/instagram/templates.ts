import type { TemplateKey } from "@/lib/instagram/types";

/**
 * Carousel templates. "midnight" is the default and mirrors the live website
 * tokens (app/globals.css dark theme + the active Appearance primary #008209):
 * black page, #171717 cards, white/12% borders, Geist, 1.25rem card radius.
 * The other three are variations for the owner to choose from; none of them
 * changes the website's own design system.
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
  },
};

export function themeFor(key: string | null | undefined): SlideTheme {
  return TEMPLATES[(key as TemplateKey) ?? "midnight"] ?? TEMPLATES.midnight;
}
