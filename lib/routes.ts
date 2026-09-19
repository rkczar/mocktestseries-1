/**
 * Central route registry manifest (Section 18/19 of the product spec).
 * This file is the single place a developer touches when adding a page —
 * `prisma/seed.ts` upserts these into RouteRegistryEntry, which powers
 * Admin -> Website -> Website Diagram and nav-link validation.
 *
 * `status: "DRAFT"` means the route is registered/planned but its real
 * implementation ships in a later phase (Section 57: honest stub, not a
 * fake working page).
 */

export type RouteUserType = "PUBLIC" | "STUDENT" | "ADMIN";
export type RouteStatus =
  | "CONNECTED"
  | "WARNING"
  | "BROKEN"
  | "ORPHAN"
  | "UNAUTHORIZED"
  | "DRAFT";

export interface RouteManifestEntry {
  pageName: string;
  route: string;
  module: string;
  userType: RouteUserType;
  authRequired: boolean;
  parentRoute?: string;
  status: RouteStatus;
}

export const ROUTE_MANIFEST: RouteManifestEntry[] = [
  // Public
  { pageName: "Homepage", route: "/", module: "Website", userType: "PUBLIC", authRequired: false, status: "CONNECTED" },
  { pageName: "Privacy Policy", route: "/privacy", module: "Website", userType: "PUBLIC", authRequired: false, parentRoute: "/", status: "CONNECTED" },
  { pageName: "Terms and Conditions", route: "/terms", module: "Website", userType: "PUBLIC", authRequired: false, parentRoute: "/", status: "CONNECTED" },
  { pageName: "Contact Us", route: "/contact", module: "Website", userType: "PUBLIC", authRequired: false, parentRoute: "/", status: "CONNECTED" },

  // Admin auth
  { pageName: "Admin Login", route: "/admin/login", module: "Admin Auth", userType: "ADMIN", authRequired: false, status: "CONNECTED" },
  { pageName: "Admin Dashboard", route: "/admin", module: "Admin Dashboard", userType: "ADMIN", authRequired: true, status: "CONNECTED" },

  // Website
  { pageName: "Homepage Builder", route: "/admin/website/homepage", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Homepage Preview", route: "/admin/website/homepage/preview", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin/website/homepage", status: "CONNECTED" },
  { pageName: "Website Diagram", route: "/admin/website/diagram", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Appearance", route: "/admin/website/appearance", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Navigation", route: "/admin/website/navigation", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Website Content", route: "/admin/website/content", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Footer", route: "/admin/website/footer", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Announcements", route: "/admin/website/announcements", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },

  // Communications — inbound Contact Us / Grow With Us inbox (distinct from
  // Announcements above, which is outbound Admin -> Students).
  { pageName: "Communications", route: "/admin/communications", module: "Communications", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Communication Detail", route: "/admin/communications/[id]", module: "Communications", userType: "ADMIN", authRequired: true, parentRoute: "/admin/communications", status: "CONNECTED" },

  // Exams (minimal working CRUD ships this slice)
  { pageName: "Manage Exams", route: "/admin/exams", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Previous Year Papers", route: "/admin/exams/previous-year-papers", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },
  { pageName: "Test Series", route: "/admin/exams/test-series", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },
  { pageName: "Subjects", route: "/admin/exams/subjects", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },
  { pageName: "Topics", route: "/admin/exams/topics", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },
  { pageName: "Syllabus", route: "/admin/exams/syllabus", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },

  // Questions (Phase 7 — All Questions/Add/Reports ship real in this slice)
  { pageName: "All Questions", route: "/admin/questions", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Add Question", route: "/admin/questions/add", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "CONNECTED" },
  { pageName: "Bulk Import", route: "/admin/questions/bulk-import", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "CONNECTED" },
  { pageName: "Question Templates", route: "/admin/questions/templates", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "CONNECTED" },
  { pageName: "Question Reports", route: "/admin/questions/reports", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "CONNECTED" },
  // Re-exports ../reports/page (same ReportedQuestion-backed triage UI) rather than a second, parallel one — see app/admin/(dashboard)/questions/queries/page.tsx.
  { pageName: "Question Queries", route: "/admin/questions/queries", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "CONNECTED" },

  // Tests (Phase 9 — Mock Tests ships real in this slice)
  { pageName: "Test Builder", route: "/admin/tests/builder", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Mock Tests", route: "/admin/tests/mock", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "CONNECTED" },
  { pageName: "Random Tests", route: "/admin/tests/random", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },
  { pageName: "Custom Tests", route: "/admin/tests/custom", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },
  { pageName: "Live Tests", route: "/admin/tests/live", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "CONNECTED" },
  { pageName: "Scheduled Tests", route: "/admin/tests/scheduled", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },

  // Custom Modules — canonical admin-owned system consumed by the Student Custom Module page
  { pageName: "Custom Modules", route: "/admin/custom-modules", module: "Custom Modules", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Custom Module Detail", route: "/admin/custom-modules/[id]", module: "Custom Modules", userType: "ADMIN", authRequired: true, parentRoute: "/admin/custom-modules", status: "CONNECTED" },

  // Students (Phase 8 — ships real in this slice)
  { pageName: "All Students", route: "/admin/students", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Student Detail", route: "/admin/students/[id]", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "CONNECTED" },
  { pageName: "Test History", route: "/admin/students/history", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "CONNECTED" },
  { pageName: "Attempted Questions", route: "/admin/students/attempted", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "CONNECTED" },
  { pageName: "Deletion Requests", route: "/admin/students/deletion-requests", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "CONNECTED" },

  // AI (Phase 10) — Solutions, Variants, Usage and Settings all ship real implementations
  // now; only the Solution Manager landing page is still an honest stub.
  { pageName: "AI Solution Manager", route: "/admin/ai/solution-manager", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "AI Solutions", route: "/admin/ai/solutions", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "CONNECTED" },
  { pageName: "AI Question Variants", route: "/admin/ai/variants", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "CONNECTED" },
  { pageName: "AI Usage", route: "/admin/ai/usage", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "CONNECTED" },
  { pageName: "AI Settings", route: "/admin/ai/settings", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "CONNECTED" },

  // Users & Access (RBAC ships this slice — minimal)
  { pageName: "Admin Users", route: "/admin/users/admins", module: "Users & Access", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Roles", route: "/admin/users/roles", module: "Users & Access", userType: "ADMIN", authRequired: true, parentRoute: "/admin/users/admins", status: "CONNECTED" },
  { pageName: "Teachers", route: "/admin/users/teachers", module: "Users & Access", userType: "ADMIN", authRequired: true, parentRoute: "/admin/users/admins", status: "DRAFT" },
  { pageName: "Permissions", route: "/admin/users/permissions", module: "Users & Access", userType: "ADMIN", authRequired: true, parentRoute: "/admin/users/admins", status: "DRAFT" },

  // Payments (Phase 11)
  { pageName: "Transactions", route: "/admin/payments/transactions", module: "Payments", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Orders", route: "/admin/payments/orders", module: "Payments", userType: "ADMIN", authRequired: true, parentRoute: "/admin/payments/transactions", status: "DRAFT" },
  { pageName: "Revenue", route: "/admin/payments/revenue", module: "Payments", userType: "ADMIN", authRequired: true, parentRoute: "/admin/payments/transactions", status: "DRAFT" },

  // Settings
  { pageName: "General Settings", route: "/admin/settings/general", module: "Settings", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Security", route: "/admin/settings/security", module: "Settings", userType: "ADMIN", authRequired: true, parentRoute: "/admin/settings/general", status: "DRAFT" },
  { pageName: "API Management", route: "/admin/settings/authentication", module: "Settings", userType: "ADMIN", authRequired: true, parentRoute: "/admin/settings/general", status: "CONNECTED" },
  { pageName: "Notifications", route: "/admin/settings/notifications", module: "Settings", userType: "ADMIN", authRequired: true, parentRoute: "/admin/settings/general", status: "DRAFT" },

  // Student Auth — a fully separate next-auth instance/cookie from Admin (see lib/auth-student.ts)
  { pageName: "Student Login / Register", route: "/login", module: "Student Auth", userType: "STUDENT", authRequired: false, parentRoute: "/", status: "CONNECTED" },
  { pageName: "Student Login (alias)", route: "/student/login", module: "Student Auth", userType: "STUDENT", authRequired: false, parentRoute: "/login", status: "CONNECTED" },
  { pageName: "Student Register (alias)", route: "/student/register", module: "Student Auth", userType: "STUDENT", authRequired: false, parentRoute: "/login", status: "CONNECTED" },

  // Student Dashboard
  { pageName: "Student Dashboard", route: "/student/dashboard", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/login", status: "CONNECTED" },
  { pageName: "My Exams", route: "/student/exams", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/dashboard", status: "CONNECTED" },
  { pageName: "Exam Detail", route: "/student/exams/[examId]", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/exams", status: "CONNECTED" },
  { pageName: "Test Series", route: "/student/test-series", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/dashboard", status: "CONNECTED" },
  { pageName: "Custom Module", route: "/student/custom-module", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/dashboard", status: "CONNECTED" },
  { pageName: "Custom Module Detail", route: "/student/custom-module/[id]", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/custom-module", status: "CONNECTED" },
  { pageName: "History", route: "/student/history", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/dashboard", status: "CONNECTED" },
  { pageName: "Saved Questions", route: "/student/saved", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/dashboard", status: "CONNECTED" },
  { pageName: "My Profile", route: "/student/profile", module: "Student Dashboard", userType: "STUDENT", authRequired: true, parentRoute: "/student/dashboard", status: "CONNECTED" },

  // Test-taking flow
  { pageName: "Attempt Instructions", route: "/student/attempt/[attemptId]", module: "Test Flow", userType: "STUDENT", authRequired: true, parentRoute: "/student/exams", status: "CONNECTED" },
  { pageName: "Attempt Run", route: "/student/attempt/[attemptId]/run", module: "Test Flow", userType: "STUDENT", authRequired: true, parentRoute: "/student/attempt/[attemptId]", status: "CONNECTED" },
  { pageName: "Attempt Result", route: "/student/attempt/[attemptId]/result", module: "Test Flow", userType: "STUDENT", authRequired: true, parentRoute: "/student/attempt/[attemptId]/run", status: "CONNECTED" },
  { pageName: "Attempt Review", route: "/student/attempt/[attemptId]/review", module: "Test Flow", userType: "STUDENT", authRequired: true, parentRoute: "/student/attempt/[attemptId]/result", status: "CONNECTED" },
];
