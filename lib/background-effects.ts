/**
 * Background Effects (Admin → Website → Appearance → Background Effects) —
 * PRESENTATION ONLY.
 *
 * Four decorative background designs, each with its own glow, rendered
 * behind the homepage / public pages / Student Dashboard. Completely
 * separate from the button Premium Glow (lib/premium-glow.ts): different
 * Setting key, different code, nothing shared.
 *
 * Pure module (no server imports): the admin form, the live preview and the
 * site renderer (components/background-effects/renderer.tsx) all use the
 * same defaults, palettes and validation from here. Values end up in inline
 * styles, so every field is validated against an allowlist / numeric range
 * on save AND on read — no free-form CSS can ever render.
 */

export const BG_DESIGNS = ["DOTTED_WATERMARK", "DOTTED_PATTERN", "GALAXY", "GRADIENT_DOTS"] as const;
export type BgDesign = (typeof BG_DESIGNS)[number];
export const BG_DESIGN_LABELS: Record<BgDesign, string> = {
  DOTTED_WATERMARK: "Dotted Watermark",
  DOTTED_PATTERN: "Full Dotted Pattern",
  GALAXY: "Galaxy Particle Formation",
  GRADIENT_DOTS: "Gradient Dots + Watermark",
};
export const BG_GLOW_LABELS: Record<BgDesign, string> = {
  DOTTED_WATERMARK: "Soft Neon Glow",
  DOTTED_PATTERN: "Ambient Dot Glow",
  GALAXY: "Particle Trail Glow",
  GRADIENT_DOTS: "Aurora Glow",
};

export const BG_SCOPES = ["HOMEPAGE", "PUBLIC", "STUDENT_DASHBOARD", "HOMEPAGE_AND_DASHBOARD"] as const;
export type BgScope = (typeof BG_SCOPES)[number];
export const BG_SCOPE_LABELS: Record<BgScope, string> = {
  HOMEPAGE: "Homepage Only",
  PUBLIC: "Public Website",
  STUDENT_DASHBOARD: "Student Dashboard",
  HOMEPAGE_AND_DASHBOARD: "Homepage + Student Dashboard",
};
/** Where a background can be mounted. Each surface asks whether the saved scope covers it. */
export type BgSurface = "HOMEPAGE" | "PUBLIC" | "STUDENT";
const SCOPE_SURFACES: Record<BgScope, readonly BgSurface[]> = {
  HOMEPAGE: ["HOMEPAGE"],
  // "Public Website" includes the homepage.
  PUBLIC: ["HOMEPAGE", "PUBLIC"],
  STUDENT_DASHBOARD: ["STUDENT"],
  HOMEPAGE_AND_DASHBOARD: ["HOMEPAGE", "STUDENT"],
};
export const scopeCovers = (scope: BgScope, surface: BgSurface) => SCOPE_SURFACES[scope].includes(surface);

// Routes that never show a background — enforced by the scope gate on the
// mounted layer (components/background-effects/scope-gate.tsx).
export { BG_EXCLUDED_PREFIXES, isBgExcludedPath } from "./background-effects-scope";

export const BG_THEME_MODES = ["AUTO", "DARK", "LIGHT"] as const;
export type BgThemeMode = (typeof BG_THEME_MODES)[number];
export const BG_THEME_LABELS: Record<BgThemeMode, string> = { AUTO: "Automatic", DARK: "Dark", LIGHT: "Light" };

export const BG_DOT_COLORS = ["WHITE", "SOFT_BLUE", "CYAN", "GREY", "CUSTOM"] as const;
export type BgDotColor = (typeof BG_DOT_COLORS)[number];
export const BG_DOT_COLOR_LABELS: Record<BgDotColor, string> = {
  WHITE: "White",
  SOFT_BLUE: "Soft Blue",
  CYAN: "Cyan",
  GREY: "Grey",
  CUSTOM: "Custom Color",
};
export const BG_GLOW_COLORS = ["BLUE", "CYAN", "PURPLE", "WHITE", "CUSTOM"] as const;
export type BgGlowColor = (typeof BG_GLOW_COLORS)[number];
export const BG_GLOW_COLOR_LABELS: Record<BgGlowColor, string> = {
  BLUE: "Blue",
  CYAN: "Cyan",
  PURPLE: "Purple",
  WHITE: "White",
  CUSTOM: "Custom",
};

