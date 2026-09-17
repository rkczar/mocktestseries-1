/**
 * Assigns every diagram node to one of ten visual system groups for the
 * Website Diagram's grouped site map (Admin -> Website -> Website Diagram).
 * Pure and framework-agnostic like `lib/diagram-graph.ts` — no server-only
 * import, so it runs identically on the server (page.tsx) and in the client
 * graph canvas (graph-view.tsx).
 *
 * The grouping is derived from data the app already computes for every route
 * — `module` (lib/routes.ts / route-scanner.ts's `classify()`) and `userType`
 * — plus a handful of route-specific overrides for cases that single field
 * can't express (e.g. the Test Flow module spans both the Test Engine and
 * Results & Review groups; Student Dashboard spans both Exams & Content and
 * the general Student Portal). Nothing here re-scans the filesystem or
 * changes route/link detection.
 */

export type DiagramGroupKey =
  | "PUBLIC_WEBSITE"
  | "AUTHENTICATION"
  | "STUDENT_PORTAL"
  | "EXAMS_CONTENT"
  | "TEST_ENGINE"
  | "RESULTS_REVIEW"
  | "AI_FEATURES"
  | "ADMIN_PANEL"
  | "WEBSITE_MANAGEMENT"
  | "SYSTEM_MONITORING";

export interface DiagramGroupMeta {
  key: DiagramGroupKey;
  label: string;
  order: number;
}

export const DIAGRAM_GROUPS: DiagramGroupMeta[] = [
  { key: "PUBLIC_WEBSITE", label: "Public Website", order: 0 },
  { key: "AUTHENTICATION", label: "Authentication", order: 1 },
  { key: "STUDENT_PORTAL", label: "Student Portal", order: 2 },
  { key: "EXAMS_CONTENT", label: "Exams & Content", order: 3 },
  { key: "TEST_ENGINE", label: "Test Engine", order: 4 },
  { key: "RESULTS_REVIEW", label: "Results & Review", order: 5 },
  { key: "AI_FEATURES", label: "AI Features", order: 6 },
  { key: "ADMIN_PANEL", label: "Admin Panel", order: 7 },
  { key: "WEBSITE_MANAGEMENT", label: "Website Management", order: 8 },
  { key: "SYSTEM_MONITORING", label: "System / API / Monitoring", order: 9 },
];

const GROUP_BY_KEY = new Map(DIAGRAM_GROUPS.map((g) => [g.key, g]));

export function groupMeta(key: DiagramGroupKey): DiagramGroupMeta {
  return GROUP_BY_KEY.get(key) ?? DIAGRAM_GROUPS[DIAGRAM_GROUPS.length - 1];
}

const EXAMS_CONTENT_STUDENT_ROUTES = new Set([
  "/student/exams",
  "/student/exams/[examId]",
  "/student/test-series",
  "/student/custom-module",
  "/student/custom-module/[id]",
]);

const AUTH_ROUTES = new Set(["/admin/login", "/login", "/student/login", "/student/register"]);

interface GroupableEntry {
  route: string;
  module: string;
  userType: string;
}

/** Assigns one of the ten diagram groups to a route. First matching rule wins. */
export function classifyGroup(entry: GroupableEntry): DiagramGroupKey {
  const { route, module, userType } = entry;

  if (AUTH_ROUTES.has(route) || module === "Student Auth" || module === "Admin Auth") {
    return "AUTHENTICATION";
  }

  if (userType === "PUBLIC") {
    return "PUBLIC_WEBSITE";
  }

  if (userType === "STUDENT") {
    if (EXAMS_CONTENT_STUDENT_ROUTES.has(route)) return "EXAMS_CONTENT";
    if (module === "Test Flow") {
      if (route.endsWith("/result") || route.endsWith("/review")) return "RESULTS_REVIEW";
      return "TEST_ENGINE"; // instructions + run
    }
    return "STUDENT_PORTAL";
  }

  // ADMIN
  if (module === "Website") return "WEBSITE_MANAGEMENT";
  if (module === "AI") return "AI_FEATURES";
  if (module === "Settings") return "SYSTEM_MONITORING";
  return "ADMIN_PANEL";
}
