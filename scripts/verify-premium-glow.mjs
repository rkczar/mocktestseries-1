/**
 * Premium Glow Effects — real browser verification (Admin → Settings → Glow
 * Effects → the student UI).
 *
 * Drives a LOCAL production build on a DISPOSABLE database seeded with
 * scripts/ai-actions-ux-fixture.ts (students + cached AI content) and
 * `scripts/verify-premium-glow.ts setup` (FULL_ADMIN + WhatsApp share on):
 *  - admin UI: defaults, live preview of color / intensity / speed / ON-OFF
 *    BEFORE saving, presets, invalid HEX blocked, Save → refresh persists,
 *    Reset to Default;
 *  - student review page: the five targets read the saved color/speed;
 *    master OFF and each target OFF stop exactly those glows while every
 *    button keeps working (Ask AI, AI Question Variant, WhatsApp link, theme
 *    cycle, A+ text size); reduced motion always stills the glow; light /
 *    dark / eye-saver, desktop + phone, no sideways scroll;
 *  - RBAC: FULL_ADMIN sees a read-only form and its raw Server Action call
 *    is refused; an anonymous call is refused; DB unchanged;
 *  - review fix: a SUBMITTED attempt's review opens Ask AI even while a
 *    second, running attempt contains the same question (the old message
 *    "Ask AI is available once you've submitted this test." never shows).
 *
 *   BASE=http://localhost:3121 FIXTURE=aiux.json GLOW_FIXTURE=glow.json \
 *   ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-premium-glow.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");

const BASE = process.env.BASE || "http://localhost:3121";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const G = JSON.parse(fs.readFileSync(process.env.GLOW_FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS || null;
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to inspect what looks like the production database.");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const actionId = (name, pageHint) =>
  Object.entries(manifest.node).find(([, v]) => v.exportedName === name && Object.keys(v.workers).some((w) => w.includes(pageHint)))?.[0];
const SAVE_ID = actionId("saveGlowEffectsAction", "admin/(dashboard)/settings");
const EXPLAIN_ID = actionId("getExplanationAction", "student/attempt/[attemptId]/review");

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
const psql = (sql) => execFileSync("psql", [process.env.DATABASE_URL.split("?")[0], "-Atc", sql], { encoding: "utf8" }).trim();
const storedGlow = () => {
  const v = psql(`select value from "Setting" where key='ui.premium_glow'`);
  return v ? JSON.parse(v) : null;
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const TARGETS = ["ASK_AI", "AI_QUESTION_VARIANT", "WHATSAPP_SHARE", "THEME_TOGGLE", "TEXT_SIZE"];
const DEFAULTS = {
  enabled: true,
  targets: Object.fromEntries(TARGETS.map((t) => [t, true])),
  color: "#9592FA",
  intensity: "MEDIUM",
  speed: "NORMAL",
};
const STUDENT_SEL = {
  ASK_AI: "[data-testid=ask-ai-button]",
  AI_QUESTION_VARIANT: "[data-testid=ai-variant-button]",
  WHATSAPP_SHARE: '[data-glow-target="WHATSAPP_SHARE"]',
  THEME_TOGGLE: '[data-glow-target="THEME_TOGGLE"]',
  TEXT_SIZE: '[data-glow-target="TEXT_SIZE"]',
};
const PREVIEW_SEL = Object.fromEntries(TARGETS.map((t) => [t, `[data-testid=glow-preview] [data-preview-target="${t}"]`]));

/** Computed glow state of every element matching each selector. */
function glowState(page, selectors) {
  return page.evaluate((selectors) => {
    const out = {};
    for (const [k, sel] of Object.entries(selectors)) {
      out[k] = [...document.querySelectorAll(sel)].map((el) => {
        const cs = getComputedStyle(el);
        return {
          name: cs.animationName,
          duration: cs.animationDuration,
          color: cs.getPropertyValue("--pg-c").trim().toUpperCase(),
          rest: cs.getPropertyValue("--premium-glow-rest").trim(),
          blur: cs.getPropertyValue("--premium-glow-blur").trim(),
          boxShadow: cs.boxShadow,
        };
      });
    }
    return out;
  }, selectors);
}
const allGlow = (s, t, pred) => s[t].length > 0 && s[t].every(pred);
const running = (g) => g.name === "premium-glow" && g.rest !== "0%";
const stopped = (g) => g.name === "none" && g.rest === "0%";

