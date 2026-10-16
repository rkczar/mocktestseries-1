/**
 * Browser/HTTP verification: Premium Unlock buttons, the dashboard
 * "Upgrade to Premium" card, the locked answer review (direct URL, refresh,
 * raw HTML, Ask AI Server Action, Saved Questions, ownership) and the PWA
 * Install App CTA (native prompt, manual steps, installed states).
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/premium-conversion-fixture.ts setup > <dir>/pcqa.json
 *   BASE=http://localhost:3311 FIXTURE=<dir>/pcqa.json DATABASE_URL=<scratch *premium*> SHOTS=<dir> \
 *     ACTION_MANIFEST=.next/server/server-reference-manifest.json NODE_PATH=<dir with playwright> node scripts/verify-premium-conversion-ui.mjs
 *
 * Read-only against the fixture except: the dashboard layout setting (via
 * the fixture's `layout` command, restored to default at the end).
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://localhost:3311";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? null;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail)}` : ""}`);
};
const fixture = (...args) =>
  execFileSync("npx", ["tsx", "scripts/premium-conversion-fixture.ts", ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim();
const shot = async (page, name, fullPage = false) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
};
const section = (key, title) => {
  const run = !ONLY || ONLY.has(key);
  if (run) console.log(title);
  return run;
};

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  firefoxDesktop: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
};
const MOBILE = { width: 390, height: 844 };

async function studentContext(browser, persona, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...opts });
  await ctx.addCookies([{ name: "student-session-token", value: F.tokens[persona], url: BASE }]);
  return ctx;
}
/** Raw server HTML (not the hydrated DOM), fetched from inside the page with its cookies. */
const rawHtml = (page, path) => page.evaluate((u) => fetch(u, { credentials: "include" }).then(async (r) => ({ status: r.status, text: await r.text() })), path);
const hasMarker = (text, prefix) => /PCQA(PAID|FREE)(QTEXT|CORRECT|EXPLAIN)/.test(text) && text.includes(prefix);

// Server Action id of getExplanationAction (app/student/ai-actions.ts), for a direct call.
// It must be POSTed to a page that registers it (review / saved / run).
function explanationActionId() {
  const m = JSON.parse(fs.readFileSync(process.env.ACTION_MANIFEST ?? ".next/server/server-reference-manifest.json", "utf8"));
  for (const [id, entry] of Object.entries(m.node ?? {})) if (entry.exportedName === "getExplanationAction") return id;
  return null;
}
const callExplanation = (page, actionId, questionId, attemptId) =>
  page.evaluate(
    async ([id, q, a]) => {
      const r = await fetch(location.pathname, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify([q, a]) });
      return { status: r.status, text: await r.text() };
    },
    [actionId, questionId, attemptId]
  );

