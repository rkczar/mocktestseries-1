import type { AppearanceColors } from "@/lib/appearance";

/**
 * Premade palettes for Admin → Website → Appearance → Design Tokens.
 *
 * A palette is just a set of values for the EXISTING brand tokens
 * (primary … info), saved through the existing Appearance form/action into
 * the same AppearanceConfig row. Background, surface, text and border are
 * not admin tokens: they belong to the per-viewer Day / Night / Eye-Saver
 * modes (app/globals.css). So a monochrome palette also carries:
 *   - `modes[own]`  — structural values for its own mode (e.g. Night for
 *     Midnight Monochrome), applied only in that mode;
 *   - `counterpart` — brand values used in the OPPOSITE mode, so a white
 *     primary never lands on a white Day background (and a black one never
 *     on the black Night canvas);
 *   - `defaultMode` — the mode a visitor gets until they pick one with the
 *     header toggle (their choice always wins).
 * Eye-Saver keeps its own grayscale overrides untouched.
 */

export type PaletteMode = "dark" | "light";

export interface StructuralTokens {
  background: string;
  surface: string;
  card: string;
  foreground: string;
  mutedForeground: string;
  border: string;
}

export interface AppearancePalette {
  id: string;
  name: string;
  description: string;
  themeType: PaletteMode;
  colors: AppearanceColors;
  /** Monochrome palettes only. */
  counterpart?: AppearanceColors;
  structural?: StructuralTokens;
  defaultMode: PaletteMode;
}

const MIDNIGHT: AppearanceColors = {
  primary: "#FFFFFF",
  secondary: "#D4D4D4",
  accent: "#A3A3A3",
  success: "#22C55E",
  error: "#EF4444",
  warning: "#F59E0B",
  info: "#38BDF8",
};

const CLEAN: AppearanceColors = {
  primary: "#111111",
  secondary: "#525252",
  accent: "#737373",
  success: "#15803D",
  error: "#DC2626",
  warning: "#B45309",
  info: "#0369A1",
};

/**
 * The live production brand colors (brand green #008209 + the existing
 * secondary/status tokens). "Brand Green (default)" restores exactly these, so
 * choosing it never changes the site's current look. The two monochrome
 * palettes are optional presets applied only by an explicit Admin action.
 */
export const BRAND_GREEN: AppearanceColors = {
  primary: "#008209",
  secondary: "#60A5FA",
  accent: "#EA580C",
  success: "#22C55E",
  error: "#F87171",
  warning: "#F59E0B",
  info: "#60A5FA",
};

export const APPEARANCE_PALETTES: AppearancePalette[] = [
  {
    id: "brand-default",
    name: "Brand Green (default)",
    description: "The current MockTestSeries.in colors (brand green #008209). Works in Day, Night and Eye-Saver modes.",
    themeType: "dark",
    colors: BRAND_GREEN,
    defaultMode: "dark",
  },
  {
    id: "midnight-monochrome",
    name: "Midnight Monochrome",
    description: "Dark. Black background, white type, grey surfaces — color only for status (correct, wrong, warning, info).",
    themeType: "dark",
    colors: MIDNIGHT,
    counterpart: CLEAN,
    structural: { background: "#050505", surface: "#121212", card: "#121212", foreground: "#FFFFFF", mutedForeground: "#A3A3A3", border: "#303030" },
    defaultMode: "dark",
  },
  {
    id: "clean-monochrome",
    name: "Clean Monochrome",
    description: "Light. White background, black type, light-grey surfaces — color only for status (correct, wrong, warning, info).",
    themeType: "light",
    colors: CLEAN,
    counterpart: MIDNIGHT,
    structural: { background: "#FFFFFF", surface: "#F7F7F7", card: "#FFFFFF", foreground: "#111111", mutedForeground: "#525252", border: "#E5E5E5" },
    defaultMode: "light",
  },
];

export const PALETTE_IDS = APPEARANCE_PALETTES.map((p) => p.id);

export function getPalette(id: unknown): AppearancePalette | null {
  return APPEARANCE_PALETTES.find((p) => p.id === id) ?? null;
}

const TOKENS = ["primary", "secondary", "accent", "success", "error", "warning", "info"] as const;

/** True when `colors` are exactly the palette's own values (any manual edit makes the palette "Custom"). */
export function colorsMatchPalette(colors: AppearanceColors, palette: AppearancePalette): boolean {
  return TOKENS.every((t) => colors[t].toLowerCase() === palette.colors[t].toLowerCase());
}

/** WCAG relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
