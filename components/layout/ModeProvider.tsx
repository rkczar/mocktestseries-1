"use client";

import { ThemeProvider } from "next-themes";

export const PUBLIC_MODES = ["day", "night", "eyesaver"] as const;
export type PublicMode = (typeof PUBLIC_MODES)[number];

/**
 * Mounted once in the root layout so every route shares next-themes' persistence + no-flash
 * boot script. It sets `data-theme` on <html>, which is document-wide — but the mode's actual
 * color overrides in globals.css only take effect inside elements carrying `data-public-scope`
 * (rendered by PublicShell), so Admin and the Test Player stay on the default appearance no
 * matter what `data-theme` is currently set to.
 */
export function ModeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="day"
      themes={[...PUBLIC_MODES]}
      enableSystem={false}
      storageKey="mts-mode"
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