// The fixture just rewrote the policy row; let the server's 5s policy cache expire first.
await new Promise((r) => setTimeout(r, 6000));
const browser = await chromium.launch();
try {
  if (section("A", "A. Premium Unlock button (Bug A)")) {
    const card = (page, title) => page.locator("section[aria-labelledby=previous-year-papers] div.h-full", { hasText: title }).first();
    const popup = (page) => page.locator("[data-testid=trial-popup]");
    {
      const ctx = await studentContext(browser, "free");
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      const paidCard = card(page, "PCQA MO 2020");
      const freeCard = card(page, "PCQA MO 2024");
      await paidCard.waitFor({ timeout: 15000 });
      check("Free 2024 paper card is unlocked (Review / Reattempt, no lock)", (await freeCard.locator("text=Reattempt").count()) === 1 && (await freeCard.locator("text=Premium").count()) === 0);
      const unlock = paidCard.locator("a", { hasText: "Unlock" });
      check("Premium 2020 paper shows an Unlock link", (await unlock.count()) === 1);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await unlock.click();
      const opened = await popup(page).waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
      check("Trial unused: Unlock opens the trial / Premium options (not a dead click)", opened && (await popup(page).getAttribute("data-state-kind")) === "WELCOME");
      const buy = popup(page).locator("a", { hasText: "Buy Premium Now" });
      check("…with Buy Premium Now → the Premium plan checkout", (await buy.getAttribute("href").catch(() => null)) === `/student/checkout/${F.premium.code}`);
      await shot(page, "A-unlock-popup");
      await page.keyboard.press("Escape");
      await popup(page).waitFor({ state: "hidden", timeout: 5000 }).catch(() => undefined);
      await unlock.click();
      check("Second Unlock click (already at ?premium=locked) opens it again", await popup(page).waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false));
      await buy.click();
      await page.waitForURL((u) => u.pathname.startsWith("/student/checkout"), { timeout: 10000 }).catch(() => undefined);
      check("Buy Premium Now lands on the Premium checkout", new URL(page.url()).pathname === `/student/checkout/${F.premium.code}`, page.url());
      const body = await page.locator("body").innerText().catch(() => "");
      check("Checkout shows the selected Premium plan", body.includes("PCQA Complete Mock Test Series"), body.slice(0, 200));
      await shot(page, "A-checkout");
      await ctx.close();
    }
    {
      const ctx = await studentContext(browser, "trialExpired");
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      const unlock = card(page, "PCQA MO 2020").locator("a", { hasText: "Unlock" });
      await unlock.waitFor({ timeout: 15000 });
      check("Trial used: Unlock links straight to the Premium plan checkout", (await unlock.getAttribute("href")) === `/student/checkout/${F.premium.code}`);
      await unlock.click();
      await page.waitForURL((u) => u.pathname.startsWith("/student/checkout"), { timeout: 10000 }).catch(() => undefined);
      check("…and clicking it opens that checkout", new URL(page.url()).pathname === `/student/checkout/${F.premium.code}`, page.url());
      await ctx.close();
    }
    {
      const ctx = await studentContext(browser, "ineligible");
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      const unlock = card(page, "PCQA MO 2020").locator("a", { hasText: "Unlock" });
      await unlock.waitFor({ timeout: 15000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await unlock.click();
      await page.waitForURL((u) => u.pathname === "/plans-and-pricing", { timeout: 10000 }).catch(() => undefined);
      check("Trial not available (mobile already used): Unlock falls back to Plans & Pricing", new URL(page.url()).pathname === "/plans-and-pricing", page.url());
      await ctx.close();
    }

    const pctx = await studentContext(browser, "paid");
    const pp = await pctx.newPage();
    await pp.goto(`${BASE}/student/checkout/${F.premium.code}`);
    const ptxt = await pp.locator("body").innerText();
    check("Active paid student on checkout: no repurchase offered", !/Buy Now|Pay ₹/i.test(ptxt) || /Active|already/i.test(ptxt), ptxt.slice(0, 300));
    await pp.goto(`${BASE}/student/dashboard`);
    const ppaid = pp.locator("section[aria-labelledby=previous-year-papers] div.h-full", { hasText: "PCQA MO 2020" }).first();
    await ppaid.waitFor();
    check("Paid student: Premium paper has no Unlock", (await ppaid.locator("a", { hasText: "Unlock" }).count()) === 0);
    await pctx.close();
  }

  if (section("B", "B. Dashboard Upgrade to Premium card (Bug B)")) {
    for (const [persona, want, textHas] of [
      ["free", true, "Free plan"],
      ["trialActive", true, "free trial is active until"],
      ["trialExpired", true, "free trial has ended"],
      ["paidExpired", true, "Complete Access has expired"],
      ["paid", false, null],
    ]) {
      const ctx = await studentContext(browser, persona);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await page.locator("h1", { hasText: "Welcome back" }).waitFor();
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const banners = page.locator("[data-testid=upgrade-banner]");
      const n = await banners.count();
      check(`${persona}: ${want ? "exactly one" : "no"} Upgrade to Premium card`, n === (want ? 1 : 0), n);
      if (want && n === 1) {
        const text = await banners.innerText();
        check(`${persona}: copy matches state ("${textHas}")`, text.includes(textHas) && text.includes("Upgrade to Premium"), text);
        check(`${persona}: no countdown / urgency wording`, !/\b(hurry|only \d+ left|ends in|\d+:\d\d:\d\d)\b/i.test(text), text);
        const cta = banners.locator("a", { hasText: "Get Complete Access" });
        check(`${persona}: Get Complete Access → Plans & Pricing`, (await cta.getAttribute("href")) === "/plans-and-pricing");
        const perf = page.locator("#performance-summary, h2:has-text('Performance Summary')").first();
        const [b, p] = [await banners.boundingBox(), await perf.boundingBox().catch(() => null)];
        check(`${persona}: card sits above Performance Summary`, Boolean(b && p && b.y < p.y), { b, p });
        const pitches = await page.locator("text=Upgrade to Complete Access").count();
        check(`${persona}: Access & Subscription shows status only (one upgrade pitch per page)`, pitches === 0 && (await page.locator("text=Renew Access").count()) === 0, pitches);
        if (persona === "free") {
          check("free: Access & Subscription status strip still present", (await page.locator("text=FREE ACCESS").count()) > 0);
          await shot(page, "B-dashboard-free", true);
          await cta.click();
          await page.waitForURL(/\/plans-and-pricing/, { timeout: 10000 }).catch(() => undefined);
          check("CTA opens Plans & Pricing", new URL(page.url()).pathname === "/plans-and-pricing", page.url());
          const buy = page.locator(`a[href="/student/checkout/${F.premium.code}"]`).first();
          check("Plans & Pricing offers the Premium plan's checkout", (await buy.count()) > 0);
        }
      }
      await ctx.close();
    }
    {
      const ctx = await studentContext(browser, "paid");
      const page = await ctx.newPage();
      await page.goto(`${BASE}/plans-and-pricing`);
      check("Paid student on Plans & Pricing: plan shows Active Plan", (await page.locator("text=Active Plan").count()) > 0);
      await ctx.close();
    }
    fixture("layout", "prod-like");
    {
      const ctx = await studentContext(browser, "trialExpired", { viewport: MOBILE, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await page.locator("h1", { hasText: "Welcome back" }).waitFor();
      const banner = page.locator("[data-testid=upgrade-banner]");
      check("Production-like saved layout: card still appears (anchored near the top)", (await banner.count()) === 1);
      const access = page.locator("text=FREE ACCESS").first();
      const [b, a] = [await banner.boundingBox().catch(() => null), await access.boundingBox().catch(() => null)];
      check("…well above the bottom Access & Subscription block", Boolean(b && (!a || b.y < a.y)), { b, a });
      check("Mobile 390px: no horizontal scroll", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      const box = await banner.boundingBox().catch(() => null);
      check("Mobile: card fits inside the viewport width", Boolean(box && box.x >= 0 && box.x + box.width <= MOBILE.width), box);
      await shot(page, "B-dashboard-mobile-prodlayout");
      await ctx.close();
    }
    fixture("layout", "upgrade-hidden");
    {
      const ctx = await studentContext(browser, "free");
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await page.locator("h1", { hasText: "Welcome back" }).waitFor();
      check("Admin hid Upgrade to Premium: card gone", (await page.locator("[data-testid=upgrade-banner]").count()) === 0);
      check("…and the full Access & Subscription upgrade card is back", (await page.locator("text=Upgrade to Complete Access").count()) === 1);
      await ctx.close();
    }
    fixture("layout", "default");
  }

  if (section("C", "C. Premium review after trial expiry (Bug C)")) {
    const actionId = explanationActionId();
    const ctx = await studentContext(browser, "trialExpired");
    const page = await ctx.newPage();
    const paidReview = `/student/attempt/${F.attempts.trialExpiredPaid}/review`;
    const resp = await page.goto(`${BASE}${paidReview}`);
    check("Direct URL to the Premium review: page loads (no crash / redirect loop)", resp?.status() === 200, resp?.status());
    check("…shows 'Answer review needs Premium access'", (await page.locator("[data-testid=review-locked]").count()) === 1);
    const lockedLink = page.locator("[data-testid=review-locked] a", { hasText: "Get Complete Access" });
    check("…offers Get Complete Access → Premium checkout", (await lockedLink.getAttribute("href").catch(() => null)) === `/student/checkout/${F.premium.code}`);
    await shot(page, "C-review-locked");
    const raw = await rawHtml(page, paidReview);
    check("Raw HTML of the locked review carries NO Premium question text / answer / explanation", !hasMarker(raw.text, "PCQAPAID"), raw.text.match(/PCQAPAID\w+/)?.[0]);
    await page.reload();
    check("Refresh: still locked", (await page.locator("[data-testid=review-locked]").count()) === 1);
    await page.goto(`${BASE}/student/attempt/${F.attempts.trialExpiredPaid}/result`);
    const resultText = await page.locator("body").innerText();
    check("Result summary still available (score shown)", /out of \d+/.test(resultText) && resultText.includes("Correct"), resultText.slice(0, 200));
    check("Result page swaps Review Answers for Unlock Answer Review", (await page.locator("[data-testid=review-unlock]").count()) === 1 && (await page.locator("a", { hasText: "Review Answers" }).count()) === 0);
    await page.goto(`${BASE}${paidReview}`);
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForURL((u) => u.pathname === paidReview, { timeout: 10000 }).catch(() => undefined);
    await page.locator("h1, [data-testid=review-locked]").first().waitFor({ timeout: 10000 }).catch(() => undefined);
    check("Back/forward navigation: still locked", (await page.locator("[data-testid=review-locked]").count()) === 1 && (await page.locator("text=PCQAPAIDCORRECT4").count()) === 0);
    const freeRaw = await rawHtml(page, `/student/attempt/${F.attempts.trialExpiredFree}/review`);
    check("Free 2024 paper review still shows its answers", freeRaw.status === 200 && freeRaw.text.includes("PCQAFREECORRECT"));
    if (actionId) {
      const ai = await callExplanation(page, actionId, F.questions.paid[0], F.attempts.trialExpiredPaid);
      check("Ask AI Server Action for a Premium question → refused with the Premium message", ai.text.includes("needs Premium access") && !ai.text.includes("PCQAPAID"), ai.text.slice(-300));
      const ai2 = await callExplanation(page, actionId, F.questions.paid[0], undefined);
      check("Ask AI without an attempt id → also refused", ai2.text.includes("needs Premium access"), ai2.text.slice(-300));
    } else check("getExplanationAction id found in the server action manifest", false);
    const saved = await rawHtml(page, "/student/saved");
    check("Saved Questions: Premium question content withheld in raw HTML", saved.status === 200 && !hasMarker(saved.text, "PCQAPAID") && saved.text.includes("This question is from a Premium test"), saved.text.match(/PCQAPAID\w+/)?.[0]);
    check("Saved Questions: free question still shows its answer", saved.text.includes("PCQAFREECORRECT1"));
    await page.goto(`${BASE}/student/saved`);
    await shot(page, "C-saved-locked");
    await ctx.close();

    for (const persona of ["trialActive", "paid"]) {
      const c = await studentContext(browser, persona);
      const p = await c.newPage();
      await p.goto(`${BASE}/student/saved`);
      const key = persona === "paid" ? "paidPaid" : "trialActivePaid";
      const r = await rawHtml(p, `/student/attempt/${F.attempts[key]}/review`);
      check(`${persona}: Premium review shows answers + explanation`, r.status === 200 && r.text.includes("PCQAPAIDCORRECT") && r.text.includes("PCQAPAIDEXPLAIN"));
      if (actionId) {
        const ai = await callExplanation(p, actionId, F.questions.paid[0], F.attempts[key]);
        check(`${persona}: Ask AI not refused for Premium reasons`, !ai.text.includes("needs Premium access"), ai.text.slice(-200));
      }
      await c.close();
    }
    {
      const c = await studentContext(browser, "paidExpired");
      const p = await c.newPage();
      await p.goto(`${BASE}/student/attempt/${F.attempts.paidExpiredPaid}/review`);
      check("Expired paid plan: Premium review locked", (await p.locator("[data-testid=review-locked]").count()) === 1);
      await c.close();
    }
    {
      const c = await studentContext(browser, "other");
      const p = await c.newPage();
      await p.goto(`${BASE}/student/saved`);
      for (const key of ["paidPaid", "trialExpiredPaid"]) {
        for (const sub of ["review", "result"]) {
          const r = await rawHtml(p, `/student/attempt/${F.attempts[key]}/${sub}`);
          check(`Other student → ${key} ${sub}: 404 and no content`, r.status === 404 && !r.text.includes("PCQAPAID"), r.status);
        }
      }
      if (actionId) {
        const ai = await callExplanation(p, actionId, F.questions.paid[0], F.attempts.paidPaid);
        check("Other student: Ask AI with someone else's attempt id refused", /Ask AI is available|needs Premium/.test(ai.text) && !ai.text.includes("PCQAPAID"), ai.text.slice(-200));
      }
      await c.close();
    }
  }

  if (section("D", "D. PWA Install App (Bug D)")) {
    for (const [path, type] of [["/manifest.webmanifest", "manifest"], ["/sw.js", "javascript"], ["/icons/icon-192.png", "png"], ["/icons/icon-512.png", "png"], ["/icons/maskable-512.png", "png"]]) {
      const r = await fetch(`${BASE}${path}`);
      check(`${path} served (200, ${type})`, r.status === 200 && (r.headers.get("content-type") ?? "").includes(type), r.status);
    }
    // A fake install event, fired after the head capture script is registered.
    // Like a real browser, it is not fired again once the app is installed (sessionStorage "pcqa-installed").
    const fakePrompt = `document.addEventListener("DOMContentLoaded",()=>{if(sessionStorage.getItem("pcqa-installed"))return;const e=new Event("beforeinstallprompt",{cancelable:true});window.__prompted=0;e.prompt=async()=>{window.__prompted++};e.userChoice=Promise.resolve({outcome:window.__accept?"accepted":"dismissed"});window.dispatchEvent(e)});`;
    const dash = async (opts, init = []) => {
      const ctx = await studentContext(browser, "free", opts);
      for (const s of init) await ctx.addInitScript(s);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/student/dashboard`);
      await page.locator("h1", { hasText: "Welcome back" }).waitFor();
      await page.waitForTimeout(800);
      return { ctx, page, banner: page.locator("[role=region][aria-label='Install MockTestSeries App']") };
    };
    {
      const { ctx, page, banner } = await dash({}, [fakePrompt]);
      check("Native prompt available: Install App banner shown", (await banner.count()) === 1);
      check("…the browser dialog is never opened by itself", (await page.evaluate(() => window.__prompted)) === 0);
      await banner.locator("button", { hasText: "Install App" }).click();
      await page.waitForTimeout(300);
      check("Click → the browser's own install prompt", (await page.evaluate(() => window.__prompted)) === 1);
      check("…no success claimed without appinstalled", (await page.locator("[data-testid=install-done]").count()) === 0);
      await page.waitForTimeout(300);
      const stays = (await banner.count()) === 1;
      check("Prompt dismissed: CTA stays (no longer disappears)", stays);
      if (stays) await banner.locator("button", { hasText: "Install App" }).click();
      check("…and now shows manual desktop steps", (await page.locator("[data-testid=install-steps][data-platform=desktop]").count()) === 1);
      await shot(page, "D-desktop-steps");
      await page.evaluate(() => {
        sessionStorage.setItem("pcqa-installed", "1");
        window.dispatchEvent(new Event("appinstalled"));
      });
      await page.waitForTimeout(300);
      check("appinstalled → 'MockTestSeries is installed' confirmation", (await page.locator("[data-testid=install-done]").count()) >= 1);
      await page.reload();
      await page.locator("h1", { hasText: "Welcome back" }).waitFor();
      await page.waitForTimeout(800);
      check("After install (flag stored): no Install CTA in the browser tab", (await banner.count()) === 0);
      await ctx.close();
    }
    {
      const { ctx, page, banner } = await dash({}, ["window.__accept=true;", fakePrompt]);
      await banner.locator("button", { hasText: "Install App" }).click();
      await page.waitForTimeout(500);
      check("Prompt accepted: CTA steps aside while the browser installs", (await banner.count()) === 0);
      check("…but no success is claimed before appinstalled", (await page.locator("[data-testid=install-done]").count()) === 0);
      await ctx.close();
    }
    for (const [name, ua, platform] of [["Android Chrome (no install event)", UA.android, "android"], ["Samsung Internet", UA.samsung, "samsung"], ["iOS Safari", UA.ios, "ios"]]) {
      const { ctx, page, banner } = await dash({ viewport: MOBILE, isMobile: true, hasTouch: true, userAgent: ua });
      check(`${name}: Install App shown`, (await banner.count()) === 1);
      if ((await banner.count()) === 1) {
        await banner.locator("button", { hasText: "Install App" }).click();
        check(`${name}: manual steps for this browser`, (await page.locator(`[data-testid=install-steps][data-platform=${platform}]`).count()) === 1);
        check(`${name}: no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        await shot(page, `D-${platform}-steps`);
      }
      await ctx.close();
    }
    {
      const { ctx, banner } = await dash({ userAgent: UA.firefoxDesktop });
      check("Desktop Firefox (cannot install): no Install CTA", (await banner.count()) === 0);
      await ctx.close();
    }
    {
      const standalone = `(()=>{const m=window.matchMedia.bind(window);window.matchMedia=(q)=>q.includes("display-mode: standalone")?{matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},onchange:null,dispatchEvent(){return false}}:m(q)})();`;
      const { ctx, banner } = await dash({ viewport: MOBILE, isMobile: true, userAgent: UA.android }, [standalone]);
      check("Running as the installed app (standalone): no Install CTA", (await banner.count()) === 0);
      await ctx.close();
    }
    {
      const { ctx, page, banner } = await dash({ viewport: MOBILE, isMobile: true, userAgent: UA.android }, [`try{localStorage.setItem("mts-app-installed","1")}catch(e){}`]);
      check("Installed earlier from this browser: no Install CTA", (await banner.count()) === 0);
      await ctx.close();
      void page;
    }
    {
      const { ctx, page, banner } = await dash({}, [`try{localStorage.setItem("mts-app-installed","1")}catch(e){}`, fakePrompt]);
      check("Browser offers install again (app was uninstalled): CTA returns", (await banner.count()) === 1);
      check("…and the stale installed flag is cleared", (await page.evaluate(() => localStorage.getItem("mts-app-installed"))) === null);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
