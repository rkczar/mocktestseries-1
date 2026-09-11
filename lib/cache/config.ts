import "server-only";

/**
 * Whether the compact Cache Management widget renders in the public Footer at all. This is
 * separate from (and checked in addition to) the per-viewer admin check that decides which
 * *buttons* inside that widget are shown — see components/cache/FooterCacheControls.tsx.
 *
 * Defaults to enabled outside production (this is "primarily for the current development
 * phase") and disabled in production, but either can be overridden without a code change via
 * the FOOTER_CACHE_CONTROLS env var — so the public controls can be turned off later purely
 * through configuration, without touching the cache architecture itself.
 */
export function footerCacheControlsEnabled(): boolean {
  const override = process.env.FOOTER_CACHE_CONTROLS;
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV !== "production";
}
