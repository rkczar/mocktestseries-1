/**
 * AI Question Importer — Import Settings → "Refresh provider routes": loading state and the
 * success / provider failure / authentication failure / persistence failure feedback, with what
 * is saved in Setting "ai.importer.routes" each time. Scratch DB + mock OpenRouter
 * (scripts/mock-openrouter-vision.mjs; route reads only — the suite checks no chat request is sent
 * and paid AI stays OFF). Run scripts/ai-import-ui-fixture.ts setup first (key, synced mock catalog, FULL_ADMIN).
 *
 *   BASE=http://localhost:3461 MOCK=http://127.0.0.1:3531 FIXTURE=<aiui.json> ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-ai-import-routes-refresh.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const BASE = process.env.BASE;
const MOCK = process.env.MOCK;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = any($1)`, [[process.env.ADMIN_USER, F.fullAdmin]]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const mock = (path, body) => fetch(`${MOCK}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const snapshot = async () => (await db.query(`select value, "updatedAt" from "Setting" where key='ai.importer.routes'`)).rows[0] ?? null;
const importerSetting = async () => (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value ?? null;
const globalFlags = async () => JSON.stringify((await db.query(`select id, approved, "medicallyApproved" from "AiModel" order by id`)).rows);

await db.query(`delete from "Setting" where key in ('ai.importer', 'ai.importer.routes')`);
await db.query(`drop trigger if exists routes_refresh_fail on "Setting"; drop function if exists routes_refresh_fail()`);
await mock("/__mock/reset", {});
const flags0 = await globalFlags();
const chat0 = (await mock("/__mock/stats")).chat;

const browser = await chromium.launch();
const errors = [];
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  return page;
}
async function login(page, user, pw) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pw);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const URL_SETTINGS = `${BASE}/admin/ai-importer/settings`;
const page = await newPage();
await login(page, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await page.goto(URL_SETTINGS);
const btn = page.locator("[data-testid=routes-refresh]");
const msg = page.locator("[data-testid=routes-refresh-msg]");
let actionId = null;
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().startsWith(URL_SETTINGS) && r.headers()["next-action"]) actionId ??= r.headers()["next-action"];
});
/** Clicks Refresh and waits for the result message; returns {tone, text}. */
async function refresh() {
  await btn.click();
  await msg.waitFor({ timeout: 30000 });
  return { tone: await msg.getAttribute("data-tone"), text: (await msg.textContent()) ?? "" };
}

