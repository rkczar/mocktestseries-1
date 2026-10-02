/**
 * Request header proxy.ts sets on every /student request it lets through:
 * the requested path + query (without the RSC cache-buster). Lets a Server
 * Component send a student whose session died mid-request back to /login
 * with the exact destination as callbackUrl. Only ever used as a
 * callbackUrl, which safeStudentCallback() re-validates.
 */
export const STUDENT_PATH_HEADER = "x-mts-student-path";
