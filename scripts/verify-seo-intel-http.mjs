/**
 * SEO Intelligence end-to-end: role access (MASTER_ADMIN manages; FULL_ADMIN
 * and TEACHER view only, enforced server-side), the full Google OAuth code
 * flow against scripts/mock-google-seo.mjs (never real Google), callback
 * forgery/replay/other-admin, every failure scenario, sync + partial
 * failures, needs-reconnect, disconnect + revoke, isolation from the student
 * Google login, and a leak scan of pages, DB rows and the server log for
 * every secret the mock issued or received.
 *
 *   BASE=http://localhost:3541 MOCK=http://127.0.0.1:3542 FIXTURE=<seo-intel-fixture.json> SERVER_LOG=<next log> \
 *   DATABASE_URL=<scratch seointel DB> AUTH_SECRET=<scratch> NODE_PATH=<playwright> node scripts/verify-seo-intel-http.mjs
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const DB = process.env.DATABASE_URL ?? "";
if (!/seointel/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must be a scratch database whose name contains 'seointel'.");
  process.exit(2);
}
const BASE = process.env.BASE ?? "http://localhost:3541";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:3542";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const PAGE = `${BASE}/admin/seo/intelligence`;
const CLIENT_ID = "123456789012-mockseoclientabcdefghijk.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-mockSeoSecret-1234567890abc";

const db = new pg.Client({ connectionString: DB.replace(/\?schema=[^&]*/, "") });
await db.connect();

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? `  — ${extra}` : ""}`);
  if (!ok) failed++;
};
const htmlSeen = [];
const mock = async (path, body) =>
  (await fetch(`${MOCK}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const setting = async (key) => (await db.query(`select value from "Setting" where key=$1`, [key])).rows[0]?.value ?? null;
// Backdate the last sync past the 1-minute throttle (keeps its status + fail streak).
const resetThrottle = () =>
  db.query(`update "Setting" set value = jsonb_set(value, '{lastSync,at}', '"2000-01-01T00:00:00.000Z"') where key='seo.intel.snapshot' and value ? 'lastSync' and value->'lastSync' <> 'null'::jsonb`);

