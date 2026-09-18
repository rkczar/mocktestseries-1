/**
 * Validates a CTA/destination route as a safe, internal, same-origin path —
 * never an arbitrary external URL. Used both to validate admin input
 * (Announcement.ctaRoute) and defensively before rendering any stored route
 * as a link, in case a row was written before this check existed.
 *
 * Pure (no prisma, no `server-only`) so it's directly testable.
 */
const SAFE_ROUTE_RE = /^\/[A-Za-z0-9\-_/.?=&%]*$/;

export function isSafeInternalRoute(route: string | null | undefined): route is string {
  if (!route) return false;
  if (route.startsWith("//")) return false; // protocol-relative — resolves to an external origin
  if (route.includes("://")) return false;
  if (route.includes("\\")) return false;
  if (/\s/.test(route)) return false;
  return SAFE_ROUTE_RE.test(route);
}
