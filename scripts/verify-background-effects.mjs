/**
 * BACKGROUND EFFECTS — real browser verification (Admin → Website →
 * Appearance → Background Effects → homepage / public pages / Student
 * Dashboard).
 *
 * Drives a LOCAL production build on a DISPOSABLE database seeded with
 * scripts/ai-actions-ux-fixture.ts (students + a FREE mock) and
 * `scripts/verify-background-effects.ts setup` (FULL_ADMIN). BASELINE is the
 * same database served by a build of the parent commit, for the
 * "unchanged while OFF" and SEO comparisons.
 *  - OFF (default): no layer, no extra element, no Galaxy code fetched, the
 *    homepage pixel-identical to the baseline build; SEO head, robots.txt and
 *    sitemap.xml identical;
 *  - admin: defaults, live preview of every control BEFORE saving (website
 *    unchanged until Save), per-design settings kept independently, Save →
 *    refresh persists, Reset to Defaults, server-side validation;
 *  - all four designs × glow ON/OFF on the homepage, dark/light/eye-saver,
 *    desktop + phone, no sideways scroll, no layout shift, never above
 *    content or clickable;
 *  - Galaxy: plays once, stops (no further animation frames), capped
 *    particles (500 desktop / 180 phone), reduced motion → still wordmark and
 *    no canvas code downloaded;
 *  - scope: Homepage Only / Public Website / Student Dashboard; never on the
 *    Test Player, OMR, checkout, Live CBT or Admin (incl. client-side
 *    navigation from the dashboard);
 *  - RBAC: FULL_ADMIN read-only + raw Server Action refused; anonymous refused;
 *    button glow (ui.premium_glow) untouched.
 *
 *   BASE=http://localhost:3171 BASELINE=http://localhost:3172 FIXTURE=aiux.json BGFX_FIXTURE=bgfx.json \
 *   ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> SHOTS=<dir> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-background-effects.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");

const BASE = process.env.BASE || "http://localhost:3171";
const BASELINE = process.env.BASELINE || null;
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const B = JSON.parse(fs.readFileSync(process.env.BGFX_FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS || null;
for (const u of [BASE, BASELINE].filter(Boolean)) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)) {
    console.error("This suite only runs against local servers backed by a disposable database.");
    process.exit(2);
  }
}
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to inspect what looks like the production database.");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const SAVE_ID = Object.entries(manifest.node).find(
  ([, v]) => v.exportedName === "saveBackgroundEffectsAction" && Object.keys(v.workers).some((w) => w.includes("website/appearance"))
)?.[0];

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
const psql = (sql) => execFileSync("psql", [process.env.DATABASE_URL.split("?")[0], "-Atc", sql], { encoding: "utf8" }).trim();
const stored = () => {
  const v = psql(`select value from "Setting" where key='ui.background_effects'`);
  return v ? JSON.parse(v) : null;
};
const storedGlow = () => psql(`select value from "Setting" where key='ui.premium_glow'`);
const shot = async (page, name, fullPage = false) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESIGNS = ["DOTTED_WATERMARK", "DOTTED_PATTERN", "GALAXY", "GRADIENT_DOTS"];
const BASE_DESIGN = {
  dotColor: "SOFT_BLUE",
  dotCustomColor: "#7DD3FC",
  dotSize: "MEDIUM",
  dotSpacing: 8,
  opacity: 10,
  watermarkPosition: "CENTER",
  watermarkScale: "LARGE",
  glowEnabled: false,
  glowColor: "CYAN",
  glowCustomColor: "#22D3EE",
  glowIntensity: 30,
  glowSpread: "MEDIUM",
  glowAnimation: false,
  galaxyAnimate: false,
  galaxyDuration: 4,
  galaxyParticles: 500,
};
const DEFAULTS = {
  enabled: false,
  design: "DOTTED_WATERMARK",
  scope: "HOMEPAGE",
  theme: "AUTO",
  designs: {
    DOTTED_WATERMARK: { ...BASE_DESIGN },
    DOTTED_PATTERN: { ...BASE_DESIGN, dotColor: "WHITE", dotSize: "SMALL", dotSpacing: 18, opacity: 8, glowColor: "BLUE", glowIntensity: 15 },
    GALAXY: { ...BASE_DESIGN, dotColor: "WHITE", opacity: 12, glowIntensity: 40 },
    GRADIENT_DOTS: { ...BASE_DESIGN, dotSize: "SMALL", dotSpacing: 16, opacity: 8, glowIntensity: 20 },
  },
};
const clone = (v) => JSON.parse(JSON.stringify(v));
/** A config with `design` active and its settings patched. */
function cfg({ design = "DOTTED_WATERMARK", scope = "HOMEPAGE", theme = "AUTO", enabled = true, patch = {} } = {}) {
  const c = clone(DEFAULTS);
  Object.assign(c, { design, scope, theme, enabled });
  Object.assign(c.designs[design], patch);
  return c;
}

