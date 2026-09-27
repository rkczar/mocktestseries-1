/**
 * Admin internal Back navigation (components/admin/admin-back-button.tsx).
 *
 * Pure helpers, no React: a per-tab stack of visited Admin URLs decides
 * "previous Admin location"; when there is none (deep link, fresh tab) the
 * logical parent route is used. Destinations are always inside /admin and
 * never the login page — Back can never leave the Admin Panel. It is
 * navigation only: every destination page still enforces auth/RBAC.
 */

export const ADMIN_ROOT = "/admin";
const MAX_STACK = 50;

/** Static Admin page routes (app/admin/(dashboard)/**). Dynamic segments are matched by shape in logicalParent. */
const ADMIN_PAGES = new Set([
  "/admin",
  "/admin/ai", "/admin/ai/settings", "/admin/ai/solution-manager", "/admin/ai/solutions", "/admin/ai/usage", "/admin/ai/variants",
  "/admin/analytics", "/admin/backup", "/admin/communications", "/admin/custom-modules",
  "/admin/exams", "/admin/exams/previous-year-papers", "/admin/exams/subjects", "/admin/exams/syllabus", "/admin/exams/test-series", "/admin/exams/topics",
  "/admin/monitoring/authentication",
  "/admin/payments", "/admin/payments/orders", "/admin/payments/revenue", "/admin/payments/transactions",
  "/admin/questions", "/admin/questions/add", "/admin/questions/bulk-import", "/admin/questions/bulk-import/history", "/admin/questions/queries",
  "/admin/questions/reports", "/admin/questions/saved-questions", "/admin/questions/templates", "/admin/questions/whatsapp-share",
  "/admin/security", "/admin/seo",
  "/admin/settings", "/admin/settings/authentication", "/admin/settings/general", "/admin/settings/notifications", "/admin/settings/security",
  "/admin/students", "/admin/students/attempted", "/admin/students/deleted", "/admin/students/deletion-requests", "/admin/students/enrollment", "/admin/students/history",
  "/admin/system",
  "/admin/tests", "/admin/tests/builder", "/admin/tests/custom", "/admin/tests/grand", "/admin/tests/live", "/admin/tests/mock", "/admin/tests/random", "/admin/tests/scheduled",
  "/admin/users", "/admin/users/admins", "/admin/users/permissions", "/admin/users/roles", "/admin/users/teachers",
  "/admin/website", "/admin/website/announcements", "/admin/website/appearance", "/admin/website/content", "/admin/website/diagram",
  "/admin/website/footer", "/admin/website/homepage", "/admin/website/login-page", "/admin/website/navigation",
]);

/**
 * Parents that are a tab of a control-center page rather than a standalone
 * page (the nearest real ancestor would lose the tab).
 */
const TAB_PARENTS: [RegExp, string][] = [
  [/^\/admin\/exams\/previous-year-papers\/[^/]+$/, "/admin/exams?tab=pyp"],
  [/^\/admin\/exams\/test-series\/[^/]+$/, "/admin/exams?tab=test-series"],
  [/^\/admin\/payments\/(coupons)\/[^/]+$/, "/admin/payments?tab=coupons"],
  [/^\/admin\/payments\/(products)\/[^/]+$/, "/admin/payments?tab=products"],
];

/** Parents that are themselves dynamic pages. */
const DYNAMIC_PARENTS: [RegExp, (path: string) => string][] = [[/^\/admin\/tests\/mock\/[^/]+\/preview$/, (p) => p.replace(/\/preview$/, "")]];

/** A safe in-Admin destination: under /admin, not the login page, no protocol/host tricks. */
export function isSafeAdminUrl(url: string | null | undefined): url is string {
  if (!url || !url.startsWith("/admin")) return false;
  if (url.startsWith("//")) return false;
  const path = url.split(/[?#]/)[0];
  if (path !== ADMIN_ROOT && !path.startsWith(ADMIN_ROOT + "/")) return false;
  return !(path === "/admin/login" || path.startsWith("/admin/login/"));
}

/** Logical parent of an Admin page: the owning control-center tab, else the nearest real ancestor route. */
export function logicalParent(pathname: string): string {
  for (const [re, target] of TAB_PARENTS) if (re.test(pathname)) return target;
  for (const [re, parent] of DYNAMIC_PARENTS) if (re.test(pathname)) return parent(pathname);
  const parts = pathname.replace(/\/+$/, "").split("/");
  while (parts.length > 2) {
    parts.pop();
    const candidate = parts.join("/");
    if (ADMIN_PAGES.has(candidate)) return candidate;
  }
  return ADMIN_ROOT;
}

const pathOf = (url: string) => url.split(/[?#]/)[0];

/** Page identity: path + control-center tab (?tab=), so "All Questions" and "Add/Edit Question" tabs are distinct pages. */
function pageKey(url: string): string {
  const [path, query = ""] = url.split("#")[0].split("?");
  const tab = new URLSearchParams(query).get("tab");
  return tab ? `${path}?tab=${tab}` : path;
}

/**
 * Records a visited Admin URL. Same page with different query (filters,
 * tab, pagination) REPLACES the top entry so Back returns to the latest
 * list state instead of stepping through every filter change; landing on
 * the entry just below the top (browser Back) pops instead of pushing.
 */
export function recordVisit(stack: string[], url: string): string[] {
  if (!isSafeAdminUrl(url)) return stack;
  const next = [...stack];
  const top = next[next.length - 1];
  if (top === url) return next;
  if (top && pageKey(top) === pageKey(url)) {
    next[next.length - 1] = url;
    return next;
  }
  if (next.length >= 2 && next[next.length - 2] === url) {
    next.pop();
    return next;
  }
  next.push(url);
  return next.slice(-MAX_STACK);
}

/** Where Back goes from `current`: the previous safe stack entry, else the logical parent. */
export function backTarget(stack: string[], current: string): { href: string; fromHistory: boolean } {
  const trimmed = stack[stack.length - 1] === current ? stack.slice(0, -1) : stack;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (isSafeAdminUrl(trimmed[i]) && pageKey(trimmed[i]) !== pageKey(current)) return { href: trimmed[i], fromHistory: true };
  }
  return { href: logicalParent(pathOf(current)), fromHistory: false };
}

export const ADMIN_NAV_STACK_KEY = "admin_nav_stack";

/**
 * For pages that mirror list state into the URL with history.replaceState
 * (no router navigation): refreshes this tab's current Back-stack entry so
 * Back returns to the exact filters/page. Browser-only; storage failures are
 * ignored (Back then falls back to the logical parent).
 */
export function syncCurrentAdminUrl(url: string) {
  try {
    const raw = window.sessionStorage.getItem(ADMIN_NAV_STACK_KEY);
    const stack = raw ? (JSON.parse(raw) as string[]) : [];
    window.sessionStorage.setItem(ADMIN_NAV_STACK_KEY, JSON.stringify(recordVisit(Array.isArray(stack) ? stack : [], url)));
  } catch {
    // convenience only
  }
}
