import type { RoleName } from "@prisma/client";

/**
 * Permission keys used by lib/rbac.ts. This is intentionally a small, real
 * set scoped to what's actually enforced in Phases 1-5 (Website, Exams
 * stubs, Users & Access) — the full granular Permissions UI (Section 52) is
 * built out in Phase 11. MASTER_ADMIN always has every permission.
 *
 * FULL_ADMIN (database value "ADMIN", see RoleName in schema.prisma) is
 * global read-only on both the Question Bank AND the Exams domain (Exams,
 * Subjects, Topics, Syllabus, Previous Year Papers, Test Series): it
 * retains every other manage permission it previously had, but does not
 * get QUESTIONS_MANAGE or EXAMS_MANAGE. Server routes must keep gating
 * every create/edit/delete/import/link/unlink mutation in those areas
 * behind requirePermission(...) — never rely on the admin UI merely hiding
 * a button.
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
  // Deliberately NOT given to FULL_ADMIN below, even though it already has
  // WEBSITE_MANAGE — the public-page on/off switch (Admin -> Website ->
  // Pages & Content) is MASTER_ADMIN-only per spec; FULL_ADMIN can still
  // view the page list, just not toggle it.
  PAGE_VISIBILITY_MANAGE: "page-visibility:manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, PermissionKey[]> = {
  MASTER_ADMIN: Object.values(PERMISSIONS),
  // FULL_ADMIN keeps every manage permission ADMIN previously had, minus
  // QUESTIONS_MANAGE and EXAMS_MANAGE — it is view-only on the Question Bank
  // (All Questions, Import History, Templates remain visible; add/edit/
  // delete/import/publish/image mutations are blocked server-side) and on
  // the Exams domain (Exams, Subjects, Topics, Syllabus, Previous Year
  // Papers, Test Series remain visible; create/edit/delete/rename/link/
  // unlink mutations are blocked server-side).
  FULL_ADMIN: [
    PERMISSIONS.WEBSITE_MANAGE,
    PERMISSIONS.HOMEPAGE_PUBLISH,
    PERMISSIONS.TESTS_MANAGE,
    PERMISSIONS.CUSTOM_MODULES_MANAGE,
    PERMISSIONS.STUDENTS_MANAGE,
    PERMISSIONS.ANNOUNCEMENTS_MANAGE,
    PERMISSIONS.COMMUNICATIONS_MANAGE,
  ],
  TEACHER: [PERMISSIONS.EXAMS_MANAGE, PERMISSIONS.QUESTIONS_MANAGE],
};
