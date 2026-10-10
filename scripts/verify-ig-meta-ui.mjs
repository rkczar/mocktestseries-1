/**
 * Instagram API connection — browser checks on SCRATCH servers (never production).
 * Starts the local mock Meta API, then for each scenario boots `next start`
 * (127.0.0.1 only) with a fake token, drives Admin → Instagram → Settings →
 * Test connection, and checks that the token never reaches the browser,
 * server logs or the database.
 *
 *   set -a; . ./.env; set +a     # DATABASE_URL must be an *igstudio* scratch DB with the ig-studio fixture
 *   npx next build
 *   PORT=3141 NODE_PATH=<dir containing playwright> node scripts/verify-ig-meta-ui.mjs
 *
 * NEXTAUTH_URL / AUTH_URL in .env must be http://localhost:<PORT>.
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { MOCK_OTHER_USER_ID, MOCK_USER_ID, mockToken, startMockGraph } from "./mock-meta-graph.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const PORT = Number(process.env.PORT ?? 3141);
const MOCK_PORT = Number(process.env.MOCK_GRAPH_PORT ?? 3197);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "IgStudio#Fixture2026";
const LOGDIR = process.env.LOGDIR ?? "/tmp/ig-meta-ui";
mkdirSync(LOGDIR, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}

const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const ACTION_ID = Object.entries(manifest.node).find(([, v]) => v.exportedName === "testInstagramConnectionAction")?.[0];
if (!ACTION_ID) throw new Error("testInstagramConnectionAction not in the build manifest — run next build first.");

const mock = await startMockGraph(MOCK_PORT);
const allTokens = [];
const serverLogs = [];

async function startServer(name, envExtra) {
  const out = path.join(LOGDIR, `server-${name}.log`);
  const env = { ...process.env, NODE_ENV: "production", INSTAGRAM_GRAPH_API_BASE: mock.base, ...envExtra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/admin/login`);
      await new Promise((r) => setTimeout(r, 250)); // previous server still up
    } catch {
      break;
    }
  }
  // Own process group, so stop() kills next-server itself and not just a wrapper.
  const child = spawn("node_modules/.bin/next", ["start", "-H", "127.0.0.1", "-p", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let exited = false;
  const exit = new Promise((r) => child.once("exit", () => ((exited = true), r())));
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const r = await fetch(`${BASE}/admin/login`);
      if (r.status === 200) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (exited) throw new Error(`next start (${name}) exited early: ${Buffer.concat(chunks).toString("utf8").slice(-400)}`);
  return {
    async stop() {
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        await Promise.race([exit, new Promise((r) => setTimeout(r, 10_000))]);
        if (!exited) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          await exit;
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      writeFileSync(out, text);
      serverLogs.push(text);
    },
  };
}

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}

/** Calls the Server Action directly (as whoever the page's cookies belong to) and returns the raw RSC text. */
async function rawAction(page) {
  return page.evaluate(
    async ([url, id]) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: "[]" });
      return { status: r.status, text: await r.text() };
    },
    [`${BASE}/admin/instagram/settings`, ACTION_ID]
  );
}

const card = (page) => page.getByTestId("ig-connection");
const text = async (page, id) => (await page.getByTestId(id).innerText()).trim();
async function runTest(page) {
  await page.getByTestId("ig-conn-test").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ig-conn-test"]')?.getAttribute("data-busy") === "0" && document.querySelector('[data-testid="ig-conn-status"]')?.getAttribute("data-status") !== "NEVER_TESTED", null, { timeout: 30000 });
  return page.getByTestId("ig-conn-status").getAttribute("data-status");
}

/** Every response body the browser received, to scan for the token. */
function capture(page) {
  const bodies = [];
  page.on("response", async (res) => {
    try {
      const t = res.request().resourceType();
      if (["document", "fetch", "xhr", "script"].includes(t)) bodies.push(await res.text());
    } catch {}
  });
  return bodies;
}

const resetDb = () => sql(`DELETE FROM "Setting" WHERE key = 'instagram.connection'; DELETE FROM "LoginAttempt";`);
const browser = await chromium.launch();
const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const SCENARIOS = [
  { name: "notconfigured", env: { INSTAGRAM_ACCESS_TOKEN: undefined, INSTAGRAM_USER_ID: undefined, INSTAGRAM_TOKEN_SET_AT: undefined }, expect: "NOT_CONFIGURED" },
  { name: "valid", env: { INSTAGRAM_USER_ID: MOCK_USER_ID, INSTAGRAM_TOKEN_SET_AT: days(0) }, expect: "CONNECTED" },
  { name: "nopublish", env: { INSTAGRAM_USER_ID: MOCK_USER_ID, INSTAGRAM_TOKEN_SET_AT: days(50) }, expect: "CONNECTED_NO_PUBLISH_PERMISSION" },
  { name: "expired", env: { INSTAGRAM_USER_ID: MOCK_USER_ID, INSTAGRAM_TOKEN_SET_AT: days(70) }, expect: "TOKEN_EXPIRED" },
  { name: "wrong", env: { INSTAGRAM_USER_ID: MOCK_USER_ID, INSTAGRAM_TOKEN_SET_AT: days(1) }, expect: "WRONG_ACCOUNT" },
  { name: "timeout", env: { INSTAGRAM_USER_ID: MOCK_USER_ID, INSTAGRAM_TOKEN_SET_AT: days(1) }, expect: "TIMEOUT" },
];

