/**
 * Installable app (PWA) — real-browser verification.
 *
 * Checks the manifest, icons, service worker (app/sw.js/route.ts), what it
 * caches (only build assets, icons and the offline page — never a page, an
 * API response, Admin or the Test Player), installability as Chromium sees
 * it, offline/online behavior, the install CTA, auth/logout, and (optional)
 * the update flow against a rebuilt server, including that a student in the
 * Test Player is never reloaded.
 *
 * Runs against a LOCAL production build backed by a DISPOSABLE database;
 * fixture JSON comes from scripts/test-engine-ui-fixture.ts (setup).
 *
 *   BASE=http://localhost:3100 FIXTURE=/path/fixture.json NODE_PATH=<dir with playwright> \
 *     node scripts/verify-pwa.mjs
 *
 * Update phase (optional): set SIGNAL_DIR. The script writes
 * $SIGNAL_DIR/ready-for-rebuild, then waits for $SIGNAL_DIR/rebuilt — in
 * between, stop the server, run `next build` again (new BUILD_ID → new
 * worker) and restart it on the same port.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");

const BASE = process.env.BASE || "http://localhost:3100";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SIGNAL_DIR = process.env.SIGNAL_DIR;
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("The PWA suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newContext(browser, { token, device } = {}) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1366, height: 900 } });
  if (token) await ctx.addCookies([{ name: "student-session-token", value: token, url: BASE }]);
  return ctx;
}
async function swReady(page) {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const active = reg.active;
    if (active && active.state !== "activated") await new Promise((r) => active.addEventListener("statechange", () => active.state === "activated" && r()));
    return { scope: reg.scope, script: reg.active?.scriptURL, state: reg.active?.state };
  });
}
/** Every URL in every mts-* cache. */
async function cachedUrls(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      out[key] = (await cache.keys()).map((r) => new URL(r.url).pathname);
    }
    return out;
  });
}
/** The two Student Dashboard install surfaces: compact banner under the greeting, and the "install-app" block card. */
const installBanner = (page) => page.getByRole("region", { name: "Install MockTestSeries App" });
const installCard = (page) => page.getByText("Install MockTestSeries", { exact: true });
/** No horizontal scroll, and the given locator lies fully inside the viewport. */
async function fitsViewport(page, locator) {
  const vw = await page.evaluate(() => window.innerWidth);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const box = await locator.boundingBox();
  return overflow <= 0 && !!box && box.x >= 0 && box.x + box.width <= vw;
}
const allowedCacheEntry = (p) => p.startsWith("/_next/static/") || p.startsWith("/icons/") || p === "/favicon.ico" || p === "/offline.html";

