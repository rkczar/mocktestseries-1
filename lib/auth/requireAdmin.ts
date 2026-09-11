import "server-only";

import { redirect } from "next/navigation";

import { adminAuth } from "@/lib/auth/admin";

/**
 * Server-side authorization gate for every admin page and server action. proxy.ts already
 * blocks unauthenticated requests to /admin/*, but that's a defense-in-depth belt, not the
 * only check — every mutating action re-verifies here too, since a session can only be trusted
 * at the moment it's read, not because a cookie merely exists.
 */
export async function requireAdmin(minRole: "ADMIN" | "SUPER_ADMIN" = "ADMIN") {
  const session = await adminAuth();
  if (!session?.user) redirect("/admin/login");

  if (minRole === "SUPER_ADMIN" && session.user.role !== "SUPER_ADMIN") {
    redirect("/admin/dashboard?error=forbidden");
  }

  return session;
}

export class ForbiddenError extends Error {}

/**
 * Same check as requireAdmin, for use inside server actions where a hard redirect would be
 * disruptive mid-form-submission — throws instead, so the action's own catch block can turn it
 * into a normal `{ error }` form state.
 */
export async function requireAdminRole(minRole: "ADMIN" | "SUPER_ADMIN" = "ADMIN") {
  const session = await adminAuth();
  if (!session?.user) throw new ForbiddenError("Not signed in.");
  if (minRole === "SUPER_ADMIN" && session.user.role !== "SUPER_ADMIN") {
    throw new ForbiddenError("Super admin role required.");
  }
  return session;
}