const protectedFp = () =>
  sql(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
         SELECT id || "updatedAt"::text AS x FROM "Question"
         UNION ALL SELECT id || "updatedAt"::text FROM "InstagramPost"
         UNION ALL SELECT id || title FROM "PreviousYearPaper"
         UNION ALL SELECT id || "updatedAt"::text FROM "MockTest"
         UNION ALL SELECT id || "updatedAt"::text FROM "Student"
         UNION ALL SELECT key || value::text FROM "Setting" WHERE key <> 'instagram.connection') t`);
const fpBefore = protectedFp();

try {
  for (const s of SCENARIOS) {
    console.log(`\n--- ${s.name} ---`);
    resetDb();
    const token = s.env.INSTAGRAM_ACCESS_TOKEN === undefined && "INSTAGRAM_ACCESS_TOKEN" in s.env ? null : mockToken(s.name);
    if (token) allTokens.push(token);
    const srv = await startServer(s.name, { ...s.env, ...(token ? { INSTAGRAM_ACCESS_TOKEN: token } : {}) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const bodies = capture(page);
    try {
      await login(page, "igmaster");
      const res = await page.goto(`${BASE}/admin/instagram/settings`);
      check(`settings page 200 with connection card + existing settings form`, res?.status() === 200 && (await card(page).count()) === 1 && (await page.getByTestId("studio-settings").count()) === 1);
      check(`before any test: "Not tested yet", last test "Never"`, (await page.getByTestId("ig-conn-status").getAttribute("data-status")) === "NEVER_TESTED" && (await text(page, "ig-conn-last")) === "Never");
      const tokenField = await text(page, "ig-conn-token");
      check(`token configured shows ${token ? "Yes + fingerprint" : "No"}`, token ? /^Yes \(fingerprint [0-9a-f]{8}\)$/.test(tokenField) : tokenField === "No", tokenField);
      check("expected account shown as @mocktestseries.in", (await text(page, "ig-conn-expected")) === "@mocktestseries.in");
      const expiry = await text(page, "ig-conn-expiry");
      const expectExpiry = { notconfigured: /No token installed/, valid: /About (59|60) days left/, nopublish: /Expires in about (9|10) days.*renew soon/, expired: /Likely expired/, wrong: /About 5[89] days left/, timeout: /About 5[89] days left/ }[s.name];
      check(`token expiration warning: ${expectExpiry}`, expectExpiry.test(expiry), expiry);
      check("publishing banner still says publishing is OFF", /Publishing is turned off/.test(await text(page, "publishing-disabled")));

      const t0 = Date.now();
      const testStartedAt = new Date(t0 - 1000).toISOString();
      const mockCallsBefore = mock.stats.requests.length;
      const status = await runTest(page);
      check(`Test connection → ${s.expect}`, status === s.expect, { status, summary: await page.getByTestId("ig-conn-summary").innerText().catch(() => null) });
      await card(page).screenshot({ path: path.join(LOGDIR, `card-${s.name}.png`) });
      const last = await text(page, "ig-conn-last");
      check("last connection test shows an IST time + duration", /IST · \d+ ms$/.test(last), last);
      const publish = await text(page, "ig-conn-publish");
      if (s.name === "valid") {
        check("username @mocktestseries.in", (await text(page, "ig-conn-username")) === "@mocktestseries.in");
        check(`Instagram User ID ${MOCK_USER_ID} (retrieved via API)`, (await text(page, "ig-conn-userid")) === MOCK_USER_ID);
        check("account type BUSINESS", (await text(page, "ig-conn-type")) === "BUSINESS");
        check("publishing permission: Granted", /Granted/.test(publish), publish);
        check("all 6 checks pass", (await page.locator('[data-testid="ig-conn-checks"] li[data-state="pass"]').count()) === 6);
        // Throttle + persistence + audit.
        await page.getByTestId("ig-conn-test").click();
        await page.getByTestId("ig-conn-error").waitFor({ timeout: 15000 });
        check("immediate re-test is throttled with a friendly message", /wait a few seconds/.test(await text(page, "ig-conn-error")));
        await page.reload();
        check("result persists after reload (Setting instagram.connection)", (await page.getByTestId("ig-conn-status").getAttribute("data-status")) === "CONNECTED");
        const audit = sql(`SELECT count(*) || ':' || coalesce(max(metadata::text), '') FROM "AuditLog" WHERE action = 'INSTAGRAM_CONNECTION_TESTED' AND "createdAt" >= '${testStartedAt}'`);
        check("audit log entry written (status only, no token)", /^1:/.test(audit) && audit.includes("CONNECTED") && !audit.includes(token), audit);
        // Other admins + signed-out callers can't run the action.
        for (const who of ["igfull", "igteacher"]) {
          const c2 = await browser.newContext();
          const p2 = await c2.newPage();
          const b2 = capture(p2);
          await login(p2, who);
          await p2.goto(`${BASE}/admin/instagram/settings`);
          check(`${who}: settings page restricted (no connection card)`, (await card(p2).count()) === 0 && (await p2.getByText("Access Restricted").count()) === 1);
          const raw = await rawAction(p2);
          check(`${who}: raw Server Action call refused ("Only a Master Admin")`, raw.text.includes("Only a Master Admin") && !raw.text.includes("mocktestseries.in\",\"userId"), raw.text.slice(0, 200));
          bodies.push(...b2);
          await c2.close();
        }
        const anon = await browser.newContext();
        const pa = await anon.newPage();
        await pa.goto(`${BASE}/`);
        const rawAnon = await rawAction(pa);
        check("signed-out raw Server Action call refused", !rawAnon.text.includes(MOCK_USER_ID) && !rawAnon.text.includes("CONNECTED\""), rawAnon.text.slice(0, 200));
        await anon.close();
        await page.waitForTimeout(5500); // past the 5 s re-test throttle
        const rawMaster = await rawAction(page);
        check("master raw action response: identity only, no token", rawMaster.text.includes(MOCK_USER_ID) && !rawMaster.text.includes(token), rawMaster.text.slice(0, 200));
        bodies.push(rawMaster.text);
      } else if (s.name === "nopublish") {
        check("username + ID still shown", (await text(page, "ig-conn-username")) === "@mocktestseries.in" && (await text(page, "ig-conn-userid")) === MOCK_USER_ID);
        check("publishing permission: Missing — instagram_business_content_publish", /Missing — instagram_business_content_publish/.test(publish), publish);
      } else if (s.name === "wrong") {
        check("shows the actual (wrong) account so the admin can see the mismatch", (await text(page, "ig-conn-username")) === "@someone.else" && (await text(page, "ig-conn-userid")) === MOCK_OTHER_USER_ID);
        check("username check names the expected account", /expected @mocktestseries\.in/.test(await page.locator('[data-check="username"]').innerText()));
        check("publishing permission: Not verified", /Not verified/.test(publish), publish);
      } else if (s.name === "expired") {
        check("summary tells the admin to install a new token", /expired.*install/i.test(await text(page, "ig-conn-summary")));
        check("publishing permission: Not verified", /Not verified/.test(publish), publish);
      } else if (s.name === "timeout") {
        check("timeout surfaced after ~10 s, UI recovered", Date.now() - t0 >= 9_500 && (await page.getByTestId("ig-conn-test").isEnabled()));
      } else if (s.name === "notconfigured") {
        check("not configured: no request was made to the API", mock.stats.requests.length === mockCallsBefore);
      }
      const all = bodies.join("\n");
      check("token never reached the browser (documents, RSC, fetches, scripts)", !token || (!all.includes(token) && !all.includes("IGAAMOCK")));
      check("no env-file content (INSTAGRAM_ACCESS_TOKEN=… / INSTAGRAM_APP_SECRET=…) in browser payloads", !/INSTAGRAM_(ACCESS_TOKEN|APP_SECRET)\s*=/.test(all));
    } finally {
      await ctx.close();
      await srv.stop();
    }
  }

  console.log("\n--- Leakage + data safety ---");
  check(`mock: ${mock.stats.requests.length} requests, all GET with Authorization header, token never in a URL`, mock.stats.nonGet === 0 && mock.stats.tokenInUrl === 0 && mock.stats.missingAuth === 0, mock.stats);
  const logs = serverLogs.join("\n");
  check("server logs (6 boots) contain no token", allTokens.every((t) => !logs.includes(t)) && !logs.includes("IGAAMOCK"));
  const dump = execFileSync("pg_dump", ["--data-only", DB], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  check("scratch DB dump contains no token", allTokens.every((t) => !dump.includes(t)) && !dump.includes("IGAAMOCK"));
  const statics = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else statics.push(p);
    }
  };
  walk(".next/static");
  const bundle = statics.map((f) => readFileSync(f, "utf8")).join("\n");
  check(`client bundle (${statics.length} files): no token, no env var names, no graph.instagram.com, no runConnectionTest`, !/IGAAMOCK|INSTAGRAM_ACCESS_TOKEN|INSTAGRAM_APP_SECRET|graph\.instagram\.com|runConnectionTest/.test(bundle));
  check("questions, PYQ papers, mock tests, students, Instagram drafts and other Settings unchanged", protectedFp() === fpBefore);
} finally {
  await browser.close();
  mock.server.close();
  resetDb();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
