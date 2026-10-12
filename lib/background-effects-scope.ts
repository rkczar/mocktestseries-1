/**
 * Routes that never show a decorative background, whatever the scope: the
 * Test Player / result / review (all under /student/attempt), OMR, payment
 * checkout, Live CBT and the Admin Panel.
 *
 * Its own dependency-free module because the client scope gate
 * (components/background-effects/scope-gate.tsx) imports it: importing
 * lib/background-effects there would ship the whole settings module in the
 * page bundle even with Background Effects OFF.
 */
export const BG_EXCLUDED_PREFIXES = ["/student/attempt", "/student/omr", "/student/checkout", "/live-cbt", "/admin"] as const;
export const isBgExcludedPath = (pathname: string) =>
  BG_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
