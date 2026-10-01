/**
 * Verifies the RUHS SEO phase 2 surfaces against real rendered HTML:
 * Exam Hub, PYQ hub, year-wise paper pages, syllabus / pattern / question
 * bank / mock series, sitemap, robots and the social (OG/Twitter) images.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-ruhs-seo-phase2.ts [baseUrl]
 *
 * baseUrl defaults to http://localhost:3301 (a local `next start`); pass
 * https://mocktestseries.in after deploy. Read-only: GET requests and
 * SELECTs only.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { computeExamPyqInsights, MIN_INDEXABLE_PAPER_QUESTIONS, MIN_INDEXABLE_PAPER_SUBJECTS } from "@/lib/exam-pyq-insights";

const BASE = (process.argv[2] ?? "http://localhost:3301").replace(/\/+$/, "");
const SITE = "https://mocktestseries.in";
const SLUG = "rajasthan-medical-officer";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let passed = 0;
async function check(name: string, fn: () => unknown) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const local = (url: string) => url.replace(SITE, BASE);
async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; MTS-SEO-verify)" } });
  return { status: res.status, html: res.status === 200 ? await res.text() : "", headers: res.headers };
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const meta = (html: string, attr: "name" | "property", key: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`, "g"))].map((m) => decode(m[1]));

async function main() {
  const exam = await prisma.exam.findFirstOrThrow({ where: { publicSlug: SLUG } });
  const insights = await computeExamPyqInsights(exam.id);

  console.log("1. PYQ data (canonical membership, no answers)");
  await check("paper counts equal raw published-question counts", async () => {
    for (const p of insights.papers) {
      const n = await prisma.question.count({ where: { previousYearPaperId: p.id, status: "PUBLISHED" } });
      assert.equal(p.questionCount, n, `${p.year}`);
    }
  });
  await check("indexable years follow the thin-page threshold", () => {
    const expected = [...new Set(insights.papers.filter((p) => p.questionCount >= MIN_INDEXABLE_PAPER_QUESTIONS && p.subjects.length >= MIN_INDEXABLE_PAPER_SUBJECTS).map((p) => p.year))];
    assert.deepEqual([...insights.indexableYears].sort(), expected.sort());
  });
  await check("insights carry aggregates only", () => {
    const allowed = new Set(["id", "year", "title", "paperCode", "questionCount", "subjects", "indexable"]);
    for (const p of insights.papers) for (const k of Object.keys(p)) assert.ok(allowed.has(k), k);
  });
  console.log(`    papers=${insights.papers.length} questions=${insights.totalQuestions} indexableYears=${insights.indexableYears.join(",")}`);

  const pages = [
    `/exams/${SLUG}`,
    `/exams/${SLUG}/previous-year-papers`,
    ...insights.indexableYears.map((y) => `/exams/${SLUG}/previous-year-papers/${y}`),
    `/exams/${SLUG}/syllabus`,
    `/exams/${SLUG}/exam-pattern`,
    `/exams/${SLUG}/question-bank`,
    `/exams/${SLUG}/mock-test-series`,
    `/exams`,
    `/`,
  ];

  console.log("2. Page metadata, headings, schema");
  const internalLinks = new Set<string>();
  const titles = new Map<string, string>();
  for (const path of pages) {
    const { status, html } = await get(path);
    await check(`${path}: 200, one H1, title/description/canonical, indexable`, () => {
      assert.equal(status, 200);
      assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, "H1 count");
      const title = decode(html.match(/<title>(.*?)<\/title>/)?.[1] ?? "");
      assert.ok(title.length >= 10 && title.length <= 100, `title length ${title.length}: ${title}`);
      assert.ok(!/RUHS MEDICAL OFFICER EXAM/.test(title), "no ALL-CAPS exam name in title");
      titles.set(path, title);
      const desc = meta(html, "name", "description")[0] ?? "";
      assert.ok(desc.length >= 50 && desc.length <= 200, `description length ${desc.length}`);
      const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
      assert.equal(canonical, `${SITE}${path === "/" ? "/" : path}`);
      assert.ok(!meta(html, "name", "robots").some((r) => r.includes("noindex")), "noindex");
    });
    await check(`${path}: og:image and twitter:image absolute and 1200×630 PNG`, async () => {
      const og = meta(html, "property", "og:image")[0];
      const tw = meta(html, "name", "twitter:image")[0];
      assert.ok(og?.startsWith(`${SITE}/og/`), `og:image ${og}`);
      assert.equal(tw, og);
      assert.equal(meta(html, "property", "og:image:width")[0], "1200");
      assert.equal(meta(html, "property", "og:image:height")[0], "630");
      assert.equal(meta(html, "name", "twitter:card")[0], "summary_large_image");
      const img = await fetch(local(og));
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), "image/png");
      const buf = Buffer.from(await img.arrayBuffer());
      assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [1200, 630]);
    });
    await check(`${path}: JSON-LD valid, no forbidden types, no answer leakage`, () => {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
      assert.ok(blocks.length > 0);
      const types = JSON.stringify(blocks);
      for (const t of ["AggregateRating", "Review", "Course", "Event"]) assert.ok(!types.includes(`"@type":"${t}"`), t);
      for (const b of blocks.filter((x) => x["@type"] === "FAQPage")) {
        for (const q of b.mainEntity) assert.ok(html.includes(decode(q.name).slice(0, 30).replace(/&/g, "&amp;")) || html.includes(q.name.slice(0, 30)), `FAQ visible: ${q.name}`);
      }
      // The homepage's AI demo intentionally shows a few admin-selected demo
      // questions with answers (Admin → AI → Homepage demo); every exam page must have none.
      if (path !== "/") assert.ok(!/isCorrect|correctOption|correctAnswer|"explanation":/.test(html), "answer data in HTML");
    });
    for (const m of html.matchAll(/href="(\/(?:exams|og)[^"#?]*)"/g)) internalLinks.add(m[1]);
  }
  await check("titles are unique across the cluster", () => assert.equal(new Set(titles.values()).size, titles.size));
  for (const [path, title] of titles) console.log(`    ${title.length.toString().padStart(3)}  ${path}  ${title}`);

  console.log("3. Internal links, thin/invalid pages");
  await check(`all ${internalLinks.size} internal exam links resolve`, async () => {
    for (const href of internalLinks) {
      const { status } = await get(href);
      assert.ok(status === 200 || status === 308, `${href} → ${status}`);
    }
  });
  await check("non-indexable / invalid years 404", async () => {
    for (const y of ["2014", "2025", "abcd", "20244"]) assert.equal((await get(`/exams/${SLUG}/previous-year-papers/${y}`)).status, 404, y);
  });

  console.log("4. Sitemap and robots");
  const sitemap = (await get("/sitemap.xml")).html;
  await check("sitemap lists hub, PYQ hub and every indexable year page", () => {
    for (const path of pages.filter((p) => p !== "/")) assert.ok(sitemap.includes(`<loc>${SITE}${path}</loc>`), path);
    assert.ok(sitemap.includes(`<loc>${SITE}/</loc>`));
  });
  await check("sitemap has no private or utility URLs", () => {
    for (const bad of ["/admin", "/student", "/api", "/og/", "/login"]) assert.ok(!sitemap.includes(`${SITE}${bad}`), bad);
  });
  await check("robots allows site, blocks private areas, points to sitemap", async () => {
    const robots = (await get("/robots.txt")).html;
    for (const d of ["/admin", "/student", "/api"]) assert.ok(robots.includes(`Disallow: ${d}`), d);
    assert.ok(!/Disallow: \/og/.test(robots));
    assert.ok(robots.includes(`Sitemap: ${SITE}/sitemap.xml`));
  });

  console.log(`\nAll ${passed} checks passed against ${BASE}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