export const BG_SIZES = ["SMALL", "MEDIUM", "LARGE"] as const;
export type BgSize = (typeof BG_SIZES)[number];
export const BG_SIZE_LABELS: Record<BgSize, string> = { SMALL: "Small", MEDIUM: "Medium", LARGE: "Large" };
export const BG_SPREADS = ["LOW", "MEDIUM", "HIGH"] as const;
export type BgSpread = (typeof BG_SPREADS)[number];
export const BG_SPREAD_LABELS: Record<BgSpread, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };
export const BG_POSITIONS = ["CENTER", "TOP", "BOTTOM"] as const;
export type BgPosition = (typeof BG_POSITIONS)[number];
export const BG_POSITION_LABELS: Record<BgPosition, string> = { CENTER: "Center", TOP: "Top", BOTTOM: "Bottom" };

/** Safe numeric ranges — enforced on save (reject) and on read (clamp). */
export const BG_LIMITS = {
  dotSpacing: { min: 6, max: 32 },
  opacity: { min: 1, max: 20 },
  glowIntensity: { min: 0, max: 100 },
  galaxyDuration: { min: 2, max: 6 },
  galaxyParticles: { min: 60, max: 500 },
} as const;
/** Mobile never draws more than this many particles, whatever the desktop count. */
export const BG_GALAXY_MOBILE_MAX = 180;

export const BG_HEX_RE = /^#[0-9a-fA-F]{6}$/;

export type BgDesignSettings = {
  dotColor: BgDotColor;
  dotCustomColor: string;
  dotSize: BgSize;
  dotSpacing: number;
  /** Percent, 1–20. */
  opacity: number;
  watermarkPosition: BgPosition;
  watermarkScale: BgSize;
  glowEnabled: boolean;
  glowColor: BgGlowColor;
  glowCustomColor: string;
  /** Percent, 0–100. */
  glowIntensity: number;
  glowSpread: BgSpread;
  glowAnimation: boolean;
  /** Galaxy only: play the particle formation (off = the finished wordmark, no JavaScript). */
  galaxyAnimate: boolean;
  /** Galaxy only: seconds, 2–6 in half-second steps. */
  galaxyDuration: number;
  /** Galaxy only: desktop upper limit (mobile is capped at BG_GALAXY_MOBILE_MAX). */
  galaxyParticles: number;
};

export type BackgroundEffectsConfig = {
  enabled: boolean;
  design: BgDesign;
  scope: BgScope;
  theme: BgThemeMode;
  /** Every design keeps its own settings; switching designs never touches another's. */
  designs: Record<BgDesign, BgDesignSettings>;
};

const BASE: BgDesignSettings = {
  dotColor: "SOFT_BLUE",
  dotCustomColor: "#7DD3FC",
  dotSize: "MEDIUM",
  dotSpacing: 8,
  opacity: 10,
  watermarkPosition: "CENTER",
  watermarkScale: "LARGE",
  glowEnabled: false,
  glowColor: "CYAN",
  glowCustomColor: "#22D3EE",
  glowIntensity: 30,
  glowSpread: "MEDIUM",
  glowAnimation: false,
  galaxyAnimate: false,
  galaxyDuration: 4,
  galaxyParticles: 500,
};

export function defaultDesignSettings(design: BgDesign): BgDesignSettings {
  switch (design) {
    case "DOTTED_WATERMARK":
      return { ...BASE };
    case "DOTTED_PATTERN":
      return { ...BASE, dotColor: "WHITE", dotSize: "SMALL", dotSpacing: 18, opacity: 8, glowColor: "BLUE", glowIntensity: 15 };
    case "GALAXY":
      return { ...BASE, dotColor: "WHITE", opacity: 12, glowIntensity: 40 };
    case "GRADIENT_DOTS":
      return { ...BASE, dotSize: "SMALL", dotSpacing: 16, opacity: 8, glowIntensity: 20 };
  }
}

