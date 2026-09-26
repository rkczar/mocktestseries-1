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
  { id: "performance-summary", label: "Performance Summary", group: "overview", card: false, description: "MCQs today, questions attempted, tests completed, streak, average score" },
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
  { id: "subscription-status", label: "Subscription Status", group: "account", card: false, description: "Active plan / expiry reminder" },
] as const satisfies readonly { id: string; label: string; group: StudentDashboardGroup; card: boolean; description: string }[];

export type StudentDashboardBlockId = (typeof STUDENT_DASHBOARD_BLOCKS)[number]["id"];
export type StudentDashboardLayout = { id: StudentDashboardBlockId; visible: boolean }[];

const BLOCK_IDS = new Set<string>(STUDENT_DASHBOARD_BLOCKS.map((b) => b.id));
export function isStudentDashboardBlockId(id: unknown): id is StudentDashboardBlockId {
  return typeof id === "string" && BLOCK_IDS.has(id);
}

export function studentDashboardBlock(id: StudentDashboardBlockId) {
  return STUDENT_DASHBOARD_BLOCKS.find((b) => b.id === id)!;
}

/** Default: Overview → Practice & Tests → Previous Year Papers → Recent Activity → account. */
export const DEFAULT_STUDENT_DASHBOARD_LAYOUT: StudentDashboardLayout = STUDENT_DASHBOARD_BLOCKS.map((b) => ({ id: b.id, visible: true }));
