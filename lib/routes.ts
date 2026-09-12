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

  // Admin auth
  { pageName: "Admin Login", route: "/admin/login", module: "Admin Auth", userType: "ADMIN", authRequired: false, status: "CONNECTED" },
  { pageName: "Admin Dashboard", route: "/admin", module: "Admin Dashboard", userType: "ADMIN", authRequired: true, status: "CONNECTED" },

  // Website
  { pageName: "Homepage Builder", route: "/admin/website/homepage", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Website Diagram", route: "/admin/website/diagram", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Appearance", route: "/admin/website/appearance", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Navigation", route: "/admin/website/navigation", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Website Content", route: "/admin/website/content", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Footer", route: "/admin/website/footer", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Announcements", route: "/admin/website/announcements", module: "Website", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },

  // Exams (minimal working CRUD ships this slice)
  { pageName: "Manage Exams", route: "/admin/exams", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "CONNECTED" },
  { pageName: "Previous Year Papers", route: "/admin/exams/previous-year-papers", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },
  { pageName: "Test Series", route: "/admin/exams/test-series", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "CONNECTED" },
  { pageName: "Subjects", route: "/admin/exams/subjects", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "DRAFT" },
  { pageName: "Topics", route: "/admin/exams/topics", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "DRAFT" },
  { pageName: "Syllabus", route: "/admin/exams/syllabus", module: "Exams", userType: "ADMIN", authRequired: true, parentRoute: "/admin/exams", status: "DRAFT" },

  // Questions (Phase 7)
  { pageName: "All Questions", route: "/admin/questions", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Add Question", route: "/admin/questions/add", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "DRAFT" },
  { pageName: "Bulk Import", route: "/admin/questions/bulk-import", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "DRAFT" },
  { pageName: "Question Templates", route: "/admin/questions/templates", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "DRAFT" },
  { pageName: "Question Reports", route: "/admin/questions/reports", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "DRAFT" },
  { pageName: "Question Queries", route: "/admin/questions/queries", module: "Questions", userType: "ADMIN", authRequired: true, parentRoute: "/admin/questions", status: "DRAFT" },

  // Tests (Phase 9)
  { pageName: "Test Builder", route: "/admin/tests/builder", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Mock Tests", route: "/admin/tests/mock", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },
  { pageName: "Random Tests", route: "/admin/tests/random", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },
  { pageName: "Custom Tests", route: "/admin/tests/custom", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },
  { pageName: "Live Tests", route: "/admin/tests/live", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },
  { pageName: "Scheduled Tests", route: "/admin/tests/scheduled", module: "Tests", userType: "ADMIN", authRequired: true, parentRoute: "/admin/tests/builder", status: "DRAFT" },

  // Students (Phase 8)
  { pageName: "All Students", route: "/admin/students", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "Test History", route: "/admin/students/history", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "DRAFT" },
  { pageName: "Attempted Questions", route: "/admin/students/attempted", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "DRAFT" },
  { pageName: "Deletion Requests", route: "/admin/students/deletion-requests", module: "Students", userType: "ADMIN", authRequired: true, parentRoute: "/admin/students", status: "DRAFT" },

  // AI (Phase 10)
  { pageName: "AI Solution Manager", route: "/admin/ai/solution-manager", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin", status: "DRAFT" },
  { pageName: "AI Solutions", route: "/admin/ai/solutions", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "DRAFT" },
  { pageName: "AI Question Variants", route: "/admin/ai/variants", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "DRAFT" },
  { pageName: "AI Usage", route: "/admin/ai/usage", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "DRAFT" },
  { pageName: "AI Settings", route: "/admin/ai/settings", module: "AI", userType: "ADMIN", authRequired: true, parentRoute: "/admin/ai/solution-manager", status: "DRAFT" },

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
  { pageName: "Authentication", route: "/admin/settings/authentication", module: "Settings", userType: "ADMIN", authRequired: true, parentRoute: "/admin/settings/general", status: "DRAFT" },
  { pageName: "Notifications", route: "/admin/settings/notifications", module: "Settings", userType: "ADMIN", authRequired: true, parentRoute: "/admin/settings/general", status: "DRAFT" },
];
