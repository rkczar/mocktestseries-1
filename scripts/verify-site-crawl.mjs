/**
 * SITE CRAWL — every reachable page, per persona, in a real browser.
 *
 * Breadth-first from each persona's entry points, following same-origin
 * links inside that persona's area, and reporting per page: HTTP status of
 * the document, redirects to /login (an authenticated persona must never be
 * bounced there), the error-boundary / crash screen, uncaught page errors,
 * console errors and every 4xx/5xx sub-request. Route existence is not the
 * check — a page passes only if it actually renders without errors.
 *
 * Personas: anonymous visitor, free student, paid student, Master Admin.
 * Runs only against a LOCAL production build backed by a DISPOSABLE copy of
 * production (see scripts/critical-flows-fixture.ts for the setup):
 *
 *   BASE=http://localhost:3100 FIXTURE=/tmp/flows.json NODE_PATH=<dir containing playwright> \
 *     node scripts/verify-site-crawl.mjs [anonymous|free|paid|admin ...]
 *
 * Never point this at production: it follows "Start" links, which create
 * test attempts for the fixture students.
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE || "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This crawl only runs against a local server backed by a disposable database.");
  process.exit(2);
}
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const MAX_PAGES = Number(process.env.MAX_PAGES || 400);
const MOBILE = process.env.MOBILE === "1";

const PERSONAS = {
  anonymous: { seeds: ["/", "/exams", `/exams/${F.examSlug}`, "/login", "/contact"], allow: (p) => !p.startsWith("/admin") && !p.startsWith("/student") },
  free: { login: F.students.free.email, seeds: ["/student/dashboard", "/", `/exams/${F.examSlug}/mock-test-series`], allow: (p) => !p.startsWith("/admin") },
  paid: { login: F.students.paid.email, seeds: ["/student/dashboard", "/student/test-series"], allow: (p) => p.startsWith("/student") },
  admin: { admin: true, seeds: ["/admin"], allow: (p) => p.startsWith("/admin") },
};

// Links that change session state or download files are not "pages".
const SKIP = [/\/logout/, /signout/i, /^\/api\//, /\/storage\//, /\.(pdf|csv|xlsx|zip|png|jpg|svg|webmanifest)$/i, /^\/admin\/login/, /^\/sw\.js/];

// Detail pages are sampled, not exhausted: at most PER_TEMPLATE pages per
// route shape (ids → :id, query values dropped), so a crawl covers every
// distinct page type instead of 2,000 question-edit pages.
const PER_TEMPLATE = Number(process.env.PER_TEMPLATE || 2);
function template(p) {
  const [pathname, query = ""] = p.split("?");
  const shape = pathname
    .split("/")
    .map((seg) => (/^c[a-z0-9]{20,}$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^\d+$/.test(seg) || /^[A-Z]+-?\d{3,}/.test(seg) ? ":id" : seg))
    .join("/");
  const keys = [...new URLSearchParams(query).keys()].sort().join("&");
  return keys ? `${shape}?${keys}` : shape;
}

let failures = 0;
const report = [];

function normalize(href, from) {
  try {
    const u = new URL(href, from);
    if (u.origin !== BASE) return null;
    u.hash = "";
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

async function loginStudent(page, email) {
  await page.goto(`${BASE}/login`);
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await Promise.all([page.waitForURL(/\/student\//, { timeout: 30000 }), page.locator("form:has(#identifier) button[type=submit]").click()]);
}

async function loginAdmin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.adminUsername);
  await page.fill("input[name=password]", F.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}

async function crawl(name) {
  const persona = PERSONAS[name];
  const browser = await chromium.launch();
  const ctx = await browser.newContext(MOBILE ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
  const page = await ctx.newPage();
  if (persona.login) await loginStudent(page, persona.login);
  if (persona.admin) await loginAdmin(page);

  let current = null;
  const issues = new Map(); // path -> [issue]
  const note = (msg) => {
    if (!current) return;
    if (!issues.has(current)) issues.set(current, []);
    const list = issues.get(current);
    if (!list.includes(msg)) list.push(msg);
  };
  page.on("pageerror", (e) => note(`pageerror: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // A sub-request failure is reported once, with its URL, by the response hook.
    if (/Failed to load resource/.test(t)) return;
    note(`console: ${t.slice(0, 160)}`);
  });
  page.on("response", (r) => {
    const s = r.status();
    if (s < 400) return;
    const url = r.url().replace(BASE, "");
    // An anonymous visitor's 401 from a student-only API is the correct answer.
    if (name === "anonymous" && s === 401) return;
    note(`HTTP ${s} ${url.slice(0, 120)}`);
  });

  const queue = [...persona.seeds];
  const seen = new Set(queue);
  const perTemplate = new Map();
  let visited = 0;
  while (queue.length && visited < MAX_PAGES) {
    const path = queue.shift();
    current = path;
    visited++;
    let status = 0;
    try {
      const res = await page.goto(BASE + path, { waitUntil: "load", timeout: 45000 });
      status = res?.status() ?? 0;
      await page.waitForTimeout(400);
    } catch (e) {
      note(`navigation failed: ${e.message.split("\n")[0].slice(0, 120)}`);
    }
    const finalPath = normalize(page.url(), BASE) ?? page.url();
    const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
    if (status >= 500) note(`document HTTP ${status}`);
    if (status === 404 && !/[?&]__probe/.test(path)) note(`document HTTP 404`);
    if (/This page couldn.t load|Application error|Something went wrong/i.test(text)) note(`crash/error screen rendered`);
    if (name !== "anonymous" && finalPath.startsWith("/login")) note(`bounced to login → ${finalPath}`);
    if (name === "admin" && finalPath.startsWith("/admin/login")) note(`admin bounced to login`);

    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href"))).catch(() => []);
    for (const href of links) {
      const p = normalize(href, page.url());
      if (!p || seen.has(p)) continue;
      const pathname = p.split("?")[0];
      if (!persona.allow(pathname) || SKIP.some((re) => re.test(pathname))) continue;
      seen.add(p);
      const t = template(p);
      const n = perTemplate.get(t) ?? 0;
      if (n >= PER_TEMPLATE) continue;
      perTemplate.set(t, n + 1);
      queue.push(p);
    }
  }
  await browser.close();

  const bad = [...issues.entries()];
  console.log(`\n=== ${name}${MOBILE ? " (mobile)" : ""}: ${visited} pages visited (${perTemplate.size} route shapes), ${bad.length} with issues${queue.length ? `, ${queue.length} not visited (MAX_PAGES)` : ""} ===`);
  for (const [p, list] of bad) {
    console.log(`  FAIL  ${p}`);
    for (const i of list) console.log(`          - ${i}`);
  }
  failures += bad.length;
  report.push({ persona: name, visited, issues: Object.fromEntries(bad) });
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PERSONAS);
for (const name of wanted) await crawl(name);
if (process.env.REPORT) fs.writeFileSync(process.env.REPORT, JSON.stringify(report, null, 2));
console.log(`\n=== ${failures === 0 ? "ALL PAGES CLEAN" : `${failures} PAGE(S) WITH ISSUES`} ===`);
process.exit(failures === 0 ? 0 : 1);
