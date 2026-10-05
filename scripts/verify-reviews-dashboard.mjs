/**
 * Student Reviews on the Student Dashboard (block "student-reviews") —
 * browser verification against a `next start` server on a *payverify*
 * scratch DB prepared by:
 *
 *   npx tsx scripts/ai-actions-ux-fixture.ts setup > /tmp/aiux.json
 *   npx tsx scripts/verify-reviews.ts dashboard-setup /tmp/aiux.json > /tmp/rdash.json
 *
 *   BASE=http://localhost:3115 AIUX=/tmp/aiux.json FIXTURE=/tmp/rdash.json SHOTS=/dir \
 *   NODE_PATH=<dir containing playwright> node scripts/verify-reviews-dashboard.mjs
 *
 * Covers: placement directly above Access & Subscription in the saved
 * production layout, only published reviews, Verified only on the genuine
 * student review, compact sizing (desktop ~2–3 cards, mobile ~1–1.2),
 * subtle RTL auto-scroll, swipe, reduced motion, dark/light, no overflow or
 * runtime/hydration errors, Share-your-experience + Access & Subscription
 * still working, the Admin → Reviews dashboard switch, and the zero-review
 * state. Leaves every review unpublished at the end.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:3115";
const AIUX = JSON.parse(readFileSync(process.env.AIUX, "utf8"));
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? null;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
async function studentPage({ mobile = false, theme, reducedMotion, token = AIUX.tokens.nine } = {}) {
  const ctx = await browser.newContext(mobile ? { ...devices["Pixel 7"], reducedMotion } : { viewport: { width: 1366, height: 900 }, reducedMotion });
  const cookies = [{ name: "student-session-token", value: token, url: BASE }];
  if (theme) cookies.push({ name: "mts-theme", value: theme, url: BASE });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => m.type() === "error" && page.errors.push(`console: ${m.text().slice(0, 160)}`));
  page.on("response", (r) => r.status() >= 500 && page.errors.push(`HTTP ${r.status()} ${r.url()}`));
  return page;
}
async function dashboard(page) {
  await page.goto(`${BASE}/student/dashboard`, { waitUntil: "networkidle" });
  return page.locator("#dashboard-reviews");
}
const translateX = (page) =>
  page.evaluate(() => {
    const t = document.querySelector("#dashboard-reviews [data-review-card]")?.closest("ul")?.parentElement;
    const m = t ? getComputedStyle(t).transform : "none";
    return m === "none" ? 0 : new DOMMatrix(m).m41;
  });
const moved = async (page, a, b) => {
  const period = await page.evaluate(() => document.querySelector("#dashboard-reviews ul")?.offsetWidth ?? 0);
  let d = b - a;
  if (period && d > period / 2) d -= period;
  if (period && d < -period / 2) d += period;
  return d;
};
const accessible = (section) => section.locator("ul:not([aria-hidden]) > li:not([aria-hidden]) figure");

// The setup writes the DB directly; one admin settings save refreshes the
// cached public reviews exactly like any Admin → Reviews change does.
const admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await admin.goto(`${BASE}/admin/login`);
await admin.fill("#username", F.master);
await admin.fill("#password", F.password);
await admin.locator("form button[type=submit]").click();
await admin.waitForURL((u) => !u.pathname.startsWith("/admin/login"));
await admin.goto(`${BASE}/admin/reviews`, { waitUntil: "load" });
await admin.getByRole("button", { name: "Save Settings" }).click();
await admin.getByText("Homepage review settings saved.").waitFor();

console.log("— Desktop dashboard (production layout)");
for (const theme of ["dark", "light"]) {
  const page = await studentPage({ theme });
  const section = await dashboard(page);
  check(`[${theme}] reviews block rendered`, (await section.count()) === 1);
  if (theme === "dark") {
    check("compact heading", (await section.locator("h2").innerText()) === "What Students Say");
    const layout = await page.evaluate(() => {
      const sec = document.querySelector("#dashboard-reviews");
      const next = sec.nextElementSibling;
      const group = sec.parentElement;
      const prevGroup = group.previousElementSibling;
      return {
        nextText: (next?.textContent ?? "").replace(/\s+/g, " ").slice(0, 160),
        nextIsPanel: Boolean(next?.querySelector("a[href]")) && !next?.id,
        prevGroup: prevGroup?.getAttribute("data-dashboard-group"),
        groupFirst: group.firstElementChild === sec,
      };
    });
    check("placed immediately above Access & Subscription (next block is the pricing panel)", layout.nextIsPanel && /₹|799|Complete Access|Unlock|Upgrade/i.test(layout.nextText), layout);
    check("after Recent Activity (production saved order kept)", layout.prevGroup === "recent" && layout.groupFirst, layout);
    const names = await accessible(section).locator("figcaption .truncate.font-medium").allInnerTexts();
    check("only the 5 published reviews (hidden one absent)", names.length === 5 && !names.includes("Hidden Person"), names);
    check("featured first, then display order", JSON.stringify(names) === JSON.stringify(["Anita Verma", "Rohit K.", "Meena S.", "Karan P.", "Nine S."]), names);
    const verified = await accessible(section).filter({ hasText: "Verified Student" }).locator("figcaption .truncate.font-medium").allInnerTexts();
    check("Verified Student only on the genuine student review", JSON.stringify(verified) === JSON.stringify(["Nine S."]), verified);
    check("hidden testimonial nowhere in the HTML", !(await page.content()).includes("Hidden Person"));
    const fit = await page.evaluate(() => {
      const vp = document.querySelector("#dashboard-reviews [data-review-card]").closest("ul").parentElement.parentElement;
      const card = document.querySelector("#dashboard-reviews [data-review-card]");
      return vp.clientWidth / card.getBoundingClientRect().width;
    });
    check("desktop shows ~2–3 cards", fit >= 2 && fit <= 3.6, fit);
    await section.scrollIntoViewIfNeeded();
    const x0 = await translateX(page);
    await sleep(1500);
    const d = await moved(page, x0, await translateX(page));
    check("subtle right → left auto-scroll (slower than homepage 36px/s)", d < -10 && d > -40, d);
    const box = await section.locator("[data-review-card]").first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(300);
    const h0 = await translateX(page);
    await sleep(700);
    check("pauses on hover", Math.abs((await translateX(page)) - h0) < 1);
    await page.mouse.move(2, 2);
    check("Share-your-experience card still present", (await page.getByText("Your review", { exact: true }).count()) === 1);
    const hrefs = await page.locator("#dashboard-reviews + * a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    const statuses = [];
    for (const h of hrefs) statuses.push((await page.request.get(`${BASE}${h}`)).status());
    check("Access & Subscription links (checkout / plans) still open", hrefs.length > 0 && statuses.every((st) => st === 200), { hrefs, statuses });
  }
  check(`[${theme}] no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (SHOTS) {
    await page.evaluate(() => document.querySelector("#dashboard-reviews").scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${SHOTS}/dash-desktop-${theme}.png` });
  }
  check(`[${theme}] no runtime/hydration/console errors`, page.errors.length === 0, page.errors);
  await page.context().close();
}

console.log("— Mobile dashboard");
for (const theme of ["dark", "light"]) {
  const page = await studentPage({ mobile: true, theme });
  const section = await dashboard(page);
  await section.scrollIntoViewIfNeeded();
  const fit = await page.evaluate(() => {
    const vp = document.querySelector("#dashboard-reviews [data-review-card]").closest("ul").parentElement.parentElement;
    return vp.clientWidth / document.querySelector("#dashboard-reviews [data-review-card]").getBoundingClientRect().width;
  });
  check(`[${theme}] mobile shows ~1–1.2 cards`, fit >= 1 && fit <= 1.3, fit);
  check(`[${theme}] no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  if (theme === "dark") {
    const m0 = await translateX(page);
    await sleep(1200);
    check("auto-scroll on mobile", (await moved(page, m0, await translateX(page))) < -5);
    const box = await section.locator("[data-review-card]").first().boundingBox();
    const s0 = await translateX(page);
    await page.evaluate(({ x, y }) => {
      const vp = document.querySelector("#dashboard-reviews [data-review-card]").closest("ul").parentElement.parentElement;
      const ev = (type, cx) => new PointerEvent(type, { pointerType: "touch", clientX: cx, clientY: y, bubbles: true, isPrimary: true });
      vp.dispatchEvent(ev("pointerdown", x));
      window.dispatchEvent(ev("pointermove", x - 50));
      window.dispatchEvent(ev("pointermove", x - 100));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
    }, { x: box.x + 200, y: box.y + 20 });
    check("manual swipe moves the row", Math.abs((await moved(page, s0, await translateX(page))) + 100) < 15);
  }
  if (SHOTS) {
    await section.screenshot({ path: `${SHOTS}/dash-mobile-${theme}.png` });
  }
  check(`[${theme}] no runtime/hydration/console errors (mobile)`, page.errors.length === 0, page.errors);
  await page.context().close();
}

console.log("— Reduced motion");
{
  const page = await studentPage({ mobile: true, reducedMotion: "reduce" });
  const section = await dashboard(page);
  await section.scrollIntoViewIfNeeded();
  await sleep(700);
  check("no transform under reduced motion", (await translateX(page)) === 0);
  const overflow = await page.evaluate(() => getComputedStyle(document.querySelector("#dashboard-reviews [data-review-card]").closest("ul").parentElement.parentElement).overflowX);
  check("swipeable row under reduced motion", overflow === "auto", overflow);
  await page.context().close();
}

console.log("— Admin switch + zero-review state");
{
  await admin.reload({ waitUntil: "load" });
  const sw = admin.getByRole("switch", { name: "Show Reviews on Student Dashboard" });
  check("setting present, default ON", (await sw.getAttribute("aria-checked")) === "true");
  await sw.click();
  await admin.getByRole("button", { name: "Save Settings" }).click();
  await admin.getByText("Homepage review settings saved.").waitFor();
  let page = await studentPage();
  check("dashboard switch OFF hides the block", (await (await dashboard(page)).count()) === 0);
  check("dashboard still renders other blocks", (await page.locator("[data-dashboard-group]").count()) >= 4 && page.errors.length === 0, page.errors);
  await page.context().close();
  const home = await (await browser.newContext()).newPage();
  await home.goto(`${BASE}/`, { waitUntil: "load" });
  check("homepage section unaffected by the dashboard switch", (await home.locator("#student-reviews").count()) === 1);
  await home.context().close();
  await admin.reload({ waitUntil: "load" });
  await admin.getByRole("switch", { name: "Show Reviews on Student Dashboard" }).click();
  await admin.getByRole("button", { name: "Save Settings" }).click();
  await admin.getByText("Homepage review settings saved.").waitFor();
  page = await studentPage();
  check("switch back ON shows it again", (await (await dashboard(page)).count()) === 1);
  await page.context().close();

  await admin.getByLabel("Select all reviews").check();
  await admin.getByRole("toolbar").getByRole("button", { name: "Unpublish" }).click();
  await admin.getByText(/reviews? hidden\./).waitFor();
  page = await studentPage();
  check("zero published reviews hide the block completely", (await (await dashboard(page)).count()) === 0 && !(await page.content()).includes("What Students Say"));
  check("Access & Subscription still renders with zero reviews", /Upgrade to Complete Access|Complete Access/.test(await page.locator("[data-dashboard-group=account]").first().innerText()));
  check("no errors in zero-review state", page.errors.length === 0, page.errors);
  await page.context().close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
