/** Social card size (Open Graph / Twitter summary_large_image). */
export const OG_SIZE = { width: 1200, height: 630 } as const;

// Bump when the artwork in lib/og/render.tsx changes so social caches fetch the new image.
export const OG_ARTWORK_VERSION = "1";
