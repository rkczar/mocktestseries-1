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
const resetThrottle = () => db.query(`update "Setting" set value = value - 'lastSync' where key='seo.intel.snapshot'`);

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

// ---- Failure scenarios (each leaves the existing connection in place) ---------------------------
for (const [scenario, reason] of [
  ["denied", "denied"],
  ["noRefresh", "no-refresh-token"],
  ["missingScope", "missing-scopes"],
  ["badAud", "id-token"],
  ["unverified", "id-token"],
  ["exchangeError", "exchange"],
]) {
  await mock("/__mock/control", { scenario });
  r = await connect(master.page);
  const after = await setting("seo.google.oauth");
  check(`${scenario} → ${reason}, message shown, connection kept`, r.status === "error" && r.reason === reason && (await master.page.content()).includes('data-testid="seo-intel-callback"') && after.refreshTokenCipher === stored1.refreshTokenCipher, JSON.stringify(r));
}
const failAudit = (await db.query(`select metadata from "AuditLog" where action='SEO_GOOGLE_CONNECT_FAILED'`)).rows;
check("connect failures audited", failAudit.length >= 6);

// ---- Reconnect replaces + revokes the old grant -------------------------------------------------
const revokedBefore = (await mock("/__mock/stats")).revoked.length;
await mock("/__mock/control", { scenario: "ok", email: "seo-owner2@example.test" });
r = await connect(master2.page);
const stored2 = await setting("seo.google.oauth");
check("MASTER B reconnect replaces the shared connection", r.status === "connected" && stored2.accountEmail === "seo-owner2@example.test" && stored2.connectedById === F.admins.master2.id);
check("old refresh token revoked at Google", (await mock("/__mock/stats")).revoked.length > revokedBefore);

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

// ---- Needs reconnect ---------------------------------------------------------------------------
await resetThrottle();
await mock("/__mock/control", { scenario: "invalidGrant" });
await open(master.page);
await master.page.getByRole("button", { name: "Sync now" }).click();
await master.page.getByRole("status").getByText("A Master Admin must reconnect Google.").waitFor({ timeout: 30000 });
html = await open(full.page);
check("invalid_grant → Needs reconnect (seen by FULL_ADMIN)", html.includes("Needs reconnect") && html.includes("A Master Admin must reconnect"));

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
html = await open(master.page);
check("page shows Not connected", html.includes("Not connected"));

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
check("server log has no token-shaped strings", !/ya29\.|1\/\/0Mock|GOCSPX-/.test(logText));
const clearOut = runScript("clear");
check("clear script removes everything", /removed/.test(clearOut) && !(await setting("seo.google.oauth")));

await browser.close();
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
