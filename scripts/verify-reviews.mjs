/**
 * Student Reviews / Testimonials — browser + HTTP verification against a
 * `next start` server on a DISPOSABLE database prepared by
 * `scripts/verify-reviews.ts setup` (fixture JSON at $FIXTURE).
 *
 * Covers: zero-review homepage, admin add/edit/order/feature/publish/unpublish/
 * bulk/delete/settings, cache invalidation to the homepage, XSS, student
 * submission (eligibility, spam, pending), approve → Verified badge rules,
 * FULL_ADMIN read-only + server-side refusal, anonymous action calls,
 * desktop/mobile marquee (RTL motion, hover pause, touch swipe), reduced
 * motion, dark/light screenshots.
 *
 *   BASE=http://localhost:3115 FIXTURE=/path/reviews-fixture.json SHOTS=/dir \
 *   NODE_PATH=/root/.claude/skills/gstack/node_modules node scripts/verify-reviews.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:3115";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? null;
const manifest = JSON.parse(readFileSync(new URL("../.next/server/server-reference-manifest.json", import.meta.url), "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, v]) => v.exportedName === name && /reviews|review-actions/.test(v.filename))?.[0];

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
async function newPage(opts = {}) {
  const ctx = await browser.newContext(opts.mobile ? { ...devices["Pixel 7"], reducedMotion: opts.reducedMotion } : { viewport: { width: 1440, height: 900 }, reducedMotion: opts.reducedMotion });
  const page = await ctx.newPage();
  page.errors = [];
  page.dialogs = [];
  page.on("pageerror", (e) => page.errors.push(e.message.slice(0, 160)));
  page.on("response", (r) => r.status() >= 500 && page.errors.push(`HTTP ${r.status()} ${r.url()}`));
  page.on("dialog", (d) => {
    page.dialogs.push(d.message());
    d.accept();
  });
  return page;
}
async function adminLogin(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("#username", username);
  await page.fill("#password", F.password);
  await page.locator("form button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 });
}
async function studentLogin(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  await page.waitForLoadState("load");
}
/** Raw Server Action call from inside the page (keeps cookies). JSON args. */
async function rawAction(page, path, id, args) {
  return page.evaluate(
    async ({ path, id, args }) => {
      const r = await fetch(path, { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: JSON.stringify(args) });
      return { status: r.status, text: await r.text() };
    },
    { path, id, args }
  );
}
/** Raw Server Action call with a single FormData argument. */
async function rawFormAction(page, path, id, fields) {
  return page.evaluate(
    async ({ path, id, fields }) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(`_1_${k}`, v);
      fd.append("0", JSON.stringify(["$K1"]));
      const r = await fetch(path, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component" }, body: fd });
      return { status: r.status, text: await r.text() };
    },
    { path, id, fields }
  );
}
async function homepageSection(page) {
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  return page.locator("#student-reviews");
}
/** Signed movement between two translateX readings, unwrapping one loop period. */
const moved = async (page, a, b) => {
  const period = await page.evaluate(() => document.querySelector("#student-reviews ul")?.offsetWidth ?? 0);
  let d = b - a;
  if (period && d > period / 2) d -= period;
  if (period && d < -period / 2) d += period;
  return d;
};
const hoverCard = async (page, section) => {
  const box = await section.locator("[data-review-card]").first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};
const translateX = (page) =>
  page.evaluate(() => {
    const t = document.querySelector("#student-reviews [data-review-card]")?.closest("ul")?.parentElement;
    const m = t ? getComputedStyle(t).transform : "none";
    return m === "none" ? 0 : new DOMMatrix(m).m41;
  });

// ---------------------------------------------------------------------------
// The fixture script writes the DB directly (no cache invalidation); one
// admin settings save refreshes the cached homepage reviews like any admin
// change does.
const admin = await newPage();
await adminLogin(admin, F.master);
await admin.goto(`${BASE}/admin/reviews`, { waitUntil: "load" });
await admin.getByRole("button", { name: "Save Settings" }).click();
await admin.getByText("Homepage review settings saved.").waitFor({ timeout: 15000 });

