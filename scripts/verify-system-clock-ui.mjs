/**
 * Browser verification of the SYSTEM CLOCK dashboard card (scratch server + scratch DB, or production read-only).
 *
 *   BASE=http://localhost:<port> ADMIN_USER=<master admin> QA_PASSWORD=<pw> [SHOTS=<dir>] NODE_PATH=<dir with playwright> \
 *   node scripts/verify-system-clock-ui.mjs
 *
 * The browser runs in a different timezone (America/Los_Angeles) with its clock deliberately 3 h 17 min 23 s WRONG:
 * the card must still show true IST and UTC (compared with this machine's NTP clock, ±2 s).
 * Checks: one card, no "Server Time", HH:MM:SS + date for both zones, ticks every second, no React/hydration errors,
 * no horizontal overflow at 375 / 768 / 1280 px, the other dashboard cards still render.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE;
const USER = process.env.ADMIN_USER ?? "qa-master";
const PW = process.env.QA_PASSWORD;
if (!BASE || !PW) {
  console.error("Refusing to run: needs BASE and QA_PASSWORD.");
  process.exit(2);
}
let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const SKEW_MS = (3 * 3600 + 17 * 60 + 23) * 1000;
const fmt = (ms, zone) => ({
  time: new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(ms),
  date: new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(ms),
});
const toSec = (hms) => hms.split(":").reduce((a, x) => a * 60 + Number(x), 0);
const secDiff = (a, b) => { const d = Math.abs(toSec(a) - toSec(b)); return Math.min(d, 86400 - d); };

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Los_Angeles" });
// A wrong browser clock: Date.now() and new Date() run 3 h 17 min 23 s ahead.
await ctx.addInitScript((skew) => {
  const RealDate = Date;
  const now = () => RealDate.now() + skew;
  class SkewDate extends RealDate { constructor(...a) { super(...(a.length ? a : [now()])); } static now() { return now(); } }
  globalThis.Date = SkewDate;
}, SKEW_MS);
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/admin/login`);
await page.fill("input[name=username]", USER);
await page.fill("input[name=password]", PW);
await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }).catch(() => null), page.locator("form button[type=submit]").click()]);
check("admin signed in", !page.url().includes("/admin/login"), page.url());
if (!page.url().replace(BASE, "").match(/^\/admin\/?$/)) await page.goto(`${BASE}/admin`);
await page.locator("[data-testid=system-clock]").waitFor({ timeout: 30000 });
const browserSays = await page.evaluate(() => ({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() }));
check("test setup: browser timezone is NOT UTC/IST and its clock is wrong by > 3 h", browserSays.tz === "America/Los_Angeles" && Math.abs(browserSays.now - Date.now()) > 3 * 3600_000, browserSays);

check("exactly ONE System Clock card", (await page.locator("[data-testid=system-clock]").count()) === 1 && (await page.locator("[data-card-id=system-clock]").count()) === 1);
const cardText = await page.locator("[data-testid=system-clock]").innerText();
check("heading SYSTEM CLOCK; IST + UTC labels, offsets, zone names", /system clock/i.test(cardText) && /IST/.test(cardText) && /UTC\+05:30/.test(cardText) && /Asia\/Kolkata/.test(cardText) && /Indian Standard Time/.test(cardText) && /UTC\+00:00/.test(cardText) && /Coordinated Universal Time/.test(cardText), cardText);
check("no separate Server Time shown", !/server time/i.test(await page.locator("main").innerText().catch(() => cardText)));

const read = async () => ({
  t: Date.now(),
  ist: { time: await page.locator("[data-testid=clock-ist-time]").innerText(), date: await page.locator("[data-testid=clock-ist-date]").innerText() },
  utc: { time: await page.locator("[data-testid=clock-utc-time]").innerText(), date: await page.locator("[data-testid=clock-utc-date]").innerText() },
});
const r = await read();
check("HH:MM:SS format (24 h) for both", /^\d{2}:\d{2}:\d{2}$/.test(r.ist.time) && /^\d{2}:\d{2}:\d{2}$/.test(r.utc.time), r);
const eIst = fmt(r.t, "Asia/Kolkata"), eUtc = fmt(r.t, "UTC");
check("UTC equals real UTC (±2 s) despite the wrong browser clock and browser timezone", secDiff(r.utc.time, eUtc.time) <= 2 && r.utc.date === eUtc.date, { shown: r.utc, expected: eUtc });
check("IST equals real IST (±2 s) and UTC + 05:30", secDiff(r.ist.time, eIst.time) <= 2 && r.ist.date === eIst.date && secDiff(r.ist.time, fmt(toSec(r.utc.time) * 1000 + 19800_000, "UTC").time) === 0, { shown: r.ist, expected: eIst });

// Ticks every second: sample every 200 ms for 4.2 s.
const seen = new Set();
for (let i = 0; i < 21; i++) { seen.add(await page.locator("[data-testid=clock-utc-time]").innerText()); await page.waitForTimeout(200); }
check("updates every second (4–5 distinct seconds in 4.2 s)", seen.size >= 4 && seen.size <= 6, [...seen]);
const r2 = await read();
check("IST and UTC stay locked together (exactly 05:30 apart) after ticking", fmt(toSec(r2.utc.time) * 1000 + 19800_000, "UTC").time === r2.ist.time, r2);

// Other dashboard cards are still there.
const ids = await page.locator("[data-testid=dashboard-grid] > [data-card-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card-id")));
check("other dashboard cards still render (Action Required, Total Students, Quick actions, Homepage status)", ["action-required", "total-students", "quick-actions", "homepage-status"].every((x) => ids.includes(x)), ids);

// Responsive: no horizontal overflow; both clocks inside the viewport.
for (const vp of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const card = document.querySelector("[data-testid=system-clock]");
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    return { docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, cardOverflow: card.scrollWidth > card.clientWidth + 1, ist: b("[data-testid=clock-ist-time]"), utc: b("[data-testid=clock-utc-time]"), vw: window.innerWidth };
  });
  check(`${vp.width}px: no horizontal overflow, both clocks fully visible`, !m.docOverflow && !m.cardOverflow && m.ist.right <= m.vw && m.utc.right <= m.vw && m.ist.left >= 0, m);
  if (process.env.SHOTS) await page.locator("[data-testid=system-clock]").screenshot({ path: `${process.env.SHOTS}/system-clock-${vp.width}.png` });
}
const relevant = errors.filter((e) => /hydrat|did not match|minified react|react error|uncaught/i.test(e));
check("no hydration / React errors in the console", relevant.length === 0, relevant);
console.log(`(all console errors: ${errors.length}${errors.length ? " — " + errors.slice(0, 3).join(" | ").slice(0, 300) : ""})`);
await browser.close();
console.log(fails ? `FAILED (${fails})` : "ALL PASS");
process.exit(fails ? 1 : 0);