function runScript(mode, input = "") {
  return execFileSync("npx", ["tsx", "scripts/set-seo-google-oauth.ts", mode], {
    input,
    env: { ...process.env, NODE_OPTIONS: "--conditions=react-server", NEXTAUTH_URL: BASE },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const browser = await chromium.launch();
async function login(who) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.admins[who].username);
  await page.fill("input[name=password]", F.admins[who].password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  return { ctx, page };
}
async function open(page, url = PAGE) {
  await page.goto(url);
  const raw = await page.evaluate((u) => fetch(u).then((r) => r.text()), url);
  htmlSeen.push(raw, await page.content());
  return page.content();
}
async function connect(page) {
  await open(page);
  await Promise.all([page.waitForURL(/\/admin\/seo\/intelligence\?google=/, { timeout: 30000 }), page.getByRole("button", { name: /^(Connect|Reconnect) Google$/ }).click()]);
  const u = new URL(page.url());
  htmlSeen.push(await page.content());
  return { status: u.searchParams.get("google"), reason: u.searchParams.get("reason") };
}

const studentBefore = JSON.stringify(await setting("auth.providers"));
const robotsBefore = await (await fetch(`${BASE}/robots.txt`)).text();
const sitemapBefore = await (await fetch(`${BASE}/sitemap.xml`)).text();

// ---- View-only roles -----------------------------------------------------------------------
const teacher = await login("teacher");
const full = await login("full");
const master = await login("master");
const master2 = await login("master2");

for (const [label, s] of [["TEACHER", teacher], ["FULL_ADMIN", full]]) {
  const html = await open(s.page);
  check(`${label} can open SEO Intelligence`, html.includes("SEO Intelligence") && html.includes("Google Connection"));
  check(`${label} sees view-only notice and no controls`, html.includes("View only") && !html.includes('data-testid="seo-intel-controls"'));
  check(`${label} is not shown the redirect URI`, !html.includes("/api/admin/seo-intel/google/callback"));
}
const seoHtml = await open(teacher.page, `${BASE}/admin/seo`);
check("SEO page links to SEO Intelligence", seoHtml.includes('href="/admin/seo/intelligence"'));

// ---- Before the client is installed ---------------------------------------------------------
let html = await open(master.page);
check("MASTER sees controls; Connect disabled before client install", html.includes('data-testid="seo-intel-controls"') && (await master.page.getByRole("button", { name: "Connect Google" }).isDisabled()));

// ---- Install the client via the ops script path ----------------------------------------------
const out = runScript("set", `${CLIENT_ID}\n${CLIENT_SECRET}\n`);
check("set script saves client and prints no secret", out.includes("Saved the SEO Google OAuth client") && !out.includes(CLIENT_SECRET) && !out.includes("mockseoclient"));
const stored0 = await setting("seo.google.oauth");
check("client secret encrypted at rest", !JSON.stringify(stored0).includes(CLIENT_SECRET) && String(stored0.clientSecretCipher).startsWith("v1:"));
const status0 = runScript("status");
check("status script: installed, not connected, GA4 553529096", /client installed/.test(status0) && /Google not connected/.test(status0) && /GA4 553529096/.test(status0));

// ---- Callback forgery ------------------------------------------------------------------------
const anon = await browser.newContext();
const anonRes = await anon.request.get(`${BASE}/api/admin/seo-intel/google/callback?code=4/0AttackerCode123&state=x`, { maxRedirects: 0 });
check("anonymous callback → redirect to admin login", [303, 307, 302].includes(anonRes.status()) && /\/admin\/login/.test(anonRes.headers().location ?? ""));
await anon.close();
await full.page.goto(`${BASE}/api/admin/seo-intel/google/callback?code=4/0AttackerCode123&state=x`);
check("FULL_ADMIN callback → forbidden", /reason=forbidden/.test(full.page.url()));
await master.page.goto(`${BASE}/api/admin/seo-intel/google/callback?code=4/0AttackerCode123&state=x`);
check("MASTER callback without a started flow → state error", /reason=state/.test(master.page.url()));
check("no connection after forged callbacks", !(await setting("seo.google.oauth")).refreshTokenCipher);

// ---- Server Actions forged by view-only roles --------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const actionId = (name) =>
  Object.entries(manifest.node ?? {}).find(([, v]) => JSON.stringify(v).includes("seo/intelligence") && v.exportedName === name)?.[0] ??
  Object.entries(manifest.node ?? {}).find(([, v]) => v.exportedName === name && JSON.stringify(v.layer ?? v).includes("intelligence"))?.[0] ??
  null;
const syncId = actionId("syncGoogleAction");
const connectId = actionId("startGoogleConnectAction");
check("found Server Action ids in the build manifest", Boolean(syncId && connectId), JSON.stringify({ syncId, connectId }));
for (const [label, s] of [["TEACHER", teacher], ["FULL_ADMIN", full]]) {
  for (const [name, id] of [["sync", syncId], ["connect", connectId]]) {
    if (!id) continue;
    const res = await s.ctx.request.post(PAGE, { headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Origin: BASE }, data: "[]", maxRedirects: 0 });
    const loc = res.headers()["x-action-redirect"] ?? res.headers().location ?? "";
    check(`${label} forged ${name} action is refused`, !loc.includes(MOCK.replace("http://", "")) && res.status() !== 303 && !res.headers()["set-cookie"]?.includes("mts-seo-google-oauth"), `status ${res.status()} ${loc}`);
  }
}
check("no state cookie / sync from forged actions", !(await setting("seo.intel.snapshot")));

// ---- Happy path ------------------------------------------------------------------------------
await mock("/__mock/control", { scenario: "ok", email: "seo-owner@example.test" });
let consentUrl = null;
master.page.on("request", (r) => {
  if (r.url().startsWith(`${MOCK}/o/oauth2/v2/auth`)) consentUrl = r.url();
});
let callbackUrl = null;
master.page.on("request", (r) => {
  if (r.url().includes("/api/admin/seo-intel/google/callback")) callbackUrl = r.url();
});
let r = await connect(master.page);
check("MASTER connect → connected", r.status === "connected", JSON.stringify(r));
check("consent URL used the SEO client, PKCE and read-only scopes", Boolean(consentUrl) && consentUrl.includes(encodeURIComponent(CLIENT_ID)) && consentUrl.includes("code_challenge_method=S256") && !consentUrl.includes("studentlogin"));
html = await master.page.content();
check("page shows connected account + GA4 553529096", html.includes("seo-owner@example.test") && html.includes("553529096") && html.includes("Connected"));
check("timestamps say IST once (no \"IST IST\")", (await master.page.locator("main").innerText()).includes(" IST") && !(await master.page.locator("main").innerText()).includes("IST IST"));
const stored1 = await setting("seo.google.oauth");
check("refresh token stored encrypted", String(stored1.refreshTokenCipher).startsWith("v1:") && stored1.accountEmail === "seo-owner@example.test");
check("state cookie cleared after callback", !(await master.ctx.cookies()).some((c) => c.name === "mts-seo-google-oauth" && c.value));

// Replay the same callback (code + state) → refused, connection unchanged
await master.page.goto(callbackUrl);
check("callback replay → state error", /reason=state/.test(master.page.url()));
check("replay left the connection unchanged", (await setting("seo.google.oauth")).refreshTokenCipher === stored1.refreshTokenCipher);

// ---- Sync --------------------------------------------------------------------------------------
await open(master.page);
await master.page.getByRole("button", { name: "Sync now" }).click();
await master.page.getByText("Synced Search Console and GA4.").waitFor({ timeout: 30000 });
html = await open(master.page);
check("GSC data shown (property, totals, queries, pages)", html.includes("sc-domain:mocktestseries.in") && html.includes("ruhs mo mock test 1") && html.includes("https://mocktestseries.in/exams/sample-1") && html.includes("56,789"));
check("GA4 data shown (channels, landing pages)", html.includes("Organic Search") && html.includes("/exams/ruhs-mo") && html.includes("61.0%"));
await master.page.getByRole("button", { name: "Sync now" }).click();
await master.page.getByText("less than a minute ago").waitFor({ timeout: 30000 });
check("second sync within a minute is throttled", true);
html = await open(teacher.page);
check("TEACHER sees synced data", html.includes("ruhs mo mock test 1") && html.includes("Organic Search") && !html.includes('data-testid="seo-intel-controls"'));

// ---- Other admin cannot finish someone else's flow ---------------------------------------------
// Hold the browser at the consent step, then ask the mock for the callback URL ourselves
// (Playwright does not route redirected requests, so the callback itself can't be intercepted).
await master.page.route(`${MOCK}/o/oauth2/v2/auth**`, (route) => route.abort());
consentUrl = null;
await open(master.page);
await master.page.getByRole("button", { name: "Reconnect Google" }).click().catch(() => {});
for (let i = 0; i < 50 && !consentUrl; i++) await master.page.waitForTimeout(200);
await master.page.unroute(`${MOCK}/o/oauth2/v2/auth**`);
callbackUrl = consentUrl ? (await fetch(consentUrl, { redirect: "manual" })).headers.get("location") : null;
const aCookie = (await master.ctx.cookies()).find((c) => c.name === "mts-seo-google-oauth");
await master.page.unroute("**/api/admin/seo-intel/google/callback**");
check("captured master A's pending callback", Boolean(callbackUrl && aCookie));
if (aCookie) await master2.ctx.addCookies([{ ...aCookie }]);
await master2.page.goto(callbackUrl);
check("MASTER B completing A's flow → other-admin", /reason=other-admin/.test(master2.page.url()));
check("connection still A's", (await setting("seo.google.oauth")).refreshTokenCipher === stored1.refreshTokenCipher);
await master.ctx.clearCookies({ name: "mts-seo-google-oauth" });

// ---- Grant safety: Google (and the mock) revoke an account's WHOLE grant -------------------------
const ACC_A = "seo-owner@example.test";
const ACC_B = "seo-owner2@example.test";
const grants = async () => (await mock("/__mock/grants")).grants;
async function syncOk() {
  await resetThrottle();
  await open(master.page);
  await master.page.getByRole("button", { name: "Sync now" }).click();
  await master.page.getByTestId("seo-intel-controls").getByRole("status").waitFor({ timeout: 30000 });
  return (await setting("seo.intel.snapshot"))?.lastSync?.ok === true;
}
const FAILS = [
  ["denied", "denied"],
  ["noRefresh", "no-refresh-token"],
  ["missingScope", "missing-scopes"],
  ["badAud", "id-token"],
  ["unverified", "id-token"],
  ["exchangeError", "exchange"],
];

// Same account, successful reconnect: new token stored, old grant NOT revoked, both work.
let g0 = await grants();
await mock("/__mock/control", { scenario: "ok", email: ACC_A });
r = await connect(master.page);
let cur = await setting("seo.google.oauth");
let g1 = await grants();
check("same-account reconnect → connected, new token stored", r.status === "connected" && cur.accountEmail === ACC_A && cur.refreshTokenCipher !== stored1.refreshTokenCipher && Boolean(cur.accountSub));
check("same-account reconnect did not revoke the grant", g1[ACC_A].epoch === g0[ACC_A].epoch && g1[ACC_A].liveRefresh >= 2, JSON.stringify({ g0: g0[ACC_A], g1: g1[ACC_A] }));
check("same-account reconnect: new connection syncs", await syncOk());

// Same account, failed reconnect: live connection untouched and still working.
for (const [scenario, reason] of FAILS) {
  const before = await setting("seo.google.oauth");
  const gb = await grants();
  await mock("/__mock/control", { scenario, email: ACC_A });
  r = await connect(master.page);
  const after = await setting("seo.google.oauth");
  const ga = await grants();
  check(`same-account ${scenario} → ${reason}, message shown, connection kept`, r.status === "error" && r.reason === reason && (await master.page.content()).includes('data-testid="seo-intel-callback"') && after.refreshTokenCipher === before.refreshTokenCipher, JSON.stringify(r));
  check(`same-account ${scenario}: grant not revoked`, ga[ACC_A].epoch === gb[ACC_A].epoch);
  await mock("/__mock/control", { scenario: "ok" });
  check(`same-account ${scenario}: existing connection still syncs`, await syncOk());
}

// Different account, failed reconnect: live connection (account A) untouched and still working.
for (const [scenario, reason] of FAILS.filter(([sc]) => ["noRefresh", "missingScope", "badAud", "unverified"].includes(sc))) {
  const before = await setting("seo.google.oauth");
  const gb = await grants();
  await mock("/__mock/control", { scenario, email: ACC_B });
  r = await connect(master.page);
  const after = await setting("seo.google.oauth");
  const ga = await grants();
  check(`other-account ${scenario} → ${reason}, A kept`, r.status === "error" && r.reason === reason && after.refreshTokenCipher === before.refreshTokenCipher && after.accountEmail === ACC_A, JSON.stringify(r));
  check(`other-account ${scenario}: A's grant not revoked`, ga[ACC_A].epoch === gb[ACC_A].epoch);
  if (scenario === "missingScope" || scenario === "noRefresh") {
    // Verified as a different account → its unusable tokens are cleaned up (B's grant only).
    check(`other-account ${scenario}: B's unusable grant revoked`, (ga[ACC_B]?.epoch ?? 0) > (gb[ACC_B]?.epoch ?? 0));
  } else {
    // Identity not verifiable → never revoked while a connection exists.
    check(`other-account ${scenario}: unverifiable tokens left alone`, (ga[ACC_B]?.epoch ?? 0) === (gb[ACC_B]?.epoch ?? 0));
  }
  await mock("/__mock/control", { scenario: "ok" });
  check(`other-account ${scenario}: A still syncs`, await syncOk());
}
const failAudit = (await db.query(`select metadata from "AuditLog" where action='SEO_GOOGLE_CONNECT_FAILED'`)).rows;
check("connect failures audited", failAudit.length >= 10);

// Different account, successful reconnect: stored first, THEN A's old grant revoked; B works.
g0 = await grants();
await mock("/__mock/control", { scenario: "ok", email: ACC_B });
r = await connect(master2.page);
const stored2 = await setting("seo.google.oauth");
g1 = await grants();
check("MASTER B reconnect with account B replaces the shared connection", r.status === "connected" && stored2.accountEmail === ACC_B && stored2.connectedById === F.admins.master2.id);
check("account A's old grant revoked at Google", g1[ACC_A].epoch > g0[ACC_A].epoch && g1[ACC_A].liveRefresh === 0);
check("account B's new grant untouched", g1[ACC_B].epoch === g0[ACC_B].epoch && g1[ACC_B].liveRefresh >= 1);
check("account B connection syncs", await syncOk());

// ---- Partial failures + redaction --------------------------------------------------------------
await resetThrottle();
await mock("/__mock/control", { scenario: "ga4Forbidden" });
await open(master.page);
await master.page.getByRole("button", { name: "Sync now" }).click();
await master.page.getByText("Sync partly failed.").waitFor({ timeout: 30000 });
html = await open(master.page);
check("GA4 403 shown as GA4 error, GSC still synced", html.includes("GA4:") && html.includes("PERMISSION_DENIED") && html.includes("ruhs mo mock test 1"));
check("GA4 error text is redacted (no bearer token)", !/ya29\.Mock/.test(html) && html.includes("[redacted]"));

await resetThrottle();
await mock("/__mock/control", { scenario: "gscGarbage" });
await open(master.page);
await master.page.getByRole("button", { name: "Sync now" }).click();
await master.page.getByText("Sync partly failed.").waitFor({ timeout: 30000 });
html = await open(master.page);
check("GSC garbage → Search Console error, GA4 data kept", html.includes("Search Console:") && html.includes("Organic Search"));

// ---- Schedule, retention, history, reporting, CSV ------------------------------------------------
function runCron() {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/seo-intel-sync.ts"], {
      env: { ...process.env, NODE_OPTIONS: "--conditions=react-server", NEXTAUTH_URL: BASE, SEO_GOOGLE_TEST_BASE_URL: MOCK },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    htmlSeen.push(out);
    return { code: 0, out };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    htmlSeen.push(out);
    return { code: e.status, out };
  }
}
let cron = runCron();
check("scheduled sync is a no-op while OFF (default)", cron.code === 0 && cron.out.includes("skipped (daily sync is OFF)"), cron.out);

