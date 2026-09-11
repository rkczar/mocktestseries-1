import "server-only";

import { redirect } from "next/navigation";

import { studentAuth } from "@/lib/auth/student";
import { prisma } from "@/lib/db";

/**
 * Re-verifies the session against the database on every call, unlike the JWT itself which is
 * stateless and won't reflect an admin deactivating the account mid-session.
 */
export async function requireStudent() {
  const session = await studentAuth();
  if (!session?.user?.id) redirect("/student/login");

  const student = await prisma.student.findUnique({ where: { id: session.user.id } });
  if (!student || !student.isActive) redirect("/student/login?next=/student/dashboard");

  return { session, student };
}