console.log("— Homepage with zero reviews");
{
  const page = await newPage();
  const res = await page.goto(`${BASE}/`, { waitUntil: "load" });
  check("homepage 200 with zero reviews", res.status() === 200, res.status());
  check("no reviews section when nothing is published", (await page.locator("#student-reviews").count()) === 0);
  check("rest of homepage renders (footer present)", (await page.locator("footer").count()) > 0);
  check("no page errors", page.errors.length === 0, page.errors);
  const anon = await page.request.get(`${BASE}/admin/reviews`, { maxRedirects: 0 });
  check("anonymous /admin/reviews redirects to login", [302, 303, 307].includes(anon.status()) && /\/admin\/login/.test(anon.headers().location ?? ""), anon.status());
  const r = await rawAction(page, "/admin/reviews", actionId("bulkReviewAction"), ["delete", ["x"]]);
  check("anonymous bulk action refused", !r.text.includes('"ok":true'), r.text.slice(0, 200));
  const s = await rawFormAction(page, "/student/dashboard", actionId("submitStudentReviewAction"), { rating: "5", comment: "Anonymous attempt to post a review here." });
  check("anonymous student submission refused", !s.text.includes('"ok":true'), s.text.slice(0, 200));
  await page.context().close();
}

console.log("— Master admin: manage testimonials");
{
  await admin.goto(`${BASE}/admin/reviews`, { waitUntil: "load" });
  check("Reviews link in admin sidebar", (await admin.locator('nav[aria-label="Admin navigation"] a[href="/admin/reviews"]').count()) > 0);
  check("empty state shown", await admin.getByText("No reviews yet.").isVisible());

  const add = async (name, rating, comment, exam = "") => {
    const form = admin.locator("form:has(#new-review-name)");
    await form.locator("#new-review-name").fill(name);
    await form.locator("#new-review-exam").fill(exam);
    await form.locator("#new-review-rating").selectOption(String(rating));
    await form.locator("#new-review-comment").fill(comment);
    await Promise.all([
      admin.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/admin/reviews")),
      form.getByRole("button", { name: "Add Testimonial" }).click(),
    ]);
    await form.getByText("Testimonial added.").waitFor({ timeout: 15000 });
    await admin.waitForFunction(() => document.querySelector("#new-review-name")?.value === "", null, { timeout: 15000 });
  };
  await add("Anita Verma", 5, "The full-length mock tests felt exactly like the real exam. Highly recommended for every aspirant preparing seriously.", "RUHS Medical Officer");
  await add("Rohit K.", 4, "PYQ explanations are clear and the analytics help me fix weak topics.");
  await add("Meena S.", 5, "Ask AI explanations saved me hours of searching through textbooks.");
  await add("Xss Test", 3, '<img src=x onerror="window.__xss=1">Practice <b>sets</b> are good <script>window.__xss=2</script>');
  await admin.reload({ waitUntil: "load" });
  check("4 testimonials listed", (await admin.locator("tbody tr").count()) === 4, await admin.locator("tbody tr").count());
  const xssRow = admin.locator("tbody tr", { hasText: "Xss Test" });
  const xssText = await xssRow.locator("td").nth(1).innerText();
  check("XSS input stored as plain text (tags + script body stripped)", !/[<>]/.test(xssText) && /Practice sets are good/.test(xssText) && !xssText.includes("__xss"), xssText);
  check("admin-added rows labelled Admin-added", (await admin.locator("tbody", { hasText: "Admin-added" }).count()) === 1 && !(await admin.locator("tbody").innerText()).includes("Student-submitted"));

  // Edit
  await admin.locator("tbody tr", { hasText: "Rohit K." }).getByRole("button", { name: "Edit" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.locator("textarea[name=comment]").fill("PYQ explanations are clear, and the analytics help me fix weak topics quickly.");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15000 });
  await admin.reload({ waitUntil: "load" });
  check("edit saved", (await admin.locator("tbody tr", { hasText: "Rohit K." }).innerText()).includes("weak topics quickly"));
  check("edit recorded (Edited … by)", (await admin.locator("tbody tr", { hasText: "Rohit K." }).innerText()).includes("Edited"));

  // Display order + featured
  const order = admin.getByLabel("Display order for Meena S.");
  await order.fill("-5");
  await order.blur();
  await admin.getByText("Order saved.").waitFor({ timeout: 15000 });
  await admin.locator("tbody tr", { hasText: "Anita Verma" }).getByRole("button", { name: "Feature", exact: true }).click();
  await admin.getByText("1 review marked featured.").waitFor({ timeout: 15000 });
}

