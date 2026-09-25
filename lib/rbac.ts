import "server-only";
import { cache } from "react";
import type { RoleName } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ROLE_PERMISSIONS, type PermissionKey } from "@/lib/permissions";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Current account state for an admin id — one primary-key lookup, memoized
 * per request (React `cache`), so a page/action that checks several
 * permissions still costs a single query.
 */
const loadAdminAccount = cache(async (adminId: string) =>
  prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { name: true, isActive: true, role: { select: { name: true } } },
  })
);

/**
 * Server-side session getter for Server Components, Server Actions and route
 * handlers — the one way admin code reads the admin session.
 *
 * A cryptographically valid admin JWT is not trusted on its own: the
 * account is re-read on every request. A deactivated or deleted admin gets
 * `null` immediately, and role/permissions always come from the account's
 * CURRENT role, never the role frozen into the token at sign-in. The
 * separate student auth instance is unaffected.
 */
export async function getAdminSession() {
  const session = await auth();
  const adminId = session?.user?.id;
  if (!session || !adminId) return null;

  const account = await loadAdminAccount(adminId);
  if (!account || !account.isActive) return null;

  const role = account.role.name as RoleName;
  session.user.role = role;
  session.user.name = account.name;
  session.user.permissions = [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])];
  return session;
}

/**
 * Throws if there is no authenticated, active admin, or the admin's current
 * role lacks the given permission. Always call this at the top of a Server
 * Action / route handler — never rely on the sidebar simply hiding a link
 * (Section 51). FULL_ADMIN holds only view keys (lib/permissions.ts), so
 * every mutation guarded here is refused for it.
 */
export async function requirePermission(permission: PermissionKey) {
  const session = await getAdminSession();
  if (!session?.user) throw new UnauthorizedError("Not signed in");

  const permissions = session.user.permissions ?? [];
  if (!permissions.includes(permission)) {
    throw new UnauthorizedError(`Missing permission: ${permission}`);
  }
  return session;
}

/**
 * Non-throwing check for Server Components deciding whether to render
 * mutation controls (e.g. FULL_ADMIN sees Mock Tests read-only). Display
 * only — every Server Action/route still enforces requirePermission itself.
 */
export async function hasPermission(permission: PermissionKey): Promise<boolean> {
  const session = await getAdminSession();
  return Boolean(session?.user?.permissions?.includes(permission));
}