async function adminLogin(browser, user, pass, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pass);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  return { ctx, page };
}
async function openAppearance(page) {
  await page.goto(`${BASE}/admin/website/appearance`);
  await page.waitForSelector("[data-testid=bg-preview] .bgfx");
}
/** The real admin Server Action, called from the signed-in admin page (in-page fetch keeps its cookies). */
function rawSave(page, config) {
  return page.evaluate(
    async ({ id, config }) => {
      const r = await fetch(location.pathname, {
        method: "POST",
        headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" },
        body: JSON.stringify([config]),
      });
      const text = await r.text();
      // The action's result row follows the re-rendered page tree in the RSC reply.
      const result = text.match(/\{"ok":(true|false)(?:,"error":"[^"]*")?/)?.[0] ?? text.slice(0, 300);
      return { status: r.status, body: result };
    },
    { id: SAVE_ID, config }
  );
}
/** Save through the action and wait out the per-worker 5 s settings cache. */
async function apply(ap, config) {
  const r = await rawSave(ap, config);
  if (!/"ok":true/.test(r.body)) throw new Error(`save failed: ${r.body}`);
  await sleep(5200);
}

async function visitorContext(browser, { device = "desktop", theme, reducedMotion, token } = {}) {
  const opts = device === "phone" ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } };
  if (reducedMotion) opts.reducedMotion = reducedMotion;
  const ctx = await browser.newContext(opts);
  const cookies = [];
  if (token) cookies.push({ name: "student-session-token", value: token, url: BASE });
  if (theme) cookies.push({ name: "mts-theme", value: theme, url: BASE });
  if (cookies.length) await ctx.addCookies(cookies);
  return ctx;
}
async function trackedPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.scripts = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|React error #418/.test(m.text()) && page.errors.push(m.text()));
  page.on("response", async (res) => {
    if (res.request().resourceType() !== "script") return;
    try {
      page.scripts.push({ url: res.url(), body: await res.text() });
    } catch {
      /* navigation raced the body */
    }
  });
  // Count animation frames requested after the Galaxy canvas reports "done",
  // and record layout shifts.
  await page.addInitScript(() => {
    window.__rafAfterDone = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      if (document.querySelector('canvas[data-bgfx-layer="galaxy"][data-state="done"]')) window.__rafAfterDone++;
      return raf(cb);
    };
    window.__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* unsupported */
    }
  });
  return page;
}
// The Galaxy canvas chunk is the only script containing the stacked wordmark lines.
const galaxyCodeLoaded = (page) => page.scripts.some((s) => s.body.includes('"MockTest","Series.in"'));
const bgfxCodeLoaded = (page) => page.scripts.some((s) => s.body.includes("BackgroundScopeGate") || s.body.includes("bgfx-breathe"));

/** Facts about the site layer on the current page. */
function layerInfo(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".bgfx:not([data-preview])");
    if (!el) return { present: false, elementsWithBgfx: document.querySelectorAll("[data-bgfx-layer]").length };
    const cs = getComputedStyle(el);
    const kids = [...el.querySelectorAll("[data-bgfx-layer]")];
    const visible = kids.filter((k) => getComputedStyle(k).display !== "none");
    const h1 = document.querySelector("h1");
    let h1OnTop = null;
    if (h1) {
      const r = h1.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
      h1OnTop = !!hit && !hit.closest(".bgfx");
    }
    return {
      present: true,
      design: el.dataset.bgfx,
      mode: el.dataset.mode,
      position: cs.position,
      zIndex: cs.zIndex,
      pointerEvents: cs.pointerEvents,
      ariaHidden: el.getAttribute("aria-hidden"),
      display: cs.display,
      layers: Object.fromEntries(["watermark", "dots", "glow", "gradient", "galaxy"].map((k) => [k, visible.filter((v) => v.dataset.bgfxLayer === k).length])),
      firstBg: visible.find((v) => v.classList.contains("t")) ? getComputedStyle(visible.find((v) => v.classList.contains("t"))).backgroundImage.slice(0, 160) : null,
      dotsBg: (() => {
        const d = visible.find((v) => v.dataset.bgfxLayer === "watermark" || v.dataset.bgfxLayer === "dots");
        return d ? getComputedStyle(d).backgroundImage : null;
      })(),
      animation: [...new Set(visible.map((v) => getComputedStyle(v).animationName))],
      h1OnTop,
      elements: el.querySelectorAll("*").length,
    };
  });
}
async function waitGalaxyDone(page, timeout = 15000) {
  await page.waitForSelector('canvas[data-bgfx-layer="galaxy"][data-state="done"]', { timeout });
}

