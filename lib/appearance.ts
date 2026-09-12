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
    primary: "#0F4C81",
    secondary: "#1B6FA8",
    accent: "#F57C00",
    success: "#2E7D32",
    error: "#C62828",
    warning: "#F57C00",
    info: "#0F4C81",
  } satisfies AppearanceColors,
  fonts: {
    heading: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
    body: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  } satisfies AppearanceFonts,
  buttonStyle: { radius: "0.5rem" } satisfies AppearanceButtonStyle,
  componentStyle: { cardRadius: "0.75rem", shadowIntensity: "sm" } satisfies AppearanceComponentStyle,
};

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
    return {
      colors: { ...DEFAULT_APPEARANCE.colors, ...(config.colors as Partial<AppearanceColors>) },
      fonts: { ...DEFAULT_APPEARANCE.fonts, ...(config.fonts as Partial<AppearanceFonts>) },
      buttonStyle: { ...DEFAULT_APPEARANCE.buttonStyle, ...(config.buttonStyle as Partial<AppearanceButtonStyle>) },
      componentStyle: {
        ...DEFAULT_APPEARANCE.componentStyle,
        ...(config.componentStyle as Partial<AppearanceComponentStyle>),
      },
    };
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
