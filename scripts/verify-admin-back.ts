/**
 * Admin internal Back navigation regression (lib/admin-back.ts +
 * components/admin/admin-back-button.tsx). Pure logic — no DB.
 *   npx tsx scripts/verify-admin-back.ts
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { backTarget, isSafeAdminUrl, logicalParent, recordVisit } from "../lib/admin-back";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

console.log("=== Admin Back Button Verification ===\n");

console.log("1. Safe destinations");
check("admin page is safe", isSafeAdminUrl("/admin/questions?tab=all"));
check("login page is never a destination", !isSafeAdminUrl("/admin/login"));
check("student page is not safe", !isSafeAdminUrl("/student/dashboard"));
check("public page is not safe", !isSafeAdminUrl("/exams"));
check("protocol-relative external URL is not safe", !isSafeAdminUrl("//evil.example/admin"));
check("look-alike prefix is not safe", !isSafeAdminUrl("/administrator"));

console.log("\n2. Logical parents");
const parents: [string, string][] = [
  ["/admin/questions/bulk-import/history/abc", "/admin/questions/bulk-import/history"],
  ["/admin/questions/bulk-import/history", "/admin/questions/bulk-import"],
  ["/admin/tests/mock/abc", "/admin/tests/mock"],
  ["/admin/tests/mock/abc/preview", "/admin/tests/mock/abc"],
  ["/admin/tests/mock/new", "/admin/tests/mock"],
  ["/admin/students/abc", "/admin/students"],
  ["/admin/exams/subjects", "/admin/exams"],
  ["/admin/exams/topics", "/admin/exams"],
  ["/admin/exams/previous-year-papers/p1", "/admin/exams?tab=pyp"],
  ["/admin/payments/coupons/new", "/admin/payments?tab=coupons"],
  ["/admin/payments/orders/o1", "/admin/payments/orders"],
  ["/admin/website/homepage", "/admin/website"],
  ["/admin/questions", "/admin"],
  ["/admin/settings/general", "/admin/settings"],
];
for (const [from, to] of parents) check(`${from} → ${to}`, logicalParent(from) === to, logicalParent(from));

console.log("\n3. History stack + list-state preservation");
let stack: string[] = [];
stack = recordVisit(stack, "/admin/questions?tab=all");
stack = recordVisit(stack, "/admin/questions?tab=all&qb=subjectId%3Danat%26page%3D4"); // filter change: same page
check("filter/page change on the same page replaces, not pushes", stack.length === 1 && stack[0].includes("page%3D4"));
stack = recordVisit(stack, "/admin/questions/add?id=q1");
const t1 = backTarget(stack, "/admin/questions/add?id=q1");
check("Back from question edit returns to the SAME filtered Question Bank", t1.fromHistory && t1.href === "/admin/questions?tab=all&qb=subjectId%3Danat%26page%3D4", t1);
stack = recordVisit(stack, "/admin/questions?tab=all&qb=subjectId%3Danat%26page%3D4"); // browser back lands on previous entry
check("landing on the previous entry pops instead of pushing", stack.length === 1);
check("external URLs are never recorded", recordVisit(["/admin"], "/student/dashboard").length === 1);
let tabs = recordVisit(["/admin/questions?tab=all&qb=page%3D4"], "/admin/questions?tab=add&id=q9");
check("a different ?tab= on the same path is a different page (pushed)", tabs.length === 2);
check("Back from the Edit tab returns to the filtered All tab", backTarget(tabs, "/admin/questions?tab=add&id=q9").href === "/admin/questions?tab=all&qb=page%3D4");
tabs = recordVisit(tabs, "/admin/questions?tab=add&id=q10");
check("switching question within the Edit tab replaces", tabs.length === 2);
const deep = backTarget([], "/admin/students/s1");
check("deep link with no history → logical parent", !deep.fromHistory && deep.href === "/admin/students", deep);
const poisoned = backTarget(["/student/x", "/admin/login", "/admin/students/s1"], "/admin/students/s1");
check("unsafe stack entries are skipped → logical parent", poisoned.href === "/admin/students", poisoned);

console.log("\n4. Implemented once, in the shared header");
const header = readFileSync("components/admin/header.tsx", "utf8");
check("header renders <AdminBackButton />", header.includes("<AdminBackButton />"));
const users = execSync("grep -rl 'AdminBackButton' app components lib || true", { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
check("AdminBackButton used only by the shared header (+ its own file)", JSON.stringify(users) === JSON.stringify(["components/admin/admin-back-button.tsx", "components/admin/header.tsx"]), users);
const button = readFileSync("components/admin/admin-back-button.tsx", "utf8");
const code = button.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check("no raw history.back() — destinations are validated admin URLs", !/history\.back\(|router\.back\(/.test(code));
check("hidden on the Admin root", button.includes("if (pathname === ADMIN_ROOT) return null;"));

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
