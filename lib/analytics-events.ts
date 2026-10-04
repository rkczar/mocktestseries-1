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