html = await open(full.page);
check("FULL_ADMIN sees Schedule & Retention read-only", html.includes("Schedule &amp; Retention") && html.includes("Daily sync off") && !html.includes('data-testid="seo-intel-settings-form"'));
const settingsId = actionId("saveIntelSettingsAction");
check("found saveIntelSettingsAction id", Boolean(settingsId));
if (settingsId) {
  const res = await full.ctx.request.post(PAGE, { headers: { "Next-Action": settingsId, "Content-Type": "text/plain;charset=UTF-8", Origin: BASE }, data: "[{},{}]", maxRedirects: 0 });
  check("FULL_ADMIN forged settings action is refused", res.status() >= 400, `status ${res.status()}`);
}
check("settings unchanged by forged action", !(await setting("seo.intel.settings")));

// Seed an old entry (pruned on save) and one 8 days back (comparison point).
const istDay = (offset) => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};
const seedEntry = (date, clicks, sessions) => ({
  date,
  at: `${date}T00:00:00Z`,
  gsc: { range: { start: date, end: date }, totals: { clicks, impressions: clicks * 40, ctr: 0.025, position: 15 }, topQueries: [], topPages: [] },
  ga4: { range: { start: date, end: date }, totals: { activeUsers: sessions - 50, sessions, screenPageViews: sessions * 3, engagementRate: 0.5 }, channels: [] },
});
await db.query(`insert into "Setting"(key, value, "updatedAt") values ($1,$2,now()), ($3,$4,now())`, [
  `seo.intel.history.${istDay(8)}`, JSON.stringify(seedEntry(istDay(8), 1000, 400)),
  `seo.intel.history.${istDay(400)}`, JSON.stringify(seedEntry(istDay(400), 1, 1)),
]);
await open(master.page);
const form = () => master.page.getByTestId("seo-intel-settings-form");
await form().locator("input[name=historyDays]").evaluate((el) => {
  el.removeAttribute("min");
  el.value = "10";
});
await form().getByRole("button", { name: "Save" }).click();
await form().getByText("Keep history for 30–1095 days.").waitFor({ timeout: 15000 });
check("retention outside 30–1095 is refused server-side", !(await setting("seo.intel.settings")));
await open(master.page);
await form().locator("input[name=autoSyncEnabled]").check();
await form().locator("input[name=historyDays]").fill("90");
await form().getByRole("button", { name: "Save" }).click();
await form().getByText(/^Saved\. Removed 1 history day/).waitFor({ timeout: 15000 });
const savedSettings = await setting("seo.intel.settings");
check("MASTER saves daily sync ON + 90 days; old history pruned immediately", savedSettings.autoSyncEnabled === true && savedSettings.historyDays === 90 && !(await setting(`seo.intel.history.${istDay(400)}`)) && Boolean(await setting(`seo.intel.history.${istDay(8)}`)));
check("settings change audited", (await db.query(`select 1 from "AuditLog" where action='SEO_INTEL_SETTINGS_SAVED'`)).rowCount === 1);
html = await open(master.page);
check("page warns the scheduler is not installed on this server", html.includes("Daily sync on") && html.includes("Scheduler not installed"));

