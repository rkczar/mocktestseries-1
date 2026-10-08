/**
 * Admin Delete Test — browser + authorization checks against a scratch server.
 *
 *   DATABASE_URL=<scratch> BASE=http://localhost:3127 \
 *   MASTER_USER=… MASTER_PASS=… FULL_USER=… FULL_PASS=… \
 *   NODE_PATH=<dir containing playwright> node scripts/verify-test-deletion-ui.mjs
 *
 * The server must run `next start` on the same scratch DATABASE_URL with
 * NEXTAUTH_URL/AUTH_URL = BASE. Fixture: scripts/test-deletion-ui-fixture.ts.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3127";
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

const fixture = (cmd) =>
  JSON.parse(
    execFileSync("npx", ["tsx", "scripts/test-deletion-ui-fixture.ts", cmd], { env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, encoding: "utf8" })
      .trim()
      .split("\n")
      .pop() || "{}"
  );
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const actionId = (name) => Object.entries(manifest.node).find(([, v]) => v.exportedName === name && /delete-actions/.test(v.filename))?.[0];

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function adminLogin(page, user, pass) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pass);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const row = (page, title) => page.locator("tr", { hasText: title });
/** Raw Server Action call from inside the page (keeps the admin cookie). */
const callAction = (page, id, args, path) =>
  page.evaluate(
    async ({ id, args, path }) => {
      const r = await fetch(path ?? location.pathname, { redirect: "manual", method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: JSON.stringify(args) });
      return { status: r.status, text: await r.text() };
    },
    { id, args, path }
  );