/** Shipped state: OFF, so the site looks exactly as before until an admin turns it on. */
export function defaultBackgroundEffectsConfig(): BackgroundEffectsConfig {
  return {
    enabled: false,
    design: "DOTTED_WATERMARK",
    scope: "HOMEPAGE",
    theme: "AUTO",
    designs: Object.fromEntries(BG_DESIGNS.map((d) => [d, defaultDesignSettings(d)])) as Record<BgDesign, BgDesignSettings>,
  };
}

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lim: { min: number; max: number }) => Math.min(lim.max, Math.max(lim.min, v));
const halfStep = (v: number) => Math.round(v * 2) / 2;

/** Tolerant parse of one stored design: each field falls back on its own. */
function parseDesign(raw: unknown, design: BgDesign): BgDesignSettings {
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = defaultDesignSettings(design);
  if (isOneOf(BG_DOT_COLORS, doc.dotColor)) out.dotColor = doc.dotColor;
  if (typeof doc.dotCustomColor === "string" && BG_HEX_RE.test(doc.dotCustomColor)) out.dotCustomColor = doc.dotCustomColor.toUpperCase();
  if (isOneOf(BG_SIZES, doc.dotSize)) out.dotSize = doc.dotSize;
  if (isNum(doc.dotSpacing)) out.dotSpacing = clamp(Math.round(doc.dotSpacing), BG_LIMITS.dotSpacing);
  if (isNum(doc.opacity)) out.opacity = clamp(Math.round(doc.opacity), BG_LIMITS.opacity);
  if (isOneOf(BG_POSITIONS, doc.watermarkPosition)) out.watermarkPosition = doc.watermarkPosition;
  if (isOneOf(BG_SIZES, doc.watermarkScale)) out.watermarkScale = doc.watermarkScale;
  if (typeof doc.glowEnabled === "boolean") out.glowEnabled = doc.glowEnabled;
  if (isOneOf(BG_GLOW_COLORS, doc.glowColor)) out.glowColor = doc.glowColor;
  if (typeof doc.glowCustomColor === "string" && BG_HEX_RE.test(doc.glowCustomColor)) out.glowCustomColor = doc.glowCustomColor.toUpperCase();
  if (isNum(doc.glowIntensity)) out.glowIntensity = clamp(Math.round(doc.glowIntensity), BG_LIMITS.glowIntensity);
  if (isOneOf(BG_SPREADS, doc.glowSpread)) out.glowSpread = doc.glowSpread;
  if (typeof doc.glowAnimation === "boolean") out.glowAnimation = doc.glowAnimation;
  if (typeof doc.galaxyAnimate === "boolean") out.galaxyAnimate = doc.galaxyAnimate;
  if (isNum(doc.galaxyDuration)) out.galaxyDuration = clamp(halfStep(doc.galaxyDuration), BG_LIMITS.galaxyDuration);
  if (isNum(doc.galaxyParticles)) out.galaxyParticles = clamp(Math.round(doc.galaxyParticles), BG_LIMITS.galaxyParticles);
  return out;
}

