export const THEME_COOKIE = "mts-theme";
export const THEMES = ["light", "dark", "eyesaver"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: string | undefined | null): value is Theme {
  return !!value && (THEMES as readonly string[]).includes(value);
}

export function nextTheme(current: Theme): Theme {
  const idx = THEMES.indexOf(current);
  return THEMES[(idx + 1) % THEMES.length];
}