/** Pixel difference between two PNG buffers (share of differing pixels), computed in a browser canvas. */
async function pixelDiff(browser, a, b) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const result = await page.evaluate(
    async ({ a, b }) => {
      const img = (src) => new Promise((res) => {
        const i = new Image();
        i.onload = () => res(i);
        i.src = `data:image/png;base64,${src}`;
      });
      const [ia, ib] = await Promise.all([img(a), img(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
      const px = (i) => {
        const c = document.createElement("canvas");
        c.width = i.width;
        c.height = i.height;
        const g = c.getContext("2d");
        g.drawImage(i, 0, 0);
        return g.getImageData(0, 0, i.width, i.height).data;
      };
      const da = px(ia);
      const db = px(ib);
      let diff = 0;
      for (let k = 0; k < da.length; k += 4) if (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]) > 6) diff++;
      return { ratio: diff / (da.length / 4) };
    },
    { a: a.toString("base64"), b: b.toString("base64") }
  );
  await ctx.close();
  return result;
}
/** A stable homepage screenshot: motion stilled, viewport only. */
async function stillShot(browser, base, theme) {
  const ctx = await visitorContext(browser, { theme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  // The live statistics cards come from each server's own stats cache (the
  // same DB, cached at different moments), so their numbers / card count can
  // differ for data reasons alone: mask them and compare everything else.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll("p,span,div")].find((n) => n.childElementCount === 0 && /^Total Students$/.test(n.textContent.trim()));
    const grid = label?.closest('[class*="grid"]');
    if (grid) grid.style.visibility = "hidden";
  });
  await sleep(300);
  const buf = await page.screenshot({ animations: "disabled" });
  await ctx.close();
  return buf;
}
/** The SEO-relevant head + headings of a page. */
async function seoOf(base, path) {
  const html = await (await fetch(base + path)).text();
  const pick = (re) => [...html.matchAll(re)].map((m) => m[0].replace(/\s+/g, " ")).sort();
  return JSON.stringify({
    title: pick(/<title>[^<]*<\/title>/g),
    meta: pick(/<meta (name|property)="[^"]+" content="[^"]*"\/?>/g),
    canonical: pick(/<link rel="canonical"[^>]*>/g),
    ld: pick(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g),
    h: pick(/<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/g).map((h) => h.replace(/ class="[^"]*"/g, "")),
    links: pick(/<a [^>]*href="\/[^"]*"/g).map((a) => a.match(/href="[^"]*"/)[0]),
  });
}