await resetThrottle();
await mock("/__mock/control", { scenario: "ok" });
cron = runCron();
const snapCron = await setting("seo.intel.snapshot");
check("scheduled sync runs when ON + connected", cron.code === 0 && /seo-intel-sync: google ok gsc=ok ga4=ok history=\d{4}-\d{2}-\d{2} pruned=0/.test(cron.out) && cron.out.includes("pagespeed skipped (API key not installed)"), cron.out);
check("scheduled sync recorded as source=scheduled, streak 0", snapCron.lastSync.source === "scheduled" && snapCron.lastSync.failStreak === 0 && snapCron.lastSync.byId === null);
check("scheduled sync audited without an actor", (await db.query(`select 1 from "AuditLog" where action='SEO_GOOGLE_SYNC' and "actorId" is null and metadata->>'source'='scheduled'`)).rowCount === 1);
check("today's history entry written", Boolean(await setting(`seo.intel.history.${istDay(0)}`)));

html = await open(teacher.page);
check("TEACHER sees history table, comparison and both daily charts", html.includes('data-testid="seo-intel-history"') && html.includes('data-testid="seo-intel-compare"') && (html.match(/data-testid="seo-intel-chart"/g) ?? []).length === 2 && html.includes("(daily automatic)"));
// React separates adjacent text pieces with <!-- --> in the HTML, so read the rendered text.
let text = await teacher.page.locator("main").innerText();
check("comparison is against the entry 8 days back", text.includes(`compared with ${istDay(8)}`) && text.includes("▲ +234"), text.match(/compared with[^\n]*/)?.[0]);

