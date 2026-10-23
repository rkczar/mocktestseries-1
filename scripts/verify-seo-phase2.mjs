/**
 * SEO phase 2 checks against two local `next start` servers on the SAME
 * scratch database (scripts/seo-phase2-fixture.ts): NEW = this branch,
 * BASE = the commit it is built on. Read-only (GET requests, SELECTs).
 *
 * - New titles/descriptions: exact text, length, uniqueness, counts that match the DB.
 * - Homepage marks the exam date tentative; no public page states an untagged countdown.
 * - Hub lists the official RUHS sources (and each official URL answers 200).
 * - Homepage + year pages link the weightage / analysis / strategy pages; every
 *   internal link on every public page resolves.
 * - Unchanged vs BASE: robots.txt, sitemap.xml, canonicals, robots meta, JSON-LD,
 *   and the status + redirect of auth / student / admin / API routes.
 *
 *   NEW=http://localhost:3711 BASE=http://localhost:3712 DATABASE_URL=<scratch *seop2*> [OFFLINE=1] node scripts/verify-seo-phase2.mjs
 */
import pg from "pg";

const NEW = process.env.NEW ?? "http://localhost:3711";
const BASE = process.env.BASE ?? "http://localhost:3712";
const DB = process.env.DATABASE_URL ?? "";
if (!/seop2/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must be a scratch database whose name contains 'seop2'.");
  process.exit(2);
}
const SITE = "https://mocktestseries.in";
const HUB = "/exams/rajasthan-medical-officer";
const db = new pg.Client({ connectionString: DB.replace(/\?schema=[^&]*/, "") });
await db.connect();

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? `  — ${extra}` : ""}`);
  if (!ok) failed++;
};
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
async function get(origin, path, opts = {}) {
  const r = await fetch(origin + path, { redirect: "manual", ...opts });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
function head(html) {
  const meta = (attr, name) => {
    const m = html.match(new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`)) ?? html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${name}"`));
    return m ? decode(m[1]) : null;
  };
  return {
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    description: meta("name", "description"),
    robots: meta("name", "robots"),
    ogTitle: meta("property", "og:title"),
    canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null,
    jsonLd: [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]),
  };
}
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const text = (html) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

// ---- robots.txt + sitemap.xml unchanged -----------------------------------------------------------
const [rN, rB, sN, sB] = await Promise.all([get(NEW, "/robots.txt"), get(BASE, "/robots.txt"), get(NEW, "/sitemap.xml"), get(BASE, "/sitemap.xml")]);
check("robots.txt byte-identical to BASE", rN.status === 200 && rN.body === rB.body);
const stripLastmod = (x) => x.replace(/<lastmod>[^<]*<\/lastmod>/g, "");
check("sitemap.xml identical to BASE (URLs, priorities)", sN.status === 200 && stripLastmod(sN.body) === stripLastmod(sB.body));
const urls = [...sN.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(SITE, "") || "/");
check("sitemap lists the hub, 3 insight pages and 4 year pages", [HUB, `${HUB}/subject-wise-weightage`, `${HUB}/previous-year-paper-analysis`, `${HUB}/preparation-strategy`, `${HUB}/previous-year-papers/2013`, `${HUB}/previous-year-papers/2024`].every((u) => urls.includes(u)), urls.join(" "));

// ---- Per page: head + JSON-LD vs BASE ---------------------------------------------------------------
const pages = {};
for (const u of urls) {
  const [n, b] = await Promise.all([get(NEW, u), get(BASE, u)]);
  pages[u] = { n, b, hn: head(n.body), hb: head(b.body) };
  const { hn, hb } = pages[u];
  const same = n.status === b.status && hn.canonical === hb.canonical && hn.robots === hb.robots;
  check(`${u}: status/canonical/robots unchanged`, n.status === 200 && same, JSON.stringify({ n: [n.status, hn.canonical, hn.robots], b: [b.status, hb.canonical, hb.robots] }));
  // JSON-LD may only differ where it repeats the page's own title/description.
  const ldN = hn.jsonLd.join("|").split(hn.title).join("<T>").split(hn.description ?? "\u0000").join("<D>");
  const ldB = hb.jsonLd.join("|").split(hb.title).join("<T>").split(hb.description ?? "\u0000").join("<D>");
  check(`${u}: structured data unchanged (apart from its title/description)`, ldN === ldB && hn.jsonLd.every((j) => { try { JSON.parse(j); return true; } catch { return false; } }));
}

