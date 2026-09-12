import type { RoleName } from "@prisma/client";

/**
 * Permission keys used by lib/rbac.ts. This is intentionally a small, real
 * set scoped to what's actually enforced in Phases 1-5 (Website, Exams
 * stubs, Users & Access) — the full granular Permissions UI (Section 52) is
 * built out in Phase 11. MASTER_ADMIN always has every permission.
 */
export const PERMISSIONS = {
  WEBSITE_MANAGE: "website:manage",
  HOMEPAGE_PUBLISH: "homepage:publish",
  EXAMS_MANAGE: "exams:manage",
  USERS_MANAGE: "users:manage",
  SETTINGS_MANAGE: "settings:manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, PermissionKey[]> = {
  MASTER_ADMIN: Object.values(PERMISSIONS),
  ADMIN: [PERMISSIONS.WEBSITE_MANAGE, PERMISSIONS.HOMEPAGE_PUBLISH, PERMISSIONS.EXAMS_MANAGE],
  TEACHER: [PERMISSIONS.EXAMS_MANAGE],
};