console.log("— Homepage reflects admin changes (cache invalidated)");
{
  const page = await newPage();
  const section = await homepageSection(page);
  check("section visible after publishing", (await section.count()) === 1);
  check("default heading", (await section.locator("h2").innerText()) === "What Students Say");
  const names = await section.locator("ul:not([aria-hidden]) > li:not([aria-hidden]) figcaption .truncate.font-medium").allInnerTexts();
  check("4 accessible cards", names.length === 4, names);
  // Featured first, then display order (Meena -5), then newest approved first for equal order.
  check("featured first, then display order", JSON.stringify(names) === JSON.stringify(["Anita Verma", "Meena S.", "Xss Test", "Rohit K."]), names);
  check("no Verified badge on admin testimonials", (await section.getByText("Verified Student").count()) === 0);
  check("exam name shown", await section.getByText("RUHS Medical Officer").first().isVisible());
  check("stars rendered with label", (await section.locator('[role=img][aria-label="5 out of 5 stars"]').count()) > 0);
  check("XSS payload did not execute", (await page.evaluate(() => window.__xss)) === undefined);
  check("no injected <img>/<script> inside section", (await section.locator("img, script").count()) === 0);
  check("no review/rating structured data", !(await page.content()).match(/"@type":\s*"(Review|AggregateRating)"/));
  const html = await page.evaluate(() => fetch("/").then((r) => r.text()));
  check("raw HTML carries no review ids/emails/student codes", !/qa-reviews\.test|MTS\d|"studentId"/.test(html.slice(html.indexOf("student-reviews"))));

  // Placement: after Benefits/features, before the pricing promo / closing CTA.
  const order = await page.evaluate(() => [...document.querySelectorAll("main > section")].map((s) => s.id || s.querySelector("h2")?.textContent?.slice(0, 30) || "?"));
  const idx = order.indexOf("student-reviews");
  check("section placed before the pricing / CTA area", idx > 0 && order.slice(idx + 1).some((id) => /complete-access|cta|start/i.test(id)) , order);

  // Motion: right → left, pause on hover.
  await section.scrollIntoViewIfNeeded();
  const x0 = await translateX(page);
  await sleep(1200);
  const x1 = await translateX(page);
  check("auto-scrolls right → left (translateX decreasing)", (await moved(page, x0, x1)) < -10, { x0, x1 });
  await hoverCard(page, section);
  await sleep(300);
  const h0 = await translateX(page);
  await sleep(800);
  const h1 = await translateX(page);
  check("pauses on hover", Math.abs(h1 - h0) < 1, { h0, h1 });
  await page.mouse.move(5, 5);
  const pauseBtn = section.getByRole("button", { name: "Pause reviews auto-scroll" });
  await pauseBtn.click();
  const p0 = await translateX(page);
  await sleep(800);
  check("Pause button stops motion", Math.abs((await translateX(page)) - p0) < 1);
  await section.getByRole("button", { name: "Play reviews auto-scroll" }).click();
  await page.keyboard.press("Tab");
  const dupFocusable = await page.evaluate(() => [...document.querySelectorAll("#student-reviews [inert] [tabindex='0'], #student-reviews [aria-hidden=true] figure")].every((el) => el.closest("[inert]")));
  check("duplicate (loop) cards are inert / out of tab order", dupFocusable);
  if (SHOTS) {
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await section.screenshot({ path: `${SHOTS}/desktop-${theme}.png` });
    }
  }
  check("no page errors (desktop)", page.errors.length === 0, page.errors);
  await page.context().close();
}

console.log("— Settings");
{
  await admin.goto(`${BASE}/admin/reviews`, { waitUntil: "load" });
  await admin.fill("#reviews-heading", "Hear From Our Students");
  await admin.fill("#reviews-subtitle", "Real feedback from aspirants.");
  await admin.selectOption("#reviews-direction", "LTR");
  await admin.selectOption("#reviews-speed", "FAST");
  await admin.getByRole("button", { name: "Save Settings" }).click();
  await admin.getByText("Homepage review settings saved.").waitFor({ timeout: 15000 });
  const page = await newPage();
  const section = await homepageSection(page);
  check("custom heading + subtitle applied", (await section.locator("h2").innerText()) === "Hear From Our Students" && (await section.getByText("Real feedback from aspirants.").isVisible()));
  await section.scrollIntoViewIfNeeded();
  const a = await translateX(page);
  await sleep(1000);
  const b = await translateX(page);
  check("Left → Right direction applied (translateX increasing)", (await moved(page, a, b)) > 10, { a, b });
  await page.context().close();
  // Back to defaults for the rest of the suite.
  await admin.reload({ waitUntil: "load" });
  await admin.fill("#reviews-heading", "");
  await admin.fill("#reviews-subtitle", "");
  await admin.selectOption("#reviews-direction", "RTL");
  await admin.selectOption("#reviews-speed", "NORMAL");
  await admin.getByRole("button", { name: "Save Settings" }).click();
  await admin.getByText("Homepage review settings saved.").waitFor({ timeout: 15000 });
}