const F = fixture("setup");
const browser = await chromium.launch();
try {
  console.log("\n--- Master Admin, desktop: delete an unused duplicate from the list ---");
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await adminLogin(page, process.env.MASTER_USER, process.env.MASTER_PASS);
    await page.goto(`${BASE}/admin/tests?tab=mock`);
    const r = row(page, "TDELUI Unused Duplicate").first();
    await r.getByRole("button", { name: /Delete TDELUI Unused Duplicate/ }).click();
    const dlg = page.getByTestId("delete-test-dialog");
    await dlg.getByText(/cannot be undone/).waitFor();
    const text = await dlg.innerText();
    check("dialog: title, type, questions, attempts, enrollments, warning", /TDELUI Unused Duplicate/.test(text) && /Mock Test/.test(text) && /2\s*Questions/i.test(text) && /0\s*Attempts/i.test(text) && /0\s*Enrollments/i.test(text) && /cannot be undone/i.test(text), text);
    const confirm = dlg.getByRole("button", { name: "Delete permanently" });
    check("confirm disabled before typing", await confirm.isDisabled());
    await dlg.getByLabel("Type DELETE to confirm").fill("delete");
    check("lower-case 'delete' does not enable it", await confirm.isDisabled());
    await dlg.getByLabel("Type DELETE to confirm").fill("DELETE");
    check("typing DELETE enables it", await confirm.isEnabled());
    await confirm.dblclick(); // double-click must still delete exactly once, cleanly
    await page.getByTestId("test-deleted-notice").waitFor({ timeout: 15000 });
    check("success notice shown", /Deleted "TDELUI Unused Duplicate" permanently/.test(await page.getByTestId("test-deleted-notice").innerText()));
    await page.waitForTimeout(500);
    check("row removed from the list without reload", (await row(page, "TDELUI Unused Duplicate").count()) === 0);
    check("still on the Mock Tests tab (filters/tab kept)", /tab=mock/.test(page.url()), page.url());
    const s = fixture("state");
    check("DB: test gone, question bank intact", !s.mocks.some((m) => m.id === F.unused) && s.questions === 2, s);

    console.log("\n--- Blocked test: exact reason + Archive instead ---");
    await row(page, "TDELUI Attempted").first().getByRole("button", { name: /Delete TDELUI Attempted/ }).click();
    await dlg.getByText("This test has student activity or protected dependencies and cannot be permanently deleted.").waitFor();
    const bt = await dlg.innerText();
    check("reason lists the attempt; no Delete permanently button", /1 student attempt recorded/.test(bt) && (await dlg.getByRole("button", { name: "Delete permanently" }).count()) === 0, bt);
    await dlg.getByRole("button", { name: "Archive instead" }).click();
    await page.getByTestId("test-deleted-notice").getByText(/Archived "TDELUI Attempted"/).waitFor({ timeout: 15000 });
    const s2 = fixture("state");
    const att = s2.mocks.find((m) => m.id === F.attempted);
    check("archived, attempt + score preserved and linked", att?.status === "ARCHIVED" && s2.attempts[0]?.mockTestId === F.attempted && s2.attempts[0]?.score === 4, s2);

    console.log("\n--- Detail page delete ---");
    await page.goto(`${BASE}/admin/tests/mock/${F.detail}`);
    await page.getByTestId("delete-test-trigger").click();
    await dlg.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dlg.getByRole("button", { name: "Delete permanently" }).click();
    await page.waitForURL(/\/admin\/tests\?tab=mock/, { timeout: 15000 });
    await page.getByTestId("test-deleted-notice").waitFor({ timeout: 15000 });
    check("redirected to Mock Tests with success notice", /Detail Page Duplicate/.test(await page.getByTestId("test-deleted-notice").innerText()));
    const r404 = await page.goto(`${BASE}/admin/tests/mock/${F.detail}`);
    check("deleted test's editor now 404s", r404.status() === 404, r404.status());

    console.log("\n--- Custom Module delete ---");
    await page.goto(`${BASE}/admin/tests?tab=custom-modules`);
    await row(page, "TDELUI Custom Module").first().getByRole("button", { name: /Delete TDELUI Custom Module/ }).click();
    await dlg.getByText(/cannot be undone/).waitFor();
    const ct = await dlg.innerText();
    check("custom module dialog has no Enrollments tile", /Custom Module/.test(ct) && !/Enrollments/.test(ct), ct);
    await dlg.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dlg.getByRole("button", { name: "Delete permanently" }).click();
    await page.getByTestId("test-deleted-notice").waitFor({ timeout: 15000 });
    check("custom module deleted", fixture("state").modules.length === 0);

    console.log("\n--- Repeat delete of an already-deleted test (raw action) ---");
    await page.goto(`${BASE}/admin/tests?tab=mock`);
    const again = await callAction(page, actionId("deleteMockTestAction"), [F.unused]);
    check("repeat delete → clean 'already deleted' result", /no longer exists/.test(again.text), again);
    await ctx.close();
  }

  console.log("\n--- Mobile (390×844) dialog ---");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await adminLogin(page, process.env.MASTER_USER, process.env.MASTER_PASS);
    await page.goto(`${BASE}/admin/tests/mock/${F.mobile}`);
    await page.getByTestId("delete-test-trigger").tap();
    const dlg = page.getByTestId("delete-test-dialog");
    await dlg.getByText("Delete this test permanently?").waitFor();
    const box = await dlg.boundingBox();
    check("dialog fits the 390px viewport", box && box.x >= 0 && box.x + box.width <= 390, box);
    await dlg.getByLabel("Type DELETE to confirm").fill("DELETE");
    const btn = dlg.getByRole("button", { name: "Delete permanently" });
    await btn.scrollIntoViewIfNeeded();
    const bb = await btn.boundingBox();
    check("confirm button on-screen and tappable", bb && bb.y + bb.height <= 844 && bb.x + bb.width <= 390, bb);
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/delete-dialog-mobile.png` : "/dev/null" }).catch(() => {});
    await btn.tap();
    await page.waitForURL(/\/admin\/tests\?tab=mock/, { timeout: 15000 });
    check("mobile delete completed", !fixture("state").mocks.some((m) => m.id === F.mobile));
    await ctx.close();
  }

  console.log("\n--- 11. Unauthorized admin (FULL_ADMIN) ---");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await adminLogin(page, process.env.FULL_USER, process.env.FULL_PASS);
    await page.goto(`${BASE}/admin/tests?tab=mock`);
    await row(page, "TDELUI Authz Target").first().waitFor();
    check("no Delete control rendered for FULL_ADMIN", (await page.getByTestId("delete-test-trigger").count()) === 0);
    const chk = await callAction(page, actionId("getMockTestDeleteCheckAction"), [F.authz]);
    const del = await callAction(page, actionId("deleteMockTestAction"), [F.authz]);
    check("forged check call refused server-side", /Only the Master Admin/.test(chk.text), chk);
    check("forged delete call refused server-side", /Only the Master Admin/.test(del.text), del);
    const delCm = await callAction(page, actionId("deleteCustomModuleAction"), [F.authz]);
    check("forged custom-module delete refused", /Only the Master Admin/.test(delCm.text), delCm);
    check("DB: target still exists", fixture("state").mocks.some((m) => m.id === F.authz));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    const anon = await callAction(page, actionId("deleteMockTestAction"), [F.authz], "/admin/tests");
    // Either the admin gate redirects before the action runs, or the action itself refuses.
    const refused = /Only the Master Admin/.test(anon.text) || anon.status === 0 || (anon.status >= 300 && anon.status < 400) || anon.status === 401 || anon.status === 403;
    check("signed-out delete call refused; target still exists", refused && fixture("state").mocks.some((m) => m.id === F.authz), anon);
    await ctx.close();
  }
} finally {
  await browser.close();
  fixture("cleanup");
}
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
