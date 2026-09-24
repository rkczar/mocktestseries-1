import "server-only";
import { redirect } from "next/navigation";
import { studentServerAuth } from "@/lib/auth-student";

export class StudentUnauthorizedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "StudentUnauthorizedError";
  }
}

/** Server-side session getter for use in Server Components / Server Actions. */
export async function getStudentSession() {
  return studentServerAuth();
}

/**
 * Throws if there is no authenticated student. Always call this at the top
 * of a student Server Action / data-access helper — never rely on a page
 * simply not rendering a link (see lib/student-data.ts for the pattern of
 * threading this studentId through every query as a mandatory filter).
 */
export async function requireStudent() {
  const session = await getStudentSession();
  if (!session?.user?.id || !session.user.studentId) {
    throw new StudentUnauthorizedError();
  }
  return {
    id: session.user.id,
    studentId: session.user.studentId,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    authProvider: session.user.authProvider,
  };
}

/**
 * requireStudent() for Server Actions: a revoked session (account deleted or
 * suspended while a tab was open — see the jwt callback in
 * lib/auth-student.ts) navigates the client to /login instead of surfacing a
 * generic action error. Route handlers keep requireStudent() and answer 401.
 */
export async function requireStudentOrLogin() {
  try {
    return await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) redirect("/login");
    throw error;
  }
}
