/**
 * Known legacy URLs from the old (PHP/static) MockTestSeries site that still
 * receive traffic (nginx access log evidence) and map with confidence to a
 * current page. Applied as permanent, single-hop redirects by next.config.ts
 * `redirects()` (query strings are carried over automatically) and drawn on
 * the Website Diagram (lib/diagram-source.ts) — one list, so the two can't
 * drift.
 *
 * Deliberately NOT a blanket `*.php` rule: an unknown legacy URL must keep
 * returning a real 404 rather than being silently sent to the homepage or
 * login. Only add an entry once its current destination is certain.
 *
 * Pure data (no `server-only`) — imported by next.config.ts.
 */
export interface LegacyRedirect {
  source: string;
  destination: string;
  label: string;
}

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  { source: "/student_login.php", destination: "/login", label: "Legacy PHP Student Login → canonical Student Login" },
  { source: "/index.php", destination: "/", label: "Legacy PHP home" },
  { source: "/index.html", destination: "/", label: "Legacy static home" },
  { source: "/contact.html", destination: "/contact", label: "Legacy static contact page" },
  { source: "/privacy.php", destination: "/contact#privacy", label: "Legacy PHP privacy policy" },
];
