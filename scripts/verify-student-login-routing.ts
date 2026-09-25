/**
 * Student login routing regression (pure — no DB, no server):
 *  - safeStudentCallback keeps same-origin /student destinations with their
 *    query string and rejects open-redirect / loop / admin targets.
 *  - the legacy redirect list is explicit (no wildcards) and every
 *    destination is an internal path.
 * Live HTTP checks (status + Location for /login, /student_login.php,
 * /student/login, www) are done with curl against the running release.
 *
 *   npx tsx scripts/verify-student-login-routing.ts
 */
import { safeStudentCallback, DEFAULT_STUDENT_DESTINATION as D } from "@/lib/student-callback";
import { LEGACY_REDIRECTS } from "@/lib/legacy-redirects";

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}

console.log("--- callbackUrl ---");
check("dashboard kept", safeStudentCallback("/student/dashboard") === "/student/dashboard");
check("attempt resume keeps ?paper=", safeStudentCallback("/student/attempt/resume?paper=ABC") === "/student/attempt/resume?paper=ABC");
check("checkout keeps code + query", safeStudentCallback("/student/checkout/RUHS-MO?coupon=X&order=1") === "/student/checkout/RUHS-MO?coupon=X&order=1");
check("test series kept", safeStudentCallback("/student/test-series") === "/student/test-series");
check("missing → dashboard", safeStudentCallback(undefined) === D && safeStudentCallback("") === D);
check("absolute external URL rejected", safeStudentCallback("https://evil.example/student") === D);
check("protocol-relative rejected", safeStudentCallback("//evil.example/student") === D);
check("backslash trick rejected", safeStudentCallback("/\\evil.example") === D);
check("prefix lookalike rejected", safeStudentCallback("/student.evil.example") === D && safeStudentCallback("/studentx") === D);
check("admin rejected", safeStudentCallback("/admin") === D);
check("login loop rejected", safeStudentCallback("/login") === D && safeStudentCallback("/student/login?callbackUrl=/login") === D);

console.log("--- legacy redirects ---");
check("/student_login.php → /login", LEGACY_REDIRECTS.some((r) => r.source === "/student_login.php" && r.destination === "/login"));
check("no wildcard / catch-all sources", LEGACY_REDIRECTS.every((r) => !/[:*()]/.test(r.source)));
check("all destinations internal", LEGACY_REDIRECTS.every((r) => r.destination.startsWith("/") && !r.destination.startsWith("//")));
check("no destination is itself a legacy source (no chains)", LEGACY_REDIRECTS.every((r) => !LEGACY_REDIRECTS.some((o) => o.source === r.destination.split("#")[0])));

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
