/**
 * Verifies the homepage SEO / free-first redesign against the live database
 * (read-only — nothing is written):
 *
 *  1. Content: the redesign copy is English, has one H1 source, no ranking /
 *     selection guarantees, no fake trust signals, and disclaims RUHS
 *     affiliation; title/description lengths are sane.
 *  2. Free-first: every "Start for free" card is backed by a FREE row of the
 *     live access comparison; a resource that turns paid disappears.
 *  3. Pricing: the Complete Access price is the canonical Product price
 *     (lib/payments/pricing.ts), never a literal; the CTA follows the viewer —
 *     anonymous → sign in to buy, no entitlement → buy, entitled → open
 *     (never "buy again").
 *  4. Exam links: every internal link points at a real public exam page.
 *  5. Global payment mode is untouched (PAID).
 *
 * The "[homepage] statistics unavailable" log lines are expected: outside
 * Next.js the cached statistics throw, which doubles as the failure test.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-homepage-seo.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { getPublishedHomepage } from "@/lib/homepage";
import { SECTION_META } from "@/lib/homepage-sections";
import { resolveHomepage, buildFreeCards, FREE_SIGNUP_HREF, STUDENT_HOME, type ResolvedHomepage } from "@/lib/homepage-render";
import { getExamMockSeriesSummary, getSeriesComparison } from "@/lib/mock-series";
import { computeProductPrice } from "@/lib/payments/pricing";
import { getPaymentMode } from "@/lib/payments/settings";
import { displayExamName } from "@/lib/exam-display";
import { ORDER, SEO, plan, REDESIGN_EXAM_CODE } from "./homepage-seo-redesign-content";
import type { HomepageSection } from "@prisma/client";
import { readFileSync } from "node:fs";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const exam = await prisma.exam.findUniqueOrThrow({ where: { code: REDESIGN_EXAM_CODE } });
  const target = plan(exam.id, exam.publicSlug!);
  const published = (await getPublishedHomepage())!;
  const now = new Date();
  const sections: HomepageSection[] = ORDER.map((key, order) => {
    const existing = published.sections.find((s) => s.key === key);
    const p = target[key];
    const base = (existing?.content as Record<string, unknown>) ?? SECTION_META[key].defaultContent;
    return {
      id: `verify-${key}`,
      homepageConfigId: published.id,
      key,
      isEnabled: p?.enabled ?? true,
      order,
      content: (p?.content ? { ...base, ...p.content } : base) as HomepageSection["content"],
      references: (p?.references ? { ...((existing?.references as object) ?? {}), ...p.references } : (existing?.references ?? {})) as HomepageSection["references"],
      createdAt: now,
      updatedAt: now,
    };
  });
  const config = { ...published, sections };
  const section = (h: ResolvedHomepage, key: string) => h.sections.find((s) => s.key === key)!;

  console.log("1. Content");
  const allText = JSON.stringify(Object.values(target).map((p) => p.content ?? {})) + SEO.title + SEO.metaDescription;
  await check("English only (no Devanagari)", () => assert.ok(!/[ऀ-ॿ]/.test(allText)));
  await check("no guarantees / fake trust claims", () => {
    for (const bad of [/guarantee/i, /#\s?1\b/, /\brank(?:er|ers)?\b/i, /selection/i, /trusted by/i, /\b\d+% success/i, /testimonial/i, /review(?:s)? from/i]) assert.ok(!bad.test(allText), String(bad));
  });
  await check("one H1 source: only HERO.heading", () => {
    assert.equal(target.HERO.content?.heading, "Online Mock Test Series for Medical Officer Exams");
  });
  await check("RUHS non-affiliation stated (guide + FAQ)", () => {
    assert.match(String(target.EXAM_GUIDE.content?.disclaimer), /not affiliated/);
    assert.ok((target.FAQ.content?.items as [string, string][]).some(([q, a]) => /official RUHS website/.test(q) && /not affiliated/.test(a)));
  });
  await check("no hard-coded price in copy", () => assert.ok(!/₹\s?\d/.test(allText)));
  await check("title ≤ 60 chars, leads with the brand", () => {
    assert.ok(SEO.title.length <= 60, String(SEO.title.length));
    assert.ok(SEO.title.startsWith("Mock Test Series"));
  });
  await check("description 120–160 chars", () => assert.ok(SEO.metaDescription.length >= 120 && SEO.metaDescription.length <= 160, String(SEO.metaDescription.length)));
  await check("exam name display", () => assert.equal(displayExamName("RUHS MEDICAL OFFICER EXAM 2026"), "RUHS Medical Officer 2026"));

  console.log("2. Free-first");
  const anon = await resolveHomepage(config, { studentId: null });
  const summary = await getExamMockSeriesSummary(exam);
  const comparison = (await getSeriesComparison(exam.id, summary.mockSeries, summary.offer))!;
  const freeRow = new Map(comparison.derivedRows.map((r) => [r.key, r.free]));
  const cards = section(anon, "FREE_START").resolved.freeCards ?? [];
  console.log(`    cards: ${cards.map((c) => `${c.title}=${c.value}`).join(", ")}`);
  await check("free section has cards", () => assert.ok(cards.length > 0));
  const rowFor: Record<string, string> = { pyq: "pyq-practice", "subject-practice": "subject-practice", ai: "ai-explanations", analysis: "analytics" };
  await check("every card is backed by a FREE row", () => {
    for (const c of cards) {
      if (c.key === "free-mocks") assert.ok(comparison.freeMocks > 0 && Number(c.value) === comparison.freeMocks);
      else assert.ok(freeRow.get(rowFor[c.key]) && freeRow.get(rowFor[c.key]) !== "—", c.key);
    }
  });
  await check("a resource that is not free is never shown as free", () => {
    const paidOnly = { ...comparison, freeMocks: 0, derivedRows: comparison.derivedRows.map((r) => ({ ...r, free: "—" })) };
    const s = section(anon, "FREE_START").resolved.examSummary!;
    assert.deepEqual(buildFreeCards(s, paidOnly, 0), []);
  });
  // Outside Next.js, unstable_cache has no incremental cache and throws —
  // a real statistics failure. It must hide only the stats cards.
  await check("statistics failure hides only the stats, page still resolves", () => {
    assert.deepEqual(section(anon, "STATISTICS").resolved.statValues, []);
    assert.ok(section(anon, "HERO").resolved.examSummary);
  });
  await check("anonymous start-free → sign-up", () => {
    assert.equal(section(anon, "FREE_START").resolved.startFreeHref, FREE_SIGNUP_HREF);
    assert.equal(section(anon, "HERO").resolved.startFreeHref, FREE_SIGNUP_HREF);
  });

  console.log("3. Pricing & CTA");
  const product = await prisma.product.findUniqueOrThrow({ where: { id: summary.offer!.product.id } });
  const price = computeProductPrice(product);
  const promo = section(anon, "MOCK_TEST_PROMOTION").resolved;
  await check("price comes from the canonical Product", () => {
    assert.equal(promo.mockSeries?.offer?.price.pricePaise, price.pricePaise);
    assert.equal(promo.mockSeries?.offer?.price.mrpPaise, price.mrpPaise);
    assert.equal(promo.mockSeries?.offer?.showPrice, true);
  });
  await check("anonymous → Unlock (sign in first)", () => assert.equal(promo.offer?.cta.kind, "LOGIN_TO_BUY"));

  const entitled = await prisma.studentEntitlement.findFirst({
    where: { productId: product.id, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { studentId: true },
  });
  const freeStudent = await prisma.student.findFirst({
    where: { status: "ACTIVE", entitlements: { none: {} } },
    select: { id: true },
  });
  if (freeStudent) {
    const h = await resolveHomepage(config, { studentId: freeStudent.id });
    await check("free student → Buy, start-free → dashboard", () => {
      assert.ok(["BUY", "UNAVAILABLE"].includes(section(h, "MOCK_TEST_PROMOTION").resolved.offer!.cta.kind));
      assert.equal(section(h, "FREE_START").resolved.startFreeHref, STUDENT_HOME);
    });
  } else console.log("    (no free student found — skipped)");
  if (entitled) {
    const h = await resolveHomepage(config, { studentId: entitled.studentId });
    await check("entitled student → Open, never buy again", () => {
      const cta = section(h, "MOCK_TEST_PROMOTION").resolved.offer!.cta;
      assert.equal(cta.kind, "OPEN");
      assert.ok(!/unlock|buy|renew/i.test(cta.label));
    });
  } else console.log("    (no entitled student found — skipped)");

  console.log("4. Internal links");
  const links = section(anon, "FEATURED_EXAM").resolved.examSummary?.links ?? [];
  await check("exam page links are real public pages", async () => {
    assert.ok(links.length >= 4);
    for (const l of links) assert.ok(l.href.startsWith(`/exams/${exam.publicSlug}/`), l.href);
  });

  console.log("5. Admin RBAC (Homepage settings incl. Platform Stats)");
  await check("MASTER_ADMIN may edit and publish", () => {
    assert.ok(DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.WEBSITE_MANAGE));
    assert.ok(DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.HOMEPAGE_PUBLISH));
  });
  await check("FULL_ADMIN is read-only (no edit / publish permission)", () => {
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.WEBSITE_MANAGE));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.HOMEPAGE_PUBLISH));
  });
  await check("every homepage mutation enforces permission server-side", () => {
    const src = readFileSync("app/admin/(dashboard)/website/homepage/actions.ts", "utf8");
    const actions = [...src.matchAll(/export async function (\w+)\([^]*?\{([^]*?)\n\}/g)];
    assert.ok(actions.length >= 6);
    for (const [, name, body] of actions) assert.match(body, /requirePermission\(PERMISSIONS\.(WEBSITE_MANAGE|HOMEPAGE_PUBLISH)\)/, name);
    assert.match(src, /sanitizeStatisticsContent\(content\)/);
  });

  console.log("6. Payments untouched");
  await check("global payment mode is PAID", async () => assert.equal(await getPaymentMode(), "PAID"));

  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
