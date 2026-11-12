"use client";

import { useEffect } from "react";
import { trackEvent } from "@/lib/analytics-events";

/** Fires one GA4 event once per browser for `onceKey` (e.g. a purchase per order id). Never throws. */
export function TrackOnce({ event, params, onceKey }: { event: string; params: Record<string, string | number | boolean | null | undefined>; onceKey: string }) {
  useEffect(() => {
    const key = `mts-ga-once:${onceKey}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      // Storage blocked: still send (at worst a rare duplicate).
    }
    trackEvent(event, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per key
  }, [onceKey]);
  return null;
}
