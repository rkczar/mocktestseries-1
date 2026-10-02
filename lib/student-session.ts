import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { studentServerAuth } from "@/lib/auth-student";
import { safeStudentCallback } from "@/lib/student-callback";
import { STUDENT_PATH_HEADER } from "@/lib/student-path";

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
    /** This browser's StudentDevice id (null for an untracked pre-device-security session). */
    deviceId: session.user.deviceId ?? null,
    /** This sign-in's StudentSession id (null when untracked). */
    sessionRowId: session.user.sessionRowId ?? null,
  };
}

/**
 * requireStudent() for pages, layouts and Server Actions: a dead session
 * (logged out elsewhere, device revoked, account suspended — see the jwt
 * callback in lib/auth-student.ts) navigates to /login with the requested
 * page as callbackUrl, so signing in again lands exactly where the student
 * was going. Never an error screen. Route handlers keep requireStudent() and
 * answer 401.
 */
export async function requireStudentOrLogin() {
  try {
    return await requireStudent();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) {
      const destination = safeStudentCallback((await headers()).get(STUDENT_PATH_HEADER));
      redirect(`/login?callbackUrl=${encodeURIComponent(destination)}`);
    }
    throw error;
  }
}
