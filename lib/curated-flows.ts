import { ADMIN_NAV } from "./admin-nav";
import { STUDENT_JOURNEY_FLOW } from "./route-connections";
import type { DiagramEntry } from "./diagram-graph";

/** Node-id subsets for the curated flow tabs. Real edges between these nodes come from the merged graph — this only picks which nodes are in frame. */

export function studentFlowNodeIds(): string[] {
  return STUDENT_JOURNEY_FLOW;
}

/** Every admin sidebar group's primary page, plus login — this is the sidebar's own real structure (`lib/admin-nav.ts`), not a hand-drawn tree. */
export function adminFlowNodeIds(): string[] {
  const ids = new Set<string>(["/admin/login", "/admin"]);
  for (const group of ADMIN_NAV) {
    if (group.items[0]) ids.add(group.items[0].href);
  }
  return [...ids];
}

export function publicFlowNodeIds(entries: DiagramEntry[]): string[] {
  const ids = entries.filter((e) => e.module === "Website" && e.userType === "PUBLIC").map((e) => e.route);
  return [...new Set([...ids, "/login"])];
}
