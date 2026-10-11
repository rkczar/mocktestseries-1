/**
 * FOOTER "LAST UPDATED" DATE — HTTP + browser regression.
 *
 * Against a scratch `next start` whose cwd is the repo root (so MARKER is the
 * release's `.deployed-at`), signed in as a scratch MASTER_ADMIN:
 *   hidden while nothing is known; a real admin public-content save shows
 *   today (IST); later logins / student activity / the line's own settings
 *   don't move it; the deployment marker wins when newer; Manual mode and its
 *   server-side validation; Show OFF on every footer; footer links,
 *   copyright and layout unchanged on desktop and mobile.
 *
 *   BASE=http://localhost:3157 DATABASE_URL=<scratch> ADMIN_USER=… ADMIN_PASS=… \
 *     MARKER=<repo>/.deployed-at SHOTS=<dir> NODE_PATH=<dir with playwright> \
 *     node scripts/verify-site-last-updated.mjs
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:3157";
const DB = process.env.DATABASE_URL;
const MARKER = process.env.MARKER;
const SHOTS = process.env.SHOTS;
if (!DB || new URL(DB).pathname === "/mocktestseries") throw new Error("scratch DATABASE_URL required");
if (!MARKER) throw new Error("MARKER required");

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}`, detail ?? "");
  }
}
const sql = (q) => execFileSync("psql", [DB.replace(/\?.*$/, ""), "-At", "-c", q], { encoding: "utf8" }).trim();
const istToday = () =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "long", year: "numeric" }).format(new Date());

async function footerInfo(page, path = "/") {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("footer");
  return page.evaluate(() => {
    const footer = document.querySelector("footer");
    const line = footer.querySelector("[data-testid=footer-last-updated]");
    const fb = footer.getBoundingClientRect();
    const lb = line?.getBoundingClientRect();
    return {
      text: line?.textContent?.trim() ?? null,
      links: [...footer.querySelectorAll("nav[aria-label=Footer] a")].map((a) => a.getAttribute("href")),
      copyright: footer.lastElementChild?.firstElementChild?.textContent?.trim() ?? null,
      isLastInFooter: line ? footer.lastElementChild.lastElementChild === line : null,
      gapToFooterBottom: lb ? Math.round(fb.bottom - lb.bottom) : null,
      fontSize: line ? getComputedStyle(line).fontSize : null,
      animation: line ? getComputedStyle(line).animationName : null,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function waitForFooter(page, expected, label, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let info;
  do {
    info = await footerInfo(page);
    if (info.text === expected) break;
    await new Promise((r) => setTimeout(r, 3000));
  } while (Date.now() < until);
  check(label, info.text === expected, { got: info.text, expected });
  return info;
}

async function adminSave(page, { show, mode, manualDate, stripLimits = false }) {
  await page.goto(`${BASE}/admin/website/footer`);
  await page.waitForSelector("[data-testid=last-updated-form]");
  const sw = page.locator("#last-updated-show");
  if ((await sw.getAttribute("aria-checked")) !== String(show)) await sw.click();
  await page.locator(`[data-testid=last-updated-mode-${mode.toLowerCase()}]`).check();
  if (stripLimits) {
    // Bypass the browser's own checks to prove the server refuses the value.
    await page.evaluate(() => {
      const input = document.querySelector("#last-updated-manual-date");
      input.removeAttribute("max");
      input.removeAttribute("required");
    });
  }
  await page.fill("#last-updated-manual-date", manualDate ?? "");
  await page.locator("[data-testid=last-updated-save]").click();
  const status = page.locator("[data-testid=last-updated-form] [role=status]");
  await status.waitFor({ timeout: 15000 });
  return (await status.textContent()).trim();
}

(async () => {
  if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER);
  sql(`DELETE FROM "Setting" WHERE key = 'website.last_updated'`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  console.log("Baseline (no deployment marker, no content change yet)");
  const base = await footerInfo(page);
  check("footer renders with its links", base.links.length > 0, base.links);
  check("line hidden while no date is known", base.text === null, base.text);
  const baselineLinks = base.links;
  const baselineCopyright = base.copyright;

  console.log("Admin sign-in + defaults");
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  await page.goto(`${BASE}/admin/website/footer`);
  await page.waitForSelector("[data-testid=last-updated-form]");
  const sw = page.locator("#last-updated-show");
  check("Show Last Updated defaults ON", (await sw.getAttribute("aria-checked")) === "true");
  check("Date Mode defaults to Automatic", await page.locator("[data-testid=last-updated-mode-automatic]").isChecked());
  check("WhatsApp + Telegram cards still on the page", (await page.locator("[data-testid=telegram-channel-form]").count()) === 1 && (await page.getByText("WhatsApp Support", { exact: false }).count()) > 0);

  console.log("A real admin public-content change (Telegram Channel save)");
  await page.fill("#telegram-channel-url", "https://t.me/lu_verify");
  await page.locator("[data-testid=telegram-save]").click();
  await page.locator("[data-testid=telegram-channel-form] [role=status]").waitFor({ timeout: 15000 });
  check("Telegram save wrote its audit row", sql(`SELECT count(*) FROM "AuditLog" WHERE action='TELEGRAM_CHANNEL_CONFIG_SAVED'`) === "1");
  const t0 = Date.now();
  await waitForFooter(page, `Last Updated: ${istToday()}`, "footer shows today's IST date after the admin change", 330_000);
  console.log(`  info  visible after ${Math.round((Date.now() - t0) / 1000)}s`);

  console.log("Non-content activity must not move the date");
  for (const action of ["ADMIN_LOGIN", "STUDENT_LOGOUT_ALL", "STUDENT_DELETION_REQUESTED", "AI_SETTINGS_SAVED", "QUESTION_REPORT_STATUS_CHANGED", "BACKUP_CREATED", "HOMEPAGE_SECTION_UPDATED"]) {
    sql(`INSERT INTO "AuditLog"(id, action, "entityType", "entityId", "createdAt") VALUES ('luv-${action}', '${action}', 'Test', 'lu-verify', now() + interval '40 days')`);
  }
  // Saving the line's own settings busts the cache, so the next render re-reads everything.
  check("saving Automatic/ON succeeds", (await adminSave(page, { show: true, mode: "AUTOMATIC", manualDate: "" })) === "Saved.");
  const afterNoise = await footerInfo(page);
  check("later logins / student / AI / backup / draft rows ignored", afterNoise.text === `Last Updated: ${istToday()}`, afterNoise.text);
  sql(`DELETE FROM "AuditLog" WHERE "entityId" = 'lu-verify'`);

  console.log("Successful-deployment marker (newer than content wins, IST conversion)");
  fs.writeFileSync(MARKER, "2026-12-25T20:00:00Z\n"); // 26 December in IST
  await new Promise((r) => setTimeout(r, 31_000)); // the reader re-checks a missing marker every 30 s
  await waitForFooter(page, "Last Updated: 26 December 2026", "deployment marker date shown (20:00 UTC → next IST day)", 20_000);
  const admin = await (async () => {
    await page.goto(`${BASE}/admin/website/footer`);
    return page.locator("[data-testid=last-updated-automatic]").innerText();
  })();
  check("admin card explains the automatic date", admin.includes("26 December 2026") && admin.includes("26 Dec 2026") && admin.includes("IST"), admin);

  console.log("Manual mode + server-side validation");
  check("Manual with a past date saves", (await adminSave(page, { show: true, mode: "MANUAL", manualDate: "2026-09-05" })) === "Saved.");
  const manual = await footerInfo(page);
  check("footer shows the manual date", manual.text === "Last Updated: 05 September 2026", manual.text);
  check("future manual date refused by the server", (await adminSave(page, { show: true, mode: "MANUAL", manualDate: "2099-01-01", stripLimits: true })).includes("future"));
  check("Manual without a date refused by the server", (await adminSave(page, { show: true, mode: "MANUAL", manualDate: "", stripLimits: true })).includes("Pick a date"));
  check("refused saves left the manual date in place", (await footerInfo(page)).text === "Last Updated: 05 September 2026");

  console.log("Show OFF / ON");
  check("Show OFF saves", (await adminSave(page, { show: false, mode: "MANUAL", manualDate: "2026-09-05" })) === "Saved.");
  for (const path of ["/", "/contact", "/privacy"]) {
    const off = await footerInfo(page, path);
    check(`line hidden on ${path}`, off.text === null, off.text);
  }
  check("Automatic + ON saves", (await adminSave(page, { show: true, mode: "AUTOMATIC", manualDate: "2026-09-05" })) === "Saved.");
  for (const path of ["/", "/contact", "/privacy"]) {
    const on = await footerInfo(page, path);
    check(`line back on ${path}`, on.text === "Last Updated: 26 December 2026", on.text);
  }
  check("settings saves did not touch the Telegram setting", sql(`SELECT value->>'url' FROM "Setting" WHERE key='website.telegram_channel'`) === "https://t.me/lu_verify");
  check("own settings saves are audited but excluded", Number(sql(`SELECT count(*) FROM "AuditLog" WHERE action='LAST_UPDATED_SETTINGS_SAVED'`)) >= 4);

  console.log("Layout (desktop + mobile)");
  for (const [name, viewport] of [["desktop", { width: 1366, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const p = await (await browser.newContext({ viewport, isMobile: name === "mobile" })).newPage();
    const info = await footerInfo(p);
    check(`${name}: footer links unchanged`, JSON.stringify(info.links) === JSON.stringify(baselineLinks), info.links);
    check(`${name}: copyright unchanged`, info.copyright === baselineCopyright, info.copyright);
    check(`${name}: line is the last thing in the footer`, info.isLastInFooter === true && info.gapToFooterBottom !== null && info.gapToFooterBottom <= 20, info);
    check(`${name}: small text, no animation`, info.fontSize === "12px" && (info.animation === "none" || info.animation === ""), info);
    check(`${name}: no horizontal scroll`, info.overflowX === false);
    if (SHOTS) {
      await p.locator("footer").scrollIntoViewIfNeeded();
      await p.locator("footer").screenshot({ path: `${SHOTS}/footer-${name}.png` });
    }
    await p.context().close();
  }
  check("no page errors", errors.length === 0, errors);

  fs.unlinkSync(MARKER);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
