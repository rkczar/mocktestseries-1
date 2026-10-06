/**
 * The registry of Student Dashboard blocks — stable IDs for real, existing
 * dashboard features only. Admin → Website → Student Dashboard can show/hide
 * and reorder these; it cannot add arbitrary content. A new dashboard
 * feature registers here and renders in
 * app/student/(dashboard)/dashboard/active-exam-dashboard.tsx — it never
 * gets its own page. Client-safe (no server imports).
 *
 * `group` decides the section heading a block renders under. Consecutive
 * visible blocks of the same group share one heading, and consecutive
 * `card` blocks share one grid, so any admin order still reads cleanly.
 */

export type StudentDashboardGroup = "overview" | "practice" | "pyq" | "recent" | "account";

export const STUDENT_DASHBOARD_BLOCKS = [
  { id: "access-status", label: "Access & Subscription", group: "account", card: false, description: "Free / Complete Access / Expired state per exam: upgrade offer, Free vs Complete comparison, or active plan with expiry" },
  { id: "performance-summary", label: "Performance Summary", group: "overview", card: false, description: "MCQs today, questions attempted, tests completed, streak, average score" },
  { id: "overall-rank", label: "Overall Rank", group: "overview", card: false, description: "Active exam's Overall Rank (average percentile over admin-selected Mock Tests, 3+ ranked tests); opens Ranking & Progress. Hidden until a Mock Test counts toward Overall Ranking" },
  { id: "analytics-progress", label: "Analytics & Progress links", group: "overview", card: false, description: "Analytics, History, My Exams, Saved Questions" },
  { id: "test-schedule", label: "Test Schedule · Next Test", group: "practice", card: false, description: "Next scheduled mock test with countdown / Start" },
  { id: "mock-tests", label: "Mock Tests", group: "practice", card: true, description: "Test series & schedule" },
  { id: "subject-test", label: "Subject Test", group: "practice", card: true, description: "Configurable subject practice" },
  { id: "custom-module", label: "Custom Module", group: "practice", card: true, description: "Build your own practice set" },
  { id: "practice-omr", label: "Practice OMR Sheet", group: "practice", card: true, description: "Direct download of the printable OMR sheet" },
  { id: "test-on-the-go", label: "Test on the Go", group: "practice", card: false, description: "Quick subject test from the active exam" },
  { id: "subjects", label: "Subjects in Active Exam", group: "practice", card: false, description: "Per-subject shortcuts into Subject Test" },
  { id: "previous-year-papers", label: "Previous Year Papers", group: "pyq", card: false, description: "Papers of the active exam: Start / Resume / Result / Review" },
  { id: "continue-attempt", label: "Continue Attempt", group: "recent", card: false, description: "Resume the student's in-progress test" },
  { id: "recent-activity", label: "Recent Test", group: "recent", card: false, description: "Latest completed test and score" },
  { id: "weak-topics", label: "Weak Topics", group: "recent", card: false, description: "Topics with the most recent wrong answers" },
  { id: "subscription-status", label: "Subscription Status", group: "account", card: false, description: "Other active plans not covered by Access & Subscription" },
  { id: "install-app", label: "Install MockTestSeries", group: "account", card: false, description: "Install-as-app prompt; shown only on browsers that support installing, never inside the installed app" },
  { id: "share-review", label: "Share your experience", group: "account", card: false, description: "Write a review (1–5 stars + comment) after completing a test; shows its moderation status once submitted" },
  // Registered last so access-status stays first; `insertBefore` places it
  // directly above Access & Subscription in the default and in saved layouts.
  { id: "student-reviews", label: "What Students Say", group: "account", card: false, insertBefore: "access-status", description: "Published reviews from Admin → Reviews (compact carousel); hidden when none are published or the Reviews setting is off" },
] as const satisfies readonly { id: string; label: string; group: StudentDashboardGroup; card: boolean; description: string; insertBefore?: string }[];

export type StudentDashboardBlockId = (typeof STUDENT_DASHBOARD_BLOCKS)[number]["id"];
export type StudentDashboardLayout = { id: StudentDashboardBlockId; visible: boolean }[];

const BLOCK_IDS = new Set<string>(STUDENT_DASHBOARD_BLOCKS.map((b) => b.id));
export function isStudentDashboardBlockId(id: unknown): id is StudentDashboardBlockId {
  return typeof id === "string" && BLOCK_IDS.has(id);
}

export function studentDashboardBlock(id: StudentDashboardBlockId) {
  return STUDENT_DASHBOARD_BLOCKS.find((b) => b.id === id)!;
}

/** The registry position a block is placed before when it is new to a layout (else: after its preceding neighbour). */
export function studentDashboardBlockAnchor(id: StudentDashboardBlockId): StudentDashboardBlockId | null {
  const block = studentDashboardBlock(id) as { insertBefore?: StudentDashboardBlockId };
  return block.insertBefore ?? null;
}

/** Default: (What Students Say) → Access & Subscription → Overview → Practice & Tests → Previous Year Papers → Recent Activity → account. */
export const DEFAULT_STUDENT_DASHBOARD_LAYOUT: StudentDashboardLayout = (() => {
  const layout: StudentDashboardLayout = STUDENT_DASHBOARD_BLOCKS.filter((b) => !("insertBefore" in b)).map((b) => ({ id: b.id, visible: true }));
  for (const b of STUDENT_DASHBOARD_BLOCKS) {
    if (!("insertBefore" in b)) continue;
    const at = layout.findIndex((e) => e.id === b.insertBefore);
    layout.splice(at < 0 ? layout.length : at, 0, { id: b.id, visible: true });
  }
  return layout;
})();