// ---- New titles + descriptions ------------------------------------------------------------------------
const exam = (await db.query(`select id from "Exam" where code='RUHSMO'`)).rows[0];
const qCount = Number((await db.query(`select count(*) from "Question" where "examId"=$1 and status='PUBLISHED'`, [exam.id])).rows[0].count);
const subjCount = Number((await db.query(`select count(*) from "ExamSubject" where "examId"=$1 and "isActive"`, [exam.id])).rows[0].count);
const pyqCount = Number((await db.query(`select count(*) from "Question" where "examId"=$1 and status='PUBLISHED' and "previousYearPaperId" is not null`, [exam.id])).rows[0].count);
const paperCount = Number((await db.query(`select count(distinct p.id) from "PreviousYearPaper" p join "Question" q on q."previousYearPaperId"=p.id where p."examId"=$1 and p."isActive" and q.status='PUBLISHED'`, [exam.id])).rows[0].count);
const availMocks = Number(
  (await db.query(`select count(*) from "MockTest" m join "TestSeries" s on s.id=m."testSeriesId" where s."examId"=$1 and m.status='PUBLISHED' and (m."availableFrom" is null or m."availableFrom" <= now())`, [exam.id])).rows[0].count
);
const fmt = (n) => n.toLocaleString("en-IN");
const expected = {
  [`${HUB}/question-bank`]: { title: `RUHS MO Question Bank: ${fmt(qCount)} MCQs by Subject`, desc: `Practise ${fmt(qCount)} RUHS Medical Officer 2026 MCQs across ${subjCount} subjects, each with an explanation. Pick a subject and see its topics.` },
  [`${HUB}/previous-year-papers`]: { title: "RUHS MO Previous Year Papers 2013–2024 – Attempt Online", descStart: `Attempt ${paperCount} real RUHS MO papers (2013–2024) online` },
  [`${HUB}/preparation-strategy`]: { title: "How to Prepare for RUHS MO 2026: 12-Week PYQ Plan", descStart: `A 12-week RUHS MO 2026 study plan built from ${pyqCount} past-paper questions` },
  [`${HUB}/exam-pattern`]: { title: "RUHS MO Exam Pattern 2026 & Marking Scheme" },
  [`${HUB}/subject-wise-weightage`]: { title: "RUHS MO Subject-Wise Weightage (2013–2024 PYQs)", descStart: `RUHS MO subject-wise weightage from ${pyqCount} PYQs (2013–2024)` },
  [`${HUB}/previous-year-paper-analysis`]: { title: "RUHS MO Previous Year Paper Analysis 2013–2024" },
  [`${HUB}/previous-year-papers/2024`]: { title: "RUHS MO 2024 Question Paper (Held 27 April 2025)", descStart: "RUHS MO 2024 paper (MODRE-2024, held 27 April 2025)" },
  [`${HUB}/previous-year-papers/2022`]: { title: "RUHS MO 2022 Question Paper – Subject-wise Analysis" },
};
// The site title template is an admin setting: strip whichever suffix it adds ("%s — …"), or none for "%s".
const tpl = (await db.query(`select value->>'titleTemplate' t from "Setting" where key='seo.settings'`)).rows[0]?.t ?? "%s — MockTestSeries.in";
const TEMPLATE = tpl.replace("%s", "");
console.log(`(title template on this DB: "${tpl}")`);
for (const [u, e] of Object.entries(expected)) {
  const h = pages[u]?.hn;
  if (!h) { check(`${u}: page present`, false); continue; }
  const bare = TEMPLATE && h.title.endsWith(TEMPLATE) ? h.title.slice(0, -TEMPLATE.length) : h.title;
  check(`${u}: title "${bare}" (${bare.length})`, bare === e.title && bare.length <= 60, `got "${h.title}"`);
  check(`${u}: full <title> ${h.title.length} chars${h.title.length > 60 ? " (over 60 only because of the template suffix)" : ""}`, h.title === bare + TEMPLATE);
  if (e.desc) check(`${u}: description exact`, h.description === e.desc, h.description);
  if (e.descStart) check(`${u}: description starts with the DB-backed facts`, (h.description ?? "").startsWith(e.descStart), h.description);
  check(`${u}: description ≤ 160 chars (${(h.description ?? "").length})`, (h.description ?? "").length > 0 && (h.description ?? "").length <= 160);
  check(`${u}: og:title matches <title>`, h.ogTitle === h.title);
}
{
  const h = pages[`${HUB}/mock-test-series`]?.hn;
  const m = h?.title.match(/^RUHS MO Test Series 2026: (\d+) Mock Tests Live/);
  const d = h?.description?.match(/(\d+) available now/);
  check("mock-test-series: title count = live mocks in the DB = description count", Boolean(m && d) && Number(m[1]) === availMocks && Number(d[1]) === availMocks, JSON.stringify({ title: h?.title, availMocks, desc: h?.description }));
}
const allTitles = Object.values(pages).map((p) => p.hn.title);
check("every sitemap page has a unique <title>", new Set(allTitles).size === allTitles.length, allTitles.join(" | "));
const allDescs = Object.values(pages).map((p) => p.hn.description);
check("every sitemap page has a unique meta description", new Set(allDescs).size === allDescs.length);
check("year pages no longer put '2026' in a past-paper title", Object.keys(pages).filter((u) => /previous-year-papers\/\d{4}$/.test(u)).every((u) => !pages[u].hn.title.includes("2026")));

