import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { RouteUserType } from "./routes";

/**
 * Mechanically derives the site's route tree and page-to-page links straight
 * from the App Router file tree and page source, instead of a hand-maintained
 * list. This is what makes the Website Diagram self-updating (Section 7/8 of
 * the spec): add a `page.tsx` under `app/`, and it shows up here on the next
 * request — no manifest edit required.
 *
 * Scope, stated honestly: link discovery only reads literal string hrefs
 * (`href="/foo"`, `href: "/foo"`, `router.push("/foo")`, `redirectTo: "/foo"`)
 * inside a route's own `page.tsx`. It does not follow imports into sibling
 * components, and it can't see template-literal hrefs (`` `/exams/${id}` ``)
 * since those aren't statically a fixed string — those stay invisible to this
 * scanner rather than being guessed at. Shared chrome (header/footer/sidebar,
 * rendered on many pages at once) is deliberately not turned into page-to-page
 * edges here; see `lib/global-nav-links.ts` for that.
 */

const APP_DIR = path.join(process.cwd(), "app");

export interface ScannedRoute {
  route: string;
  pageName: string;
  module: string;
  userType: RouteUserType;
  authRequired: boolean;
  parentRoute: string | null;
  filePath: string;
}

function isRouteGroup(dirName: string): boolean {
  return dirName.startsWith("(") && dirName.endsWith(")");
}

function humanize(segment: string): string {
  const stripped = segment.replace(/^\[+/, "").replace(/\]+$/, "");
  if (!stripped) return "Home";
  return stripped
    .split("-")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Pulls a short page name out of `export const metadata = { title: "X — Site Name" }` when present. */
function extractTitle(source: string): string | null {
  const m = source.match(/title:\s*["'`]([^"'`]+)["'`]/);
  if (!m) return null;
  const first = m[1].split(/[—-]/)[0].trim();
  return first || null;
}

function classify(route: string): { userType: RouteUserType; module: string; authRequired: boolean } {
  if (route.startsWith("/admin")) {
    return { userType: "ADMIN", module: route.startsWith("/admin/settings") ? "Settings" : "Admin", authRequired: route !== "/admin/login" };
  }
  if (route.startsWith("/student") || route === "/login") {
    const isAuthPage = route === "/login" || route === "/student/login" || route === "/student/register";
    return { userType: "STUDENT", module: "Student", authRequired: !isAuthPage };
  }
  return { userType: "PUBLIC", module: "Website", authRequired: false };
}

const ROOT_ROUTES = new Set(["/", "/admin", "/admin/login"]);

/** Walks `app/` for real `page.tsx` files (App Router convention) and derives route metadata mechanically. */
export function scanAppRoutes(): ScannedRoute[] {
  const routes: ScannedRoute[] = [];

  function walk(dir: string, segments: string[]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const pageFile = entries.find((e) => e.isFile() && /^page\.(tsx|ts)$/.test(e.name));
    if (pageFile) {
      const routePath = "/" + segments.filter(Boolean).join("/");
      const normalizedRoute = routePath === "" ? "/" : routePath;
      const filePath = path.join(dir, pageFile.name);
      let title: string | null = null;
      try {
        title = extractTitle(fs.readFileSync(filePath, "utf8"));
      } catch {
        title = null;
      }
      const lastReal = [...segments].reverse().find(Boolean) ?? "";
      const { userType, module, authRequired } = classify(normalizedRoute);
      routes.push({
        route: normalizedRoute,
        pageName: title ?? humanize(lastReal),
        module,
        userType,
        authRequired,
        parentRoute: null,
        filePath,
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "api" || entry.name.startsWith("_") || entry.name === "node_modules") continue;
      const seg = isRouteGroup(entry.name) ? "" : entry.name;
      walk(path.join(dir, entry.name), [...segments, seg]);
    }
  }

  walk(APP_DIR, []);

  const byRoute = new Set(routes.map((r) => r.route));
  for (const r of routes) {
    if (ROOT_ROUTES.has(r.route)) continue;
    const parts = r.route.split("/").filter(Boolean);
    let found: string | null = null;
    for (let i = parts.length - 1; i > 0; i--) {
      const candidate = "/" + parts.slice(0, i).join("/");
      if (byRoute.has(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      found = r.route.startsWith("/admin") ? "/admin" : r.route.startsWith("/student") ? "/student/dashboard" : "/";
    }
    r.parentRoute = found === r.route ? null : found;
  }

  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

const HREF_PATTERNS = [
  /\bhref\s*=\s*"(\/[a-zA-Z0-9\-_/[\]]*)"/g,
  /\bhref\s*:\s*"(\/[a-zA-Z0-9\-_/[\]]*)"/g,
  /router\.push\(\s*"(\/[a-zA-Z0-9\-_/[\]]*)"\s*\)/g,
  /redirectTo\s*:\s*"(\/[a-zA-Z0-9\-_/[\]]*)"/g,
];

export interface ScannedLink {
  to: string;
}

/** Extracts literal internal hrefs from a single route's own page.tsx source (see scope note above). */
export function scanOutgoingLinks(route: ScannedRoute): ScannedLink[] {
  let source: string;
  try {
    source = fs.readFileSync(route.filePath, "utf8");
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const re of HREF_PATTERNS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      const target = m[1];
      if (!target || target === route.route) continue;
      found.add(target);
    }
  }
  return [...found].map((to) => ({ to }));
}
