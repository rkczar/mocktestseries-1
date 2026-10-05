/**
 * NEET Phase 2 — scientific media in a real browser, through nginx.
 *
 * Needs: a production build on the scratch DB (`next start -H 127.0.0.1 -p 3111`,
 * STORAGE_DIR=<scratch>) behind a scratch nginx on BASE that serves /media/
 * from <scratch>/media with /etc/nginx/snippets/mocktestseries-media.conf and
 * proxies everything else (NEXTAUTH_URL = BASE).
 *
 *   STORAGE_DIR=<scratch> DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-media-engine.ts setup > /tmp/med.json
 *   BASE=http://localhost:3121 NEXT_DIRECT=http://127.0.0.1:3111 FIXTURE=/tmp/med.json DATABASE_URL=<scratch> STORAGE_DIR=<scratch> \
 *     ADMIN_USER=… ADMIN_PASS=… [SHOTS=<dir>] NODE_PATH=/root/.claude/skills/gstack/node_modules node scripts/verify-media-engine.mjs
 *   … verify-media-engine.ts cleanup /tmp/med.json
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const { Client } = require("pg");
const sharp = require("sharp");

const BASE = process.env.BASE ?? "http://localhost:3121";
const NEXT_DIRECT = process.env.NEXT_DIRECT ?? "http://127.0.0.1:3111";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const MEDIA_ROOT = path.join(process.env.STORAGE_DIR, "media");
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const idx = (key) => F.order.indexOf(F.ids[key]);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
}
const info = (m) => console.log(`INFO  ${m}`);

const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, "") });
await db.connect();
const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const releaseLease = (id) => db.query(`update "TestAttempt" set "activeDeviceId" = null, "activeSeenAt" = null where id = $1`, [id]);

const browser = await chromium.launch();
async function newPage({ mobile = false, dark = false } = {}) {
  const ctx = await browser.newContext({
    ...(mobile ? { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } : { viewport: { width: 1366, height: 900 } }),
    colorScheme: dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.mobile = mobile;
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  return page;
}
async function login(page, email) {
  await db.query(`delete from "StudentDevice" where "studentId" in (select id from "Student" where email = $1)`, [email]);
  await db.query(`delete from "StudentLoginAttempt" where identifier = $1`, [email]);
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}
async function adminLogin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
async function openRun(page, attemptId) {
  await releaseLease(attemptId);
  await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await page.locator("[data-testid=test-player]").waitFor({ timeout: 30000 });
}
const position = async (page) => Number(((await page.locator("[data-testid=question-position]").first().textContent()) ?? "").match(/\d+/)?.[0] ?? 1) - 1;
async function goTo(page, i) {
  for (let guard = 0; guard < 400 && (await position(page)) !== i; guard++) {
    const here = await position(page);
    await page.getByRole("button", { name: here < i ? /^(Save & )?Next/ : /Previous/ }).first().click();
  }
  await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(String(n)), i + 1);
}
const imagesLoaded = (page, scope = "[data-testid=test-player]") =>
  page.locator(`${scope} [data-testid=question-media] img`).evaluateAll(async (imgs) => {
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => i.addEventListener("load", r, { once: true }) || i.addEventListener("error", r, { once: true })))));
    return imgs.map((i) => ({ ok: i.complete && i.naturalWidth > 0, alt: i.getAttribute("alt"), w: i.getAttribute("width"), h: i.getAttribute("height"), src: i.getAttribute("src") }));
  });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const multipart = (fields, file) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("file", new Blob([file.bytes], { type: file.type }), file.name);
  return fd;
};

try {
  // -------------------------------------------------------------------------
  console.log("M1 nginx /media/: immutable cache, 404s, Next never serves it");
  {
    const key = (await q1(`select "storageKey" from "QuestionAsset" where "questionId" = $1 limit 1`, [F.ids.circuit])).storageKey;
    const r = await fetch(`${BASE}/media/${key}`);
    const body = Buffer.from(await r.arrayBuffer());
    check("existing asset → 200 image/webp", r.status === 200 && r.headers.get("content-type") === "image/webp", { s: r.status, t: r.headers.get("content-type") });
    check("Cache-Control: public, max-age=31536000, immutable", r.headers.get("cache-control") === "public, max-age=31536000, immutable", r.headers.get("cache-control"));
    check("served bytes = the content-addressed file", body.equals(readFileSync(path.join(MEDIA_ROOT, key))));
    check("nosniff header present", r.headers.get("x-content-type-options") === "nosniff");
    const miss = await fetch(`${BASE}/media/q/00/${"0".repeat(64)}.webp`);
    check("missing asset → 404 and NOT cached as immutable", miss.status === 404 && !(miss.headers.get("cache-control") ?? "").includes("immutable"), { s: miss.status, c: miss.headers.get("cache-control") });
    check("SVG under /media/ → 404", (await fetch(`${BASE}/media/q/x.svg`)).status === 404);
    check("dot path under /media/ → 404", (await fetch(`${BASE}/media/q/.tmp-abc.webp`)).status === 404);
    check("POST to /media/ refused", [403, 405].includes((await fetch(`${BASE}/media/${key}`, { method: "POST" })).status));
    const direct = await fetch(`${NEXT_DIRECT}/media/${key}`);
    check("Next.js itself does not serve /media/ (404 direct)", direct.status === 404, direct.status);
  }

  // -------------------------------------------------------------------------
  console.log("M2 RBAC + admin upload path + new file live without restart");
  {
    const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><circle cx="150" cy="100" r="${60 + (Date.now() % 30)}" fill="none" stroke="#000" stroke-width="3"/></svg>`) }])
      .png()
      .toBuffer();
    const url = `${BASE}/api/admin/questions/${F.draftId}/assets`;
    const anon = await fetch(url, { method: "POST", body: multipart({ role: "QUESTION", alt: "Anonymous attempt" }, { bytes: png, type: "image/png", name: "x.png" }), redirect: "manual" });
    check("anonymous upload refused", [401, 403, 307, 302].includes(anon.status), anon.status);

    const student = await newPage();
    await login(student, F.students.review.email);
    const studentTry = await student.evaluate(
      async ({ url, b64 }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append("role", "QUESTION");
        fd.append("alt", "Student attempt at upload");
        fd.append("file", new Blob([bytes], { type: "image/png" }), "x.png");
        const post = await fetch(url, { method: "POST", body: fd });
        const del = await fetch(url, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: "x" }) });
        const patch = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: "x", alt: "hacked" }) });
        const rich = await fetch(url.replace("/assets", "/rich"), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentFormat: "RICH_V1" }) });
        return [post.status, del.status, patch.status, rich.status];
      },
      { url, b64: png.toString("base64") }
    );
    check("student cannot upload / delete / edit / change format (403s)", studentTry.every((s) => s === 403 || s === 401), studentTry);
    await student.context().close();

    const admin = await newPage();
    await adminLogin(admin);
    const call = (method, fieldsOrJson, file, target = url) =>
      admin.evaluate(
        async ({ method, target, fields, json, b64, type, name }) => {
          let body;
          const headers = {};
          if (json) {
            body = JSON.stringify(json);
            headers["Content-Type"] = "application/json";
          } else {
            body = new FormData();
            for (const [k, v] of Object.entries(fields)) body.append(k, v);
            if (b64) body.append("file", new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }), name);
          }
          const r = await fetch(target, { method, body, headers });
          return { status: r.status, body: await r.json().catch(() => null) };
        },
        { method, target, fields: file ? fieldsOrJson : undefined, json: file ? undefined : fieldsOrJson, b64: file?.bytes.toString("base64"), type: file?.type, name: file?.name }
      );
    const toRich = await call("PATCH", { contentFormat: "RICH_V1", explanation: "Admin explanation $x$" }, null, url.replace("/assets", "/rich"));
    check("admin: DRAFT question → RICH_V1", toRich.status === 200 && toRich.body.question.contentFormat === "RICH_V1", toRich);
    const evil = await call("POST", { role: "QUESTION", alt: "A circle diagram for the test", storageKey: "../../../etc/passwd", url: "/etc/passwd" }, { bytes: png, type: "image/png", name: "circle.png" });
    check("admin upload works; client storageKey/url ignored (server-made key)", evil.status === 200 && /^q\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/.test(evil.body.asset.storageKey), evil);
    const live = await fetch(`${BASE}${evil.body.asset.url}`);
    check("brand-new asset served by nginx immediately (no restart)", live.status === 200 && (live.headers.get("cache-control") ?? "").includes("immutable"), live.status);
    const dup = await call("POST", { role: "EXPLANATION", alt: "Same circle, again" }, { bytes: png, type: "image/png", name: "circle-again.png" });
    check("exact duplicate upload → same file, flagged deduplicated", dup.status === 200 && dup.body.deduplicated === true && dup.body.asset.storageKey === evil.body.asset.storageKey, dup.body);
    const svg = await call("POST", { role: "QUESTION", alt: "An svg drawing here" }, { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), type: "image/svg+xml", name: "x.svg" });
    check("SVG upload → 400", svg.status === 400, svg);
    // Browsers strip paths from upload names, so send the raw multipart from Node with the admin session.
    const cookie = (await admin.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const boundary = "----mtsboundary" + Date.now();
    const raw = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\nQUESTION\r\n--${boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\nTraversal name test\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../evil.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const trav = await fetch(url, { method: "POST", headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}`, origin: BASE }, body: raw });
    const travBody = await trav.json().catch(() => null);
    // The multipart parser already reduces "../../evil.png" to its basename; either way the name never names a file.
    const { execSync } = require("node:child_process");
    const strays = execSync(`find ${JSON.stringify(path.dirname(process.env.STORAGE_DIR))} -name 'evil*' 2>/dev/null | wc -l`).toString().trim();
    check(
      "traversal filename can't reach storage (refused, or stored only under its hash key; no evil* file anywhere)",
      (trav.status === 400 || /^q\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/.test(travBody?.asset?.storageKey ?? "")) && strays === "0",
      { s: trav.status, strays }
    );
    const noAlt = await call("POST", { role: "QUESTION" }, { bytes: png, type: "image/png", name: "c.png" });
    check("missing alt → 400", noAlt.status === 400, noAlt);
    const rm = await call("DELETE", { assetId: dup.body.asset.id });
    check("remove reference → 200; file still on disk and served", rm.status === 200 && existsSync(path.join(MEDIA_ROOT, dup.body.asset.storageKey)) && (await fetch(`${BASE}${dup.body.asset.url}`)).status === 200);
    const pub = await call("PATCH", { contentFormat: "PLAIN" }, null, `${BASE}/api/admin/questions/${F.ids.circuit}/rich`);
    check("published question's format change refused", pub.status === 400, pub);

    // Legacy image endpoint: replacing/removing no longer deletes the old file.
    const legacy = await call("POST", { target: "question", questionId: F.draftId }, { bytes: png, type: "image/png", name: "legacy.png" }, `${BASE}/api/admin/questions/images`);
    const legacyFile = path.join(process.env.STORAGE_DIR, "question-images", legacy.body?.url?.split("/").pop() ?? "none");
    const legacyDel = await call("DELETE", { url: legacy.body?.url, questionId: F.draftId, target: "question" }, null, `${BASE}/api/admin/questions/images`);
    check("legacy image route: DELETE keeps the file (old attempts keep their image)", legacy.status === 200 && legacyDel.status === 200 && existsSync(legacyFile), { legacy, legacyFile });

    // Admin UI (the minimum authoring path).
    await admin.goto(`${BASE}/admin/questions/preview/${F.draftId}`);
    await admin.locator("[data-testid=media-manager]").waitFor();
    const before = await admin.locator("[data-testid=managed-asset]").count();
    const up = admin.locator("[data-testid=media-upload]");
    await up.locator("input[name=file]").setInputFiles({ name: "ray.png", mimeType: "image/png", buffer: readFileSync(path.join(process.env.FX_DIR, "ray.png")) });
    await up.locator("select[name=role]").selectOption("OPTION");
    await up.locator("select[name=optionLabel]").selectOption("C");
    await up.locator("input[name=alt]").fill("Ray diagram for option C");
    await up.getByRole("button", { name: "Upload" }).click();
    await admin.getByText("Image attached.").waitFor({ timeout: 20000 });
    await admin.waitForFunction((n) => document.querySelectorAll("[data-testid=managed-asset]").length === n + 1, before, { timeout: 15000 });
    check("admin UI: attach option C image with alt", (await admin.locator('[data-testid=managed-asset][data-role=OPTION][data-option=C]').count()) === 1);
    check("admin preview shows it inside option C", (await admin.locator('[data-testid=admin-question-preview] img[alt="Ray diagram for option C"]').count()) === 1);
    await shot(admin, "admin-media-manager");
    check("M2 admin no page errors", admin.errors.length === 0, admin.errors);
    await admin.context().close();
  }

  // -------------------------------------------------------------------------
  console.log("M3 Player (desktop): every scientific fixture, viewer, no answer interference, CLS");
  {
    const page = await newPage();
    await login(page, F.students.exam.email);
    // Slow /media/ so a missing reservation would show up as layout shift.
    await page.route("**/media/**", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await openRun(page, F.attempts.exam);
    const firstBox = await page.locator("[data-testid=test-player] [data-testid=question-media] img").first().boundingBox();
    const imgs0 = await imagesLoaded(page);
    const afterBox = await page.locator("[data-testid=test-player] [data-testid=question-media] img").first().boundingBox();
    const cls = await page.evaluate(() => window.__cls);
    check("space reserved before the image arrives (same box before/after load)", firstBox && afterBox && Math.abs(firstBox.height - afterBox.height) < 1 && firstBox.height > 50, { firstBox, afterBox });
    check(`cumulative layout shift on an image question ≈ 0 (${cls.toFixed(4)})`, cls < 0.01, cls);
    await page.unroute("**/media/**");
    check("circuit: image loaded, alt, width/height, KaTeX formula", imgs0.length === 1 && imgs0[0].ok && imgs0[0].alt.startsWith("Circuit:") && imgs0[0].w && (await page.locator("[data-testid=test-player] p.text-question .katex").count()) >= 2, imgs0);
    await shot(page, "desktop-circuit");

    for (const [key, n, altStart] of [
      ["graph", 1, "Velocity-time"],
      ["ray", 1, "Ray diagram"],
      ["biology", 1, "Longitudinal section"],
      ["molecule", 1, "Structure of phenol"],
    ]) {
      await goTo(page, idx(key));
      const im = await imagesLoaded(page);
      check(`${key}: ${n} image(s) loaded with alt`, im.length === n && im.every((i) => i.ok) && im[0].alt.startsWith(altStart), im);
      if (key === "molecule") check("mhchem + molecule image together", (await page.locator("[data-testid=test-player] p.text-question .katex").count()) >= 2);
      await shot(page, `desktop-${key}`);
    }

    await goTo(page, idx("reaction"));
    const rx = await imagesLoaded(page);
    check("reaction: diagram + 4 option structure images loaded", rx.length === 5 && rx.every((i) => i.ok), rx);
    const optB = page.locator('[data-testid=option][data-label="B"]');
    await optB.locator("img").click({ force: true });
    check("tapping an option IMAGE selects that option (like its text)", await optB.locator("input").isChecked());
    await page.locator('[data-testid=option][data-label="C"] [data-testid=media-expand]').click();
    const viewer = page.locator("[data-testid=image-viewer]");
    await viewer.waitFor({ state: "visible" });
    check("option expand button opens the viewer", await viewer.isVisible());
    check("…and does NOT select option C (B stays selected)", !(await page.locator('[data-testid=option][data-label="C"] input').isChecked()) && (await optB.locator("input").isChecked()));
    check("viewer shows the option image with its alt", (await viewer.locator("[data-testid=viewer-image]").getAttribute("alt")) === "Structure C: diethyl ether");
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    check("zoom in → 150%", (await viewer.locator("[data-testid=viewer-zoom]").textContent()) === "150%");
    const wide = await viewer.locator("[data-testid=viewer-image]").evaluate((i) => i.getBoundingClientRect().width);
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    const wider = await viewer.locator("[data-testid=viewer-image]").evaluate((i) => i.getBoundingClientRect().width);
    check("zoomed image grows (pan by scrolling)", wider > wide * 1.3, { wide, wider });
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    check("Escape closes the viewer", (await viewer.count()) === 0);
    check("answer unchanged after viewing (B)", await optB.locator("input").isChecked());

    await goTo(page, idx("twoImages"));
    const two = await imagesLoaded(page);
    check("two images in authored order (Figure 1 then Figure 2)", two.length === 2 && two[0].alt.startsWith("Figure 1") && two[1].alt.startsWith("Figure 2"), two);
    await page.locator("[data-testid=test-player] [data-testid=question-media] [data-testid=media-expand]").first().click();
    await viewer.waitFor({ state: "visible" });
    await viewer.locator("[data-testid=viewer-close]").click();
    await viewer.waitFor({ state: "detached" });
    check("question image tap opens viewer; Close closes it", (await viewer.count()) === 0);
    await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
    check("Next still works after the viewer", (await position(page)) === idx("twoImages") + 1);

    await goTo(page, idx("explained"));
    check("explanation images not shown during the exam", (await page.locator('img[alt^="Ray at the critical"]').count()) === 0);
    await goTo(page, idx("decorative"));
    const decAlt = await page.locator("[data-testid=test-player] [data-testid=question-media] img").getAttribute("alt");
    check('decorative image has alt=""', decAlt === "");
    check("M3 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // -------------------------------------------------------------------------
  console.log("M4 Phone 360 px, light + dark: fit, backing plate, viewer gestures");
  for (const dark of [false, true]) {
    const page = await newPage({ mobile: true, dark });
    await login(page, F.students.dark.email);
    await openRun(page, F.attempts.dark);
    const mode = dark ? "dark" : "light";
    for (const key of ["circuit", "graph", "ray", "biology", "molecule", "reaction", "twoImages"]) {
      await goTo(page, idx(key));
      await imagesLoaded(page);
      check(`${mode} ${key}: no page-level horizontal scroll`, await noHScroll(page));
      if (["biology", "reaction"].includes(key)) await shot(page, `mobile-${mode}-${key}`);
    }
    await goTo(page, idx("reaction"));
    const plate = await page.locator('[data-testid=option][data-label="A"] img').evaluate((i) => ({ bg: getComputedStyle(i).backgroundColor, w: i.getBoundingClientRect().width, vw: innerWidth }));
    check(`${mode}: transparent line art sits on a white plate`, plate.bg === "rgb(255, 255, 255)", plate);
    check(`${mode}: option image fits the screen`, plate.w <= plate.vw - 32, plate);
    const filter = await page.locator('[data-testid=option][data-label="A"] img').evaluate((i) => getComputedStyle(i).filter);
    check(`${mode}: image not inverted/recoloured`, filter === "none", filter);
    await page.locator('[data-testid=option][data-label="D"] label, [data-testid=option][data-label="D"]').first().tap();
    check(`${mode}: tapping option D selects it`, await page.locator('[data-testid=option][data-label="D"] input').isChecked());
    await goTo(page, idx("biology"));
    await page.locator("[data-testid=test-player] [data-testid=media-expand]").first().tap();
    const viewer = page.locator("[data-testid=image-viewer]");
    await viewer.waitFor({ state: "visible" });
    const img = viewer.locator("[data-testid=viewer-image]");
    const box = await img.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
    check(`${mode}: double-tap zooms to 250%`, (await viewer.locator("[data-testid=viewer-zoom]").textContent()) === "250%");
    await shot(page, `mobile-${mode}-viewer-zoomed`);
    const scrolled = await viewer.locator(".overflow-auto").evaluate((el) => {
      el.scrollLeft = 120;
      return el.scrollLeft;
    });
    check(`${mode}: zoomed image pans (scrollable)`, scrolled > 0, scrolled);
    await viewer.locator("[data-testid=viewer-close]").tap();
    await viewer.waitFor({ state: "detached" });
    check(`${mode}: viewer closes; no page scroll lock left`, (await page.evaluate(() => document.body.style.overflow)) === "");
    await page.getByRole("button", { name: /Previous/ }).first().tap();
    check(`${mode}: Previous works after the viewer`, (await position(page)) === idx("biology") - 1);
    check(`M4 ${mode} no page errors`, page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // -------------------------------------------------------------------------
  console.log("M5 Practice reveal + Review: explanation images; history after replace");
  {
    const page = await newPage();
    await login(page, F.students.practice.email);
    await openRun(page, F.attempts.practice);
    await goTo(page, idx("explained"));
    await page.locator('[data-testid=option][data-label="A"] input').click();
    await page.locator("[data-testid=human-explanation]").waitFor({ timeout: 15000 });
    const ex = await imagesLoaded(page, "[data-testid=human-explanation]");
    check("after reveal: 2 explanation images loaded, in order", ex.length === 2 && ex.every((i) => i.ok) && ex[0].alt.startsWith("Ray at the critical"), ex);
    await shot(page, "desktop-practice-explanation-images");
    await page.context().close();

    // Admin replaces the circuit image; the submitted attempt must keep the old one.
    const oldKey = (await q1(`select "storageKey", id from "QuestionAsset" where "questionId" = $1`, [F.ids.circuit]));
    const admin = await newPage();
    await adminLogin(admin);
    const replaced = await admin.evaluate(
      async ({ url, assetId, b64 }) => {
        const fd = new FormData();
        fd.append("replaceAssetId", assetId);
        fd.append("alt", "Circuit (corrected)");
        fd.append("file", new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" }), "circuit-v2.png");
        const r = await fetch(url, { method: "POST", body: fd });
        return { status: r.status, body: await r.json() };
      },
      { url: `${BASE}/api/admin/questions/${F.ids.circuit}/assets`, assetId: oldKey.id, b64: readFileSync(path.join(process.env.FX_DIR, "graph.png")).toString("base64") }
    );
    check("admin replaced the circuit image (new key)", replaced.status === 200 && replaced.body.asset.storageKey !== oldKey.storageKey, replaced);
    await admin.context().close();

    const rv = await newPage({ mobile: true });
    await login(rv, F.students.review.email);
    await rv.goto(`${BASE}/student/attempt/${F.attempts.review}/review`);
    await rv.locator("[data-testid=review-nav]").waitFor();
    const reviewImgs = await imagesLoaded(rv, "main");
    check("old submitted attempt still shows the ORIGINAL circuit image", reviewImgs.length === 1 && reviewImgs[0].ok && reviewImgs[0].src === `/media/${oldKey.storageKey}`, reviewImgs);
    const next = rv.locator("[data-testid=review-nav] button[aria-label='Next question']");
    for (let i = 0; i < idx("explained"); i++) await next.click();
    const rex = await imagesLoaded(rv, "[data-testid=human-explanation]");
    check("review: explanation images loaded", rex.length === 2 && rex.every((i) => i.ok));
    check("review on phone: no horizontal scroll", await noHScroll(rv));
    await rv.context().close();
  }

  // -------------------------------------------------------------------------
  console.log("M6 180-question paper (60 image questions) on a throttled phone: preload, cache, transfer");
  {
    const page = await newPage({ mobile: true });
    await login(page, F.students.perf.email);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    // ~4G-ish phone link.
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 120, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (1 * 1024 * 1024) / 8 });
    const media = [];
    page.on("response", async (r) => {
      if (new URL(r.url()).pathname.startsWith("/media/")) media.push({ url: new URL(r.url()).pathname, fromCache: r.fromServiceWorker() || (await r.request().sizes().then((s) => s.responseBodySize === 0).catch(() => false)) });
    });
    const t0 = Date.now();
    await openRun(page, F.attempts.perf);
    await imagesLoaded(page);
    const firstLoad = Date.now() - t0;
    const initialMedia = [...new Set(media.map((m) => m.url))];
    info(`first load incl. Q1 image: ${firstLoad} ms; media requested on load: ${initialMedia.length} (Q1 + Q2 preload expected; Q2 has none)`);
    check("on load: only the current (and next) question's images are fetched — not the paper's 60", initialMedia.length <= 2, initialMedia);

    // Preload: Q3 → Q4 (image) must be requested while on Q3; Q7 not.
    await goTo(page, 2);
    await page.waitForTimeout(300);
    const q4Requested = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => new URL(e.name).pathname.startsWith("/media/")).length);
    await page.waitForTimeout(1500);
    const t1 = Date.now();
    await goTo(page, 3);
    const preloadedReady = await page.locator("[data-testid=test-player] [data-testid=question-media] img").first().evaluate((i) => i.complete && i.naturalWidth > 0);
    const preloadedMs = Date.now() - t1;
    check("next question's image was preloaded: complete the moment it is shown", preloadedReady, { q4Requested });
    // Not preloaded: palette jump straight to Q100 (index 99 has an image), skipping Q5–Q99.
    await page.locator('[data-testid=palette] button[aria-label="Go to question 100"]').scrollIntoViewIfNeeded();
    const t2 = Date.now();
    await page.locator('[data-testid=palette] button[aria-label="Go to question 100"]').tap();
    await page.waitForFunction(() => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes("100"));
    const coldReady = await page.locator("[data-testid=test-player] [data-testid=question-media] img").first().evaluate((i) => i.complete && i.naturalWidth > 0);
    await imagesLoaded(page);
    const coldMs = Date.now() - t2;
    const single = await page.evaluate(() => {
      const src = document.querySelector("[data-testid=test-player] [data-testid=question-media] img")?.getAttribute("src");
      const e = performance.getEntriesByType("resource").find((x) => x.name.endsWith(src));
      return e ? { ms: Math.round(e.responseEnd - e.startTime), transferKiB: Math.round(e.transferSize / 1024), decodedKiB: Math.round(e.decodedBodySize / 1024) } : null;
    });
    info(`throttled phone: preloaded next image complete on arrival = ${preloadedReady} (shown in ${preloadedMs} ms); NOT preloaded (palette jump) complete on arrival = ${coldReady}, loaded in ${coldMs} ms ${JSON.stringify(single)}`);
    check("a non-preloaded image is NOT already there (preload is targeted, not the whole paper)", coldReady === false);

    const all = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => new URL(e.name).pathname.startsWith("/media/")).map((e) => ({ n: e.name, t: e.transferSize, d: e.decodedBodySize })));
    const uniq = [...new Map(all.map((x) => [x.n, x])).values()];
    info(`after visiting Q1–Q4 and Q100: ${uniq.length} distinct images, ${(uniq.reduce((s, x) => s + x.d, 0) / 1024).toFixed(0)} KiB decoded, ${(uniq.reduce((s, x) => s + x.t, 0) / 1024).toFixed(0)} KiB transferred`);
    check("only visited questions' images + one preload each were fetched (not 60)", uniq.length <= 4, uniq.map((x) => x.n.slice(-20)));

    // Cached reload: immutable files come from the HTTP cache, no network.
    await releaseLease(F.attempts.perf);
    await page.reload();
    await page.locator("[data-testid=test-player]").waitFor();
    await imagesLoaded(page);
    const cached = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => new URL(e.name).pathname.startsWith("/media/")).map((e) => e.transferSize));
    check("reload: images served from cache (0 bytes transferred)", cached.length > 0 && cached.every((t) => t === 0), cached);
    const mem = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : null));
    info(`JS heap after paper: ${mem} MiB`);
    check("M6 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }
} catch (e) {
  failed++;
  console.log(`FAIL  suite crashed: ${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
} finally {
  await browser.close();
  await db.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
