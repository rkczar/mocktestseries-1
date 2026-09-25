import "server-only";
import { scanAppRoutes, scanOutgoingLinks } from "./route-scanner";
import { ROUTE_CONNECTIONS, type RouteConnection } from "./route-connections";
import { ADMIN_CONFIG_LINKS } from "./diagram-admin-links";
import { DEPRECATED_ROUTES } from "./deprecated-routes";
import { LEGACY_REDIRECTS } from "./legacy-redirects";
import type { DiagramEntry } from "./diagram-graph";

export interface DiagramSource {
  entries: DiagramEntry[];
  connections: RouteConnection[];
}

const connectionKey = (from: string, to: string) => `${from}=>${to}`;

/**
 * Merges the admin-controlled registry (DB, still the source of truth for
 * status like WARNING/DRAFT) with what actually exists and links out on disk
 * right now (`lib/route-scanner.ts`). Two things fall out of this for free:
 *
 * - A registry row claiming a real status for a route with no matching
 *   `page.tsx` is downgraded to BROKEN — the claim doesn't match reality.
 * - A `page.tsx` that exists but isn't in the registry yet shows up anyway,
 *   flagged `autoDiscovered`, instead of silently not appearing.
 */
export function buildDiagramSource(dbEntries: DiagramEntry[]): DiagramSource {
  const scannedRoutes = scanAppRoutes();
  const scannedByRoute = new Map(scannedRoutes.map((r) => [r.route, r]));
  const dbByRoute = new Map(dbEntries.map((e) => [e.route, e]));
  const deprecatedRoutes = new Set(DEPRECATED_ROUTES);

  const entries: DiagramEntry[] = dbEntries.map((entry) => {
    const scanned = scannedByRoute.get(entry.route);
    const deprecated = deprecatedRoutes.has(entry.route);
    if (!scanned && entry.status !== "DRAFT") {
      return { ...entry, status: "BROKEN", autoDiscovered: false, missing: true, deprecated };
    }
    return { ...entry, autoDiscovered: false, missing: false, deprecated };
  });

  for (const scanned of scannedRoutes) {
    if (dbByRoute.has(scanned.route)) continue;
    entries.push({
      pageName: scanned.pageName,
      route: scanned.route,
      module: scanned.module,
      userType: scanned.userType,
      authRequired: scanned.authRequired,
      parentRoute: scanned.parentRoute,
      status: "CONNECTED",
      autoDiscovered: true,
      missing: false,
      deprecated: deprecatedRoutes.has(scanned.route),
    });
  }

  // Legacy URLs with no page.tsx — permanent redirects in next.config.ts —
  // are drawn as deprecated nodes with a redirect edge, so the diagram shows
  // where old links land instead of reporting them as broken.
  const knownRoutes = new Set(entries.map((e) => e.route));
  for (const legacy of LEGACY_REDIRECTS) {
    if (knownRoutes.has(legacy.source)) continue;
    entries.push({
      pageName: `${legacy.source} (legacy redirect)`,
      route: legacy.source,
      module: "Legacy",
      userType: "PUBLIC",
      authRequired: false,
      parentRoute: null,
      status: "CONNECTED",
      autoDiscovered: false,
      missing: false,
      deprecated: true,
    });
  }

  const merged = new Map<string, RouteConnection>(ROUTE_CONNECTIONS.map((c) => [connectionKey(c.from, c.to), c]));
  for (const legacy of LEGACY_REDIRECTS) {
    const to = legacy.destination.split("#")[0] || "/";
    merged.set(connectionKey(legacy.source, to), { from: legacy.source, to, source: "redirect", label: `Permanent redirect — ${legacy.label}` });
  }

  for (const link of ADMIN_CONFIG_LINKS) {
    merged.set(connectionKey(link.from, link.to), { ...link, source: "admin-config" });
  }

  for (const scanned of scannedRoutes) {
    for (const link of scanOutgoingLinks(scanned)) {
      const key = connectionKey(scanned.route, link.to);
      if (merged.has(key)) continue;
      merged.set(key, { from: scanned.route, to: link.to, source: "scanned", label: "Auto-detected link" });
    }
  }

  return { entries, connections: [...merged.values()] };
}
