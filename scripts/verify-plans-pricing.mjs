/**
 * Public Plans & Pricing (/plans-and-pricing) end-to-end checks against a
 * `next start` on a SCRATCH database seeded by scripts/plans-pricing-fixture.ts.
 *
 *   BASE=http://localhost:3141 FIXTURE=/tmp/plans.json DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-plans-pricing.mjs
 *
 * Covers: guest SSR HTML (title, description, canonical, robots, one H1,
 * BreadcrumbList / WebPage / OfferCatalog JSON-LD whose prices match the
 * cards), listing rules, guest → login, per-student ownership states (no
 * duplicate Buy for covered access), Renew, sitemap/robots, nav links,
 * /student/plans redirect, Admin price/deactivate changes, desktop/mobile
 * layout and console/hydration errors.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://localhost:3141";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE ?? "/tmp/plans.json", "utf8"));
const PATH = "/plans-and-pricing";
let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

async function get(path, token) {
  const res = await fetch(BASE + path, { headers: token ? { cookie: `student-session-token=${token}` } : {}, redirect: "manual" });
  return { status: res.status, headers: res.headers, html: res.status === 200 ? await res.text() : "" };
}
const meta = (html, re) => (html.match(re) ?? [])[1] ?? null;
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
/** The plan card / row for a product code: its HTML slice. */
function planHtml(html, code) {
  const start = html.indexOf(`id="plan-${code}"`);
  if (start < 0) return null;
  const next = html.indexOf('id="plan-', start + 10);
  return html.slice(start, next < 0 ? start + 6000 : next);
}
const stateOf = (html, code) => (planHtml(html, code)?.match(/data-plan-state="([^"]+)"/) ?? [])[1] ?? null;
const P = F.products;
const fixture = (...args) =>
  execFileSync("npx", ["tsx", "scripts/plans-pricing-fixture.ts", ...args], { env: process.env, encoding: "utf8" }).trim();