// Failure streak via the scheduler
await mock("/__mock/control", { scenario: "ga4Forbidden" });
await resetThrottle();
cron = runCron();
check("scheduled partial failure exits non-zero and logs FAILED (no token in log line)", cron.code === 1 && cron.out.includes("FAILED gsc=ok ga4=error") && !/ya29\.|1\/\/0Mock/.test(cron.out), cron.out);
await resetThrottle();
runCron();
await open(full.page);
text = await full.page.locator("main").innerText();
check("2 consecutive failures shown as a streak", (await setting("seo.intel.snapshot")).lastSync.failStreak === 2 && text.includes("2 failed syncs in a row"));
await mock("/__mock/control", { scenario: "ok" });
await resetThrottle();
cron = runCron();
check("a successful sync resets the streak", cron.code === 0 && (await setting("seo.intel.snapshot")).lastSync.failStreak === 0);

// CSV export
const csvGet = (ctx, report) => ctx.request.get(`${BASE}/api/admin/seo-intel/export?report=${report}`, { maxRedirects: 0 });
let res = await csvGet(teacher.ctx, "queries");
let body = await res.text();
htmlSeen.push(body);
check("TEACHER downloads queries CSV", res.status() === 200 && res.headers()["content-type"].startsWith("text/csv") && /attachment; filename="seo-intel-queries-/.test(res.headers()["content-disposition"]) && body.startsWith("query,clicks,impressions,ctr,position") && body.includes("ruhs mo mock test 1"));
check("CSV neutralises formula cells", body.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`) && !/^=HYPERLINK/m.test(body));
for (const rep of ["pages", "landing-pages", "channels", "history"]) {
  res = await csvGet(full.ctx, rep);
  body = await res.text();
  htmlSeen.push(body);
  check(`FULL_ADMIN downloads ${rep} CSV`, res.status() === 200 && body.split("\r\n").length > 2);
}
check("history CSV has today's and the seeded day", body.includes(istDay(0)) && body.includes(istDay(8)));
check("unknown report → 400", (await csvGet(master.ctx, "secrets")).status() === 400);
const anon2 = await browser.newContext();
res = await anon2.request.get(`${BASE}/api/admin/seo-intel/export?report=queries`, { maxRedirects: 0 });
check("signed-out CSV export refused", res.status() === 403);
await anon2.close();

// ---- PageSpeed + Core Web Vitals ------------------------------------------------------------------
const PSI_KEY = ["AIza", "SyMockPageSpeedKey0123456789abcdefg"].join(""); // = the mock's key, built at runtime
const backdatePsi = () =>
  db.query(`update "Setting" set value = jsonb_set(value, '{lastRun,at}', '"2000-01-01T00:00:00.000Z"') where key='seo.intel.pagespeed' and value->'lastRun' <> 'null'::jsonb`);
function keyScript(mode, input = "") {
  return execFileSync("npx", ["tsx", "scripts/set-seo-pagespeed-key.ts", mode], {
    input,
    env: { ...process.env, NODE_OPTIONS: "--conditions=react-server", NEXTAUTH_URL: BASE },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function runPsi() {
  await open(master.page);
  const started = Date.now();
  await master.page.getByRole("button", { name: "Run PageSpeed check" }).click();
  const st = master.page.getByTestId("seo-intel-psi-controls").getByRole("status");
  await st.waitFor({ timeout: 60000 });
  return { text: await st.innerText(), ms: Date.now() - started };
}

html = await open(master.page);
check("PageSpeed card: key not installed, Run disabled", html.includes("API key not installed") && (await master.page.getByRole("button", { name: "Run PageSpeed check" }).isDisabled()));
html = await open(full.page);
check("FULL_ADMIN sees PageSpeed card without controls", html.includes("PageSpeed &amp; Core Web Vitals") && !html.includes('data-testid="seo-intel-psi-controls"'));

let ko = keyScript("set", `${PSI_KEY}\n`);
htmlSeen.push(ko);
check("key script saves the key, prints only a fingerprint", /Saved the PageSpeed API key \(encrypted\)\. Fingerprint [0-9a-f]{8}\./.test(ko) && !ko.includes("AIza"));
const keyRow = await setting("seo.pagespeed.key");
check("key encrypted at rest", String(keyRow.apiKeyCipher).startsWith("v1:") && !JSON.stringify(keyRow).includes("AIza"));
check("key install audited (fingerprint only)", (await db.query(`select 1 from "AuditLog" where action='SEO_PAGESPEED_KEY_SET' and metadata::text not like '%AIza%'`)).rowCount === 1);

const runPsiId = actionId("runPageSpeedAction");
check("found runPageSpeedAction id", Boolean(runPsiId));
await mock("/__mock/control", { psiScenario: "ok", resetPsiCalls: true });
for (const [label, sess] of [["TEACHER", teacher], ["FULL_ADMIN", full]]) {
  const r = await sess.ctx.request.post(PAGE, { headers: { "Next-Action": runPsiId, "Content-Type": "text/plain;charset=UTF-8", Origin: BASE }, data: "[]", maxRedirects: 0 });
  check(`${label} forged PageSpeed run is refused`, r.status() >= 400 && (await mock("/__mock/stats")).psiCalls.length === 0, `status ${r.status()}`);
}

let pr = await runPsi();
let ms = await mock("/__mock/stats");
const psiCalls = ms.psiCalls.filter((c) => c.api === "psi");
const cruxCalls = ms.psiCalls.filter((c) => c.api === "crux");
check("MASTER run completes", pr.text === "PageSpeed check complete.", pr.text);
check("3 default pages × mobile + desktop, + CrUX phone/desktop", psiCalls.length === 6 && cruxCalls.length === 2 && new Set(psiCalls.map((c) => `${c.target}|${c.strategy}`)).size === 6);
check("only this site's pages were sent to PageSpeed", psiCalls.every((c) => c.target.startsWith("https://mocktestseries.in/")) && psiCalls.some((c) => c.target === "https://mocktestseries.in/plans-and-pricing"));
check("key sent in the X-goog-api-key header on every call", ms.psiCalls.every((c) => c.headerKey));
check("key never in a URL", ms.urlLeaks.length === 0, JSON.stringify(ms.urlLeaks));
const spread = Math.max(...ms.psiCalls.map((c) => c.t)) - Math.min(...ms.psiCalls.map((c) => c.t));
check("all calls sent in parallel (one 45 s window)", spread < 1500, `${spread} ms`);
check("run audited", (await db.query(`select 1 from "AuditLog" where action='SEO_PAGESPEED_RUN' and metadata->>'source'='manual' and metadata->>'ok'='true'`)).rowCount === 1);

await open(teacher.page);
text = await teacher.page.locator("main").innerText();
check("TEACHER sees scores with rating text", /Mobile\s+72\s+Needs improvement/.test(text) && /Desktop\s+96\s+Good/.test(text), text.match(/Lab test[\s\S]{0,300}/)?.[0]);
check("lab LCP/CLS/TBT shown with ratings", text.includes("3.4 s (Needs improvement)") && text.includes("1.2 s (Good)") && text.includes("310 ms"));
check("field data: this page for /, whole site elsewhere", text.includes("This page: LCP 2.3 s, INP 150 ms, CLS 0.08") && text.includes("Whole site: LCP 2.7 s"));
check("CrUX origin table with collection period + ratings", text.includes("2026-09-22 to 2026-10-19") && text.includes("2.9 s (Needs improvement)") && text.includes("0.12 (Needs improvement)") && text.includes("90 ms (Good)"));
check("timestamps shown (Last check …, Checked …)", /Last check \d{2} \w{3} \d{4}/.test(text) && /Checked \d{2} \w{3} \d{4}/.test(text));
check("teacher does not see the key fingerprint", !/Key fingerprint/.test(text));
check("today's history has the PageSpeed summary", (await setting(`seo.intel.history.${istDay(0)}`))?.psi?.mobile === 72 && (await setting(`seo.intel.history.${istDay(0)}`)).psi.cruxLcpP75Phone === 2900);

pr = await runPsi();
check("second run within 2 minutes is throttled", pr.text.includes("less than 2 minutes"));

for (const [scenario, expect, extra] of [
  ["psiError", "finished with 1 error", "Lighthouse returned error: FAILED_DOCUMENT_REQUEST"],
  ["quota", "finished with 8 errors", "RESOURCE_EXHAUSTED"],
  ["badKey", "finished with 8 errors", "INVALID_ARGUMENT"],
]) {
  await backdatePsi();
  await mock("/__mock/control", { psiScenario: scenario });
  pr = await runPsi();
  const t = await master.page.locator("main").innerText();
  check(`${scenario}: reported as errors, other results intact`, pr.text.includes(expect) && t.includes(extra), pr.text);
  if (scenario === "psiError") check("psiError: the failing row shows its error, the rest keep scores", (await master.page.getByTestId("seo-intel-psi-error").count()) === 1 && /Mobile\s+72/.test(t));
  if (scenario === "badKey") {
    const stored = JSON.stringify(await setting("seo.intel.pagespeed"));
    check("badKey: Google's echoed key is redacted on page and in storage", !t.includes("AIza") && t.includes("[redacted]") && !stored.includes("AIza"));
  }
}
await backdatePsi();
await mock("/__mock/control", { psiScenario: "slow" });
pr = await runPsi();
{
  // PageSpeed calls (test timeout 1.5 s) time out; CrUX (15 s) still answers after the 3 s delay.
  const t = await master.page.locator("main").innerText();
  check("slow Google: PageSpeed calls time out cleanly, CrUX still answers", pr.text.includes("finished with 6 errors") && t.includes("Google did not answer in time.") && pr.ms < 15000, `${pr.text} ${pr.ms}ms`);
}
await backdatePsi();
await mock("/__mock/control", { psiScenario: "cruxNoData" });
pr = await runPsi();
text = await master.page.locator("main").innerText();
check("no Chrome user data is not an error", pr.text === "PageSpeed check complete." && text.includes("Google does not yet have enough Chrome user data"));

// Settings: pages to test
await open(master.page);
const f2 = master.page.getByTestId("seo-intel-settings-form");
for (const [val, ok] of [
  ["/\n/admin", false],
  ["https://evil.example/", false],
  ["/\n/a\n/b\n/c", false],
  ["/\n/exams", true],
]) {
  await open(master.page);
  await f2.locator("textarea[name=pagespeedPaths]").fill(val);
  await f2.getByRole("button", { name: "Save" }).click();
  const st = f2.getByRole("status");
  await st.waitFor({ timeout: 15000 });
  const msg = await st.innerText();
  check(`PageSpeed pages ${JSON.stringify(val)} → ${ok ? "saved" : "refused"}`, ok ? msg.startsWith("Saved") : msg.startsWith("PageSpeed pages:"), msg);
}
check("saved PageSpeed pages", JSON.stringify((await setting("seo.intel.settings")).pagespeedPaths) === JSON.stringify(["/", "/exams"]));
await backdatePsi();
await mock("/__mock/control", { psiScenario: "ok", resetPsiCalls: true });
pr = await runPsi();
check("next run tests only the saved pages", (await mock("/__mock/stats")).psiCalls.filter((c) => c.api === "psi").length === 4);

res = await csvGet(teacher.ctx, "pagespeed");
body = await res.text();
htmlSeen.push(body);
check("TEACHER downloads PageSpeed CSV (no key)", res.status() === 200 && body.startsWith("page,strategy,checked_at,score") && body.includes("/exams,desktop") && !body.includes("AIza"));

// Daily job runs PageSpeed independently of the Google connection
await backdatePsi();
await resetThrottle();
cron = runCron();
check("scheduled job runs PageSpeed when the key is installed", cron.out.includes("pagespeed ok errors=0") && !cron.out.includes("AIza"), cron.out);
check("scheduled PageSpeed audited without an actor", (await db.query(`select 1 from "AuditLog" where action='SEO_PAGESPEED_RUN' and "actorId" is null and metadata->>'source'='scheduled'`)).rowCount === 1);
ko = keyScript("status");
htmlSeen.push(ko);
check("key status prints fingerprint + last check, never the key", /key installed \(fingerprint [0-9a-f]{8}/.test(ko) && !ko.includes("AIza"));

// ---- Needs reconnect ---------------------------------------------------------------------------
await resetThrottle();
await mock("/__mock/control", { scenario: "invalidGrant" });
await open(master.page);
await master.page.getByRole("button", { name: "Sync now" }).click();
await master.page.getByRole("status").getByText("A Master Admin must reconnect Google.").waitFor({ timeout: 30000 });
html = await open(full.page);
check("invalid_grant → Needs reconnect (seen by FULL_ADMIN)", html.includes("Needs reconnect") && html.includes("A Master Admin must reconnect"));
await resetThrottle();
cron = runCron();
check("scheduled sync skips while the connection needs reconnecting", cron.code === 0 && cron.out.includes("skipped (connection needs a Master Admin to reconnect)"), cron.out);

// ---- Disconnect --------------------------------------------------------------------------------
await mock("/__mock/control", { scenario: "ok" });
await open(master.page);
await master.page.getByRole("button", { name: "Disconnect", exact: true }).click();
await master.page.fill("input[name=confirm]", "nope");
await master.page.getByRole("button", { name: "Disconnect Google" }).click();
await master.page.getByText("Type DISCONNECT to confirm.").waitFor({ timeout: 15000 });
check("disconnect needs typed confirmation", Boolean((await setting("seo.google.oauth")).refreshTokenCipher));
await master.page.fill("input[name=confirm]", "DISCONNECT");
const revokedBeforeDisc = (await mock("/__mock/stats")).revoked.length;
await master.page.getByRole("button", { name: "Disconnect Google" }).click();
await master.page.getByText(/^Disconnected\./).waitFor({ timeout: 30000 });
const stored3 = await setting("seo.google.oauth");
check("disconnect removes refresh token, keeps client", !stored3.refreshTokenCipher && !stored3.accountEmail && String(stored3.clientSecretCipher).startsWith("v1:"));
check("disconnect revoked at Google", (await mock("/__mock/stats")).revoked.length > revokedBeforeDisc);
check("disconnect ended account B's whole grant", (await grants())[ACC_B].liveRefresh === 0);
html = await open(master.page);
check("page shows Not connected", html.includes("Not connected"));
cron = runCron();
check("scheduled sync skips while Google is not connected", cron.code === 0 && cron.out.includes("skipped (Google not connected)"), cron.out);
check("…while PageSpeed still runs on its own (key installed, Google disconnected)", cron.out.includes("pagespeed ok") || cron.out.includes("pagespeed skipped (A PageSpeed check ran less than 2 minutes ago"), cron.out);
ko = keyScript("clear");
check("key clear removes the key", ko.includes("PageSpeed API key removed.") && !(await setting("seo.pagespeed.key")));
cron = runCron();
check("scheduled PageSpeed skips without a key", cron.out.includes("pagespeed skipped (API key not installed)"), cron.out);
// No live connection: an unusable token from a failed attempt is revoked (nothing to protect).
{
  const gb = await grants();
  await mock("/__mock/control", { scenario: "missingScope", email: ACC_A });
  r = await connect(master.page);
  const ga = await grants();
  check("failed connect with no live connection → unusable grant revoked, still not connected", r.reason === "missing-scopes" && ga[ACC_A].epoch > gb[ACC_A].epoch && !(await setting("seo.google.oauth")).refreshTokenCipher);
  await mock("/__mock/control", { scenario: "ok" });
}

// ---- Isolation + leak scan --------------------------------------------------------------------
check("student Google login config untouched", JSON.stringify(await setting("auth.providers")) === studentBefore);
check("robots.txt unchanged", (await (await fetch(`${BASE}/robots.txt`)).text()) === robotsBefore);
check("sitemap.xml unchanged", (await (await fetch(`${BASE}/sitemap.xml`)).text()) === sitemapBefore);
const stats = await mock("/__mock/stats");
check("no secret ever sent in a URL query", stats.urlLeaks.length === 0, JSON.stringify(stats.urlLeaks));
const { secrets } = await mock("/__mock/secrets");
const dbText = JSON.stringify((await db.query(`select key, value from "Setting" where key like 'seo.%'`)).rows) + JSON.stringify((await db.query(`select action, metadata from "AuditLog" where action like 'SEO_%'`)).rows);
const logText = process.env.SERVER_LOG ? fs.readFileSync(process.env.SERVER_LOG, "utf8") : "";
const leaks = [];
for (const s of secrets.filter((x) => x.length >= 10)) {
  if (htmlSeen.some((h) => h.includes(s))) leaks.push(`page:${s.slice(0, 6)}`);
  if (dbText.includes(s)) leaks.push(`db:${s.slice(0, 6)}`);
  if (logText.includes(s)) leaks.push(`log:${s.slice(0, 6)}`);
}
check(`no issued/received secret (${secrets.length}) in pages, DB rows, audit log or server log`, leaks.length === 0, leaks.join(", "));
check("server log has no token- or key-shaped strings", !/ya29\.|1\/\/0Mock|GOCSPX-|AIza/.test(logText));
const clearOut = runScript("clear");
check("clear script removes everything", /removed/.test(clearOut) && !(await setting("seo.google.oauth")));

await browser.close();
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