async function adminLogin(browser, user, pass, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pass);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  return { ctx, page };
}
async function openGlowTab(page) {
  await page.goto(`${BASE}/admin/settings?tab=glow-effects`);
  await page.waitForSelector("[data-testid=glow-preview]");
}
/** The real admin Server Action, called from the signed-in admin page (in-page fetch keeps its cookies). */
function rawSave(page, config) {
  return page.evaluate(
    async ({ id, config }) => {
      const r = await fetch(location.pathname + location.search, {
        method: "POST",
        headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" },
        body: JSON.stringify([config]),
      });
      return { status: r.status, body: (await r.text()).slice(0, 400) };
    },
    { id: SAVE_ID, config }
  );
}

async function studentContext(browser, token, { device = "desktop", theme, reducedMotion } = {}) {
  const opts = device === "phone" ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } };
  if (reducedMotion) opts.reducedMotion = reducedMotion;
  const ctx = await browser.newContext(opts);
  const cookies = [{ name: "student-session-token", value: token, url: BASE }];
  if (theme) cookies.push({ name: "mts-theme", value: theme, url: BASE });
  await ctx.addCookies(cookies);
  return ctx;
}
async function studentPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return page;
}
async function startPractice(page) {
  await page.goto(`${BASE}/student/test-series/${F.mockId}`);
  await page.waitForSelector("[data-testid=pre-test-setup]");
  await page.locator('input[name="answerMode"][value="INSTANT"]').check();
  await page.getByRole("button", { name: /Start Test|Practice Again/ }).click();
  await page.waitForURL(/\/run$/, { timeout: 30000 });
  await page.waitForSelector("[data-testid=test-player]");
  return page.url().split("/attempt/")[1].split("/")[0];
}
async function answerFirst(page) {
  await page.locator(`[data-testid=option][data-label="${F.keys[0]}"]`).click();
  await page.waitForSelector("[data-testid=reveal-result]", { timeout: 15000 });
}
async function submit(page) {
  await page.getByRole("button", { name: "Submit Test" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await page.waitForURL(/\/result$/, { timeout: 30000 });
}
async function openReview(page, attemptId) {
  await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
  await page.waitForSelector("[data-testid=ask-ai-button]");
  await page.waitForSelector('[data-glow-target="WHATSAPP_SHARE"]');
}

async function main() {
  check("Server Action ids found in the build manifest", !!SAVE_ID && !!EXPLAIN_ID, { SAVE_ID, EXPLAIN_ID });
  psql(`delete from "Setting" where key='ui.premium_glow'`);
  // Re-runnable: drop this student's earlier fixture attempts (scratch DB only).
  psql(`delete from "TestAttempt" where "studentId"='${F.students.fresh}'`);
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------
    console.log("\n--- 1. Student: submitted attempt + a second RUNNING attempt with the same questions ---");
    const sctx = await studentContext(browser, F.tokens.fresh);
    const sp = await studentPage(sctx);
    const submittedId = await startPractice(sp);
    await answerFirst(sp);
    await submit(sp);
    const runningId = await startPractice(sp);
    check("second attempt is IN_PROGRESS in the DB", psql(`select status from "TestAttempt" where id='${runningId}'`) === "IN_PROGRESS");

    console.log("\n--- 2. Review fix: submitted review opens Ask AI despite the running attempt ---");
    await openReview(sp, submittedId);
    const legacy = await sp.evaluate(
      async ({ id, q }) => {
        const r = await fetch(location.pathname, { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: JSON.stringify([q]) });
        return r.text();
      },
      { id: EXPLAIN_ID, q: F.questionIds[0] }
    );
    check("without review context the canonical rule still locks it (running attempt) — security rule unchanged", /once you've submitted this test/.test(legacy), legacy.slice(0, 200));
    await sp.getByTestId("ask-ai-button").click();
    await sp.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept", { timeout: 20000 });
    check("review: Ask AI shows the explanation", true);
    check("review: 'Ask AI is available once you've submitted this test.' NOT shown", !/once you've submitted this test/.test(await sp.locator("body").innerText()));
    await sp.getByTestId("ai-variant-button").click();
    await sp.waitForFunction(() => /Practice Question|Variant|Question 1/i.test(document.querySelector("[data-testid=ai-panel]")?.innerText || ""), null, { timeout: 30000 });
    check("review: AI Question Variant opens its panel (no lock message)", !/once you've submitted this test/.test(await sp.locator("[data-testid=ai-panel]").innerText()));
    const student = F.students.fresh;
    const out = execFileSync("npx", ["tsx", "scripts/verify-premium-glow.ts", "reveal", student, submittedId, runningId, F.questionIds[0]], {
      env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
      encoding: "utf8",
    });
    process.stdout.write(out.replace(/\nALL PREMIUM GLOW CHECKS PASSED\n?/, "\n"));
    if (/FAIL/.test(out)) failures++;

    console.log("\n--- 3. Defaults on the student review page (no Setting row yet) ---");
    await openReview(sp, submittedId);
    let s = await glowState(sp, STUDENT_SEL);
    for (const t of TARGETS) check(`default: ${t} glows (#9592FA, 2.5s)`, allGlow(s, t, (g) => running(g) && g.color === "#9592FA" && g.duration === "2.5s"), s[t]);
    check("theme + A+ glow on both header and page controls", s.THEME_TOGGLE.length >= 1 && s.TEXT_SIZE.length >= 1, { theme: s.THEME_TOGGLE.length, a: s.TEXT_SIZE.length });
    await shot(sp, "student-default");

    // ------------------------------------------------------------------
    console.log("\n--- 4. Admin (MASTER_ADMIN): defaults + live preview before saving ---");
    const { ctx: actx, page: ap } = await adminLogin(browser, process.env.ADMIN_USER, process.env.ADMIN_PASS);
    await openGlowTab(ap);
    check("Settings → Glow Effects tab renders", (await ap.getByRole("tab", { name: "Glow Effects" }).getAttribute("data-state")) === "active");
    check("master switch ON", (await ap.locator("#glow-master").getAttribute("data-state")) === "checked");
    for (const t of TARGETS) check(`switch ${t} ON`, (await ap.locator(`#glow-${t}`).getAttribute("data-state")) === "checked");
    check("HEX shows current default #9592FA", (await ap.locator("#glow-hex").inputValue()) === "#9592FA");
    check("Medium + Normal selected", (await ap.getByRole("radio", { name: "Medium", exact: true }).getAttribute("aria-checked")) === "true" && (await ap.getByRole("radio", { name: "Normal", exact: true }).getAttribute("aria-checked")) === "true");
    check("Save disabled until something changes", await ap.getByRole("button", { name: "Save Changes" }).isDisabled());
    let p = await glowState(ap, PREVIEW_SEL);
    for (const t of TARGETS) check(`preview ${t} glowing`, allGlow(p, t, running), p[t]);

    for (const preset of [["Purple", "#9592FA"], ["Blue", "#3B82F6"], ["Cyan", "#06B6D4"], ["Green", "#22C55E"], ["Gold", "#F59E0B"], ["Pink", "#EC4899"]]) {
      await ap.getByRole("button", { name: preset[0], exact: true }).click();
      p = await glowState(ap, PREVIEW_SEL);
      check(`preset ${preset[0]} → HEX ${preset[1]} + preview color`, (await ap.locator("#glow-hex").inputValue()) === preset[1] && allGlow(p, "ASK_AI", (g) => g.color === preset[1]), { hex: await ap.locator("#glow-hex").inputValue(), p: p.ASK_AI });
    }
    check("color picker follows the preset", (await ap.locator('input[type=color]').inputValue()) === "#ec4899");
    await ap.locator("#glow-hex").fill("#12345");
    check("invalid HEX → error + Save disabled", (await ap.getByText("Enter a 6-digit hex color like #8B5CF6.").count()) === 1 && (await ap.getByRole("button", { name: "Save Changes" }).isDisabled()));
    await ap.locator("#glow-hex").fill("#12AB9F");
    p = await glowState(ap, PREVIEW_SEL);
    check("custom HEX #12AB9F → preview + 'Custom color'", allGlow(p, "ASK_AI", (g) => g.color === "#12AB9F") && (await ap.getByText("Custom color").count()) === 1, p.ASK_AI);
    for (const [label, blur] of [["Low", "14px"], ["High", "28px"], ["Medium", "22px"]]) {
      await ap.getByRole("radio", { name: label, exact: true }).click();
      p = await glowState(ap, PREVIEW_SEL);
      check(`intensity ${label} → preview halo ${blur}`, allGlow(p, "ASK_AI", (g) => g.blur === blur), p.ASK_AI);
    }
    for (const [label, dur] of [["Slow", "3.5s"], ["Fast", "1.5s"], ["Normal", "2.5s"]]) {
      await ap.getByRole("radio", { name: label, exact: true }).click();
      p = await glowState(ap, PREVIEW_SEL);
      check(`speed ${label} → preview ${dur}`, allGlow(p, "ASK_AI", (g) => g.duration === dur), p.ASK_AI);
    }
    await ap.locator("#glow-WHATSAPP_SHARE").click();
    p = await glowState(ap, PREVIEW_SEL);
    check("preview: WhatsApp OFF stops only WhatsApp", allGlow(p, "WHATSAPP_SHARE", stopped) && TARGETS.filter((t) => t !== "WHATSAPP_SHARE").every((t) => allGlow(p, t, running)), p);
    await ap.locator("#glow-master").click();
    p = await glowState(ap, PREVIEW_SEL);
    check("preview: master OFF stops all five", TARGETS.every((t) => allGlow(p, t, stopped)), p);
    await ap.locator("#glow-master").click();
    check("nothing saved yet (preview only)", storedGlow() === null);
    await shot(ap, "admin-draft");

    console.log("\n--- 5. Save → refresh admin → student page ---");
    const auditBefore = Number(psql(`select count(*) from "AuditLog" where action='PREMIUM_GLOW_SAVED'`));
    await ap.getByRole("radio", { name: "High", exact: true }).click();
    await ap.getByRole("radio", { name: "Fast", exact: true }).click();
    await ap.getByRole("button", { name: "Save Changes" }).click();
    await ap.waitForSelector("text=Saved. Students see the new glow within a few seconds.");
    let st = storedGlow();
    check("DB: Setting ui.premium_glow saved", st && st.color === "#12AB9F" && st.intensity === "HIGH" && st.speed === "FAST" && st.enabled === true && st.targets.WHATSAPP_SHARE === false, st);
    check("audit log row written", Number(psql(`select count(*) from "AuditLog" where action='PREMIUM_GLOW_SAVED'`)) === auditBefore + 1);
    await openGlowTab(ap);
    check("after refresh: HEX #12AB9F, High, Fast, WhatsApp OFF", (await ap.locator("#glow-hex").inputValue()) === "#12AB9F" && (await ap.getByRole("radio", { name: "High", exact: true }).getAttribute("aria-checked")) === "true" && (await ap.getByRole("radio", { name: "Fast", exact: true }).getAttribute("aria-checked")) === "true" && (await ap.locator("#glow-WHATSAPP_SHARE").getAttribute("data-state")) === "unchecked");
    await openReview(sp, submittedId);
    s = await glowState(sp, STUDENT_SEL);
    for (const t of TARGETS.filter((t) => t !== "WHATSAPP_SHARE")) check(`student: ${t} glows #12AB9F at 1.5s, High halo`, allGlow(s, t, (g) => running(g) && g.color === "#12AB9F" && g.duration === "1.5s" && g.blur === "28px"), s[t]);
    check("student: WhatsApp glow OFF", allGlow(s, "WHATSAPP_SHARE", stopped), s.WHATSAPP_SHARE);
    const wa = sp.locator('[data-glow-target="WHATSAPP_SHARE"]').first();
    const href = await wa.getAttribute("href");
    check("student: WhatsApp still a working share link (wa.me, new tab)", /^https:\/\/(wa\.me|api\.whatsapp\.com)\//.test(href ?? "") && (await wa.getAttribute("target")) === "_blank" && (await wa.isEnabled()), href);
    const [popup] = await Promise.all([sctx.waitForEvent("page", { timeout: 10000 }).catch(() => null), wa.click()]);
    check("student: clicking WhatsApp opens the share tab", !!popup && /wa\.me|whatsapp/.test(popup.url()), popup?.url());
    if (popup) await popup.close();
    await shot(sp, "student-custom");

    console.log("\n--- 6. Master OFF → all five stop, all five still work ---");
    await openGlowTab(ap);
    await ap.locator("#glow-master").click();
    await ap.getByRole("button", { name: "Save Changes" }).click();
    await ap.waitForSelector("text=Saved.");
    check("DB: enabled=false", storedGlow().enabled === false);
    await openReview(sp, submittedId);
    s = await glowState(sp, STUDENT_SEL);
    for (const t of TARGETS) check(`master OFF: ${t} not animating`, allGlow(s, t, stopped), s[t]);
    const theme0 = await sp.evaluate(() => document.documentElement.dataset.theme);
    await sp.locator('[data-glow-target="THEME_TOGGLE"]').first().click();
    const theme1 = await sp.evaluate(() => document.documentElement.dataset.theme);
    check("theme toggle still switches theme", theme0 !== theme1, { theme0, theme1 });
    await sp.locator('[data-glow-target="TEXT_SIZE"]').first().click();
    await sp.getByRole("menuitem").filter({ hasText: /Large/ }).first().click();
    check("A+ still changes text size", (await sp.evaluate(() => document.documentElement.dataset.textSize)) !== "md");
    await sp.getByTestId("ask-ai-button").click();
    await sp.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept", { timeout: 20000 });
    check("Ask AI still works with glow off", true);
    await sp.getByTestId("ai-variant-button").click();
    await sp.waitForSelector("[data-testid=ai-panel]");
    check("AI Question Variant still works with glow off", !/once you've submitted/.test(await sp.locator("body").innerText()));
    check("WhatsApp still a share link with glow off", /wa\.me|whatsapp/.test((await sp.locator('[data-glow-target="WHATSAPP_SHARE"]').first().getAttribute("href")) ?? ""));
    check("no console errors on the review page", sp.errors.length === 0, sp.errors);

    // Section 6 cycled the theme (Night → Eye Saver, single-hue glow by design) and the text size; back to Night/md.
    await sctx.addCookies([{ name: "mts-theme", value: "dark", url: BASE }, { name: "mts-text-size", value: "md", url: BASE }]);
    console.log("\n--- 7. Each individual target OFF (master ON) ---");
    for (const off of TARGETS) {
      const cfg = { ...DEFAULTS, targets: Object.fromEntries(TARGETS.map((t) => [t, t !== off])) };
      const r = await rawSave(ap, cfg);
      await openReview(sp, submittedId);
      s = await glowState(sp, STUDENT_SEL);
      check(`${off} OFF → only ${off} stops`, r.status === 200 && allGlow(s, off, stopped) && TARGETS.filter((t) => t !== off).every((t) => allGlow(s, t, running)), { status: r.status, s });
    }

    console.log("\n--- 8. Presets applied to the student page ---");
    for (const color of ["#3B82F6", "#06B6D4", "#22C55E", "#F59E0B", "#EC4899", "#9592FA"]) {
      await rawSave(ap, { ...DEFAULTS, color });
      await openReview(sp, submittedId);
      s = await glowState(sp, STUDENT_SEL);
      check(`student color ${color}`, TARGETS.every((t) => allGlow(s, t, (g) => g.color === color)), s.ASK_AI);
    }
    for (const [intensity, blur] of [["LOW", "14px"], ["MEDIUM", "22px"], ["HIGH", "28px"]])
      for (const [speed, dur] of [["SLOW", "3.5s"], ["NORMAL", "2.5s"], ["FAST", "1.5s"]]) {
        if (intensity !== "MEDIUM" && speed !== "NORMAL") continue;
        await rawSave(ap, { ...DEFAULTS, intensity, speed });
        await openReview(sp, submittedId);
        s = await glowState(sp, STUDENT_SEL);
        check(`student ${intensity}/${speed} → halo ${blur}, ${dur}`, allGlow(s, "ASK_AI", (g) => g.blur === blur && g.duration === dur), s.ASK_AI);
      }

    console.log("\n--- 9. Server-side validation of the real action ---");
    const before = JSON.stringify(storedGlow());
    for (const [label, cfg] of [
      ["invalid HEX", { ...DEFAULTS, color: "#12345" }],
      ["CSS injection", { ...DEFAULTS, color: "#123456;}body{display:none" }],
      ["bad intensity", { ...DEFAULTS, intensity: "MAX" }],
      ["bad speed", { ...DEFAULTS, speed: "0.1s" }],
      ["string boolean", { ...DEFAULTS, enabled: "false" }],
      ["arbitrary selector target", { ...DEFAULTS, targets: { ...DEFAULTS.targets, "body *": true } }],
    ]) {
      await rawSave(ap, cfg);
      check(`rejected: ${label} (DB unchanged)`, JSON.stringify(storedGlow()) === before);
    }

    console.log("\n--- 10. Reduced motion, themes, phone ---");
    await rawSave(ap, DEFAULTS);
    {
      const ctx = await studentContext(browser, F.tokens.fresh, { reducedMotion: "reduce" });
      const page = await studentPage(ctx);
      await openReview(page, submittedId);
      const r = await glowState(page, STUDENT_SEL);
      check("prefers-reduced-motion: no animation even with admin glow ON", TARGETS.every((t) => allGlow(r, t, (g) => g.name === "none")), r);
      check("prefers-reduced-motion: still a static glow (visible, not flashing)", allGlow(r, "ASK_AI", (g) => /0\.4\)/.test(g.boxShadow) && /14px 2px/.test(g.boxShadow)), r.ASK_AI);
      await ctx.close();
    }
    for (const theme of ["light", "dark", "eyesaver"])
      for (const device of ["desktop", "phone"]) {
        const ctx = await studentContext(browser, F.tokens.fresh, { device, theme });
        const page = await studentPage(ctx);
        await openReview(page, submittedId);
        const r = await glowState(page, STUDENT_SEL);
        const expect = theme === "eyesaver" ? null : "#9592FA";
        check(`${theme}/${device}: all five glow${expect ? " #9592FA" : " (single-hue Eye-Saver)"}`, TARGETS.every((t) => allGlow(r, t, (g) => running(g) && (!expect || g.color === expect))), r.ASK_AI);
        check(`${theme}/${device}: no sideways scroll`, (await overflow(page)) <= 1);
        await shot(page, `student-${theme}-${device}`);
        await ctx.close();
      }

    console.log("\n--- 11. RBAC ---");
    {
      const { ctx, page } = await adminLogin(browser, G.fullAdmin.username, G.fullAdmin.password);
      await openGlowTab(page);
      check("FULL_ADMIN: page is view-only", (await page.getByText("View only — only a Master Admin can change glow effects.").count()) === 1 && (await page.locator("#glow-master").isDisabled()) && (await page.getByRole("button", { name: "Save Changes" }).isDisabled()));
      const prior = JSON.stringify(storedGlow());
      const r = await rawSave(page, { ...DEFAULTS, color: "#FF0000" });
      check("FULL_ADMIN: raw save refused, DB unchanged", JSON.stringify(storedGlow()) === prior, r);
      await ctx.close();
    }
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`);
      const prior = JSON.stringify(storedGlow());
      const r = await page.evaluate(
        async ({ id }) => (await fetch("/admin/settings", { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify([{ enabled: false }]) })).status,
        { id: SAVE_ID }
      );
      check("anonymous: raw save refused, DB unchanged", JSON.stringify(storedGlow()) === prior, r);
      await ctx.close();
    }
    {
      const html = await (await fetch(`${BASE}/login`)).text();
      const style = html.match(/<style>([^<]*--premium-glow-color[^<]*)<\/style>/)?.[1] ?? "";
      check("public page carries only the glow presentation variables", /--premium-glow-color:#9592FA/.test(style) && !/apiKey|secret|razorpay|gemini/i.test(style), style.slice(-300));
    }

    console.log("\n--- 12. Reset to Default ---");
    await rawSave(ap, { ...DEFAULTS, enabled: false, color: "#22C55E", intensity: "LOW", speed: "SLOW" });
    await openGlowTab(ap);
    ap.once("dialog", (d) => d.accept());
    await ap.getByRole("button", { name: "Reset to Default" }).click();
    await ap.waitForSelector("text=Restored the default glow.");
    st = storedGlow();
    check("DB: defaults restored", st.enabled === true && st.color === "#9592FA" && st.intensity === "MEDIUM" && st.speed === "NORMAL" && TARGETS.every((t) => st.targets[t] === true), st);
    check("form shows defaults", (await ap.locator("#glow-hex").inputValue()) === "#9592FA" && (await ap.locator("#glow-master").getAttribute("data-state")) === "checked");
    await openReview(sp, submittedId);
    s = await glowState(sp, STUDENT_SEL);
    check("student back to default glow", TARGETS.every((t) => allGlow(s, t, (g) => running(g) && g.color === "#9592FA" && g.duration === "2.5s")), s.ASK_AI);
    check("admin: no page errors", ap.errors.length === 0, ap.errors);

    {
      const ctx = await adminLogin(browser, process.env.ADMIN_USER, process.env.ADMIN_PASS, { ...devices["Pixel 7"] });
      await openGlowTab(ctx.page);
      check("admin Glow Effects on phone: no sideways scroll", (await overflow(ctx.page)) <= 1);
      await shot(ctx.page, "admin-phone");
      await ctx.ctx.close();
    }
    await shot(ap, "admin-default");
    await actx.close();
    await sctx.close();
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL PREMIUM GLOW BROWSER CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
