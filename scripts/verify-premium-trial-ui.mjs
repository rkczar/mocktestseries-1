/**
 * Browser/HTTP verification for Free Trial + Premium Access.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-trial-ui-fixture.ts setup > /tmp/ptqa.json
 *   BASE=http://localhost:3181 FIXTURE=/tmp/ptqa.json DATABASE_URL=<scratch *premium*> SHOTS=<dir> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-premium-trial-ui.mjs
 *
 * Covers: dashboard popup states (welcome / active / ending / expired), once
 * per day, never for paid students, explicit trial start from the popup,
 * Premium lock → popup, mobile layout (no horizontal scroll), Plans &
 * Pricing three-tier comparison + "Till Exam", public SEO pages stay public,
 * Admin → Free Access & Trial view + FULL_ADMIN cannot change settings.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://localhost:3181";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? null;
if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};
const sql = (q) => execFileSync("psql", [process.env.DATABASE_URL.replace(/\?.*$/, ""), "-X", "-A", "-t", "-c", q], { encoding: "utf8" }).trim();
const fixture = (...args) =>
  execFileSync("npx", ["tsx", "scripts/premium-trial-ui-fixture.ts", ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim();

async function studentContext(browser, persona, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: "student-session-token", value: F.tokens[persona], url: BASE }]);
  return ctx;
}
async function popupState(page, wait = 6000) {
  const dlg = page.locator("[data-testid=trial-popup]");
  try {
    await dlg.waitFor({ state: "visible", timeout: wait });
    return { state: await dlg.getAttribute("data-state-kind"), text: await dlg.innerText() };
  } catch {
    return null;
  }
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

// The fixture just rewrote the policy row; let the server's 5s policy cache expire first.
await new Promise((r) => setTimeout(r, 6000));
const browser = await chromium.launch();
try {
  console.log("1. Welcome popup (eligible student, trial not started)");
  {
    const ctx = await studentContext(browser, "fresh", { width: 390, height: 844 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/student/dashboard`);
    const p = await popupState(page);
    check("Dashboard shows the WELCOME popup", p?.state === "WELCOME", p);
    check("Title 'Unlock Your 2-Day FREE Premium Trial'", Boolean(p?.text.includes("Unlock Your 2-Day FREE Premium Trial")));
    check("Subtitle mentions 48 hours", Boolean(p?.text.includes("for 48 hours")));
    check("Comparison FREE FOREVER | 2-DAY TRIAL | PREMIUM", Boolean(p && /FREE FOREVER/.test(p.text) && /2-DAY TRIAL/.test(p.text) && /PREMIUM/.test(p.text)));
    check("Buttons: Start 2-Day Free Trial / Buy Premium Now / Continue Free", Boolean(p && p.text.includes("Start 2-Day Free Trial") && p.text.includes("Buy Premium Now") && p.text.includes("Continue Free")));
    const buyLink = page.locator("[data-testid=trial-popup] a:has-text('Buy Premium Now')");
    await buyLink.waitFor({ state: "visible" });
    check("Buy Premium Now uses the existing checkout", (await buyLink.getAttribute("href")) === `/student/checkout/${F.premium.code}`);
    const box = await page.locator("[data-testid=trial-popup]").boundingBox();
    check("Mobile (390px): popup fits the screen", Boolean(box && box.x >= 0 && box.x + box.width <= 390 && box.height <= 844), box);
    check("Mobile: no horizontal page scroll", await noHorizontalScroll(page));
    await shot(page, "01-welcome-mobile");
    check("Showing the popup did not start a trial", fixture("trial", F.students.fresh) === "null");
    await page.locator("[data-testid=trial-popup] button:has-text('Continue Free')").click();
    await page.reload();
    check("Reload the same day: no popup", (await popupState(page, 4000)) === null);
    await page.goto(`${BASE}/student/test-series`);
    await page.goto(`${BASE}/student/dashboard`);
    check("Navigate away and back: no popup", (await popupState(page, 4000)) === null);
    await ctx.close();
  }

  console.log("\n2. Premium lock → trial options → explicit start");
  {
    const ctx = await studentContext(browser, "fresh2");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/student/dashboard`);
    await popupState(page); // today's welcome
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.papers.paid}`);
    check("Starting a Premium PYQ redirects to the dashboard trial options", /\/student\/dashboard\?premium=locked/.test(page.url()), page.url());
    const p = await popupState(page);
    check("…and opens the popup even though today's slot was used", p?.state === "WELCOME", p);
    await shot(page, "02-locked-welcome-desktop");
    await page.locator("[data-testid=start-trial]").click();
    await page.locator("[data-testid=trial-popup][data-state-kind=ACTIVE]").waitFor({ timeout: 15000 });
    const active = await popupState(page);
    check("After clicking Start: 'Your Premium Trial Is Active!'", Boolean(active?.text.includes("Your Premium Trial Is Active!")), active);
    check("Server-derived countdown ~ '1 Day 23 Hours Remaining' / '2 Days 0 Hours'", Boolean(active && /(1 Day 23 Hours|2 Days 0 Hours) Remaining/.test(active.text)), active?.text);
    const t = JSON.parse(fixture("trial", F.students.fresh2));
    check("DB: trial row created, exactly 48 hours", t?.hours === 48, t);
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.papers.paid}`);
    check("During the trial the Premium PYQ opens (no paywall redirect)", !/premium=locked/.test(page.url()), page.url());
    await ctx.close();
    // New browser, same account: same trial (server-side)
    const ctx2 = await studentContext(browser, "fresh2");
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/student/dashboard?premium=locked`);
    const again = await popupState(p2);
    check("Another browser: same trial, no restart offered", again?.state === "ACTIVE" && !again.text.includes("Start 2-Day Free Trial"), again);
    check("DB: still one trial with the same end", JSON.parse(fixture("trial", F.students.fresh2))?.endsAt === t.endsAt);
    await ctx2.close();
  }

  console.log("\n3. Active / ending / expired / paid");
  for (const [persona, expect, re] of [
    ["active", "ACTIVE", /Your Premium Trial Is Active!/],
    ["ending", "ENDING", /Your Free Trial Ends Soon!/],
    ["expired", "EXPIRED", /Your Premium Trial Has Ended/],
  ]) {
    const ctx = await studentContext(browser, persona, persona === "ending" ? { width: 390, height: 844 } : { width: 1366, height: 900 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/student/dashboard`);
    const p = await popupState(page);
    check(`${persona}: ${expect} popup`, p?.state === expect && re.test(p.text), p);
    // Fixture trial started ~1h before setup (minutes may have passed since): 46–47h left.
    if (persona === "active") check("active: countdown '1 Day 22/23 Hours Remaining'", Boolean(p && /1 Day 2[23] Hours Remaining/.test(p.text)), p?.text);
    if (persona === "active") check("active: Upgrade to Premium + Continue Practicing", Boolean(p?.text.includes("Upgrade to Premium") && p.text.includes("Continue Practicing")));
    if (persona === "ending") check("ending: '4 Hours 59 Minutes Remaining' style countdown", Boolean(p && /4 Hours (5\d|4\d) Minutes Remaining/.test(p.text)), p?.text);
    if (persona === "ending") check("ending: Buy Premium + Continue Practicing", Boolean(p?.text.includes("Buy Premium") && p.text.includes("Continue Practicing")));
    if (persona === "expired") check("expired: free tests, analytics and results still available", Boolean(p?.text.includes("Your free tests, analytics and previous results are still available.")));
    if (persona === "expired") check("expired: Buy Premium + Continue Free", Boolean(p?.text.includes("Buy Premium") && p.text.includes("Continue Free")));
    await shot(page, `03-${persona}`);
    await page.reload();
    check(`${persona}: not shown again on reload`, (await popupState(page, 4000)) === null);
    await ctx.close();
  }
  {
    const ctx = await studentContext(browser, "paid");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/student/dashboard`);
    check("Paid Premium student: no popup", (await popupState(page, 5000)) === null);
    await page.goto(`${BASE}/student/dashboard?premium=locked`);
    check("Paid Premium student: no popup even from a lock link", (await popupState(page, 4000)) === null);
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.papers.paid}`);
    check("Paid Premium student: Premium PYQ opens", !/premium=locked/.test(page.url()), page.url());
    await ctx.close();
  }
  {
    const ctx = await studentContext(browser, "expired");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.papers.free}`);
    check("Expired trial: selected free PYQ still opens", !/premium=locked/.test(page.url()), page.url());
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.papers.paid}`);
    check("Expired trial: Premium PYQ → trial/upgrade options", /premium=locked/.test(page.url()), page.url());
    for (const path of ["/student/history", "/student/analytics"]) {
      const r = await page.goto(`${BASE}${path}`);
      check(`Expired trial: ${path} still loads`, Boolean(r && r.status() < 400 && !/login|premium=locked/.test(page.url())), `${r?.status()} ${page.url()}`);
    }
    await ctx.close();
  }

  console.log("\n4. Plans & Pricing");
  {
    const res = await fetch(`${BASE}/plans-and-pricing`);
    const html = (await res.text()).replace(/<!-- -->/g, "");
    check("Guest: 200", res.status === 200);
    check("H1 unchanged", html.includes("RUHS MO 2026 Test Series — Plans &amp; Pricing") || html.includes("RUHS MO 2026 Test Series — Plans & Pricing"));
    check("Canonical unchanged", /<link rel="canonical" href="[^"]*\/plans-and-pricing"/.test(html));
    check("Three-tier comparison shown (enforcement ON)", html.includes("Free Forever vs Premium Trial vs Premium") && html.includes("data-testid=\"premium-access-comparison\""));
    check("Validity 'Till Exam' + supporting text", html.includes("Till Exam") && html.includes("Full Premium Access Until RUHS MO 2026 Exam"));
    check("Price from the DB (₹999)", html.includes("₹999"));
    check("Free trial FAQ present", html.includes("Is there a free trial?"));
    check("Old 'N mock tests are free' FAQ replaced", !/mock tests? (is|are) free to attempt/.test(html));
    check("Free forever lists the selected tests", html.includes("PTQA MO 2024") && html.includes("PTQA Mock Test 1") && html.includes("PTQA Physiology Subject Mock Test 01"));
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.goto(`${BASE}/plans-and-pricing`);
    check("Pricing mobile: no horizontal scroll", await noHorizontalScroll(page));
    await page.locator("[data-testid=premium-access-comparison]").scrollIntoViewIfNeeded();
    await shot(page, "04-pricing-mobile");
    fixture("policy", "off");
    await new Promise((r) => setTimeout(r, 6000)); // policy cache TTL 5s
    const off = (await (await fetch(`${BASE}/plans-and-pricing`)).text()).replace(/<!-- -->/g, "");
    check("Enforcement OFF: old Free vs Complete comparison back, no trial copy", off.includes("Free vs Complete Series") && !off.includes("Free Forever vs Premium Trial vs Premium"));
    fixture("policy", "on");
    await new Promise((r) => setTimeout(r, 6000));
  }

  console.log("\n5. Public SEO pages stay public (anonymous, no redirect)");
  for (const path of ["/", `/exams/${F.examSlug}`, `/exams/${F.examSlug}/previous-year-papers`, `/exams/${F.examSlug}/mock-test-series`, "/robots.txt", "/sitemap.xml"]) {
    const r = await fetch(`${BASE}${path}`, { redirect: "manual" });
    check(`${path} → 200 (no login/checkout redirect)`, r.status === 200, r.status);
  }
  {
    const r = await fetch(`${BASE}/`, { headers: { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" }, redirect: "manual" });
    check("Googlebot gets the same homepage status (no cloaking)", r.status === 200);
  }

  console.log("\n5b. Accurate Free/Premium on the public series page + dashboard card");
  {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    await page.goto(`${BASE}/exams/${F.examSlug}/mock-test-series`);
    // ScheduleRow: badges sit in the sibling div above the <p> title.
    const badgeFor = async (title) => (await page.locator(`p:text-is("${title}")`).first().locator("xpath=..").innerText()).replace(/\s+/g, " ");
    const legacy = await badgeFor("PTQA Mock Test 2 (legacy free)");
    check("Series page: legacy-FREE mock shows 'Complete Series' (not Free)", /Complete Series/.test(legacy) && !/\bFree\b/.test(legacy), legacy.slice(0, 160));
    const free1 = await badgeFor("PTQA Mock Test 1");
    check("Series page: selected free mock shows 'Free'", /\bFree\b/.test(free1), free1.slice(0, 160));
    const body = await page.locator("main").innerText();
    check("Series page: PYQ row says '1 free paper'", body.includes("1 free paper"));
    const fctx = await studentContext(browser, "locked");
    const fp = await fctx.newPage();
    await fp.goto(`${BASE}/student/dashboard`);
    const dlg = await popupState(fp);
    if (dlg) await fp.keyboard.press("Escape");
    const dash = await fp.locator("main").innerText();
    check("Dashboard Upgrade card shows 'Till Exam' (exam date configured)", dash.includes("Till Exam") && !dash.includes("100 days access"), dash.slice(0, 200));
    await fctx.close();
  }

  console.log("\n5c. Homepage visual regression vs the production code (BASELINE)");
  if (process.env.BASELINE) {
    const shotsOf = async (origin, w, h) => {
      const c = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: "reduce" });
      const pg = await c.newPage();
      await pg.goto(`${origin}/`, { waitUntil: "networkidle" });
      await pg.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
      // Live platform statistics are cached per server (different start times → different counts): mask them.
      await pg.evaluate(() => {
        const el = document.querySelector("#statistics") ?? [...document.querySelectorAll("section")].find((x) => /Total Students/.test(x.textContent ?? ""));
        if (el) el.style.visibility = "hidden";
      });
      await pg.waitForTimeout(800);
      const buf = await pg.screenshot({ fullPage: true });
      const struct = await pg.evaluate(() =>
        [...document.querySelectorAll("h1,h2,h3,section,nav a,header a")]
          .filter((e) => !(e.closest("#statistics") || /Total Students/.test(e.closest("section")?.textContent ?? "")))
          .map((e) => (e.tagName === "SECTION" ? `SECTION#${e.id}` : `${e.tagName}:${(e.textContent || "").trim().slice(0, 40)}`))
      );
      await c.close();
      return { buf, struct };
    };
    const pixelDiff = async (a, b) => {
      const pg = await (await browser.newContext()).newPage();
      return pg.evaluate(async ([a64, b64]) => {
        const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
        const [ia, ib] = await Promise.all([load(a64), load(b64)]);
        if (ia.width !== ib.width || ia.height !== ib.height) return { sizeDiff: [ia.width, ia.height, ib.width, ib.height] };
        const cv = (i) => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
        const da = cv(ia), db = cv(ib);
        let n = 0;
        for (let k = 0; k < da.length; k += 4) if (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]) > 24) n++;
        return { changed: n, total: da.length / 4 };
      }, [`data:image/png;base64,${a.toString("base64")}`, `data:image/png;base64,${b.toString("base64")}`]);
    };
    fixture("policy", "off");
    await new Promise((r) => setTimeout(r, 6000));
    for (const [w, h, label] of [[1366, 900, "desktop"], [390, 844, "mobile"]]) {
      const base = await shotsOf(process.env.BASELINE, w, h);
      const feat = await shotsOf(BASE, w, h);
      const d = await pixelDiff(base.buf, feat.buf);
      if (SHOTS) { fs.writeFileSync(`${SHOTS}/07-home-${label}-baseline.png`, base.buf); fs.writeFileSync(`${SHOTS}/07-home-${label}-feature.png`, feat.buf); }
      check(`Enforcement OFF, ${label}: homepage pixel-identical to production code`, !d.sizeDiff && d.changed === 0, d);
      check(`Enforcement OFF, ${label}: same headings/sections/nav`, JSON.stringify(base.struct) === JSON.stringify(feat.struct));
    }
    fixture("policy", "on");
    await new Promise((r) => setTimeout(r, 6000));
    for (const [w, h, label] of [[1366, 900, "desktop"], [390, 844, "mobile"]]) {
      const base = await shotsOf(process.env.BASELINE, w, h);
      const feat = await shotsOf(BASE, w, h);
      if (SHOTS) fs.writeFileSync(`${SHOTS}/07-home-${label}-feature-ON.png`, feat.buf);
      check(`Enforcement ON, ${label}: same headings/sections/nav as production (no card or section removed)`, JSON.stringify(base.struct) === JSON.stringify(feat.struct), { base: base.struct.length, feat: feat.struct.length });
      const d = await pixelDiff(base.buf, feat.buf);
      check(`Enforcement ON, ${label}: page width unchanged (no horizontal growth)`, !d.sizeDiff || d.sizeDiff[0] === d.sizeDiff[2], d);
      console.log(`  INFO  Enforcement ON, ${label}: height ${d.sizeDiff ? `${d.sizeDiff[1]} → ${d.sizeDiff[3]} px (accurate Premium rows added to existing lists)` : "unchanged"}`);
    }
  } else console.log("  (skipped: set BASELINE=<origin of a server running the production commit>)");

  console.log("\n6. Admin → Payments → Free Access & Trial");
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", F.admin.master);
    await page.fill("input[name=password]", F.admin.password);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
    await page.goto(`${BASE}/admin/payments?tab=free-access`);
    const body = await page.locator("main").innerText();
    check("Master: panel renders with enforcement ON", /Premium Access Enforcement\s*ON/i.test(body), body.slice(0, 200));
    check("Master: Trial Analytics with real counts", /Trials started\s*\n?\s*\d+/i.test(body) && /Active trials\s*\n?\s*\d+/i.test(body));
    check("Master: 3 free selections pre-filled", (await page.locator("select[name=freePyqId]").inputValue()) === F.papers.free && (await page.locator("select[name=freeMockTestId]").inputValue()) === F.mocks.free && (await page.locator("select[name=freeSubjectMockTestId]").inputValue()) === F.mocks.subject);
    await shot(page, "06-admin-master");
    // Save with no changes → success + audit log row
    await page.locator("form:has(select[name=freePyqId]) button[type=submit]").click();
    await page.locator("text=Free Access & Trial settings saved.").waitFor({ timeout: 15000 });
    check("Master: save works and is audit-logged", Number(sql(`SELECT count(*) FROM "AuditLog" WHERE action='PREMIUM_POLICY_UPDATED'`)) >= 1);
    // Enforcement switch requires typed confirmation
    await page.fill("#pe-confirm", "nope");
    await page.locator("form:has(#pe-confirm) button[type=submit]").click();
    await page.locator("text=Type DISABLE to confirm.").waitFor({ timeout: 15000 });
    check("Master: switching needs the typed confirmation", (await page.locator("text=Type DISABLE to confirm.").count()) > 0);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", F.admin.full);
    await page.fill("input[name=password]", F.admin.password);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
    await page.goto(`${BASE}/admin/payments?tab=free-access`);
    check("FULL_ADMIN: can view the panel", (await page.locator("text=Free Access & Trial Settings").count()) > 0);
    check("FULL_ADMIN: controls disabled", await page.locator("select[name=freePyqId]").isDisabled());
    // Bypass the UI: re-enable and submit anyway → server refuses.
    const before = sql(`SELECT value::text FROM "Setting" WHERE key='access.premium_policy'`);
    await page.evaluate(() => {
      document.querySelectorAll("fieldset,button,select,input").forEach((el) => el.removeAttribute("disabled"));
      const sel = document.querySelector("select[name=freePyqId]");
      if (sel) sel.value = "";
    });
    await page.locator("form:has(select[name=freePyqId]) button[type=submit]").click();
    await page.locator("text=Forbidden").first().waitFor({ timeout: 15000 });
    check("FULL_ADMIN: forced submit → Forbidden", (await page.locator("text=Forbidden").count()) > 0);
    check("FULL_ADMIN: setting unchanged", sql(`SELECT value::text FROM "Setting" WHERE key='access.premium_policy'`) === before);
    await page.fill("#pe-confirm", "DISABLE");
    await page.evaluate(() => document.querySelectorAll("fieldset,button,input").forEach((el) => el.removeAttribute("disabled")));
    await page.locator("form:has(#pe-confirm) button[type=submit]").click();
    await page.locator("text=Forbidden").first().waitFor({ timeout: 15000 });
    check("FULL_ADMIN: cannot switch enforcement off", sql(`SELECT value->>'enforcementEnabled' FROM "Setting" WHERE key='access.premium_policy'`) === "true");
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
