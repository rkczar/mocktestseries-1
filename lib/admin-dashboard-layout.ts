/**
 * Admin Dashboard card registry (stable IDs, default order and width).
 * The order is a per-admin preference stored in Setting
 * `admin.dashboard.layout:<adminId>`. It only changes ORDER: which cards a
 * viewer sees is still decided by their permissions when the page renders,
 * so a saved layout can never reveal a restricted card. Unknown IDs in a
 * saved layout are ignored, and cards added later (missing from a saved
 * layout) appear at their default position.
 */

export type DashboardCardSize = "stat" | "half" | "full";

export const DASHBOARD_CARDS: { id: string; label: string; size: DashboardCardSize }[] = [
  { id: "action-required", label: "Action Required", size: "full" },
  { id: "total-students", label: "Total Students", size: "stat" },
  { id: "online-now", label: "Online Now", size: "stat" },
  { id: "active-students", label: "Active Students (7d)", size: "stat" },
  { id: "new-registrations", label: "New Registrations (7d)", size: "stat" },
  { id: "communications", label: "Communications", size: "stat" },
  { id: "multiple-sessions", label: "Multiple Active Sessions", size: "stat" },
  { id: "total-exams", label: "Total Exams", size: "stat" },
  { id: "active-exams", label: "Active Exams", size: "stat" },
  { id: "test-series", label: "Test Series", size: "stat" },
  { id: "active-test-series", label: "Active Test Series", size: "stat" },
  { id: "pyq-papers", label: "Previous Year Papers", size: "stat" },
  { id: "mock-tests", label: "Mock Tests", size: "stat" },
  { id: "live-mock-tests", label: "Live Mock Tests", size: "stat" },
  { id: "available-tests", label: "Available Tests", size: "stat" },
  { id: "upcoming-tests", label: "Upcoming Tests", size: "stat" },
  { id: "next-scheduled-test", label: "Next Scheduled Test", size: "stat" },
  { id: "attempts-today", label: "Attempts Today", size: "stat" },
  { id: "submissions-24h", label: "Submissions (24h)", size: "stat" },
  { id: "total-questions", label: "Total Questions", size: "stat" },
  { id: "draft-questions", label: "Draft Questions", size: "stat" },
  { id: "tests-attempted", label: "Tests Attempted", size: "stat" },
  { id: "ai-explanations", label: "AI Explanations Generated", size: "stat" },
  { id: "ai-usage", label: "AI Usage Today", size: "stat" },
  { id: "ai-cost", label: "AI Cost Today", size: "stat" },
  { id: "ai-month", label: "Monthly AI Spend", size: "stat" },
  { id: "pending-reports", label: "Pending Question Reports", size: "stat" },
  { id: "deletion-requests", label: "Deletion Requests", size: "stat" },
  { id: "revenue-mtd", label: "Revenue (MTD, LIVE)", size: "stat" },
  { id: "vps-storage", label: "VPS Storage", size: "stat" },
  { id: "quick-actions", label: "Quick actions", size: "full" },
  { id: "needs-attention", label: "Needs your attention", size: "half" },
  { id: "audit-log", label: "Audit log", size: "half" },
  { id: "homepage-status", label: "Homepage status", size: "full" },
];

export const DASHBOARD_CARD_IDS = DASHBOARD_CARDS.map((c) => c.id);
const KNOWN = new Set(DASHBOARD_CARD_IDS);

export const dashboardLayoutKey = (adminId: string) => `admin.dashboard.layout:${adminId}`;

/** Keeps only known, unique IDs (bounded) — anything else from storage or the browser is dropped. */
export function sanitizeDashboardOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw.slice(0, 200)) if (typeof v === "string" && KNOWN.has(v) && !out.includes(v)) out.push(v);
  return out;
}

/**
 * Applies a saved order to the cards present: saved IDs first in saved
 * order; a card missing from the saved order is placed right after the card
 * that precedes it in the default order (so newly added cards show up near
 * where they belong instead of at the very end).
 */
export function applyDashboardOrder<T extends { id: string }>(items: T[], saved: string[]): T[] {
  if (!saved.length) return items;
  const present = new Map(items.map((i) => [i.id, i]));
  const ordered: string[] = saved.filter((id) => present.has(id));
  for (const id of DASHBOARD_CARD_IDS) {
    if (!present.has(id) || ordered.includes(id)) continue;
    const prev = DASHBOARD_CARD_IDS.slice(0, DASHBOARD_CARD_IDS.indexOf(id)).reverse().find((p) => ordered.includes(p));
    ordered.splice(prev ? ordered.indexOf(prev) + 1 : 0, 0, id);
  }
  return ordered.map((id) => present.get(id)!).filter(Boolean);
}
