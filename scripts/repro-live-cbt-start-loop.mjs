/**
 * Reproduces the 7 Oct 2026 Live CBT incident in a real browser on a
 * DISPOSABLE database (fixture: scripts/live-cbt-ui-fixture.ts). The live
 * mock gets the exact production configuration at the scheduled start:
 * Enrollment ON, Scheduled Release (start passed, NO window end), result
 * release Immediate, Single Attempt — and an enrolled student presses
 * "Start Live Test".
 *
 * Before the fix: the start action redirects back to the same page (to show a
 * Pre-Test Setup that the Live CBT page never renders), so the button does
 * nothing and no attempt is created. After the fix: the player opens.
 *
 *   BASE=http://localhost:3121 FIXTURE=<lcb.json> DATABASE_URL=<scratch> EXPECT=loop|player \
 *     NODE_PATH=<dir containing playwright> node scripts/repro-live-cbt-start-loop.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3121";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const EXPECT = process.env.EXPECT ?? "player";
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
const DB = process.env.DATABASE_URL.replace(/\?schema=public$/, "");
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();

const sid = F.students.viewer.id;
sql(`delete from "TestAttempt" where "mockTestId"='${F.l1}'`);
sql(`delete from "StudentDevice" where "studentId"='${sid}'`);
sql(`delete from "StudentLoginAttempt" where "studentId"='${sid}'`);
// The production row at 04:30 UTC on 7 Oct (AuditLog 01:43:52 / 01:43:59 + enrollment ON since 6 Oct).
sql(`update "MockTest" set "availableFrom"=now()-interval '1 minute', "availableUntil"=null, "resultReleaseMode"='IMMEDIATE',
     "resultReleaseAt"=null, "attemptPolicy"='SINGLE_ATTEMPT', "enrollmentEnabled"=true, "enrollmentOpensAt"=null, "enrollmentClosesAt"=null where id='${F.l1}'`);
sql(`insert into "MockTestEnrollment"(id,"mockTestId","studentId") values ('repro-${Date.now()}','${F.l1}','${sid}') on conflict do nothing`);

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const posts = [];
page.on("request", (r) => r.method() === "POST" && r.url().includes("/student/test-series/") && posts.push(r.url()));
await page.goto(`${BASE}/login`);
await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
await page.fill("#identifier", F.students.viewer.email);
await page.fill("input[name=password]", F.password);
await page.locator("form:has(#identifier) button[type=submit]").click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });

await page.goto(`${BASE}/student/test-series/${F.l1}`);
const phase = await page.getAttribute("[data-testid=live-cbt-panel]", "data-phase");
const btn = page.getByRole("button", { name: /Start Live Test/ });
console.log(`panel phase: ${phase}; Start Live Test visible: ${await btn.isVisible()}`);
for (let i = 1; i <= 3; i++) {
  await btn.click();
  await page.waitForTimeout(4000);
  console.log(`click ${i}: url=${new URL(page.url()).pathname} player=${(await page.locator("[data-testid=test-player]").count()) > 0}`);
  if (!page.url().includes("/student/test-series/")) break;
}
const attempts = sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l1}' and "studentId"='${sid}'`);
const reachedPlayer = /\/student\/attempt\/[^/]+\/run$/.test(page.url());
console.log(`server-action POSTs: ${posts.length}; attempts created: ${attempts}; reached player: ${reachedPlayer}`);
await browser.close();

const ok = EXPECT === "loop" ? !reachedPlayer && attempts === "0" : reachedPlayer && attempts === "1";
console.log(ok ? `RESULT: matches expectation (${EXPECT})` : `RESULT: does NOT match expectation (${EXPECT})`);
process.exit(ok ? 0 : 1);