async function main() {
  const browser = await chromium.launch({ args: ["--bypass-app-banner-engagement-checks"] });
  try {
    // ------------------------------------------------------------------
    console.log("\n--- Manifest, icons, worker script ---");
    {
      const res = await fetch(`${BASE}/manifest.webmanifest`);
      const m = await res.json();
      check("manifest 200 + application/manifest+json", res.status === 200 && /manifest\+json/.test(res.headers.get("content-type")));
      check("name / short_name = MockTestSeries", m.name === "MockTestSeries" && m.short_name === "MockTestSeries");
      check("display standalone, scope /, start_url /student/dashboard", m.display === "standalone" && m.scope === "/" && m.start_url === "/student/dashboard");
      check("categories include education", m.categories?.includes("education"));
      for (const want of [["192x192", "any"], ["512x512", "any"], ["192x192", "maskable"], ["512x512", "maskable"]]) {
        const icon = m.icons.find((i) => i.sizes === want[0] && i.purpose === want[1]);
        const r = icon && (await fetch(`${BASE}${icon.src}`));
        const buf = r && Buffer.from(await r.arrayBuffer());
        // PNG IHDR: width/height at bytes 16..23.
        const ok = r?.status === 200 && buf.readUInt32BE(16) === Number(want[0].split("x")[0]) && buf.readUInt32BE(20) === Number(want[0].split("x")[1]);
        check(`icon ${want[0]} ${want[1]}: 200 + real dimensions`, ok, icon?.src);
      }
      check("apple-touch-icon 200", (await fetch(`${BASE}/icons/apple-touch-icon.png`)).status === 200);
      const sw = await fetch(`${BASE}/sw.js`);
      check("sw.js served as JS, never HTTP-cached", sw.status === 200 && /javascript/.test(sw.headers.get("content-type")) && /no-store/.test(sw.headers.get("cache-control")));
      check("offline.html 200", (await fetch(`${BASE}/offline.html`)).status === 200);
    }

    // ------------------------------------------------------------------
    console.log("\n--- Public visitor: registration, installability, what is cached ---");
    {
      const ctx = await newContext(browser);
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await page.goto(`${BASE}/`);
      const reg = await swReady(page);
      check("worker registered at /sw.js, scope /, activated", reg.script === `${BASE}/sw.js` && reg.scope === `${BASE}/` && reg.state === "activated", reg);
      await page.reload();
      check("page controlled after reload", await page.evaluate(() => !!navigator.serviceWorker.controller));
      const errors = (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors;
      check("Chromium installability: no errors", errors.length === 0, errors);
      const manifest = await cdp.send("Page.getAppManifest");
      check("Chromium parsed the manifest without errors", manifest.errors.length === 0 && /manifest\.webmanifest$/.test(manifest.url), manifest.errors);
      const installEvent = await page.evaluate(() => !!window.__mtsInstallEvent);
      console.log(`  info  beforeinstallprompt captured in this headless run: ${installEvent}`);

      // Public pages: crawlable, untouched.
      for (const p of ["/exams", "/privacy", "/robots.txt", "/sitemap.xml"]) {
        const r = await page.goto(`${BASE}${p}`);
        check(`${p} 200 through the worker`, r.status() === 200);
      }
      check("/exams is not noindex", !(await page.goto(`${BASE}/exams`), await page.locator('meta[name="robots"][content*="noindex"]').count()));
      const redirected = await page.goto(`${BASE}/exams/any-exam/mock-tests`);
      check("legacy redirect still applies (→ /mock-test-series)", /\/exams\/any-exam\/mock-test-series$/.test(page.url()) || redirected.request().redirectedFrom() !== null);

      // Protected routes still redirect while the worker controls the page.
      await page.goto(`${BASE}/student/dashboard`);
      check("/student/dashboard → /login?callbackUrl (anonymous)", /\/login\?callbackUrl=%2Fstudent%2Fdashboard$/.test(page.url()), page.url());
      await page.goto(`${BASE}/student/attempt/does-not-exist/run`);
      check("/student/attempt/* → /login (anonymous)", /\/login\?callbackUrl=/.test(page.url()), page.url());
      await page.goto(`${BASE}/admin`);
      check("/admin → /admin/login (anonymous)", /\/admin\/login\?callbackUrl=%2Fadmin$/.test(page.url()), page.url());
      const apiStatus = await page.evaluate(async () => (await fetch("/api/admin/does-not-exist")).status);
      check("admin API still refuses anonymous callers", apiStatus !== 200, apiStatus);

      const cached = await cachedUrls(page);
      const all = Object.values(cached).flat();
      check("only mts-* caches exist", Object.keys(cached).every((k) => k.startsWith("mts-")), Object.keys(cached));
      check("cache holds only build assets / icons / offline page", all.every(allowedCacheEntry), all.filter((p) => !allowedCacheEntry(p)));
      check("offline page precached", all.includes("/offline.html"));
      check("no page HTML, API, admin or student entry cached", !all.some((p) => p === "/" || p.startsWith("/api") || p.startsWith("/admin") || p.startsWith("/student") || p.startsWith("/exams")));

      // Offline → fallback page; back online → real page.
      await page.goto(`${BASE}/exams`);
      await ctx.setOffline(true);
      await page.waitForSelector("text=You're offline. Reconnect to continue using MockTestSeries.", { timeout: 5000 }).then(
        () => check("offline notice appears on an open page", true),
        () => check("offline notice appears on an open page", false)
      );
      await page.goto(`${BASE}/exams`).catch(() => null);
      check("offline navigation → offline page", /You're offline\./.test(await page.locator("h1").first().innerText().catch(() => "")));
      const offlineText = await page.locator("body").innerText();
      check("offline page never claims anything was saved/submitted", !/saved|submitted/i.test(offlineText.replace(/This page will reload automatically[^\n]*/, "")));
      check("offline page keeps the URL (retry reloads the same page)", page.url() === `${BASE}/exams`);
      const attemptNav = await page.goto(`${BASE}/student/attempt/x/run`).then(() => "served", (e) => e.message);
      check("offline: attempt navigation is NOT handled by the worker", /ERR_INTERNET_DISCONNECTED/.test(attemptNav), attemptNav);
      const adminNav = await page.goto(`${BASE}/admin`).then(() => "served", (e) => e.message);
      check("offline: admin navigation is NOT handled by the worker", /ERR_INTERNET_DISCONNECTED/.test(adminNav), adminNav);
      await page.goto(`${BASE}/exams`).catch(() => null);
      await ctx.setOffline(false);
      await page.waitForFunction(() => !/You're offline\./.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 15000 }).then(
        () => check("connection returns → offline page reloads into the real page (≤10 s)", true),
        () => check("connection returns → offline page reloads into the real page (≤10 s)", false)
      );
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Signed-in student (Android phone): dashboard, install CTA, logout ---");
    {
      const ctx = await newContext(browser, { token: F.token, device: "Pixel 7" });
      const page = await ctx.newPage();
      const res = await page.goto(`${BASE}/student/dashboard`);
      check("dashboard 200 for a signed-in student", res.status() === 200 && /\/student\/dashboard$/.test(page.url()), page.url());
      await swReady(page);
      await page.reload();
      check("dashboard controlled by the worker", await page.evaluate(() => !!navigator.serviceWorker.controller));
      const hasPrompt = await page.evaluate(() => !!window.__mtsInstallEvent);
      if (hasPrompt) {
        check("Chromium: both install CTAs shown", (await installBanner(page).count()) === 1 && (await installCard(page).count()) === 1);
      } else {
        check("no install event → no install CTA at all (no fake button)", (await installBanner(page).count()) === 0 && (await installCard(page).count()) === 0);
      }
      const all = Object.values(await cachedUrls(page)).flat();
      check("student pages never cached", !all.some((p) => p.startsWith("/student") || p.startsWith("/api")), all.filter((p) => !allowedCacheEntry(p)));

      await ctx.close();
    }

    // ------------------------------------------------------------------
    // Headless Chromium does not fire beforeinstallprompt (it needs real
    // engagement), so the Chromium install flow is driven with a stand-in
    // event that has the same prompt()/userChoice contract. Chromium's own
    // installability verdict is checked above via CDP.
    console.log("\n--- Chromium install flow (stand-in install event) + standalone ---");
    const standInPrompt = () => {
      window.__prompted = 0;
      window.addEventListener("load", () => {
        const e = new Event("beforeinstallprompt", { cancelable: true });
        e.prompt = async () => { window.__prompted++; };
        e.userChoice = Promise.resolve({ outcome: "accepted" });
        window.dispatchEvent(e);
      });
    };
    for (const [surface, device] of [["upper banner", "Pixel 7"], ["lower card", "Pixel 7"]]) {
      const ctx = await newContext(browser, { token: F.token, device });
      await ctx.addInitScript(standInPrompt);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await installBanner(page).waitFor({ timeout: 15000 }).catch(() => null);
      check(`[${surface}] both CTAs shown once the browser offers installation`, (await installBanner(page).count()) === 1 && (await installCard(page).count()) === 1);
      check(`[${surface}] browser's default mini-infobar suppressed (preventDefault)`, await page.evaluate(() => window.__mtsInstallEvent?.defaultPrevented === true));
      if (surface === "upper banner") {
        const banner = installBanner(page);
        check("upper banner sits directly under the greeting", await page.evaluate(() => {
          const h1 = document.querySelector("h1");
          const region = document.querySelector('[aria-label="Install MockTestSeries App"]');
          return !!h1 && !!region && h1.parentElement === region.parentElement;
        }));
        check("upper banner copy", /Get faster access directly from your home screen\./.test(await banner.innerText()));
        check("upper banner is compact (≤ 120 px tall on a phone)", ((await banner.boundingBox())?.height ?? 999) <= 120, await banner.boundingBox());
        check("upper banner fits the phone viewport, no horizontal scroll", await fitsViewport(page, banner.getByRole("button", { name: "Install App" })));
        await banner.getByRole("button", { name: "Install App" }).click();
      } else {
        await page.getByRole("button", { name: "Install", exact: true }).click();
      }
      await page.waitForFunction(() => window.__prompted === 1, null, { timeout: 5000 }).catch(() => null);
      check(`[${surface}] opens the browser's own install dialog (same prompt())`, await page.evaluate(() => window.__prompted === 1));
      await sleep(500);
      check(`[${surface}] after install BOTH CTAs disappear`, (await installBanner(page).count()) === 0 && (await installCard(page).count()) === 0);
      await ctx.close();
    }
    for (const device of ["iPhone SE", "Galaxy S8"]) {
      const ctx = await newContext(browser, { token: F.token, device });
      await ctx.addInitScript(standInPrompt);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await installBanner(page).waitFor({ timeout: 15000 }).catch(() => null);
      const vw = await page.evaluate(() => window.innerWidth);
      check(`${device} (${vw}px): banner + Install App button fit, no horizontal scroll`, await fitsViewport(page, installBanner(page).getByRole("button", { name: "Install App" })));
      await ctx.close();
    }

    // Installed app: (display-mode: standalone) matches → no CTA anywhere.
    {
      const app = await newContext(browser, { token: F.token, device: "Pixel 7" });
      await app.addInitScript(() => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? real("(min-width: 0px)") : real(q));
        window.addEventListener("load", () => {
          const e = new Event("beforeinstallprompt", { cancelable: true });
          e.prompt = async () => {};
          e.userChoice = Promise.resolve({ outcome: "dismissed" });
          window.dispatchEvent(e);
        });
      });
      const ap = await app.newPage();
      await ap.goto(`${BASE}/student/dashboard`);
      await sleep(1500);
      check("installed (standalone) app: dashboard renders", /\/student\/dashboard$/.test(ap.url()));
      check("installed (standalone) app: no upper banner", (await installBanner(ap).count()) === 0);
      check("installed (standalone) app: no install card", (await installCard(ap).count()) === 0);
      await ap.getByRole("button", { name: "Toggle menu" }).tap();
      check("installed (standalone) app: no install menu item", (await ap.getByRole("button", { name: "Install MockTestSeries" }).count()) === 0);
      await app.close();
    }

    console.log("\n--- Logout with the worker active (second fixture student) ---");
    {
      const ctx = await newContext(browser, { token: F.malToken, device: "Pixel 7" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await swReady(page);
      await page.reload();
      check("signed in before logout", /\/student\/dashboard$/.test(page.url()), page.url());

      // Real logout through the UI, then protected access must be gone.
      await page.getByRole("button", { name: "Account menu" }).click();
      await page.getByRole("menuitem", { name: "Logout" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/student/dashboard"), { timeout: 15000 });
      await page.goto(`${BASE}/student/dashboard`);
      check("after logout /student/dashboard → /login", /\/login\?callbackUrl=/.test(page.url()), page.url());
      const apiAfter = await page.evaluate(async () => (await fetch("/student/dashboard", { redirect: "manual" })).type);
      check("after logout a direct dashboard fetch is redirected, not served from a cache", apiAfter === "opaqueredirect", apiAfter);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- iPhone: Add to Home Screen guidance (no fake install prompt) ---");
    {
      const ctx = await newContext(browser, { token: F.token, device: "iPhone 14" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await installBanner(page).waitFor({ timeout: 15000 }).catch(() => null);
      check("iOS: upper banner + lower card shown", (await installBanner(page).count()) === 1 && (await installCard(page).count()) === 1);
      check("iOS: no programmatic Install button", (await page.getByRole("button", { name: "Install", exact: true }).count()) === 0);
      check("iOS: upper banner fits, no horizontal scroll", await fitsViewport(page, installBanner(page).getByRole("button", { name: "Install App" })));
      await installBanner(page).getByRole("button", { name: "Install App" }).tap();
      check("iOS upper banner: shows Share → Add to Home Screen steps", /Add to Home Screen/.test(await installBanner(page).innerText()));
      await page.getByRole("button", { name: "How to install" }).tap();
      check("iOS lower card: shows the same steps", (await page.getByText("Add to Home Screen").count()) === 2);
      await installBanner(page).getByRole("button", { name: "Not now" }).tap();
      await sleep(300);
      check("Not now on the banner hides BOTH dashboard CTAs", (await installBanner(page).count()) === 0 && (await installCard(page).count()) === 0);
      await page.reload();
      await sleep(1500);
      check("shared dismissal remembered after reload (both hidden)", (await installBanner(page).count()) === 0 && (await installCard(page).count()) === 0);
      await page.getByRole("button", { name: "Toggle menu" }).tap();
      check("mobile menu still offers Install MockTestSeries", (await page.getByRole("button", { name: "Install MockTestSeries" }).count()) === 1);
      await ctx.close();
    }
    {
      // Dismissing from the lower card hides the upper banner too.
      const ctx = await newContext(browser, { token: F.token, device: "iPhone 14" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await installBanner(page).waitFor({ timeout: 15000 }).catch(() => null);
      await page.getByRole("button", { name: /Not now/ }).last().tap();
      await sleep(300);
      check("Not now on the card hides BOTH dashboard CTAs", (await installBanner(page).count()) === 0 && (await installCard(page).count()) === 0);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    if (SIGNAL_DIR) {
      console.log("\n--- Update: new deploy while a student is mid-test ---");
      const ctx = await newContext(browser, { token: F.token });
      const dash = await ctx.newPage();
      await dash.goto(`${BASE}/student/dashboard`);
      await swReady(dash);
      await dash.reload();
      const before = await dash.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("mts-static-")));

      const run = await ctx.newPage();
      await run.goto(`${BASE}/student/attempt/${F.subjectAttemptId}/run`);
      await run.waitForSelector("[data-testid=test-player]");
      await run.locator('[data-testid=option][data-label="C"]').click();
      await run.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
      await run.evaluate(() => (window.__notReloaded = true));
      const timerBefore = await run.locator("[data-testid=timer]").innerText().catch(() => null);

      fs.writeFileSync(path.join(SIGNAL_DIR, "ready-for-rebuild"), "");
      console.log("  info  waiting for the rebuilt server…");
      while (!fs.existsSync(path.join(SIGNAL_DIR, "rebuilt"))) await sleep(2000);

      for (const p of [dash, run]) await p.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
      await dash.waitForSelector("text=New version available", { timeout: 20000 }).then(
        () => check("dashboard: 'New version available — Update' shown", true),
        () => check("dashboard: 'New version available — Update' shown", false)
      );
      await sleep(1500);
      check("Test Player: no update banner mid-test", (await run.getByText("New version available").count()) === 0);
      check("new worker waits (old one still controls)", await dash.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting));

      const reloaded = dash.waitForEvent("load", { timeout: 20000 });
      await dash.getByRole("button", { name: "Update" }).click();
      await reloaded.then(() => check("Update reloads the dashboard onto the new version", true), () => check("Update reloads the dashboard onto the new version", false));
      await sleep(1500);
      const after = await dash.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("mts-static-")));
      check("old build's static cache removed, new one in use", before.length === 1 && !after.includes(before[0]), { before, after });
      check("dashboard renders after update", /\/student\/dashboard$/.test(dash.url()) && (await dash.locator("main").count()) > 0);

      check("Test Player was NOT reloaded by the update", await run.evaluate(() => window.__notReloaded === true));
      check("Test Player answer C still selected", await run.locator('[data-testid=option][data-label="C"] input').isChecked());
      if (timerBefore) check("Test Player timer still running", (await run.locator("[data-testid=timer]").innerText()) !== timerBefore);
      await run.getByRole("button", { name: /Save & Next/ }).click();
      await run.locator('[data-testid=option][data-label="A"]').click();
      await run.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 }).then(
        () => check("Test Player keeps saving answers after the switch", true),
        () => check("Test Player keeps saving answers after the switch", false)
      );
      await run.getByRole("button", { name: "Submit Test" }).first().click();
      await run.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
      await run.waitForURL(/\/result$/, { timeout: 20000 }).then(() => check("submit → result after the update", true), () => check("submit → result after the update", false));
      const reviewRes = await run.goto(run.url().replace(/\/result$/, "/review"));
      check("review page opens", reviewRes.status() === 200 && /\/review$/.test(run.url()));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL PWA CHECKS PASSED" : `\n${failures} PWA CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
