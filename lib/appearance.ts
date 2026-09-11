import { unstable_cache } from "next/cache";

import { prisma } from "@/lib/db";

export const DISPLAY_FONTS = {
  "Source Serif 4": "var(--font-source-serif-4)",
  "Playfair Display": "var(--font-playfair-display)",
  "Lora": "var(--font-lora)",
} as const;

export const BODY_FONTS = {
  Manrope: "var(--font-manrope)",
  Inter: "var(--font-inter)",
  "Work Sans": "var(--font-work-sans)",
} as const;

export type AppearanceDTO = {
  primaryColor: string;
  accentColor: string;
  successColor: string;
  errorColor: string;
  fontDisplay: keyof typeof DISPLAY_FONTS;
  fontBody: keyof typeof BODY_FONTS;
  buttonRadiusPx: number;
};

const DEFAULTS: AppearanceDTO = {
  primaryColor: "#0F4C81",
  accentColor: "#F57C00",
  successColor: "#2E7D32",
  errorColor: "#C62828",
  fontDisplay: "Source Serif 4",
  fontBody: "Manrope",
  buttonRadiusPx: 10,
};

async function loadAppearance(): Promise<AppearanceDTO> {
  const row = await prisma.appearanceSetting.findFirst();
  if (!row) return DEFAULTS;

  return {
    primaryColor: row.primaryColor,
    accentColor: row.accentColor,
    successColor: row.successColor,
    errorColor: row.errorColor,
    fontDisplay: (row.fontDisplay in DISPLAY_FONTS ? row.fontDisplay : DEFAULTS.fontDisplay) as AppearanceDTO["fontDisplay"],
    fontBody: (row.fontBody in BODY_FONTS ? row.fontBody : DEFAULTS.fontBody) as AppearanceDTO["fontBody"],
    buttonRadiusPx: row.buttonRadiusPx,
  };
}

export const getAppearance = unstable_cache(loadAppearance, ["appearance-settings"], {
  tags: ["appearance"],
});

export function appearanceCssVars(a: AppearanceDTO) {
  return `:root{--primary:${a.primaryColor};--brand-accent:${a.accentColor};--success:${a.successColor};--error:${a.errorColor};--radius-button:${a.buttonRadiusPx}px;--font-display-active:${DISPLAY_FONTS[a.fontDisplay]};--font-body-active:${BODY_FONTS[a.fontBody]};}`;
}
