import { isSafeInternalRoute } from "@/lib/safe-route";

export const DEFAULT_STUDENT_DESTINATION = "/student/dashboard";

/**
 * The one post-login destination rule for Student auth (password, OTP,
 * Google, registration, and an already-signed-in visit to /login): a
 * same-origin path inside the student area, query string intact (e.g.
 * /student/attempt/resume?paper=<id>, /student/checkout/<code>). Anything
 * else — external/protocol-relative URLs, /admin, /login itself — falls back
 * to the dashboard, so callbackUrl can never become an open redirect or a
 * login loop. Pure — usable from server actions and pages alike.
 */
export function safeStudentCallback(callbackUrl: string | null | undefined): string {
  if (!callbackUrl || !isSafeInternalRoute(callbackUrl)) return DEFAULT_STUDENT_DESTINATION;
  const path = callbackUrl.split(/[?#]/)[0];
  if (path !== "/student" && !path.startsWith("/student/")) return DEFAULT_STUDENT_DESTINATION;
  if (path === "/student/login" || path === "/student/register") return DEFAULT_STUDENT_DESTINATION;
  return callbackUrl;
}
