"use client";

import { lazy, Suspense, useSyncExternalStore } from "react";
import type { GalaxyCanvasProps } from "./galaxy-canvas";

// The canvas code is its own chunk, fetched only when Galaxy (with its
// animation ON) is actually rendered — never part of a page's initial bundle.
// React.lazy rather than next/dynamic: the loader stub is bundled wherever a
// background can mount, and lazy adds no runtime to pages with effects OFF.
const GalaxyCanvas = lazy(() => import("./galaxy-canvas"));

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

export function GalaxyLoader({ ignoreReducedMotion, ...props }: GalaxyCanvasProps & { ignoreReducedMotion?: boolean }) {
  // Server snapshot = "reduced" so nothing renders before hydration (the
  // canvas never server-renders); then reduced-motion visitors keep the CSS
  // still version and skip the download.
  const reduced = useSyncExternalStore(subscribe, () => window.matchMedia(REDUCED).matches, () => true);
  if (reduced && !ignoreReducedMotion) return null;
  return (
    <Suspense fallback={null}>
      <GalaxyCanvas {...props} />
    </Suspense>
  );
}
