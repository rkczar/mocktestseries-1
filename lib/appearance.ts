import { prisma } from "@/lib/prisma";

export interface AppearanceColors {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

export interface AppearanceFonts {
  heading: string;
  body: string;
}

export interface AppearanceButtonStyle {
  radius: string;
}

export interface AppearanceComponentStyle {
  cardRadius: string;
  shadowIntensity: "none" | "sm" | "md";
}

export const DEFAULT_APPEARANCE = {
  colors: {
    primary: "#3B82F6",
    secondary: "#60A5FA",
    accent: "#EA580C",
    success: "#22C55E",
    error: "#F87171",
    warning: "#F59E0B",
    info: "#60A5FA",
  } satisfies AppearanceColors,
  fonts: {
    heading: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    body: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  } satisfies AppearanceFonts,
  buttonStyle: { radius: "0.625rem" } satisfies AppearanceButtonStyle,
  componentStyle: { cardRadius: "0.75rem", shadowIntensity: "sm" } satisfies AppearanceComponentStyle,
};

/**
 * Appearance values are interpolated into a <style> block in the <head> of
 * EVERY page (app/layout.tsx), so they are treated as untrusted and must
 * match these allow-lists — on save (the Admin action) AND on read
 * (getAppearance), so a row written before this validation existed can
 * never render. Nothing outside these grammars can close the style tag or
 * inject CSS/HTML/JS.
 */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** Exactly the options offered by the Appearance form. */
export const BUTTON_RADIUS_OPTIONS = ["0rem", "0.375rem", "0.5rem", "1rem"] as const;
export const CARD_RADIUS_OPTIONS = ["0rem", "0.5rem", "0.75rem", "1.25rem"] as const;
export const SHADOW_OPTIONS = ["none", "sm", "md"] as const;
/**
 * A CSS font-family list: comma-separated family names — bare identifiers
 * (letters, digits, spaces, hyphens), quoted names with the same
 * characters, or a `var(--custom-property)` (e.g. the Geist next/font
 * variable). No `;`, `{`, `}`, `<`, `>`, `/`, `\`, `(` beyond var(), URLs or
 * other CSS syntax can appear.
 */
const FONT_FAMILY_ITEM = String.raw`(?:var\(--[A-Za-z0-9-]{1,60}\)|[A-Za-z][A-Za-z0-9 -]{0,60}|"[A-Za-z0-9 -]{1,60}"|'[A-Za-z0-9 -]{1,60}')`;
export const FONT_STACK_RE = new RegExp(String.raw`^\s*${FONT_FAMILY_ITEM}(?:\s*,\s*${FONT_FAMILY_ITEM}){0,9}\s*$`);
export const FONT_STACK_MAX_LENGTH = 300;

export function isValidFontStack(value: unknown): value is string {
  return typeof value === "string" && value.length <= FONT_STACK_MAX_LENGTH && FONT_STACK_RE.test(value);
}
const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

/** Keeps each stored value only if it passes its allow-list; anything else falls back to the default. */
function sanitizeAppearance(raw: {
  colors?: Partial<Record<keyof AppearanceColors, unknown>>;
  fonts?: Partial<Record<keyof AppearanceFonts, unknown>>;
  buttonStyle?: { radius?: unknown };
  componentStyle?: { cardRadius?: unknown; shadowIntensity?: unknown };
}): ResolvedAppearance {
  const d = DEFAULT_APPEARANCE;
  const color = (k: keyof AppearanceColors) => {
    const v = raw.colors?.[k];
    return typeof v === "string" && HEX_COLOR_RE.test(v) ? v : d.colors[k];
  };
  return {
    colors: {
      primary: color("primary"),
      secondary: color("secondary"),
      accent: color("accent"),
      success: color("success"),
      error: color("error"),
      warning: color("warning"),
      info: color("info"),
    },
    fonts: {
      heading: isValidFontStack(raw.fonts?.heading) ? raw.fonts.heading : d.fonts.heading,
      body: isValidFontStack(raw.fonts?.body) ? raw.fonts.body : d.fonts.body,
    },
    buttonStyle: {
      radius: isOneOf(BUTTON_RADIUS_OPTIONS, raw.buttonStyle?.radius) ? raw.buttonStyle.radius : d.buttonStyle.radius,
    },
    componentStyle: {
      cardRadius: isOneOf(CARD_RADIUS_OPTIONS, raw.componentStyle?.cardRadius) ? raw.componentStyle.cardRadius : d.componentStyle.cardRadius,
      shadowIntensity: isOneOf(SHADOW_OPTIONS, raw.componentStyle?.shadowIntensity)
        ? raw.componentStyle.shadowIntensity
        : d.componentStyle.shadowIntensity,
    },
  };
}

export interface ResolvedAppearance {
  colors: AppearanceColors;
  fonts: AppearanceFonts;
  buttonStyle: AppearanceButtonStyle;
  componentStyle: AppearanceComponentStyle;
}

/**
 * Reads the single active AppearanceConfig row. Falls back to the brand
 * defaults (Section 7) if none exists yet or the DB isn't reachable — the
 * site must never break because Appearance hasn't been configured.
 */
export async function getAppearance(): Promise<ResolvedAppearance> {
  try {
    const config = await prisma.appearanceConfig.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!config) return DEFAULT_APPEARANCE;
    return sanitizeAppearance({
      colors: (config.colors ?? undefined) as Partial<Record<keyof AppearanceColors, unknown>> | undefined,
      fonts: (config.fonts ?? undefined) as Partial<Record<keyof AppearanceFonts, unknown>> | undefined,
      buttonStyle: (config.buttonStyle ?? undefined) as { radius?: unknown } | undefined,
      componentStyle: (config.componentStyle ?? undefined) as { cardRadius?: unknown; shadowIntensity?: unknown } | undefined,
    });
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function appearanceToCssVariables(appearance: ResolvedAppearance): string {
  const { colors, fonts, buttonStyle, componentStyle } = appearance;
  return `:root{
  --color-primary:${colors.primary};
  --color-secondary:${colors.secondary};
  --color-accent:${colors.accent};
  --color-success:${colors.success};
  --color-error:${colors.error};
  --color-warning:${colors.warning};
  --color-info:${colors.info};
  --font-heading:${fonts.heading};
  --font-body:${fonts.body};
  --radius-button:${buttonStyle.radius};
  --radius-card:${componentStyle.cardRadius};
}`;
}