// ---- Exam date: tentative, never presented as confirmed --------------------------------------------
const home = pages["/"].n.body;
const homeText = text(home);
const days = Number(homeText.match(/About (\d+) days left/)?.[1]);
const examRow = (await db.query(`select "examDate" from "Exam" where id=$1`, [exam.id])).rows[0];
check("homepage hero shows the date as tentative", /Exam date \d{1,2} \w+ 2026 \(tentative\)/.test(homeText), homeText.match(/Exam date[^.]{0,60}/)?.[0]);
check("homepage countdown reads 'About N days left' with N from the DB date", Number.isInteger(days) && Math.abs(days - Math.ceil((new Date(examRow.examDate) - Date.now()) / 86_400_000)) <= 1, String(days));
check("homepage fact row is labelled 'Exam date (tentative)'", homeText.includes("Exam date (tentative)"));
const baseHomeText = text(pages["/"].b.body);
check("BASE showed the untagged countdown (the bug this fixes)", /\d+ days left/.test(baseHomeText) && !baseHomeText.includes("(tentative)"));
const untagged = Object.entries(pages).filter(([, p]) => /(?<!About )\b\d+ days left/.test(text(p.n.body))).map(([u]) => u);
check("no public page shows an untagged 'N days left'", untagged.length === 0, untagged.join(" "));