console.log("1. Guest server-rendered HTML");
const g = await get(PATH);
check("200 without login", g.status === 200, String(g.status));
check("Cache-Control private / no-store (no shared caching)", /private/.test(g.headers.get("cache-control") ?? "") && /no-store/.test(g.headers.get("cache-control") ?? ""), g.headers.get("cache-control"));
const title = meta(g.html, /<title>([^<]*)<\/title>/);
check("unique title (50–60 chars)", title === "RUHS MO 2026 Test Series Price &amp; Plans — MockTestSeries.in" || title === "RUHS MO 2026 Test Series Price & Plans — MockTestSeries.in", title);
const desc = meta(g.html, /<meta name="description" content="([^"]*)"/);
check("meta description 150–160 chars", desc !== null && desc.length >= 150 && desc.length <= 160, `${desc?.length}: ${desc}`);
// Absolute URLs use the configured site URL (SEO settings), not the scratch server origin.
const canonical = meta(g.html, /<link rel="canonical" href="([^"]*)"/);
const SITE = canonical ? new URL(canonical).origin : BASE;
check("self-referencing canonical", canonical === `${SITE}${PATH}`, canonical);
check("robots index, follow", /<meta name="robots" content="index, follow"/.test(g.html));
check("og:title / og:url / og:description", /property="og:title"/.test(g.html) && new RegExp(`property="og:url" content="${SITE}${PATH}"`).test(g.html) && /property="og:description"/.test(g.html));
check("exactly one H1", (g.html.match(/<h1[\s>]/g) ?? []).length === 1);
check("H2 and H3 headings present", (g.html.match(/<h2[\s>]/g) ?? []).length >= 4 && (g.html.match(/<h3[\s>]/g) ?? []).length >= 4);
for (const k of ["series", "mock2", "mock3", "pyq", "passC"]) check(`shown: ${k}`, planHtml(g.html, P[k].code) !== null);
for (const k of ["freeMock", "draftMock", "inactive", "invisible", "free", "inactiveExam"]) check(`hidden: ${k}`, !g.html.includes(P[k].code) && !g.html.includes(P[k].name));
check("single mocks show the mock title, not the product name", planHtml(g.html, P.mock2.code)?.includes("Plans QA Mock 2") && !g.html.includes(P.mock2.name));
const examHeadings = [...g.html.matchAll(/<h2 id="exam-[^"]+"[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<!-- -->/g, ""));
check("groups by exam (both active exams, inactive exam hidden)", examHeadings.length === 2 && examHeadings[0] === "Plans QA Medical Officer 2026 Plans" && examHeadings[1] === "Plans QA Second Plans", JSON.stringify(examHeadings));
check("category headings", ["Test Series Packages", "Previous Year Paper Packages", "Single Mock Tests", "Complete Access Plans"].every((h) => g.html.includes(h)));
const series = planHtml(g.html, P.series.code) ?? "";
check("series: sale price ₹899.10, MRP ₹2,000, 55% OFF, validity", series.includes("₹899.10") && series.includes("₹2,000") && /55(<!-- -->)?% OFF/.test(series) && series.includes("100 days"), series.slice(0, 400));
check("series: admin benefits listed", (series.match(/<li/g) ?? []).length >= 1);
check("PYQ: ₹499, lifetime", (planHtml(g.html, P.pyq.code) ?? "").includes("₹499") && /lifetime/i.test(planHtml(g.html, P.pyq.code) ?? ""));
check("guest Buy Now → /login?callbackUrl=checkout", series.includes(`href="/login?callbackUrl=${encodeURIComponent(`/student/checkout/${P.series.code}`)}"`));
check("guest: no ownership state rendered", [...g.html.matchAll(/data-plan-state="([^"]+)"/g)].every((m) => m[1] === "guest"));

const ld = ldBlocks(g.html);
const crumbs = ld.find((b) => b["@type"] === "BreadcrumbList");
check("BreadcrumbList: Home → Plans & Pricing", crumbs?.itemListElement?.length === 2 && crumbs.itemListElement[0].item === `${SITE}/` && crumbs.itemListElement[1].name === "Plans & Pricing");
const page = ld.find((b) => b["@type"] === "WebPage");
check("WebPage with absolute url", page?.url === `${SITE}${PATH}` && page["@context"] === "https://schema.org");
const offers = page?.mainEntity?.itemListElement ?? [];
check("OfferCatalog (not one Product) with 5 offers", page?.mainEntity?.["@type"] === "OfferCatalog" && offers.length === 5 && !ld.some((b) => b["@type"] === "Product"), String(offers.length));
check("no ratings / reviews in structured data", !JSON.stringify(ld).match(/aggregateRating|"review"/i));
const seriesOffer = offers.find((o) => o.url.endsWith(`#plan-${P.series.code}`));
check("structured price = displayed price (series 899.10 INR, priceValidUntil)", seriesOffer?.price === "899.10" && seriesOffer.priceCurrency === "INR" && /^\d{4}-\d{2}-\d{2}$/.test(seriesOffer.priceValidUntil ?? ""));
check("every offer price appears on its card", offers.every((o) => {
  const code = o.url.split("#plan-")[1];
  const n = Number(o.price);
  const shown = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
  return (planHtml(g.html, code) ?? "").includes(shown);
}));
check("internal links: exam overview, mock series, PYQ, question bank, refund policy", [`/exams/${F.examSlug}"`, `/exams/${F.examSlug}/mock-test-series"`, `/exams/${F.examSlug}/previous-year-papers"`, `/exams/${F.examSlug}/question-bank"`, '/refund-policy"'].every((h) => g.html.includes(`href="${h}`)));

console.log("2. Sitemap / robots");
const sm = await get("/sitemap.xml");
check("sitemap lists /plans-and-pricing", sm.html.includes(`<loc>${SITE}${PATH}</loc>`));
const rb = await get("/robots.txt");
check("robots.txt does not disallow it", rb.status === 200 && !/Disallow: \/plans/.test(rb.html));

console.log("3. Students: ownership states");
const expect = {
  fresh: { series: "BUY", mock2: "BUY", mock3: "BUY", pyq: "BUY", passC: "BUY" },
  series: { series: "ACTIVE", mock2: "COVERED", mock3: "COVERED", pyq: "BUY", passC: "BUY" },
  single: { series: "BUY", mock2: "ACTIVE", mock3: "BUY" },
  expired: { series: "EXPIRED", mock2: "BUY", mock3: "BUY" },
  pass: { passC: "ACTIVE", series: "BUY" },
};
const studentHtml = {};
for (const [persona, want] of Object.entries(expect)) {
  const r = await get(PATH, F.tokens[persona]);
  studentHtml[persona] = r.html;
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, stateOf(r.html, P[k].code)]));
  check(`${persona}: ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}
const own = planHtml(studentHtml.series, P.series.code) ?? "";
check("owner: Active Plan + View Series, no Buy/checkout link", own.includes("Active Plan") && own.includes('href="/student/test-series"') && !own.includes("/student/checkout/"));
const cov = planHtml(studentHtml.series, P.mock2.code) ?? "";
check("covered mock: Already Enrolled, Included in <series>, Start Test, no checkout", cov.includes("Already Enrolled") && cov.includes("Included in") && cov.includes(`/student/test-series/${F.mocks.paid2}`) && !cov.includes("/student/checkout/"));
const soon = planHtml(studentHtml.single, P.mock2.code) ?? "";
check("expiring in 5 days: Active Plan + Renew → checkout", soon.includes("Active Plan") && soon.includes(`/student/checkout/${P.mock2.code}`) && soon.includes(">Renew<"));
const exp = planHtml(studentHtml.expired, P.series.code) ?? "";
check("expired: Renew → checkout", exp.includes(">Renew<") && exp.includes(`href="/student/checkout/${P.series.code}"`));
const fresh = planHtml(studentHtml.fresh, P.series.code) ?? "";
check("signed-in buyer: Buy Now → checkout directly", fresh.includes(`href="/student/checkout/${P.series.code}"`) && fresh.includes(">Buy Now<"));
check("signed-in header shows My Dashboard", studentHtml.fresh.includes(">My Dashboard<"));
check("guest header shows no My Dashboard", !g.html.includes(">My Dashboard<"));

console.log("4. Redirects / nav");
const old = await get("/student/plans", F.tokens.fresh);
check("/student/plans → /plans-and-pricing", [307, 308].includes(old.status) && (old.headers.get("location") ?? "").endsWith(PATH), `${old.status} ${old.headers.get("location")}`);

console.log("5. Admin changes reflect (Admin product columns)");
fixture("mutate", "price", P.series.id);
let r = await get(PATH);
check("updated price + discount shown (₹1,499 · MRP ₹3,000 · 50% OFF)", (planHtml(r.html, P.series.code) ?? "").includes("₹1,499") && (planHtml(r.html, P.series.code) ?? "").includes("₹3,000") && /50(<!-- -->)?% OFF/.test(planHtml(r.html, P.series.code) ?? ""));
check("structured price follows (1499.00)", ldBlocks(r.html).find((b) => b["@type"] === "WebPage")?.mainEntity.itemListElement.find((o) => o.url.endsWith(P.series.code))?.price === "1499.00");
fixture("mutate", "deactivate", P.series.id);
r = await get(PATH);
check("deactivated product disappears (card + offer)", planHtml(r.html, P.series.code) === null && ldBlocks(r.html).find((b) => b["@type"] === "WebPage")?.mainEntity.itemListElement.length === 4);
fixture("mutate", "restore", P.series.id);
r = await get(PATH);
check("restored product reappears", planHtml(r.html, P.series.code) !== null);

console.log("6. Browser: layout, console, navigation");
const browser = await chromium.launch();
for (const [label, viewport] of [["desktop", { width: 1366, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport, isMobile: label === "mobile" });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  pg.on("pageerror", (e) => errors.push(String(e)));
  await pg.goto(BASE + PATH, { waitUntil: "networkidle" });
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`${label}: no horizontal overflow`, !overflow);
  check(`${label}: no console / hydration errors`, errors.length === 0, errors.join(" | ").slice(0, 300));
  await pg.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/plans-${label}.png`, fullPage: true });
  if (label === "mobile") {
    await pg.locator(`#plan-${P.series.code} a`, { hasText: "Buy Now" }).click();
    await pg.waitForURL(/\/login/);
    check("guest Buy Now → login page with callback", decodeURIComponent(pg.url()).includes(`callbackUrl=/student/checkout/${P.series.code}`), pg.url());
  }
  await ctx.close();
}
const sctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await sctx.addCookies([{ name: "student-session-token", value: F.tokens.fresh, url: BASE }]);
const sp = await sctx.newPage();
await sp.goto(BASE + "/student/exams", { waitUntil: "networkidle" });
const navLinks = await sp.locator("header nav a").allInnerTexts();
check("student nav: My Exams → Plans & Pricing → Test Series → Custom Module", JSON.stringify(navLinks.slice(0, 4)) === JSON.stringify(["My Exams", "Plans & Pricing", "Test Series", "Custom Module"]), JSON.stringify(navLinks));
await sp.locator("header nav a", { hasText: "Plans & Pricing" }).first().click();
await sp.waitForURL(new RegExp(`${PATH}$`));
check("nav click opens /plans-and-pricing", sp.url().endsWith(PATH));
await sp.locator(`#plan-${P.series.code} a`, { hasText: "Buy Now" }).click();
await sp.waitForURL(/\/student\/checkout\//);
await sp.waitForLoadState("networkidle");
const body = await sp.locator("main").innerText();
check("Buy Now → existing checkout with the same price", sp.url().endsWith(`/student/checkout/${P.series.code}`) && body.includes("₹899.10"), body.slice(0, 200));
await sctx.close();
const octx = await browser.newContext();
await octx.addCookies([{ name: "student-session-token", value: F.tokens.series, url: BASE }]);
const op = await octx.newPage();
await op.goto(`${BASE}/student/checkout/${P.mock2.code}`, { waitUntil: "networkidle" });
const covText = await op.locator("main").innerText();
check("checkout still refuses a covered mock (no Pay button)", !/Pay ₹|Buy Now/i.test(covText), covText.slice(0, 200));
await octx.close();
await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