console.log("— Student submission");
{
  const fresh = await newPage();
  await studentLogin(fresh, F.fresh);
  await fresh.goto(`${BASE}/student/dashboard`, { waitUntil: "load" });
  check("no review prompt before any completed test", (await fresh.getByText("Share your experience").count()) === 0);
  const r = await rawFormAction(fresh, "/student/dashboard", actionId("submitStudentReviewAction"), { rating: "5", comment: "Trying to post without completing any test at all." });
  check("server refuses a review before any completed test", r.text.includes("Complete at least one test"), r.text.slice(0, 200));
  await fresh.context().close();

  const st = await newPage();
  await studentLogin(st, F.reviewer);
  await st.goto(`${BASE}/student/dashboard`, { waitUntil: "load" });
  const card = st.locator("div", { has: st.getByText("Share your experience", { exact: true }) }).last();
  check("review prompt shown after a completed test", await st.getByText("Share your experience", { exact: true }).isVisible());
  check("shows the masked public name", await st.getByText(/Shown publicly as “Qa S\.”/).isVisible());
  await st.getByRole("button", { name: "Write a review" }).click();
  await st.getByRole("radio", { name: "4 stars" }).click();
  await st.fill("#student-review-comment", "Great mocks, see https://spam.example for more");
  await st.getByRole("button", { name: "Submit review" }).click();
  await st.getByText("Please remove links").waitFor({ timeout: 15000 });
  check("links rejected server-side", true);
  await st.fill("#student-review-comment", "The subject tests and detailed solutions helped me improve my accuracy a lot.");
  await st.getByRole("button", { name: "Submit review" }).click();
  await st.getByText(/Your review has been submitted/).waitFor({ timeout: 15000 });
  check("submission accepted, Pending", await st.getByText("Pending approval").isVisible());
  // A second create attempt must not create a duplicate (update path + cooldown).
  const dup = await rawFormAction(st, "/student/dashboard", actionId("submitStudentReviewAction"), { rating: "1", comment: "Second rapid submission that should be throttled." });
  check("rapid resubmission throttled", dup.text.includes("Please wait"), dup.text.slice(0, 200));
  void card;
  await st.context().close();

  const page = await newPage();
  const section = await homepageSection(page);
  check("pending student review not public", !(await section.innerText()).includes("Qa S."));
  await page.context().close();
}

