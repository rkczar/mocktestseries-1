import type { RoleName } from "@prisma/client";

/**
 * Permission keys used by lib/rbac.ts. This is intentionally a small, real
 * set scoped to what's actually enforced in Phases 1-5 (Website, Exams
 * stubs, Users & Access) — the full granular Permissions UI (Section 52) is
 * built out in Phase 11. MASTER_ADMIN always has every permission.
 *
 * FULL_ADMIN (database value "ADMIN", see RoleName in schema.prisma) is
 * global read-only specifically on the Question Bank: it retains every
 * other manage permission it previously had, but does not get
 * QUESTIONS_MANAGE. Server routes must keep gating every question
 * create/edit/delete/import/image/publish mutation behind
 * requirePermission(PERMISSIONS.QUESTIONS_MANAGE) — never rely on the admin
 * UI merely hiding a button.
 */
export const PERMISSIONS = {
  WEBSITE_MANAGE: "website:manage",
  HOMEPAGE_PUBLISH: "homepage:publish",
  EXAMS_MANAGE: "exams:manage",
  USERS_MANAGE: "users:manage",
  SETTINGS_MANAGE: "settings:manage",
  QUESTIONS_MANAGE: "questions:manage",
  TESTS_MANAGE: "tests:manage",
  CUSTOM_MODULES_MANAGE: "custom-modules:manage",
  STUDENTS_MANAGE: "students:manage",
  ANNOUNCEMENTS_MANAGE: "announcements:manage",
  COMMUNICATIONS_MANAGE: "communications:manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, PermissionKey[]> = {
  MASTER_ADMIN: Object.values(PERMISSIONS),
  // FULL_ADMIN keeps every manage permission ADMIN previously had, minus
  // QUESTIONS_MANAGE — it is view-only on the Question Bank (All Questions,
  // Import History, Templates remain visible; add/edit/delete/import/
  // publish/image mutations are blocked server-side).
  FULL_ADMIN: [
    PERMISSIONS.WEBSITE_MANAGE,
    PERMISSIONS.HOMEPAGE_PUBLISH,
    PERMISSIONS.EXAMS_MANAGE,
    PERMISSIONS.TESTS_MANAGE,
    PERMISSIONS.CUSTOM_MODULES_MANAGE,
    PERMISSIONS.STUDENTS_MANAGE,
    PERMISSIONS.ANNOUNCEMENTS_MANAGE,
    PERMISSIONS.COMMUNICATIONS_MANAGE,
  ],
  TEACHER: [PERMISSIONS.EXAMS_MANAGE, PERMISSIONS.QUESTIONS_MANAGE],
};
