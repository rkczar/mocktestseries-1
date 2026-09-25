/**
 * One-time, idempotent setup of the RUHS Medical Officer 2026 Mock Test
 * Series product funnel. DRY RUN by default — prints every change; pass
 * --apply to write. Safe to re-run: each step checks current state first.
 *
 *   npx tsx --conditions react-server scripts/setup-ruhs-mock-series.ts [--apply]
 *
 * What it does (and deliberately does NOT do):
 *  1. Creates/updates the canonical TestSeries (slug ruhs-mo-2026-mock-test-series,
 *     50 PLANNED, PUBLISHED). Creates NO mock tests — admins add real ones.
 *  2. Re-points the existing RUHS product (code ruhs-mo-full-access, 0 orders)
 *     from EXAM_ACCESS to TEST_SERIES for that series, so buying it unlocks
 *     the series and lands in Student → Test Series, while PYQs / subject
 *     practice stay free. Prices (MRP / selling / sale) are NOT changed.
 *  3. Generates one printable Practice OMR sheet (PDF) for the series if the
 *     series has none — available to FREE and PAID students alike.
 *  4. Fixes stale homepage content in the PUBLISHED config (and the working
 *     DRAFT, so a later publish keeps it): links to the old /mock-tests URL,
 *     the "/#test-series" header anchor, a duplicate "Browse Exams" nav item,
 *     the hardcoded "50 Full-Length Mock Tests" / "50+" / "10 Years" claims,
 *     and adds RUHS MO resource links to the footer.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { testResourcesDir, randomResourceFilename, publicResourceUrlFor } from "@/lib/test-resources";
import { buildOmrPdf } from "@/lib/omr-sheet";

const APPLY = process.argv.includes("--apply");
const EXAM_CODE = "RUHSMO";
const SERIES_SLUG = "ruhs-mo-2026-mock-test-series";
const SERIES_NAME = "RUHS Medical Officer 2026 Mock Test Series";
const PRODUCT_CODE = "ruhs-mo-full-access";
const PRODUCT_NAME = "RUHS Medical Officer 2026 Complete Mock Test Series";

const log = (msg: string) => console.log(`${APPLY ? "APPLY" : "DRY  "} ${msg}`);

type Pair = [string, string];

function fixHomepageContent(key: string, content: Record<string, unknown>, urls: Record<string, string>): Record<string, unknown> | null {
  const c = structuredClone(content);
  const swapOld = (v: unknown) => (typeof v === "string" && /\/exams\/[^/]+\/mock-tests$/.test(v) ? urls.series : v);
  let changed = false;
  const set = (k: string, v: unknown) => {
    if (JSON.stringify(c[k]) !== JSON.stringify(v)) {
      c[k] = v;
      changed = true;
    }
  };
  for (const k of ["primaryCtaHref", "secondaryCtaHref", "ctaHref", "buttonHref", "secondaryButtonHref"]) {
    if (k in c && swapOld(c[k]) !== c[k]) set(k, swapOld(c[k]));
  }
  if (key === "HEADER" && Array.isArray(c.navItems)) {
    const nav = (c.navItems as Pair[])
      .filter(([label]) => label !== "Browse Exams") // duplicate of "Exams" → /exams
      .map(([label, href]): Pair => (href === "/#test-series" ? ["Mock Test Series", urls.series] : [label, href]));
    set("navItems", nav);
  }
  if (key === "MOCK_TEST_PROMOTION") {
    if (typeof c.heading === "string" && /^\s*50\b/.test(c.heading)) set("heading", SERIES_NAME);
    if (c.ctaText === "Browse Mock Tests") set("ctaText", "View Mock Test Series");
    if (!c.numberMode) set("numberMode", "LIVE");
    set("description", "Scheduled, exam-pattern mocks with stated syllabus coverage, instant results and AI-powered review.");
  }
  if (key === "PREVIOUS_YEAR_PAPERS" && typeof c.heading === "string" && /^\s*10 Years/.test(c.heading)) {
    set("heading", "RUHS MO Previous Year Papers");
    set("description", "Practice real RUHS Medical Officer papers in live-test format, with results, review and AI explanations.");
  }
  if (key === "STATISTICS" && Array.isArray(c.metrics)) {
    const metrics = (c.metrics as Record<string, unknown>[]).map((m) =>
      m.label === "Mock Tests" && m.mode === "MANUAL" ? { ...m, label: "Published Mock Tests", mode: "LIVE", dynamicKey: "mockTestsPublished", manualValue: undefined } : m
    );
    set("metrics", metrics);
  }
  if (key === "FOOTER" && Array.isArray(c.links)) {
    const links = [...(c.links as Pair[])];
    const want: Pair[] = [
      ["RUHS MO 2026", urls.hub],
      ["RUHS MO Mock Test Series", urls.series],
      ["RUHS MO Previous Year Papers", `${urls.hub}/previous-year-papers`],
      ["RUHS MO Syllabus", `${urls.hub}/syllabus`],
      ["RUHS MO Exam Pattern", `${urls.hub}/exam-pattern`],
    ];
    for (const w of want) if (!links.some(([, href]) => href === w[1])) links.push(w);
    set("links", links);
  }
  return changed ? c : null;
}

async function main() {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { code: EXAM_CODE } });
  if (!exam.publicSlug) throw new Error("RUHS MO exam has no publicSlug");
  const urls = { hub: `/exams/${exam.publicSlug}`, series: `/exams/${exam.publicSlug}/mock-test-series` };
  console.log(`Exam: ${exam.name} (${exam.id}) · public: ${exam.publicPageEnabled}`);

  // 1. Series
  let series = await prisma.testSeries.findUnique({ where: { slug: SERIES_SLUG } });
  if (!series) {
    log(`create TestSeries "${SERIES_NAME}" (50 planned, PUBLISHED, slug ${SERIES_SLUG})`);
    if (APPLY) {
      series = await prisma.testSeries.create({
        data: {
          examId: exam.id,
          name: SERIES_NAME,
          slug: SERIES_SLUG,
          testCount: 50,
          status: "PUBLISHED",
          isActive: true,
          order: 0,
          description:
            "Exam-focused RUHS MO mock tests released on a schedule, with previous year papers, a practice OMR sheet, AI-powered answer review and performance analytics.",
        },
      });
    }
  } else {
    log(`TestSeries exists (${series.id}, ${series.status}, planned ${series.testCount}) — unchanged`);
  }

  // 2. Product
  const product = await prisma.product.findUnique({ where: { code: PRODUCT_CODE }, include: { _count: { select: { orders: true, entitlements: true } } } });
  if (!product) {
    log(`product ${PRODUCT_CODE} not found — create a TEST_SERIES product in Admin → Payments → Products`);
  } else if (product.productType === "TEST_SERIES" && product.testSeriesId === series?.id) {
    log(`product ${PRODUCT_CODE} already sells the series — unchanged`);
  } else {
    log(
      `product ${PRODUCT_CODE}: ${product.productType} → TEST_SERIES (series ${series?.id ?? "<new>"}), name → "${PRODUCT_NAME}". ` +
        `Price unchanged: MRP ${product.mrpPaise / 100}, selling ${product.sellingPricePaise / 100}. Orders ${product._count.orders}, entitlements ${product._count.entitlements}.`
    );
    if (APPLY && series) {
      await prisma.product.update({
        where: { id: product.id },
        data: { productType: "TEST_SERIES", testSeriesId: series.id, examId: exam.id, name: PRODUCT_NAME },
      });
    }
  }

  // 3. Practice OMR
  const existingOmr = series
    ? await prisma.testResource.count({ where: { type: "OMR_TEMPLATE", OR: [{ testSeriesId: series.id }, { examId: exam.id, mockTestId: null }] } })
    : 0;
  const qCount = exam.totalQuestions && exam.totalQuestions > 0 && exam.totalQuestions <= 200 ? exam.totalQuestions : 100;
  if (existingOmr > 0) {
    log(`OMR sheet already present (${existingOmr}) — unchanged`);
  } else {
    log(`generate Practice OMR PDF (${qCount} questions, A–D) scoped to the series`);
    if (APPLY && series) {
      const bytes = await buildOmrPdf(`RUHS Medical Officer 2026 — Practice OMR (${qCount} Questions)`, qCount);
      const filename = randomResourceFilename("application/pdf")!;
      await fs.mkdir(testResourcesDir(), { recursive: true });
      await fs.writeFile(path.join(testResourcesDir(), filename), bytes);
      await prisma.testResource.create({
        data: {
          type: "OMR_TEMPLATE",
          title: `Practice OMR — ${qCount} Questions`,
          fileUrl: publicResourceUrlFor(filename),
          mimeType: "application/pdf",
          fileSizeBytes: bytes.length,
          questionCount: qCount,
          examId: exam.id,
          testSeriesId: series.id,
        },
      });
    }
  }

  // 4. Homepage content (PUBLISHED + working DRAFT)
  const configs = await prisma.homepageConfig.findMany({ where: { status: { in: ["PUBLISHED", "DRAFT"] } }, include: { sections: true } });
  for (const cfg of configs) {
    for (const s of cfg.sections) {
      const next = fixHomepageContent(s.key, s.content as Record<string, unknown>, urls);
      if (!next) continue;
      log(`homepage ${cfg.status} v${cfg.version} ${s.key}:\n      before ${JSON.stringify(s.content).slice(0, 400)}\n      after  ${JSON.stringify(next).slice(0, 400)}`);
      if (APPLY) await prisma.homepageSection.update({ where: { id: s.id }, data: { content: next as Prisma.InputJsonValue } });
    }
  }

  console.log(APPLY ? "Done." : "Dry run only — re-run with --apply to write.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
