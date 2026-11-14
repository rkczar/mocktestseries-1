/**
 * Background Effects on the public exam pages (EXAM surface): exam pages show the background exactly when the saved
 * scope shows it on the homepage; every other public page keeps its existing rule. LOCAL build + DISPOSABLE database:
 * this script rewrites the scratch `ui.background_effects` row per scope and restores it at the end.
 *
 *   BASE=http://127.0.0.1:3681 EXAM_SLUG=<public slug> SETTING_JSON=<file with a saved config> DATABASE_URL=<scratch> \
 *     SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-exam-background-ui.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:3681";
const SLUG = process.env.EXAM_SLUG;
const SHOTS = process.env.SHOTS || "";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) || !/\/mts_[a-z0-9_]+/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Local server + scratch database only.");
  process.exit(2);
}
const saved = JSON.parse(fs.readFileSync(process.env.SETTING_JSON, "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=[^&]*/, "") });
await db.connect();
const KEY = "ui.background_effects";
const original = (await db.query(`select value from "Setting" where key = $1`, [KEY])).rows[0]?.value ?? null;
const setScope = async (scope, enabled = true) => {
  await db.query(`insert into "Setting" (key, value, "updatedAt") values ($1, $2, now()) on conflict (key) do update set value = excluded.value, "updatedAt" = now()`, [
    KEY,
    JSON.stringify({ ...saved, scope, enabled }),
  ]);
  await new Promise((r) => setTimeout(r, 6000)); // settings cache TTL is 5 s
};

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const EXAM_PAGES = ["/exams", `/exams/${SLUG}`, `/exams/${SLUG}/syllabus`, `/exams/${SLUG}/exam-pattern`];
const OTHER_PUBLIC = ["/plans-and-pricing", "/contact"];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route((url) => !url.href.startsWith(BASE), (route) => route.abort());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const canvasOn = async (path) => {
  const r = await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  return { status: r.status(), canvas: (await page.locator("canvas").count()) > 0 };
};

try {
  for (const [scope, homepage, publicPages] of [
    ["HOMEPAGE_AND_DASHBOARD", true, false], // production today
    ["HOMEPAGE", true, false],
    ["PUBLIC", true, true],
    ["STUDENT_DASHBOARD", false, false],
  ]) {
    console.log(`scope ${scope}`);
    await setScope(scope);
    check(`homepage background = ${homepage}`, (await canvasOn("/")).canvas === homepage);
    for (const p of EXAM_PAGES) {
      const r = await canvasOn(p);
      check(`${p} (HTTP ${r.status}) background = ${homepage} (follows the homepage)`, r.status === 200 && r.canvas === homepage, r);
      if (scope === "HOMEPAGE_AND_DASHBOARD" && p === `/exams/${SLUG}` && SHOTS) await page.screenshot({ path: `${SHOTS}/exam-page-galaxy.png` });
    }
    for (const p of OTHER_PUBLIC) {
      const r = await canvasOn(p);
      check(`${p} background = ${publicPages} (unchanged rule)`, r.canvas === publicPages, r);
    }
  }
  console.log("disabled");
  await setScope("PUBLIC", false);
  check("Background Effects OFF → no exam page background", !(await canvasOn(`/exams/${SLUG}`)).canvas);
  check("no page errors", errors.length === 0, errors.slice(0, 3));
} finally {
  if (original === null) await db.query(`delete from "Setting" where key = $1`, [KEY]);
  else await db.query(`update "Setting" set value = $2 where key = $1`, [KEY, JSON.stringify(original)]);
  await browser.close();
  await db.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL EXAM BACKGROUND CHECKS PASSED");
process.exit(failures ? 1 : 0);
