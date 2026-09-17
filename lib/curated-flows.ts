import { ADMIN_NAV } from "./admin-nav";
import { STUDENT_JOURNEY_FLOW } from "./route-connections";
import type { DiagramEntry } from "./diagram-graph";

/** Node-id subsets for the curated flow tabs. Real edges between these nodes come from the merged graph — this only picks which nodes are in frame. */

export function studentFlowNodeIds(): string[] {
  return STUDENT_JOURNEY_FLOW;
}

/** Every admin sidebar item's page, plus login — this is the sidebar's own real structure (`lib/admin-nav.ts`), not a hand-drawn tree. */
export function adminFlowNodeIds(): string[] {
  const ids = new Set<string>(["/admin/login", "/admin"]);
  for (const item of ADMIN_NAV) {
    ids.add(item.href);
  }
  return [...ids];
}

export function publicFlowNodeIds(entries: DiagramEntry[]): string[] {
  const ids = entries.filter((e) => e.module === "Website" && e.userType === "PUBLIC").map((e) => e.route);
  return [...new Set([...ids, "/login"])];
}

/**
 * The single end-to-end chain the product is built around: an admin signs
 * in and manages the site, a visitor lands on the public site and logs in
 * as a student, the student takes a test, and lands on their result and
 * answer review (analysis). Same real, currently-wired pages as the Admin
 * Flow and Student Flow tabs — just chained into one readable strip instead
 * of split across tabs.
 */
export function fullJourneyFlowNodeIds(): string[] {
  return [
    "/admin/login",
    "/admin",
    ...STUDENT_JOURNEY_FLOW,
  ];
}
