/**
 * Verifies the RUHS SEO phase 3 surfaces against real rendered HTML: the
 * Subject-Wise Weightage, Previous Year Paper Analysis and Preparation
 * Strategy pages, the syllabus repositioning, the MODRE-2024 (held
 * 27 April 2025) wording, the mock-page fixes, internal links, sitemap and
 * the logged-out protection of every practice CTA.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ruhs-seo-phase3.ts [baseUrl]
 *
 * baseUrl defaults to http://localhost:3301 (a local `next start`); pass
 * https://mocktestseries.in after deploy. Read-only: GET requests and
 * SELECTs only.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { computeExamPyqInsights } from "@/lib/exam-pyq-insights";
import { analysePyqInsights, EXAM_INSIGHT_PAGES, hasPyqAnalysis } from "@/lib/exam-pyq-analysis";

const BASE = (process.argv[2] ?? "http://localhost:3301").replace(/\/+$/, "");
const SITE = "https://mocktestseries.in";
const SLUG = "rajasthan-medical-officer";
const HUB = `/exams/${SLUG}`;
const NEW_PAGES = Object.values(EXAM_INSIGHT_PAGES).map((p) => `${HUB}/${p}`);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let passed = 0;
async function check(name: string, fn: () => unknown) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; MTS-SEO-verify)" } });
  return { status: res.status, html: res.status === 200 ? await res.text() : "", location: res.headers.get("location") };
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const meta = (html: string, attr: "name" | "property", key: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`, "g"))].map((m) => decode(m[1]));
const text = (html: string) => decode(html.replace(/<!-- -->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const titleOf = (html: string) => decode(html.match(/<title>(.*?)<\/title>/)?.[1] ?? "");
const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const pct = (share: number) => `${(Math.round(share * 1000) / 10).toFixed(1)}%`;

async function main() {
  const exam = await prisma.exam.findFirstOrThrow({ where: { publicSlug: SLUG } });
  const insights = await computeExamPyqInsights(exam.id);
  const a = analysePyqInsights(insights);

  console.log("1. Analysis data equals raw database counts (subject level only)");
  await check("analysis gate passes for RUHS MO", () => assert.ok(hasPyqAnalysis(insights)));
  await check("subject totals equal a raw groupBy of published PYQs", async () => {
    const raw = await prisma.question.groupBy({
      by: ["subjectId"],
      where: { status: "PUBLISHED", previousYearPaper: { examId: exam.id, isActive: true } },
      _count: { _all: true },
    });
    const names = new Map((await prisma.subject.findMany({ where: { id: { in: raw.map((r) => r.subjectId) } } })).map((s) => [s.id, s.name]));
    const rawByName = new Map(raw.map((r) => [names.get(r.subjectId)!, r._count._all]));
    assert.equal(a.totalQuestions, [...rawByName.values()].reduce((x, y) => x + y, 0));
    for (const s of a.spreads) assert.equal(s.count, rawByName.get(s.name), s.name);
    assert.equal(Math.round(a.spreads.reduce((t, s) => t + s.share, 0) * 1000), 1000);
  });
  await check("recent + older halves cover every paper exactly once", () => {
    assert.equal(a.older.questions + a.recent.questions, a.totalQuestions);
    assert.equal(a.older.years.length + a.recent.years.length, a.papers.length);
  });
  console.log(`    papers=${a.papers.length} questions=${a.totalQuestions} older=${a.older.years.join(",")} recent=${a.recent.years.join(",")} significant=${a.trends.filter((t) => t.signal !== "steady").length}`);

  console.log("2. New pages: metadata, headings, schema, data, safety");
  const stems = (
    await prisma.question.findMany({
      where: { status: "PUBLISHED", previousYearPaper: { examId: exam.id } },
      select: { text: true },
    })
  )
    .map((q) => q.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 40);
  const titles = new Map<string, string>();
  const studentLinks = new Set<string>();
  for (const path of NEW_PAGES) {
    const { status, html } = await get(path);
    const body = text(html);
    await check(`${path}: 200, one H1, title/description/canonical/og:url, indexable`, () => {
      assert.equal(status, 200);
      assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, "H1 count");
      const title = titleOf(html);
      assert.ok(title.length >= 10 && title.length <= 100, `title ${title.length}: ${title}`);
      titles.set(path, title);
      const desc = meta(html, "name", "description")[0] ?? "";
      assert.ok(desc.length >= 50 && desc.length <= 200, `description length ${desc.length}`);
      assert.equal(html.match(/<link rel="canonical" href="([^"]*)"/)?.[1], `${SITE}${path}`);
      assert.equal(meta(html, "property", "og:url")[0], `${SITE}${path}`);
      assert.ok(meta(html, "property", "og:image")[0]?.startsWith(`${SITE}/og/`), "og:image");
      assert.ok(!meta(html, "name", "robots").some((r) => r.includes("noindex")), "noindex");
    });
    await check(`${path}: breadcrumbs + JSON-LD valid and allowed`, () => {
      const blocks = jsonLd(html);
      const types = blocks.map((b) => b["@type"]);
      assert.ok(types.includes("BreadcrumbList"));
      assert.ok(types.includes(path.endsWith(EXAM_INSIGHT_PAGES.strategy) ? "Article" : "WebPage"), types.join(","));
      const all = JSON.stringify(blocks);
      for (const t of ["AggregateRating", "Review", "Course", "Event", "HowTo", "Dataset"]) assert.ok(!all.includes(`"@type":"${t}"`), t);
      const page = blocks.find((b) => b["@type"] === "WebPage" || b["@type"] === "Article");
      assert.equal(page.url, `${SITE}${path}`);
      assert.equal(page.isPartOf["@id"], `${SITE}/#website`);
      const crumbs = blocks.find((b) => b["@type"] === "BreadcrumbList").itemListElement;
      assert.equal(crumbs[2].item, `${SITE}${HUB}`);
      for (const b of blocks.filter((x) => x["@type"] === "FAQPage")) for (const q of b.mainEntity) assert.ok(body.includes(q.name), `FAQ visible: ${q.name}`);
      if (types.includes("Article")) {
        const art = blocks.find((b) => b["@type"] === "Article");
        assert.equal(art.author.name, "MockTestSeries.in Editorial Team");
        assert.ok(body.includes("By MockTestSeries.in Editorial Team"));
      }
    });
    await check(`${path}: numbers come from the database`, () => {
      if (path.endsWith(EXAM_INSIGHT_PAGES.strategy)) assert.ok(body.includes(`${a.papers.length} previous year papers`), "paper count");
      else assert.ok(body.includes(`${a.totalQuestions}`), "total questions");
      if (!path.endsWith(EXAM_INSIGHT_PAGES.analysis)) assert.ok(body.includes(pct(a.spreads[0].share)), "top share");
      if (path.endsWith(EXAM_INSIGHT_PAGES.weightage)) {
        for (const s of a.spreads) assert.ok(body.includes(`${s.name} ${s.count} ${pct(s.share)} ${s.papers}/${a.papers.length}`), `row ${s.name}`);
        assert.ok(/does not guarantee/.test(body), "historical disclaimer");
      }
      if (path.endsWith(EXAM_INSIGHT_PAGES.analysis)) for (const p of a.papers) assert.ok(html.includes(`href="${HUB}/previous-year-papers/${p.year}"`), `year link ${p.year}`);
    });
    await check(`${path}: no question text, answers or difficulty data`, () => {
      assert.ok(!/isCorrect|correctOption|correctAnswer|"explanation":/.test(html), "answer data");
      assert.ok(!/\b(EASY|HARD)\b/.test(html), "difficulty values");
      for (const stem of stems) assert.ok(!body.includes(stem.slice(0, 40)), `question text leaked: ${stem.slice(0, 40)}`);
    });
    for (const m of html.matchAll(/href="(\/student[^"]*)"/g)) studentLinks.add(decode(m[1]));
  }
  await check("new titles are unique and distinct from the syllabus title", async () => {
    const syllabus = titleOf((await get(`${HUB}/syllabus`)).html);
    assert.equal(new Set([...titles.values(), syllabus]).size, titles.size + 1);
  });
  for (const [path, title] of titles) console.log(`    ${title.length.toString().padStart(3)}  ${path}  ${title}`);
  await check("unknown exam slug 404s on every new page", async () => {
    for (const p of Object.values(EXAM_INSIGHT_PAGES)) assert.equal((await get(`/exams/no-such-exam/${p}`)).status, 404, p);
  });

  console.log("3. Existing pages: syllabus intent, 2024/2025 wording, mock fixes, links");
  await check("syllabus targets syllabus intent (no 'Weightage' in title/H1)", async () => {
    const { html } = await get(`${HUB}/syllabus`);
    assert.match(titleOf(html), /Syllabus: Subject & Topic-wise List/);
    assert.ok(!/weightage/i.test(titleOf(html)));
    assert.ok(!/weightage/i.test(text(html.match(/<h1[\s\S]*?<\/h1>/)![0])));
    assert.ok(html.includes(`href="${HUB}/${EXAM_INSIGHT_PAGES.weightage}"`), "links to weightage");
  });
  await check("2024 page says MODRE-2024, held 27 April 2025, with the official source; other years don't", async () => {
    const { html } = await get(`${HUB}/previous-year-papers/2024`);
    assert.match(titleOf(html), /2024 Question Paper \(Exam Held April 2025\)/);
    const body = text(html);
    assert.ok(body.includes("MODRE-2024") && body.includes("27 April 2025"));
    assert.ok(html.includes("old.ruhsraj.org/cms/uploads/2025/05/Final_Answer_Key_After_Expert_Opinion__8154.pdf"));
    const other = await get(`${HUB}/previous-year-papers/2022`);
    assert.ok(!text(other.html).includes("27 April 2025"));
  });
  await check("mock page: no ALL-CAPS exam name in headings; WebPage isPartOf #website", async () => {
    const { html } = await get(`${HUB}/mock-test-series`);
    for (const h of html.match(/<h2[\s\S]*?<\/h2>/g) ?? []) assert.ok(!/RUHS MEDICAL OFFICER EXAM/.test(h), h);
    const page = jsonLd(html).find((b) => b["@type"] === "WebPage");
    assert.equal(page.isPartOf["@id"], `${SITE}/#website`);
  });
  await check("each new page is linked from the hub, PYQ hub, a year page, syllabus/pattern/question bank and mock page", async () => {
    const sources = [HUB, `${HUB}/previous-year-papers`, `${HUB}/previous-year-papers/2018`, `${HUB}/syllabus`, `${HUB}/exam-pattern`, `${HUB}/question-bank`, `${HUB}/mock-test-series`, ...NEW_PAGES];
    const inbound = new Map(NEW_PAGES.map((p) => [p, 0]));
    for (const src of sources) {
      const { html } = await get(src);
      for (const p of NEW_PAGES) if (src !== p && html.includes(`href="${p}"`)) inbound.set(p, inbound.get(p)! + 1);
    }
    for (const [p, n] of inbound) assert.ok(n >= 5, `${p}: ${n} inbound`);
    console.log(`    inbound: ${[...inbound].map(([p, n]) => `${p.split("/").pop()}=${n}`).join(" ")}`);
  });
  await check("every internal exam link on the new pages resolves", async () => {
    const links = new Set<string>();
    for (const p of NEW_PAGES) for (const m of (await get(p)).html.matchAll(/href="(\/exams[^"#?]*)"/g)) links.add(m[1]);
    for (const href of links) assert.equal((await get(href)).status, 200, href);
  });

  console.log("4. Protection of practice CTAs (logged out)");
  await check(`all ${studentLinks.size} /student links on the new pages redirect to login with a callback`, async () => {
    assert.ok(studentLinks.size > 0);
    for (const href of studentLinks) {
      const { status, location } = await get(href);
      assert.ok(status === 307 || status === 302, `${href} → ${status}`);
      const loc = new URL(location!, SITE);
      assert.equal(loc.pathname, "/login", `${href} → ${location}`);
      assert.equal(loc.searchParams.get("callbackUrl"), href, "callback preserved");
    }
  });

  console.log("5. Sitemap and robots");
  const sitemap = (await get("/sitemap.xml")).html;
  await check("sitemap lists the three new pages", () => {
    for (const p of NEW_PAGES) assert.ok(sitemap.includes(`<loc>${SITE}${p}</loc>`), p);
  });
  await check("sitemap has no private or utility URLs", () => {
    for (const bad of ["/admin", "/student", "/api", "/og/", "/login"]) assert.ok(!sitemap.includes(`${SITE}${bad}`), bad);
  });
  await check("robots still blocks /admin, /student, /api", async () => {
    const robots = (await get("/robots.txt")).html;
    for (const d of ["/admin", "/student", "/api"]) assert.ok(robots.includes(`Disallow: ${d}`), d);
  });

  console.log(`\nAll ${passed} checks passed against ${BASE}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
