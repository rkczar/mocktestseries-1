/**
 * AUTH / SESSION / LOGOUT — permanent regression guard (real browser + HTTP).
 *
 * Covers what a "minor" change to middleware, lib/auth*.ts, lib/rbac.ts,
 * lib/student-devices.ts or next.config.ts could silently break:
 *   - student login → logout → Back shows the login page, not the dashboard
 *   - a copy of the pre-logout student cookie is rejected (server-side revocation)
 *   - admin login → logout → a copy of the pre-logout admin cookie is rejected
 *     (AdminUser.sessionsValidAfter), and the admin can sign in again
 *   - session cookies are HttpOnly + SameSite=Lax; private pages are no-store
 *   - unauthenticated admin API → 401/403 (never 200/500); raw test-resource
 *     PDFs → 404; /api/health → 200; HSTS + Permissions-Policy set; no X-Powered-By
 *
 * Runs only against a LOCAL production build backed by a DISPOSABLE database:
 *   DATABASE_URL=<scratch> npx prisma migrate deploy
 *   DATABASE_URL=<scratch> ADMIN_SEED_EMAIL=qa@example.test ADMIN_SEED_USERNAME=qa-master ADMIN_SEED_PASSWORD=… npx tsx prisma/seed.ts
 *   npx next build
 *   DATABASE_URL=<scratch> AUTH_URL=http://localhost:3100/api/student-auth NEXTAUTH_URL=http://localhost:3100 npx next start -p 3100 &
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/auth-session-fixture.ts setup > /tmp/auth-fixture.json
 *   BASE=http://localhost:3100 FIXTURE=/tmp/auth-fixture.json ADMIN_USER=qa-master ADMIN_PASS=… \
 *     NODE_PATH=<dir containing playwright> node scripts/verify-auth-session.mjs
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/auth-session-fixture.ts cleanup
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE || "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "";

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

async function studentLogin(page) {
  await page.goto(`${BASE}/login`);
  await page.fill("#identifier", F.studentIdentifier);
  await page.fill("input[name=password]", F.studentPassword);
  await Promise.all([page.waitForURL(/\/student\//, { timeout: 30000 }), page.locator("form:has(#identifier) button[type=submit]").click()]);
}

async function adminLogin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", ADMIN_USER);
  await page.fill("input[name=password]", ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}

const browser = await chromium.launch();
try {
  console.log("1. Student login / logout / Back / cookie replay");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await studentLogin(page);
    check("student lands on /student/*", /\/student\//.test(page.url()), page.url());
    const cookie = (await ctx.cookies()).find((c) => c.name === "student-session-token");
    check("student cookie is HttpOnly + SameSite=Lax", cookie?.httpOnly === true && cookie?.sameSite === "Lax", cookie && { httpOnly: cookie.httpOnly, sameSite: cookie.sameSite });
    const dash = await page.request.get(`${BASE}/student/dashboard`);
    check("student dashboard is Cache-Control no-store", /no-store/.test(dash.headers()["cache-control"] ?? ""), dash.headers()["cache-control"]);

    await page.goto(`${BASE}/student/dashboard`);
    await page.getByRole("button", { name: /account|profile|menu/i }).first().click();
    await Promise.all([page.waitForURL(/\/login/, { timeout: 30000 }), page.getByRole("menuitem", { name: /logout/i }).click()]);
    check("logout lands on /login", /\/login/.test(page.url()), page.url());
    check("session cookie cleared", !(await ctx.cookies()).some((c) => c.name === "student-session-token"));

    await page.goBack().catch(() => {});
    await page.waitForTimeout(2000);
    check("Back after logout shows login, not the dashboard", /\/login/.test(page.url()), page.url());

    const replay = await browser.newContext();
    await replay.addCookies([{ name: "student-session-token", value: cookie.value, url: BASE }]);
    const rp = await replay.newPage();
    await rp.goto(`${BASE}/student/dashboard`);
    check("replayed pre-logout student cookie → /login", /\/login/.test(rp.url()), rp.url());
    const sess = await replay.request.get(`${BASE}/api/student-auth/session`);
    check("replayed cookie has no session", (await sess.text()).trim() === "null");
    await replay.close();

    await studentLogin(page);
    check("student can sign in again after logout", /\/student\//.test(page.url()), page.url());
    await ctx.close();
  }

  console.log("\n2. Admin login / logout / cookie replay");
  if (!ADMIN_USER || !ADMIN_PASS) {
    check("ADMIN_USER / ADMIN_PASS provided", false);
  } else {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await adminLogin(page);
    check("admin lands on /admin", /\/admin(?!\/login)/.test(page.url()), page.url());
    const cookie = (await ctx.cookies()).find((c) => /session-token$/.test(c.name));
    check("admin cookie is HttpOnly + SameSite=Lax", cookie?.httpOnly === true && cookie?.sameSite === "Lax");
    await Promise.all([page.waitForURL(/\/admin\/login/, { timeout: 30000 }), page.locator("header form button[type=submit]").first().click()]);
    check("admin logout lands on /admin/login", /\/admin\/login/.test(page.url()), page.url());

    const replay = await browser.newContext();
    await replay.addCookies([{ name: cookie.name, value: cookie.value, url: BASE }]);
    const rp = await replay.newPage();
    await rp.goto(`${BASE}/admin`);
    check("replayed pre-logout admin cookie → /admin/login", /\/admin\/login/.test(rp.url()), rp.url());
    await replay.close();

    await adminLogin(page);
    check("admin can sign in again after logout", /\/admin(?!\/login)/.test(page.url()), page.url());
    await page.goto(`${BASE}/admin`);
    check("fresh admin session stays valid", /\/admin(?!\/login)/.test(page.url()), page.url());
    await ctx.close();
  }

  console.log("\n3. Unauthenticated surfaces + headers");
  {
    const ctx = await browser.newContext();
    const r = ctx.request;
    const api = await r.get(`${BASE}/api/admin/questions/bulk-import/history`);
    check("admin API without session → 401/403", [401, 403].includes(api.status()), api.status());
    const pdf = await r.get(`${BASE}/storage/test-resources/00000000-0000-0000-0000-000000000000.pdf`, { maxRedirects: 0 });
    check("raw test-resource PDF without admin session → 404", pdf.status() === 404, pdf.status());
    const health = await r.get(`${BASE}/api/health`);
    check("/api/health → 200 ok", health.status() === 200 && (await health.json()).status === "ok", health.status());
    const home = await r.get(`${BASE}/`);
    const h = home.headers();
    check("HSTS header set", /max-age=\d+/.test(h["strict-transport-security"] ?? ""), h["strict-transport-security"]);
    check("Permissions-Policy set", Boolean(h["permissions-policy"]));
    check("no X-Powered-By", !h["x-powered-by"], h["x-powered-by"]);
    const sp = await r.get(`${BASE}/student/dashboard`, { maxRedirects: 0 });
    check("student page without session → redirect to /login", [302, 303, 307].includes(sp.status()) && /\/login/.test(sp.headers().location ?? ""), sp.status());
    const ap = await r.get(`${BASE}/admin`, { maxRedirects: 0 });
    check("admin page without session → redirect to /admin/login", [302, 303, 307].includes(ap.status()) && /\/admin\/login/.test(ap.headers().location ?? ""), ap.status());
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL AUTH/SESSION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
