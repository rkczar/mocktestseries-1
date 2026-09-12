import "server-only";
import { auth } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Server-side session getter for use in Server Components / Server Actions. */
export async function getAdminSession() {
  return auth();
}

/**
 * Throws if there is no authenticated admin, or the admin lacks the given
 * permission. Always call this at the top of a Server Action / route
 * handler — never rely on the sidebar simply hiding a link (Section 51).
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
