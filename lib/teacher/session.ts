import "server-only";
import { cache } from "react";
import { getStaffSession } from "@/lib/rbac";
import { teacherScope, TeacherAccessError, type TeacherScope } from "@/lib/teacher/scope";

/** The signed-in teacher's scope (memoized per request), or null. Kept apart from lib/teacher/scope.ts so that stays session-free (scripts). */
export const getTeacher = cache(async (): Promise<TeacherScope | null> => {
  const session = await getStaffSession();
  if (!session?.user?.id || session.user.role !== "TEACHER") return null;
  return teacherScope(session.user.id);
});

/** For Server Actions: throws when the caller is not an active teacher. */
export async function requireTeacher(): Promise<TeacherScope> {
  const scope = await getTeacher();
  if (!scope) throw new TeacherAccessError("Your teacher account is not active. Sign in again or contact the Master Admin.");
  return scope;
}
