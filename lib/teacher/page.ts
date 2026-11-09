import "server-only";
import { notFound, redirect } from "next/navigation";
import { TeacherAccessError, type TeacherScope } from "@/lib/teacher/scope";
import { getTeacher } from "@/lib/teacher/session";

/** For Teacher Portal pages: the scope, or a redirect to sign-in. */
export async function requireTeacherPage(): Promise<TeacherScope> {
  const scope = await getTeacher();
  if (!scope) redirect("/teacher-login");
  return scope;
}

/** Runs a scope lookup; out-of-scope ids render as 404. */
export async function inScopeOr404<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TeacherAccessError) notFound();
    throw e;
  }
}