/** Tolerant parse of the stored document. A missing or broken row reads as the (OFF) defaults. */
export function parseBackgroundEffectsConfig(raw: unknown): BackgroundEffectsConfig {
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = defaultBackgroundEffectsConfig();
  if (typeof doc.enabled === "boolean") out.enabled = doc.enabled;
  if (isOneOf(BG_DESIGNS, doc.design)) out.design = doc.design;
  if (isOneOf(BG_SCOPES, doc.scope)) out.scope = doc.scope;
  if (isOneOf(BG_THEME_MODES, doc.theme)) out.theme = doc.theme;
  const designs = doc.designs && typeof doc.designs === "object" ? (doc.designs as Record<string, unknown>) : {};
  for (const d of BG_DESIGNS) out.designs[d] = parseDesign(designs[d], d);
  return out;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function validateDesign(raw: unknown, design: BgDesign): Result<BgDesignSettings> {
  const name = BG_DESIGN_LABELS[design];
  if (!raw || typeof raw !== "object") return { ok: false, error: `${name}: missing settings.` };
  const d = raw as Record<string, unknown>;
  const inRange = (v: unknown, lim: { min: number; max: number }) => isNum(v) && v >= lim.min && v <= lim.max;
  if (!isOneOf(BG_DOT_COLORS, d.dotColor)) return { ok: false, error: `${name}: unknown dot color.` };
  if (typeof d.dotCustomColor !== "string" || !BG_HEX_RE.test(d.dotCustomColor)) return { ok: false, error: `${name}: custom dot color must be a 6-digit hex color like #7DD3FC.` };
  if (!isOneOf(BG_SIZES, d.dotSize)) return { ok: false, error: `${name}: dot size must be Small, Medium or Large.` };
  if (!inRange(d.dotSpacing, BG_LIMITS.dotSpacing) || !Number.isInteger(d.dotSpacing)) return { ok: false, error: `${name}: dot spacing must be ${BG_LIMITS.dotSpacing.min}–${BG_LIMITS.dotSpacing.max} px.` };
  if (!inRange(d.opacity, BG_LIMITS.opacity) || !Number.isInteger(d.opacity)) return { ok: false, error: `${name}: opacity must be ${BG_LIMITS.opacity.min}–${BG_LIMITS.opacity.max}%.` };
  if (!isOneOf(BG_POSITIONS, d.watermarkPosition)) return { ok: false, error: `${name}: watermark position must be Center, Top or Bottom.` };
  if (!isOneOf(BG_SIZES, d.watermarkScale)) return { ok: false, error: `${name}: watermark scale must be Small, Medium or Large.` };
  if (typeof d.glowEnabled !== "boolean") return { ok: false, error: `${name}: glow must be ON or OFF.` };
  if (!isOneOf(BG_GLOW_COLORS, d.glowColor)) return { ok: false, error: `${name}: unknown glow color.` };
  if (typeof d.glowCustomColor !== "string" || !BG_HEX_RE.test(d.glowCustomColor)) return { ok: false, error: `${name}: custom glow color must be a 6-digit hex color like #22D3EE.` };
  if (!inRange(d.glowIntensity, BG_LIMITS.glowIntensity) || !Number.isInteger(d.glowIntensity)) return { ok: false, error: `${name}: glow intensity must be 0–100%.` };
  if (!isOneOf(BG_SPREADS, d.glowSpread)) return { ok: false, error: `${name}: glow spread must be Low, Medium or High.` };
  if (typeof d.glowAnimation !== "boolean") return { ok: false, error: `${name}: glow animation must be ON or OFF.` };
  if (typeof d.galaxyAnimate !== "boolean") return { ok: false, error: `${name}: galaxy animation must be ON or OFF.` };
  if (!inRange(d.galaxyDuration, BG_LIMITS.galaxyDuration) || halfStep(d.galaxyDuration as number) !== d.galaxyDuration) {
    return { ok: false, error: `${name}: animation duration must be 2–6 seconds.` };
  }
  if (!inRange(d.galaxyParticles, BG_LIMITS.galaxyParticles) || !Number.isInteger(d.galaxyParticles)) {
    return { ok: false, error: `${name}: particle count must be ${BG_LIMITS.galaxyParticles.min}–${BG_LIMITS.galaxyParticles.max}.` };
  }
  return {
    ok: true,
    value: {
      dotColor: d.dotColor,
      dotCustomColor: d.dotCustomColor.toUpperCase(),
      dotSize: d.dotSize,
      dotSpacing: d.dotSpacing as number,
      opacity: d.opacity as number,
      watermarkPosition: d.watermarkPosition,
      watermarkScale: d.watermarkScale,
      glowEnabled: d.glowEnabled,
      glowColor: d.glowColor,
      glowCustomColor: d.glowCustomColor.toUpperCase(),
      glowIntensity: d.glowIntensity as number,
      glowSpread: d.glowSpread,
      glowAnimation: d.glowAnimation,
      galaxyAnimate: d.galaxyAnimate,
      galaxyDuration: d.galaxyDuration as number,
      galaxyParticles: d.galaxyParticles as number,
    },
  };
}

/** Strict validation for an admin save: rejects (never silently fixes) anything out of range or unknown. */
export function validateBackgroundEffectsConfig(raw: unknown): { ok: true; config: BackgroundEffectsConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid settings." };
  const doc = raw as Record<string, unknown>;
  if (typeof doc.enabled !== "boolean") return { ok: false, error: "Background Effects must be ON or OFF." };
  if (!isOneOf(BG_DESIGNS, doc.design)) return { ok: false, error: "Unknown background design." };
  if (!isOneOf(BG_SCOPES, doc.scope)) return { ok: false, error: "Unknown Apply To option." };
  if (!isOneOf(BG_THEME_MODES, doc.theme)) return { ok: false, error: "Theme Behavior must be Automatic, Dark or Light." };
  if (!doc.designs || typeof doc.designs !== "object") return { ok: false, error: "Missing design settings." };
  const designs = doc.designs as Record<string, unknown>;
  const keys = Object.keys(designs);
  if (keys.length !== BG_DESIGNS.length || keys.some((k) => !isOneOf(BG_DESIGNS, k))) return { ok: false, error: "Unknown background design." };
  const out = {} as Record<BgDesign, BgDesignSettings>;
  for (const d of BG_DESIGNS) {
    const r = validateDesign(designs[d], d);
    if (!r.ok) return r;
    out[d] = r.value;
  }
  return { ok: true, config: { enabled: doc.enabled, design: doc.design, scope: doc.scope, theme: doc.theme, designs: out } };
}

// ---------------------------------------------------------------------------
// Colors. Every named color has a dark-theme and a light-theme value: white
// dots would vanish on the light canvas, so they become a soft dark grey.

const DOT_PALETTE: Record<Exclude<BgDotColor, "CUSTOM">, { dark: string; light: string }> = {
  WHITE: { dark: "#FFFFFF", light: "#374151" },
  SOFT_BLUE: { dark: "#93C5FD", light: "#1E40AF" },
  CYAN: { dark: "#67E8F9", light: "#0E7490" },
  GREY: { dark: "#A3A3A3", light: "#4B5563" },
};
const GLOW_PALETTE: Record<Exclude<BgGlowColor, "CUSTOM">, { dark: string; light: string }> = {
  BLUE: { dark: "#3B82F6", light: "#3B82F6" },
  CYAN: { dark: "#22D3EE", light: "#06B6D4" },
  PURPLE: { dark: "#A78BFA", light: "#8B5CF6" },
  WHITE: { dark: "#FFFFFF", light: "#94A3B8" },
};

export function resolveDotColors(s: BgDesignSettings) {
  return s.dotColor === "CUSTOM" ? { dark: s.dotCustomColor, light: s.dotCustomColor } : DOT_PALETTE[s.dotColor];
}
export function resolveGlowColors(s: BgDesignSettings) {
  return s.glowColor === "CUSTOM" ? { dark: s.glowCustomColor, light: s.glowCustomColor } : GLOW_PALETTE[s.glowColor];
}

/** `#RRGGBB` (already validated) + alpha → `rgba(…)`. */
export function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Mix two `#RRGGBB` colors (t = share of b). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export const BG_DOT_SIZE_PX: Record<BgSize, number> = { SMALL: 1.5, MEDIUM: 2, LARGE: 3 };
export const BG_WORDMARK = "MockTestSeries.in";