console.log("— Moderation: approve → Verified");
{
  await admin.goto(`${BASE}/admin/reviews?source=STUDENT_SUBMITTED&status=PENDING`, { waitUntil: "load" });
  check("filter: source + status", (await admin.locator("tbody tr").count()) === 1);
  const row = admin.locator("tbody tr", { hasText: "Qa S." });
  check("student row labelled Student-submitted with student code", /Student-submitted/.test(await row.innerText()) && /MTS/i.test(await row.innerText()));
  check("row shows no email/phone", !/@qa-reviews\.test|\+91/.test(await row.innerText()));
  check("Publish not offered before approval", (await row.getByRole("button", { name: "Publish", exact: true }).count()) === 0);
  await admin.goto(`${BASE}/admin/reviews?rating=4`, { waitUntil: "load" });
  check("filter: rating", (await admin.locator("tbody tr").count()) === 2, await admin.locator("tbody tr").count());
  await admin.goto(`${BASE}/admin/reviews?q=accuracy`, { waitUntil: "load" });
  check("search", (await admin.locator("tbody tr").count()) === 1);
  // Edit the student's displayed text: original must be preserved.
  await admin.locator("tbody tr").getByRole("button", { name: "Edit" }).click();
  await admin.getByRole("dialog").locator("textarea[name=comment]").fill("Subject tests and detailed solutions improved my accuracy.");
  await admin.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
  await admin.getByRole("dialog").waitFor({ state: "hidden", timeout: 15000 });
  await admin.reload({ waitUntil: "load" });
  check("original student submission kept after edit", await admin.getByText("Edited — view original student submission").isVisible());
  check("source unchanged after edit", /Student-submitted/.test(await admin.locator("tbody tr").innerText()));
  await admin.locator("tbody tr").getByRole("button", { name: "Approve" }).click();
  await admin.getByText("1 review approved.").waitFor({ timeout: 15000 });
  await admin.reload({ waitUntil: "load" });
  check("approved by admin recorded", /Approved .* by QA Reviews Master/.test(await admin.locator("tbody tr").innerText()));
  await admin.locator("tbody tr").getByRole("button", { name: "Publish", exact: true }).click();
  await admin.getByText("1 review published.").waitFor({ timeout: 15000 });

  const page = await newPage();
  const section = await homepageSection(page);
  const studentCard = section.locator("ul:not([aria-hidden]) > li:not([aria-hidden]) figure", { hasText: "Qa S." });
  check("approved student review public", (await studentCard.count()) === 1);
  check("Verified Student badge on the genuine student review", await studentCard.getByText("Verified Student").isVisible());
  check("Verified badge appears exactly once in the accessible group", (await section.locator("ul:not([aria-hidden]) li:not([aria-hidden])").getByText("Verified Student").count()) === 1);
  await page.context().close();

  // Reject hides it again.
  await admin.goto(`${BASE}/admin/reviews?q=accuracy`, { waitUntil: "load" });
  await admin.locator("tbody tr").getByRole("button", { name: "Reject" }).click();
  await admin.getByText("1 review rejected.").waitFor({ timeout: 15000 });
  const p2 = await newPage();
  check("rejected review removed from homepage", !(await (await homepageSection(p2)).innerText()).includes("Qa S."));
  await p2.context().close();
  // Student sees the locked state.
  const st = await newPage();
  await studentLogin(st, F.reviewer);
  await st.goto(`${BASE}/student/dashboard`, { waitUntil: "load" });
  check("student sees moderated state, cannot edit", (await st.getByText("Not published").isVisible()) && (await st.getByRole("button", { name: "Edit review" }).count()) === 0);
  await st.context().close();
}

console.log("— FULL_ADMIN is read-only (server-enforced)");
{
  const fa = await newPage();
  await adminLogin(fa, F.full);
  await fa.goto(`${BASE}/admin/reviews`, { waitUntil: "load" });
  check("read-only notice", await fa.getByText(/Read-only/).isVisible());
  check("no add form / bulk toolbar / row actions", (await fa.locator("#new-review-name").count()) === 0 && (await fa.getByRole("toolbar").count()) === 0 && (await fa.getByRole("button", { name: "Delete" }).count()) === 0);
  const before = await fa.locator("tbody tr").count();
  const r = await rawAction(fa, "/admin/reviews", actionId("bulkReviewAction"), ["delete", ["anything"]]);
  check("FULL_ADMIN raw delete refused server-side", r.text.includes("permission"), r.text.slice(0, 200));
  const s = await rawFormAction(fa, "/admin/reviews", actionId("saveReviewsSettingsAction"), { enabled: "false", heading: "x", maxReviews: "3", speed: "FAST", direction: "LTR" });
  check("FULL_ADMIN raw settings save refused", s.text.includes("permission"), s.text.slice(0, 200));
  const c = await rawFormAction(fa, "/admin/reviews", actionId("createReviewAction"), { displayName: "Sneaky", rating: "5", comment: "Should never be created by a read-only admin." });
  check("FULL_ADMIN raw create refused", c.text.includes("permission"), c.text.slice(0, 200));
  await fa.reload({ waitUntil: "load" });
  check("nothing changed", (await fa.locator("tbody tr").count()) === before);
  await fa.context().close();
}

