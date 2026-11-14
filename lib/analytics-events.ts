/**
 * Custom GA4 events through the gtag.js already loaded by
 * components/analytics/ga-route-tracker.tsx — no other SDK. A no-op when
 * gtag isn't loaded (admin routes, blocked by the browser, server render).
 * Callers pass ids/counts/enums only — never question text or other content.
 */
export function trackEvent(name: string, params: Record<string, string | number | boolean | null | undefined> = {}) {
  if (typeof window === "undefined") return;
  const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
  if (typeof gtag !== "function") return;
  try {
    gtag("event", name, params);
  } catch {
    // Analytics must never break the page.
  }
}

/**
 * trackEvent at most once per browser for `onceKey` (e.g. `begin_checkout:<orderId>`), so a retried
 * payment window or a re-render can't count the same order twice. Same storage key scheme as
 * components/analytics/track-once.tsx. Storage blocked: still sends (at worst a rare duplicate).
 */
export function trackEventOnce(onceKey: string, name: string, params: Record<string, string | number | boolean | null | undefined> = {}) {
  if (typeof window === "undefined") return;
  const key = `mts-ga-once:${onceKey}`;
  try {
    if (window.localStorage.getItem(key)) return;
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked.
  }
  trackEvent(name, params);
}