async function main() {
  check("Server Action id found in the build manifest", !!SAVE_ID, SAVE_ID);
  psql(`delete from "Setting" where key='ui.background_effects'`);
  const glowBefore = storedGlow();
  psql(`delete from "TestAttempt" where "studentId"='${F.students.fresh}'`);
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------
    console.log("\n--- 1. OFF (no Setting row): nothing rendered, nothing loaded ---");
    for (const device of ["desktop", "phone"]) {
      const ctx = await visitorContext(browser, { device });
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      const info = await layerInfo(p);
      check(`${device}: no background layer / element`, !info.present && info.elementsWithBgfx === 0, info);
      const html = await (await fetch(`${BASE}/`)).text();
      check(`${device}: no bgfx markup or styles in the HTML`, !/bgfx|data-bgfx/.test(html));
      check(`${device}: no Galaxy / background code downloaded`, !galaxyCodeLoaded(p) && !bgfxCodeLoaded(p));
      check(`${device}: no canvas`, (await p.locator("canvas").count()) === 0);
      check(`${device}: no sideways scroll`, (await overflow(p)) <= 0);
      check(`${device}: no page errors`, p.errors.length === 0, p.errors);
      await ctx.close();
    }
    {
      const ctx = await visitorContext(browser, { token: F.tokens.fresh });
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/student/dashboard`, { waitUntil: "networkidle" });
      // The tiny client scope gate is bundled where the layer can mount
      // (dashboard / public pages); it renders nothing while OFF.
      check("dashboard OFF: no layer, no Galaxy code", !(await layerInfo(p)).present && !galaxyCodeLoaded(p));
      const gate = p.scripts.filter((x) => x.body.includes("BackgroundScopeGate"));
      console.log(`  info  dashboard bundles the scope gate: ${gate.length ? "yes (one shared chunk)" : "no"}`);
      await p.goto(`${BASE}/exams`, { waitUntil: "networkidle" });
      check("public page OFF: no layer", !(await layerInfo(p)).present);
      await ctx.close();
    }
    if (BASELINE) {
      for (const theme of ["dark", "light"]) {
        // Warm both servers first so neither shot catches a cold render.
        await stillShot(browser, BASE, theme);
        await stillShot(browser, BASELINE, theme);
        const [a, b] = [await stillShot(browser, BASE, theme), await stillShot(browser, BASELINE, theme)];
        const d = await pixelDiff(browser, a, b);
        check(`homepage OFF (${theme}) pixel-identical to the baseline build`, d.ratio === 0, d);
        if (SHOTS) {
          fs.writeFileSync(`${SHOTS}/off-${theme}.png`, a);
          fs.writeFileSync(`${SHOTS}/off-${theme}-baseline.png`, b);
        }
      }
      for (const path of ["/", "/exams", "/plans-and-pricing", "/contact"]) {
        const [x, y] = [await seoOf(BASE, path), await seoOf(BASELINE, path)];
        check(`SEO head + headings + links unchanged: ${path}`, x === y, x.length + " vs " + y.length);
      }
      for (const path of ["/robots.txt", "/sitemap.xml"]) {
        const [x, y] = [await (await fetch(BASE + path)).text(), await (await fetch(BASELINE + path)).text()];
        check(`${path} identical to baseline`, x === y && x.length > 20);
      }
    } else console.log("  (no BASELINE — skipped pixel / SEO comparison)");

    // ------------------------------------------------------------------
    console.log("\n--- 2. Admin: defaults + live preview before Save ---");
    const { ctx: actx, page: ap } = await adminLogin(browser, process.env.ADMIN_USER, process.env.ADMIN_PASS);
    await openAppearance(ap);
    check("Appearance page shows the Background Effects card", (await ap.getByText("Background Effects", { exact: true }).count()) >= 1);
    check("existing Appearance (theme) form still renders", (await ap.locator("form, [data-testid=appearance-form]").count()) >= 1);
    check("master switch OFF", (await ap.locator("#bg-enabled").getAttribute("aria-checked")) === "false" || (await ap.locator("#bg-enabled").getAttribute("data-state")) === "unchecked");
    const radio = (group, value) => ap.locator(`[data-testid=${group}] [data-value="${value}"]`);
    check("Dotted Watermark selected", (await ap.locator('[data-design="DOTTED_WATERMARK"][role=radio]').getAttribute("aria-checked")) === "true");
    check("Homepage Only + Automatic selected", (await radio("bg-scope", "HOMEPAGE").getAttribute("aria-checked")) === "true" && (await radio("bg-theme", "AUTO").getAttribute("aria-checked")) === "true");
    check("opacity 10%, spacing 8px", (await ap.getByTestId("bg-opacity-value").innerText()) === "10%" && (await ap.getByTestId("bg-spacing-value").innerText()) === "8px");
    check("Save disabled until something changes", await ap.getByTestId("bg-save").isDisabled());
    check("all 20 controls present", (await Promise.all([
      ap.locator("#bg-enabled").count(), ap.locator('[role=radio][data-design]').count(), ap.getByTestId("bg-scope").count(), ap.getByTestId("bg-theme").count(),
      ap.locator("#bg-dot-color").count(), ap.getByTestId("bg-dot-size").count(), ap.locator("#bg-spacing").count(), ap.locator("#bg-opacity").count(),
      ap.getByTestId("bg-wm-position").count(), ap.getByTestId("bg-wm-scale").count(), ap.locator("#bg-glow").count(), ap.locator("#bg-glow-color").count(),
      ap.locator("#bg-glow-intensity").count(), ap.getByTestId("bg-glow-spread").count(), ap.locator("#bg-glow-animation").count(),
      ap.getByTestId("bg-preview").count(), ap.getByTestId("bg-save").count(), ap.getByRole("button", { name: "Reset to Defaults" }).count(),
    ])).every((n) => n >= 1));
    const previewInfo = () =>
      ap.evaluate(() => {
        const el = document.querySelector("[data-testid=bg-preview] .bgfx");
        const wm = el?.querySelector('[data-bgfx-layer="watermark"]');
        return {
          design: el?.dataset.bgfx,
          mode: el?.dataset.mode,
          opacity: wm ? getComputedStyle(wm).opacity : null,
          glow: el ? el.querySelectorAll('[data-bgfx-layer="glow"]').length : 0,
          bg: wm ? getComputedStyle(wm).backgroundImage : null,
          width: document.querySelector("[data-testid=bg-preview]").getBoundingClientRect().width,
          canvas: !!el?.querySelector("canvas"),
        };
      });
    let pv = await previewInfo();
    check("preview shows the Dotted Watermark while the site is OFF", pv.design === "DOTTED_WATERMARK" && pv.opacity === "0.1", pv);
    await ap.locator("#bg-opacity").fill("18");
    pv = await previewInfo();
    check("preview: opacity change shows live (0.18)", pv.opacity === "0.18", pv);
    await ap.locator("#bg-dot-color").selectOption("CYAN");
    pv = await previewInfo();
    check("preview: dot color change shows live (cyan)", /103, 232, 249/.test(pv.bg), pv.bg);
    await ap.locator("#bg-glow").click();
    pv = await previewInfo();
    check("preview: glow ON shows glow layers", pv.glow >= 1, pv);
    await ap.locator("#bg-glow-intensity").fill("90");
    check("preview: glow intensity reaches the glow layer", (await ap.evaluate(() => getComputedStyle(document.querySelector('[data-testid=bg-preview] [data-bgfx-layer="glow"]')).backgroundImage)).includes("0.18"));
    await ap.getByTestId("bg-preview-light").click();
    pv = await previewInfo();
    check("preview: light mode (Automatic follows the preview theme)", pv.mode === "light" && /30, 64, 175|14, 116, 144/.test(pv.bg), pv);
    await ap.getByTestId("bg-preview-dark").click();
    await ap.getByTestId("bg-preview-mobile").click();
    pv = await previewInfo();
    check("preview: mobile frame (≤ 360px)", pv.width <= 360, pv.width);
    await shot(ap, "admin-preview-mobile");
    await ap.getByTestId("bg-preview-desktop").click();
    await ap.locator('[role=radio][data-design="GALAXY"]').click();
    check("Galaxy: Replay Animation button", (await ap.getByTestId("bg-replay").count()) === 1);
    check("preview: Galaxy (animation OFF) shows the still wordmark, no canvas", (await previewInfo()).canvas === false);
    await ap.getByTestId("bg-replay").click();
    await ap.waitForSelector('[data-testid=bg-preview] canvas[data-bgfx-layer="galaxy"]', { timeout: 10000 });
    await ap.waitForSelector('[data-testid=bg-preview] canvas[data-state="done"]', { timeout: 15000 });
    check("preview: Replay plays the formation to completion", true);
    await shot(ap, "admin-preview-galaxy");
    check("nothing saved by preview changes", stored() === null);
    {
      const ctx = await visitorContext(browser);
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      check("website unchanged while the admin previews", !(await layerInfo(p)).present);
      await ctx.close();
    }

    console.log("\n--- 3. Admin: independent design settings, Save → refresh persists ---");
    await openAppearance(ap);
    await ap.locator("#bg-enabled").click();
    // Design 1: Soft Blue, 10%, Cyan glow 30%.
    await ap.locator("#bg-glow").click();
    // Design 2: Grey, 6%, Blue ambient glow 15%.
    await ap.locator('[role=radio][data-design="DOTTED_PATTERN"]').click();
    await ap.locator("#bg-dot-color").selectOption("GREY");
    await ap.locator("#bg-opacity").fill("6");
    await ap.locator("#bg-glow").click();
    // Design 3: White particles, Purple glow 40%.
    await ap.locator('[role=radio][data-design="GALAXY"]').click();
    await ap.locator("#bg-glow").click();
    await ap.locator("#bg-glow-color").selectOption("PURPLE");
    // Design 4: Blue gradient 8%, Cyan aurora 20%.
    await ap.locator('[role=radio][data-design="GRADIENT_DOTS"]').click();
    await ap.locator("#bg-glow").click();
    // Back to Design 1: its values must be untouched by the others.
    await ap.locator('[role=radio][data-design="DOTTED_WATERMARK"]').click();
    check("switching back: Design 1 still 10% / Soft Blue", (await ap.getByTestId("bg-opacity-value").innerText()) === "10%" && (await ap.locator("#bg-dot-color").inputValue()) === "SOFT_BLUE");
    await ap.locator('[role=radio][data-design="DOTTED_PATTERN"]').click();
    check("switching back: Design 2 still 6% / Grey", (await ap.getByTestId("bg-opacity-value").innerText()) === "6%" && (await ap.locator("#bg-dot-color").inputValue()) === "GREY");
    await ap.locator('[role=radio][data-design="DOTTED_WATERMARK"]').click();
    await ap.getByTestId("bg-save").click();
    await ap.waitForSelector("text=Saved. Visitors see the new background within a few seconds.");
    let st = stored();
    check("DB: enabled, Dotted Watermark, Homepage Only", st?.enabled === true && st.design === "DOTTED_WATERMARK" && st.scope === "HOMEPAGE", st && { e: st.enabled, d: st.design, s: st.scope });
    check("DB: Design 1 Soft Blue / 10% / Cyan glow 30%", st.designs.DOTTED_WATERMARK.dotColor === "SOFT_BLUE" && st.designs.DOTTED_WATERMARK.opacity === 10 && st.designs.DOTTED_WATERMARK.glowEnabled && st.designs.DOTTED_WATERMARK.glowColor === "CYAN" && st.designs.DOTTED_WATERMARK.glowIntensity === 30);
    check("DB: Design 2 Grey / 6% / Blue glow 15%", st.designs.DOTTED_PATTERN.dotColor === "GREY" && st.designs.DOTTED_PATTERN.opacity === 6 && st.designs.DOTTED_PATTERN.glowEnabled && st.designs.DOTTED_PATTERN.glowColor === "BLUE" && st.designs.DOTTED_PATTERN.glowIntensity === 15);
    check("DB: Design 3 White / Purple glow 40%", st.designs.GALAXY.dotColor === "WHITE" && st.designs.GALAXY.glowColor === "PURPLE" && st.designs.GALAXY.glowIntensity === 40 && st.designs.GALAXY.glowEnabled);
    check("DB: Design 4 8% / Cyan aurora 20%", st.designs.GRADIENT_DOTS.opacity === 8 && st.designs.GRADIENT_DOTS.glowColor === "CYAN" && st.designs.GRADIENT_DOTS.glowIntensity === 20 && st.designs.GRADIENT_DOTS.glowEnabled);
    check("audit log row written", psql(`select count(*) from "AuditLog" where action='BACKGROUND_EFFECTS_SAVED'`) !== "0");
    await openAppearance(ap);
    check("after refresh: switch ON, Design 1 selected, glow ON", (await ap.locator("#bg-enabled").getAttribute("aria-checked")) === "true" && (await ap.locator('[data-design="DOTTED_WATERMARK"][role=radio]').getAttribute("aria-checked")) === "true" && (await ap.locator("#bg-glow").getAttribute("aria-checked")) === "true");
    await ap.locator('[role=radio][data-design="DOTTED_PATTERN"]').click();
    check("after refresh: Design 2 settings persisted", (await ap.getByTestId("bg-opacity-value").innerText()) === "6%" && (await ap.locator("#bg-dot-color").inputValue()) === "GREY");
    await sleep(5200);

    // ------------------------------------------------------------------
    console.log("\n--- 4. Every design × glow on the homepage (desktop + phone, dark + light) ---");
    const offInfo = {};
    {
      // CLS reference with the feature OFF (same build).
      await apply(ap, { ...cfg(), enabled: false });
      for (const device of ["desktop", "phone"]) {
        const ctx = await visitorContext(browser, { device });
        const p = await trackedPage(ctx);
        await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
        await sleep(500);
        offInfo[device] = await p.evaluate(() => window.__cls);
        await ctx.close();
      }
    }
    for (const design of DESIGNS) {
      for (const glow of [true, false]) {
        await apply(ap, cfg({ design, patch: { glowEnabled: glow, ...(design === "GALAXY" ? { galaxyAnimate: false } : {}) } }));
        for (const device of ["desktop", "phone"]) {
          for (const theme of ["dark", "light"]) {
            const ctx = await visitorContext(browser, { device, theme });
            const p = await trackedPage(ctx);
            await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
            await sleep(300);
            const info = await layerInfo(p);
            const tag = `${design} glow ${glow ? "ON" : "OFF"} ${device} ${theme}`;
            const wantLayers =
              design === "DOTTED_PATTERN" ? info.layers?.dots === 1 : design === "GRADIENT_DOTS" ? info.layers?.dots === 1 && info.layers?.gradient === 1 && info.layers?.watermark === 1 : info.layers?.watermark === 1;
            check(`${tag}: layer rendered behind content, inert`, info.present && info.design === design && info.position === "fixed" && info.zIndex === "-1" && info.pointerEvents === "none" && info.ariaHidden === "true" && wantLayers, info);
            check(`${tag}: glow layers ${glow ? "present" : "absent"}`, glow ? info.layers.glow >= 1 : info.layers.glow === 0, info.layers);
            check(`${tag}: H1 stays on top and clickable content is not covered`, info.h1OnTop !== false, info.h1OnTop);
            const lightDots = /55, 65, 81|30, 64, 175|75, 85, 99|14, 116, 144/.test(info.dotsBg ?? "");
            check(`${tag}: ${theme} palette`, theme === "light" ? lightDots : !lightDots, info.dotsBg?.slice(0, 120));
            check(`${tag}: no sideways scroll`, (await overflow(p)) <= 0);
            const cls = await p.evaluate(() => window.__cls);
            check(`${tag}: no added layout shift (CLS ${cls.toFixed(4)} vs OFF ${offInfo[device].toFixed(4)})`, cls <= offInfo[device] + 0.001);
            check(`${tag}: static — no animation, no Galaxy code`, info.animation.every((a) => a === "none") && !galaxyCodeLoaded(p), { a: info.animation });
            check(`${tag}: no page errors`, p.errors.length === 0, p.errors);
            if (theme === "dark" || device === "phone") await shot(p, `home-${design}-${glow ? "glow" : "noglow"}-${device}-${theme}`);
            await ctx.close();
          }
        }
      }
    }
    {
      await apply(ap, cfg({ design: "DOTTED_WATERMARK", theme: "DARK", patch: { glowEnabled: true } }));
      const ctx = await visitorContext(browser, { theme: "light" });
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      const info = await layerInfo(p);
      check("Theme Behavior = Dark keeps the dark palette on a light site", info.mode === "dark" && !/30, 64, 175/.test(info.dotsBg), info);
      await apply(ap, cfg({ design: "DOTTED_WATERMARK", theme: "LIGHT" }));
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      check("Theme Behavior = Light uses the light palette", /30, 64, 175/.test((await layerInfo(p)).dotsBg));
      await ctx.close();
      const ectx = await visitorContext(browser, { theme: "eyesaver" });
      const ep = await trackedPage(ectx);
      await ep.goto(`${BASE}/`, { waitUntil: "networkidle" });
      const e = await layerInfo(ep);
      check("Eye-Saver mode hides the decoration (readability first)", !e.present || e.display === "none", e);
      await ectx.close();
    }
    {
      await apply(ap, cfg({ design: "GRADIENT_DOTS", patch: { glowEnabled: true, glowAnimation: true } }));
      const ctx = await visitorContext(browser);
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      check("Glow Animation ON: slow breathing glow", (await layerInfo(p)).animation.includes("bgfx-breathe"));
      await ctx.close();
      const rctx = await visitorContext(browser, { reducedMotion: "reduce" });
      const rp = await trackedPage(rctx);
      await rp.goto(`${BASE}/`, { waitUntil: "networkidle" });
      check("Glow Animation + reduced motion: still", (await layerInfo(rp)).animation.every((a) => a === "none"));
      await rctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- 5. Galaxy formation: once, then stops ---");
    await apply(ap, cfg({ design: "GALAXY", patch: { galaxyAnimate: true, galaxyDuration: 2, glowEnabled: true, glowAnimation: true } }));
    for (const device of ["desktop", "phone"]) {
      const ctx = await visitorContext(browser, { device });
      const p = await trackedPage(ctx);
      const t0 = Date.now();
      await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      const h1Visible = await p.locator("h1").first().isVisible();
      await p.waitForSelector('canvas[data-bgfx-layer="galaxy"]', { timeout: 15000 });
      const n = Number(await p.locator('canvas[data-bgfx-layer="galaxy"]').getAttribute("data-particles"));
      check(`${device}: H1 renders without waiting for the animation`, h1Visible);
      check(`${device}: particle count within limit (${n})`, n >= 40 && n <= (device === "phone" ? 180 : 500), n);
      await waitGalaxyDone(p);
      const took = Date.now() - t0;
      check(`${device}: formation completes (~2 s, took ${took} ms)`, took < 12000);
      await shot(p, `galaxy-done-${device}`);
      const before = await p.evaluate(() => window.__rafAfterDone);
      await sleep(1500);
      const after = await p.evaluate(() => window.__rafAfterDone);
      check(`${device}: no animation frames after completion`, after === before, { before, after });
      const painted = await p.evaluate(() => {
        const c = document.querySelector('canvas[data-bgfx-layer="galaxy"]');
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
        return lit;
      });
      check(`${device}: finished wordmark stays painted`, painted > 500, painted);
      check(`${device}: Galaxy code downloaded only now`, galaxyCodeLoaded(p));
      check(`${device}: no sideways scroll`, (await overflow(p)) <= 0);
      check(`${device}: no page errors`, p.errors.length === 0, p.errors);
      await ctx.close();
    }
    {
      // Readable wordmark: the finished particle positions trace the letters
      // (wide layout: a horizontal band; most columns of the band hold dots).
      const ctx = await visitorContext(browser);
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`);
      await waitGalaxyDone(p);
      const shape = await p.evaluate(() => {
        const c = document.querySelector('canvas[data-bgfx-layer="galaxy"]');
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let minX = 1e9, maxX = 0, minY = 1e9, maxY = 0;
        for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 0) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        return { w: (maxX - minX) / c.width, h: (maxY - minY) / c.height };
      });
      check("finished particles form a wide wordmark band (not a random scatter)", shape.w > 0.6 && shape.h < 0.4, shape);
      await ctx.close();
    }
    {
      const ctx = await visitorContext(browser, { reducedMotion: "reduce" });
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await sleep(1000);
      const fb = await p.evaluate(() => {
        const f = document.querySelector(".bgfx .gx-fb");
        return f ? getComputedStyle(f).display : null;
      });
      check("reduced motion: no canvas, still wordmark shown", (await p.locator("canvas").count()) === 0 && fb === "block", fb);
      check("reduced motion: Galaxy code never downloaded", !galaxyCodeLoaded(p));
      await ctx.close();
    }
    {
      await apply(ap, cfg({ design: "GALAXY", patch: { galaxyAnimate: true, galaxyDuration: 2, glowEnabled: false } }));
      const ctx = await visitorContext(browser);
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`);
      await waitGalaxyDone(p);
      check("glow-free Galaxy runs and completes", (await layerInfo(p)).layers.glow === 0);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- 6. Scope + protected routes ---");
    const studentCtx = await visitorContext(browser, { token: F.tokens.fresh });
    const sp = await trackedPage(studentCtx);
    const visit = async (page, path) => {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      return (await layerInfo(page)).present;
    };
    await apply(ap, cfg({ scope: "HOMEPAGE" }));
    check("Homepage Only: homepage ON", await visit(sp, "/"));
    check("Homepage Only: public page OFF", !(await visit(sp, "/exams")));
    check("Homepage Only: dashboard OFF", !(await visit(sp, "/student/dashboard")));
    await apply(ap, cfg({ scope: "PUBLIC" }));
    check("Public Website: homepage ON", await visit(sp, "/"));
    for (const path of ["/exams", "/plans-and-pricing", "/contact"]) check(`Public Website: ${path} ON`, await visit(sp, path));
    check("Public Website: dashboard OFF", !(await visit(sp, "/student/dashboard")));
    check("Public Website: Live CBT page never", !(await visit(sp, `/live-cbt/${F.mockId}`)));
    await apply(ap, cfg({ scope: "STUDENT_DASHBOARD" }));
    check("Student Dashboard: dashboard ON", await visit(sp, "/student/dashboard"));
    check("Student Dashboard: exams list ON", await visit(sp, "/student/exams"));
    check("Student Dashboard: homepage OFF", !(await visit(sp, "/")));
    // (/student/omr only redirects to the OMR sheet PDF or the dashboard; the
    // OMR answer-entry screen is /student/attempt/<id>/omr-entry — see below.)
    check("Student Dashboard: checkout never", !(await visit(sp, `/student/checkout/${F.paidProduct?.code ?? "x"}`)));
    await apply(ap, cfg({ scope: "HOMEPAGE_AND_DASHBOARD" }));
    check("Homepage + Dashboard: homepage ON", await visit(sp, "/"));
    check("Homepage + Dashboard: dashboard ON", await visit(sp, "/student/dashboard"));
    check("Homepage + Dashboard: public page OFF", !(await visit(sp, "/exams")));
    // Client-side navigation keeps the dashboard layout mounted: the gate must still hide it.
    await visit(sp, "/student/dashboard");
    const checkoutPath = `/student/checkout/${F.paidProduct?.code ?? "x"}`;
    await sp.evaluate((p) => window.next?.router?.push(p), checkoutPath);
    await sp.waitForURL(/\/student\/checkout/, { timeout: 15000 });
    await sleep(800);
    check("client-side navigation dashboard → checkout: layer removed", !(await layerInfo(sp)).present);
    await sp.evaluate(() => window.next?.router?.push("/student/dashboard"));
    await sp.waitForURL(/\/student\/dashboard/, { timeout: 15000 });
    await sleep(800);
    check("client-side navigation back to the dashboard: layer back", (await layerInfo(sp)).present);
    // Test Player, result and review.
    await sp.goto(`${BASE}/student/test-series/${F.mockId}`);
    await sp.waitForSelector("[data-testid=pre-test-setup]");
    check("pre-test setup (dashboard page) shows the layer", (await layerInfo(sp)).present);
    await sp.locator('input[name="answerMode"][value="INSTANT"]').check();
    await sp.getByRole("button", { name: /Start Test|Practice Again/ }).click();
    await sp.waitForURL(/\/run$/, { timeout: 30000 });
    await sp.waitForSelector("[data-testid=test-player]");
    check("Test Player: never", !(await layerInfo(sp)).present && (await sp.locator("[data-bgfx-layer]").count()) === 0);
    await sp.locator(`[data-testid=option][data-label="${F.keys[0]}"]`).click();
    await sp.waitForSelector("[data-testid=reveal-result]", { timeout: 15000 });
    check("Test Player: answering works normally", true);
    await sp.getByRole("button", { name: "Submit Test" }).first().click();
    await sp.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
    await sp.waitForURL(/\/result$/, { timeout: 30000 });
    check("Result: never", !(await layerInfo(sp)).present);
    await sp.goto(sp.url().replace(/\/result$/, "/review"), { waitUntil: "networkidle" });
    check("Question Review: never", !(await layerInfo(sp)).present);
    await sp.goto(sp.url().replace(/\/review$/, "/omr-entry"), { waitUntil: "networkidle" });
    check("OMR entry route (/student/attempt/…/omr-entry): never", !(await layerInfo(sp)).present);
    check("student pages: no errors", sp.errors.length === 0, sp.errors);
    await studentCtx.close();
    await openAppearance(ap);
    check("Admin Panel: only the preview, never a site layer", (await ap.locator(".bgfx:not([data-preview])").count()) === 0);

    // ------------------------------------------------------------------
    console.log("\n--- 7. Server-side validation + RBAC ---");
    const prior = JSON.stringify(stored());
    for (const [label, bad] of [
      ["opacity 50", (c) => (c.designs.DOTTED_WATERMARK.opacity = 50)],
      ["particles 5000", (c) => (c.designs.GALAXY.galaxyParticles = 5000)],
      ["duration 10", (c) => (c.designs.GALAXY.galaxyDuration = 10)],
      ["CSS injection in custom color", (c) => (c.designs.DOTTED_WATERMARK.dotCustomColor = "#000;}</style><script>alert(1)</script>")],
      ["unknown design", (c) => (c.design = "HACK")],
    ]) {
      const c = cfg();
      bad(c);
      const r = await rawSave(ap, c);
      check(`refused: ${label}`, /"ok":false/.test(r.body) && JSON.stringify(stored()) === prior, r.body.slice(-160));
    }
    {
      const { ctx, page } = await adminLogin(browser, B.fullAdmin.username, B.fullAdmin.password);
      await openAppearance(page);
      check("FULL_ADMIN: view only", (await page.getByText("View only — only a Master Admin can change background effects.").count()) === 1 && (await page.locator("#bg-enabled").isDisabled()) && (await page.getByTestId("bg-save").isDisabled()));
      const r = await rawSave(page, cfg({ design: "GALAXY" }));
      check("FULL_ADMIN: raw save refused, DB unchanged", JSON.stringify(stored()) === prior, r);
      await ctx.close();
    }
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`);
      const r = await page.evaluate(
        async ({ id }) => (await fetch("/admin/website/appearance", { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify([{ enabled: true }]) })).status,
        { id: SAVE_ID }
      );
      check("anonymous: raw save refused, DB unchanged", JSON.stringify(stored()) === prior, r);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- 8. Reset to Defaults → OFF, site back to normal ---");
    await openAppearance(ap);
    await ap.getByRole("button", { name: "Reset to Defaults" }).click();
    await ap.waitForSelector("text=Defaults loaded (Background Effects OFF). Press Save Changes to apply them.");
    check("nothing saved by Reset alone", JSON.stringify(stored()) === prior);
    await ap.getByTestId("bg-save").click();
    await ap.waitForSelector("text=Saved. Background Effects are OFF on the website.");
    st = stored();
    const { updatedAt, ...rest } = st;
    // jsonb reorders keys: compare with sorted keys.
    const canon = (v) => (v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    check("DB: defaults stored (OFF)", JSON.stringify(canon(rest)) === JSON.stringify(canon(DEFAULTS)) && !!updatedAt, rest);
    await sleep(5200);
    {
      const ctx = await visitorContext(browser);
      const p = await trackedPage(ctx);
      await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
      check("homepage: layer gone after OFF", !(await layerInfo(p)).present && !galaxyCodeLoaded(p));
      await ctx.close();
    }
    check("admin pages: no errors", ap.errors.length === 0, ap.errors);
    check("button glow setting (ui.premium_glow) untouched", storedGlow() === glowBefore);
    await actx.close();
  } finally {
    await browser.close();
    psql(`delete from "Setting" where key='ui.background_effects'`);
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL BACKGROUND EFFECTS BROWSER CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