console.log("— Mobile, swipe, reduced motion");
{
  const page = await newPage({ mobile: true });
  const section = await homepageSection(page);
  await section.scrollIntoViewIfNeeded();
  const w = await section.locator("[data-review-card]").first().evaluate((el) => el.getBoundingClientRect().width / window.innerWidth);
  check("mobile card ≈ 1–1.3 per screen", w > 0.7 && w < 0.85, w);
  check("no horizontal page scroll on mobile", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const m0 = await translateX(page);
  await sleep(1000);
  check("auto-scroll continues on mobile", (await moved(page, m0, await translateX(page))) < -5);
  // Touch swipe: drag right by 120px.
  const box = await section.locator("[data-review-card]").first().boundingBox();
  const s0 = await translateX(page);
  await page.evaluate(({ x, y }) => {
    const vp = document.querySelector("#student-reviews [data-review-card]").closest("ul").parentElement.parentElement;
    const ev = (type, cx) => new PointerEvent(type, { pointerType: "touch", clientX: cx, clientY: y, bubbles: true, isPrimary: true });
    vp.dispatchEvent(ev("pointerdown", x));
    window.dispatchEvent(ev("pointermove", x + 60));
    window.dispatchEvent(ev("pointermove", x + 120));
  }, { x: box.x + 20, y: box.y + 20 });
  const s1 = await translateX(page);
  check("manual swipe moves the row by the finger distance", Math.abs((await moved(page, s0, s1)) - 120) < 15, { s0, s1 });
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" })));
  const r0 = await translateX(page);
  await sleep(800);
  check("auto-scroll waits briefly after a swipe", Math.abs((await translateX(page)) - r0) < 1);
  if (SHOTS) {
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await section.screenshot({ path: `${SHOTS}/mobile-${theme}.png` });
    }
  }
  check("no page errors (mobile)", page.errors.length === 0, page.errors);
  await page.context().close();

  for (const mobile of [false, true]) {
    const rm = await newPage({ mobile, reducedMotion: "reduce" });
    const sec = await homepageSection(rm);
    await sec.scrollIntoViewIfNeeded();
    await sleep(800);
    check(`reduced motion (${mobile ? "mobile" : "desktop"}): no transform`, (await translateX(rm)) === 0);
    const info = await rm.evaluate(() => {
      const card = document.querySelector("#student-reviews [data-review-card]");
      const vp = card.closest("ul").parentElement.parentElement;
      const hiddenCopies = [...document.querySelectorAll("#student-reviews [aria-hidden=true]")].filter((e) => e.matches("ul, li")).every((e) => getComputedStyle(e).display === "none");
      return { overflow: getComputedStyle(vp).overflowX, hiddenCopies, pauseBtn: getComputedStyle(document.querySelector("#student-reviews button[aria-pressed]")).display };
    });
    check(`reduced motion (${mobile ? "mobile" : "desktop"}): scrollable row, copies hidden, no pause button`, info.overflow === "auto" && info.hiddenCopies && info.pauseBtn === "none", info);
    await rm.context().close();
  }
}

console.log("— Bulk unpublish / delete → zero-review state");
{
  await admin.goto(`${BASE}/admin/reviews`, { waitUntil: "load" });
  await admin.getByLabel("Select all reviews").check();
  await admin.getByRole("toolbar").getByRole("button", { name: "Unpublish" }).click();
  await admin.getByText(/reviews? hidden\./).waitFor({ timeout: 15000 });
  let page = await newPage();
  check("bulk unpublish hides the section", (await (await homepageSection(page)).count()) === 0);
  await page.context().close();
  await admin.reload({ waitUntil: "load" });
  await admin.getByLabel("Select all reviews").check();
  await admin.getByRole("toolbar").getByRole("button", { name: "Publish", exact: true }).click();
  await admin.getByText(/published\..*skipped — only approved/).waitFor({ timeout: 15000 });
  check("bulk publish skips the rejected student review", true);
  await admin.reload({ waitUntil: "load" });
  await admin.locator("tbody tr", { hasText: "Xss Test" }).getByRole("button", { name: "Delete" }).click();
  await admin.getByText("1 review deleted.").waitFor({ timeout: 15000 });
  check("single delete asks for confirmation", admin.dialogs.some((d) => /Permanently delete 1 review/.test(d)));
  await admin.reload({ waitUntil: "load" });
  await admin.getByLabel("Select all reviews").check();
  await admin.getByRole("toolbar").getByRole("button", { name: "Delete" }).click();
  await admin.getByText(/reviews? deleted\./).waitFor({ timeout: 15000 });
  await admin.reload({ waitUntil: "load" });
  check("admin empty state after deleting all", await admin.getByText("No reviews yet.").isVisible());
  page = await newPage();
  check("homepage hides section with zero reviews", (await (await homepageSection(page)).count()) === 0);
  check("homepage still renders", (await page.locator("footer").count()) > 0 && page.errors.length === 0, page.errors);
  await page.context().close();
  check("no admin page errors", admin.errors.length === 0, admin.errors);
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
