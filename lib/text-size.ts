export const TEXT_SIZE_COOKIE = "mts-text-size";
export const TEXT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export function isTextSize(value: string | undefined | null): value is TextSize {
  return !!value && (TEXT_SIZES as readonly string[]).includes(value);
}

export const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  xs: "Very Small",
  sm: "Small",
  md: "Default",
  lg: "Large",
  xl: "Extra Large",
};

export const TEXT_SIZE_SHORT: Record<TextSize, string> = {
  xs: "A−−",
  sm: "A−",
  md: "A",
  lg: "A+",
  xl: "A++",
};