section("A. Empty importer model list (the production state) — loading state + explained success");
check("before: routes not read", /Not read yet/.test(await page.locator("[data-testid=status-routes]").textContent()));
// Hold the Server Action for 1.5 s so the loading state is observable.
await page.route(URL_SETTINGS, async (route) => {
  if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
  await route.continue();
});
await btn.click();
check("while running: button says Refreshing… and is disabled", /Refreshing provider routes…/.test(await btn.textContent()) && (await btn.isDisabled()));
check("while running: progress text shown", await page.locator("[data-testid=routes-refresh-progress]").isVisible());
await msg.waitFor({ timeout: 30000 });
await page.unroute(URL_SETTINGS);
let m = { tone: await msg.getAttribute("data-tone"), text: (await msg.textContent()) ?? "" };
check("after: button label restored and enabled", /^Refresh provider routes$/.test((await btn.textContent()).trim()) && !(await btn.isDisabled()));
check("empty list → warning explains no model routes to read + what to do", m.tone === "warning" && /no model is on the importer's model list/.test(m.text) && /Add the models the importer may use under Importer models/.test(m.text) && /No model is approved automatically/.test(m.text), m);
let snap = await snapshot();
check("saved: snapshot with ZDR list read, 0 models", snap && snap.value.zdr.ok === true && Object.keys(snap.value.models).length === 0, snap?.value);
check("status panel updated to OK", (await page.locator("[data-testid=status-routes]").getAttribute("data-tone")) === "success" && /for 0 importer models/.test(await page.locator("[data-testid=status-routes]").textContent()));
check("selection no longer says routes were not read", !/has not been read yet/.test((await page.locator("[data-testid=selection]").textContent()) ?? ""));

section("B. Success with models on the (unsaved) importer list");
for (const id of ["mockvision/reader", "mocktext/classifier"]) {
  await page.locator("[data-testid=importer-model-search]").fill(id);
  await page.locator(`[data-testid=importer-model-hits] li[data-model-id="${id}"] [data-testid=importer-model-add]`).click();
}
const reads0 = (await mock("/__mock/stats")).routeReads;
m = await refresh();
check("success message names the models read and the ZDR list", m.tone === "success" && /refreshed and saved at \d\d:\d\d UTC: 2 model\(s\) read, Zero-Data-Retention list read/.test(m.text), m);
snap = await snapshot();
check("saved: both models with routes", snap.value.models["mockvision/reader"]?.ok === true && snap.value.models["mocktext/classifier"]?.ok === true);
check("mock saw 3 route reads (ZDR list + 2 models)", (await mock("/__mock/stats")).routeReads - reads0 === 3);
check("automatic selection now picks a page-reading model", (await page.locator("[data-testid=sel-extract]").getAttribute("data-model")) === "mockvision/reader");

section("C. Provider failure (OpenRouter unreachable / partial)");
const before = (await snapshot()).value.fetchedAt;
await mock("/__mock/config", { zdrStatus: 503, endpointsStatus: 503 });
m = await refresh();
check("all reads fail → error says OpenRouter could not be reached + where to check", m.tone === "error" && /OpenRouter could not be reached/.test(m.text) && /Admin → AI → Providers/.test(m.text), m);
snap = await snapshot();
check("failed reads are recorded (models not usable), never invented", snap.value.fetchedAt !== before && snap.value.zdr.ok === false && snap.value.models["mockvision/reader"].ok === false);
check("status panel shows the problem", (await page.locator("[data-testid=status-routes]").getAttribute("data-tone")) === "warning");
await mock("/__mock/config", { zdrStatus: null, endpointsStatus: 503 });
m = await refresh();
check("partial failure → warning lists the models not read", m.tone === "warning" && /routes read for 0 of 2 model\(s\)/.test(m.text) && /mockvision\/reader/.test(m.text), m);
await mock("/__mock/config", { zdrStatus: null, endpointsStatus: null });
m = await refresh();
check("provider back → success again", m.tone === "success", m);

section("D. Persistence failure (database refuses the write)");
const good = await snapshot();
await db.query(`create function routes_refresh_fail() returns trigger language plpgsql as $$ begin if new.key = 'ai.importer.routes' then raise exception 'scratch: simulated write failure'; end if; return new; end $$`);
await db.query(`create trigger routes_refresh_fail before insert or update on "Setting" for each row execute function routes_refresh_fail()`);
try {
  m = await refresh();
  check("error says the routes could not be saved, previous data unchanged, what to do", m.tone === "error" && /could not be saved \(database error\)/.test(m.text) && /previous route data is unchanged/.test(m.text) && /server log/.test(m.text), m);
  const after = await snapshot();
  check("stored snapshot unchanged", after.value.fetchedAt === good.value.fetchedAt && String(after.updatedAt) === String(good.updatedAt));
} finally {
  await db.query(`drop trigger if exists routes_refresh_fail on "Setting"; drop function if exists routes_refresh_fail()`);
}
m = await refresh();
check("write possible again → success", m.tone === "success", m);

section("E. Authentication / authorization failure");
const kept = await snapshot();
await page.context().clearCookies();
m = await refresh();
check("signed out → error asks to reload / sign in again", m.tone === "error" && /(sign in again|Sign in again)/.test(m.text), m);
check("signed out → nothing saved", (await snapshot()).value.fetchedAt === kept.value.fetchedAt);
const full = await newPage();
await login(full, F.fullAdmin, F.password);
await full.goto(URL_SETTINGS);
check("FULL_ADMIN: no Refresh button", (await full.locator("[data-testid=routes-refresh]").count()) === 0);
const raw = await full.evaluate(
  async ([url, id]) => (await fetch(url, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8" }, body: "[]" })).text(),
  [URL_SETTINGS, actionId]
);
check("FULL_ADMIN calling the action directly → refused with the permission message", /do not have permission/.test(raw), raw.slice(-300));
check("FULL_ADMIN → nothing saved", (await snapshot()).value.fetchedAt === kept.value.fetchedAt);

section("F. Safety");
check("no chat (paid) request reached the mock", (await mock("/__mock/stats")).chat === chat0);
const imp = await importerSetting();
check("paid AI never switched on (importer settings not saved by the suite)", imp === null || imp.aiEnabled === false, imp);
check("global AI → Models approvals unchanged", (await globalFlags()) === flags0);
check("no page errors", errors.length === 0, errors);

await db.query(`delete from "Setting" where key = 'ai.importer.routes'`);
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