// ---- Official sources on the hub ------------------------------------------------------------------------
const OFFICIAL = [
  "https://old.ruhsraj.org/cms/uploads/2026/08/MO_600_2435.pdf",
  "https://ruhsmomedical.com/",
  "https://ruhsraj.org/",
  "https://old.ruhsraj.org/cms/uploads/2025/05/Final_Answer_Key_After_Expert_Opinion__8154.pdf",
];
const hub = pages[HUB].n.body;
check("hub has the 'Official RUHS notices and sources' section", text(hub).includes("Official RUHS notices and sources") && hub.includes('id="official-sources"'));
check("hub links all 4 official sources, new tab + noopener", OFFICIAL.every((u) => new RegExp(`href="${u.replace(/[.?]/g, "\\$&")}"[^>]*target="_blank"[^>]*rel="noopener noreferrer"`).test(hub)));
check("BASE hub had none of them", OFFICIAL.every((u) => !pages[HUB].b.body.includes(`href="${u}"`)));
const sourcesText = text(hub.match(/id="official-sources"[\s\S]*?<\/section>/)?.[0] ?? "");
check("official-sources section states no salary, fee, age or exam date", sourcesText.length > 100 && !/₹|Rs\.?\s?\d|salary|fee|age limit|\b\d{1,2} (December|Dec)\b/i.test(sourcesText), sourcesText.slice(0, 300));
if (!process.env.OFFLINE) {
  for (const u of OFFICIAL) {
    const r = await fetch(u, { method: "GET", headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow" }).catch((e) => ({ status: String(e) }));
    check(`official source answers 200: ${u}`, r.status === 200, String(r.status));
    await r.body?.cancel?.();
  }
}

// ---- Internal links ------------------------------------------------------------------------------------------
const INSIGHT = ["subject-wise-weightage", "previous-year-paper-analysis", "preparation-strategy"].map((s) => `${HUB}/${s}`);
check("homepage links the weightage, analysis and strategy pages", INSIGHT.every((u) => hrefs(home).includes(u)), INSIGHT.filter((u) => !hrefs(home).includes(u)).join(" "));
check("BASE homepage did not link analysis/strategy", !hrefs(pages["/"].b.body).includes(INSIGHT[2]));
for (const u of Object.keys(pages).filter((x) => /previous-year-papers\/\d{4}$/.test(x))) {
  const h = hrefs(pages[u].n.body);
  check(`${u}: links analysis + strategy + weightage`, INSIGHT.every((x) => h.includes(x)));
}
const strategyIn = Object.values(pages).filter((p) => hrefs(p.n.body).includes(INSIGHT[2])).length;
const strategyInBase = Object.values(pages).filter((p) => hrefs(p.b.body).includes(INSIGHT[2])).length;
check(`preparation-strategy inbound pages: ${strategyInBase} → ${strategyIn}`, strategyIn >= strategyInBase + 5);
const internal = new Set();
for (const p of Object.values(pages)) for (const h of hrefs(p.n.body)) if (h.startsWith("/") && !h.startsWith("//") && !h.startsWith("/_next") && !/\.(css|js|png|ico|svg|webmanifest|woff2?)(\?|$)/.test(h)) internal.add(h.split("#")[0]);
const broken = [];
const baseBroken = [];
for (const h of internal) {
  const r = await get(NEW, h);
  if (r.status >= 400) ((await get(BASE, h)).status >= 400 ? baseBroken : broken).push(`${h} ${r.status}`);
}
check(`all ${internal.size} internal links on public pages resolve, apart from links BASE also breaks`, broken.length === 0, broken.join(", "));
if (baseBroken.length) console.log(`INFO  broken in BASE too (fixture homepage content, not this change): ${baseBroken.join(", ")}`);

// ---- Auth / student / admin / API routes unchanged -------------------------------------------------------
const ROUTES = ["/login", "/student/dashboard", "/student/test-series", "/student/attempt/resume", "/admin", "/admin/seo", "/admin/seo/intelligence", "/api/admin/seo-intel/export?kind=queries", "/api/admin/seo-intel/google/callback", "/plans-and-pricing", "/exams", "/student_login.php", "/exams/ruhs-mo"];
for (const r of ROUTES) {
  const [n, b] = await Promise.all([get(NEW, r), get(BASE, r)]);
  const norm = (x) => (x ?? "").replace(NEW, "").replace(BASE, "").replace(/localhost:371[12]/g, "localhost");
  check(`${r}: ${n.status} ${norm(n.location)} (same as BASE)`, n.status === b.status && norm(n.location) === norm(b.location), `BASE ${b.status} ${norm(b.location)}`);
}

await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
