import "server-only";

import { redirect } from "next/navigation";

import { studentAuth } from "@/lib/auth/student";
import { prisma } from "@/lib/db";

/**
 * Re-verifies the session against the database on every call, unlike the JWT itself which is
 * stateless and won't reflect an admin deactivating the account mid-session.
 */
export async function requireStudent(next?: string) {
  const loginUrl = next ? `/student/login?next=${encodeURIComponent(next)}` : "/student/login";

  const session = await studentAuth();
  if (!session?.user?.id) redirect(loginUrl);

  const student = await prisma.student.findUnique({ where: { id: session.user.id } });
  if (!student || !student.isActive) redirect(loginUrl);

  return { session, student };
}

export class UnauthorizedError extends Error {}

/**
 * Same check as requireStudent, for server actions and route handlers invoked programmatically
 * (autosave, submit, AI-explanation fetch) where a hard redirect would be the wrong response —
 * throws instead, so the caller can turn it into a normal error result.
 */
export async function requireStudentSession() {
  const session = await studentAuth();
  if (!session?.user?.id) throw new UnauthorizedError("Not signed in.");

  const student = await prisma.student.findUnique({ where: { id: session.user.id } });
  if (!student || !student.isActive) throw new UnauthorizedError("Not signed in.");

  return { session, student };
}
