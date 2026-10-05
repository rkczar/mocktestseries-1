/**
 * Targeted verification for the Student Access / Subscription UX
 * (lib/payments/student-access.ts, offer display config, dashboard block).
 *
 * SAFETY: writes fixtures, flips the payment mode and gateway config, so it
 * REFUSES to run unless DATABASE_URL points at a *payverify* scratch DB:
 *
 *   DATABASE_URL=<scratch url> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-student-access-ux.ts
 *
 * Proves: free student → FREE state, canonical Product price, checkout link
 * == canonical product checkout, comparison rows present; active student →
 * ACTIVE with the entitlement's real expiry and tests unlocked by the same
 * engine; lifetime → no fabricated expiry; expired → EXPIRED + renew link;
 * gateway disabled / purchase disabled / MAINTENANCE → no checkout link;
 * FREE mode → no upgrade promo; offer display can't override the price row;
 * admin display mutations are TEST_SERIES_MANAGE-gated and FULL_ADMIN lacks it.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { StudentAuthProvider, MockTestStatus, RoleName } from "@prisma/client";

if (!/payverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *payverify* scratch database.");
  process.exit(2);
}

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { setPaymentMode, bumpPaymentSettingsCache } = await import("@/lib/payments/settings");
  const { saveRazorpayConfig } = await import("@/lib/razorpay-config");
  const { getStudentExamAccessSummaries } = await import("@/lib/payments/student-access");
  const { loadAccessContext, evaluateContentAccess } = await import("@/lib/payments/access");
  const { getCheckoutQuote } = await import("@/lib/payments/orders");
  const { computeProductPrice } = await import("@/lib/payments/pricing");
  const { offerDisplaySchema, saveOfferDisplay, resetOfferDisplay } = await import("@/lib/payments/offer-display");
  const { applyOfferDisplay } = await import("@/lib/payments/offer-display-shared");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");
  const { STUDENT_DASHBOARD_BLOCKS } = await import("@/lib/student-dashboard-blocks");
  const { normalizeStudentDashboardLayout } = await import("@/lib/student-dashboard-layout");

  const setMode = async (m: "FREE" | "PAID" | "MAINTENANCE") => {
    await setPaymentMode(m, undefined);
    bumpPaymentSettingsCache();
  };

  console.log("=== Student Access / Subscription UX (scratch DB) ===\n");
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({
    data: { name: `UX Exam ${sfx}`, code: `UX-${sfx}`, durationMinutes: 30, publicSlug: `ux-${sfx}`, publicPageEnabled: true },
  });
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `UX Series ${sfx}`, status: "PUBLISHED", testCount: 10 } });
  const mk = (title: string, accessType: "FREE" | "PAID", order: number) =>
    prisma.mockTest.create({ data: { examId: exam.id, testSeriesId: series.id, title, durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType, order } });
  const [, , paid1] = await Promise.all([mk("Free 1", "FREE", 1), mk("Free 2", "FREE", 2), mk("Paid 1", "PAID", 3), mk("Paid 2", "PAID", 4)]);
  const product = await prisma.product.create({
    data: {
      code: `ux-${sfx}`,
      name: "UX Complete Series",
      productType: "TEST_SERIES",
      examId: exam.id,
      testSeriesId: series.id,
      accessType: "PAID",
      mrpPaise: 199900,
      sellingPricePaise: 79900,
      accessDurationType: "DAYS",
      accessDays: 180,
    },
  });
  const mkStudent = (t: string) =>
    prisma.student.create({ data: { studentId: `UX-${t}-${sfx}`, name: `UX ${t}`, email: `ux-${t}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const [free, active, lifetime, expired] = await Promise.all(["F", "A", "L", "E"].map(mkStudent));
  const now = Date.now();
  const activeUntil = new Date(now + 200 * 86_400_000);
  const expiredAt = new Date(now - 3 * 86_400_000);
  await prisma.studentEntitlement.createMany({
    data: [
      { studentId: active.id, productId: product.id, source: "PURCHASE", startsAt: new Date(now - 10 * 86_400_000), expiresAt: activeUntil },
      { studentId: lifetime.id, productId: product.id, source: "ADMIN_GRANT", startsAt: new Date(now - 86_400_000), expiresAt: null },
      { studentId: expired.id, productId: product.id, source: "PURCHASE", startsAt: new Date(now - 100 * 86_400_000), expiresAt: expiredAt },
    ],
  });
  await saveRazorpayConfig({ slot: "TEST", keyId: "rzp_test_UxVerify123", keySecret: "ux_secret_x", webhookSecret: "ux_whsec_x" });
  await saveRazorpayConfig({ environment: "TEST", enabled: true });
  await setMode("PAID");

  const summaryFor = async (sid: string) => (await getStudentExamAccessSummaries(sid, [exam]))[0];
  const unlocked = async (sid: string) =>
    evaluateContentAccess(await loadAccessContext(sid), { kind: "MOCK_TEST", id: paid1.id, examId: exam.id, testSeriesId: series.id, accessType: "PAID" }).allowed;
  const checkout = `/student/checkout/${product.code}`;

  console.log("A. Free student");
  const f = await summaryFor(free.id);
  const quote = await getCheckoutQuote(free.id, product.code);
  check("State FREE", f?.state === "FREE");
  check("Price is the canonical Product price (₹799, MRP ₹1999)", f?.offer?.price.pricePaise === computeProductPrice(product).pricePaise && f?.offer?.price.pricePaise === 79900 && f.offer.price.mrpPaise === 199900);
  check("Dashboard price == checkout quote payable", f?.offer?.price.pricePaise === quote?.payablePaise);
  check("Unlock CTA → canonical product checkout", f?.checkoutHref === checkout);
  check("2 free / 2 Complete-Access tests", f?.freeMocks === 2 && f?.lockedMocks === 2);
  check("Comparison rows present, price row first", (f?.comparison.length ?? 0) > 3 && f?.comparison[0].key === "price");
  check("Comparison link → public series page #plans", f?.comparisonHref === `/exams/${exam.publicSlug}/mock-test-series#plans`);
  check("Paid mock locked for the free student", !(await unlocked(free.id)));

  console.log("\nB. Active paid student");
  const a = await summaryFor(active.id);
  check("State ACTIVE (no upgrade promo)", a?.state === "ACTIVE");
  check("Expiry == entitlement expiresAt", a?.entitlement?.expiresAt?.getTime() === activeUntil.getTime());
  check("Days remaining computed from real expiry", a?.entitlement?.daysLeft === 200);
  check("Paid mock unlocked by the same engine", await unlocked(active.id));
  const l = await summaryFor(lifetime.id);
  check("Lifetime entitlement → ACTIVE with no fabricated expiry", l?.state === "ACTIVE" && l.entitlement?.expiresAt === null && l.entitlement.daysLeft === null);

  console.log("\nC. Expired student");
  const e = await summaryFor(expired.id);
  check("State EXPIRED with previous expiry", e?.state === "EXPIRED" && e.entitlement?.expiresAt?.getTime() === expiredAt.getTime());
  check("Renew CTA → canonical checkout", e?.checkoutHref === checkout);
  check("Paid mock locked again", !(await unlocked(expired.id)));

  console.log("\nD. Purchase unavailable → no dead Buy path");
  await saveRazorpayConfig({ enabled: false });
  const g = await summaryFor(free.id);
  check("Gateway disabled → no checkout link + message", g?.checkoutHref === null && Boolean(g?.unavailableReason));
  await saveRazorpayConfig({ enabled: true });
  await prisma.product.update({ where: { id: product.id }, data: { purchaseEnabled: false } });
  const pe = await summaryFor(free.id);
  check("Product purchase disabled → no checkout link", pe?.checkoutHref === null);
  await prisma.product.update({ where: { id: product.id }, data: { purchaseEnabled: true } });
  await setMode("MAINTENANCE");
  const mt = await summaryFor(free.id);
  check("MAINTENANCE → no checkout link, paused message", mt?.checkoutHref === null && /paused/i.test(mt?.unavailableReason ?? ""));
  await setMode("FREE");
  const fm = await summaryFor(free.id);
  check("FREE mode → FREE_MODE (no upgrade promo, no checkout)", fm?.state === "FREE_MODE" && fm.checkoutHref === null);
  await setMode("PAID");

  console.log("\nE. Offer display config");
  const parsed = offerDisplaySchema.safeParse({
    promoVisible: false,
    heading: "Go Complete",
    description: "",
    ctaLabel: "Unlock now",
    rows: [
      { key: "price", feature: "Cheap!", free: { mode: "TEXT", text: "₹1" }, paid: { mode: "TEXT", text: "₹1" }, visible: true, highlight: true },
      { key: "analytics", free: { mode: "CROSS" }, paid: { mode: "CHECK" }, visible: true, highlight: false },
      { key: "bookmarks", free: { mode: "AUTO" }, paid: { mode: "AUTO" }, visible: false, highlight: false },
      { key: "custom-a1", feature: "Doubt support", free: { mode: "CROSS" }, paid: { mode: "TEXT", text: "Email" }, visible: true, highlight: false },
    ],
  });
  check("Valid config parses", parsed.success);
  if (parsed.success) {
    await saveOfferDisplay(series.id, parsed.data);
    const c = await summaryFor(free.id);
    const price = c?.comparison.find((r) => r.key === "price");
    check("Price row can't be overridden (still canonical)", price?.feature === "Price" && price.paid.text.includes("₹799") && price.highlight);
    check("Row override applied (analytics: Free ✗ / Complete ✓)", c?.comparison.find((r) => r.key === "analytics")?.free.state === "cross");
    check("Hidden row removed", !c?.comparison.some((r) => r.key === "bookmarks"));
    check("Custom row shown", c?.comparison.some((r) => r.key === "custom-a1" && r.paid.text === "Email") ?? false);
    check("Heading / CTA / promo flag from config", c?.display.heading === "Go Complete" && c.display.ctaLabel === "Unlock now" && c.display.promoVisible === false);
    check("Checkout price unaffected by display config", (await getCheckoutQuote(free.id, product.code))?.payablePaise === 79900);
    await resetOfferDisplay(series.id);
  }
  check(
    "Custom row with AUTO rejected",
    !offerDisplaySchema.safeParse({ promoVisible: true, heading: "h", description: "", ctaLabel: "c", rows: [{ key: "custom-x", feature: "X", free: { mode: "AUTO" }, paid: { mode: "CHECK" }, visible: true, highlight: false }] }).success
  );
  check("applyOfferDisplay appends new derived rows", applyOfferDisplay([{ key: "k", feature: "K", free: "Yes", paid: "Yes" }], { ...parsed.data!, rows: [] }).length === 1);

  console.log("\nF. Authorization");
  const src = readFileSync("app/admin/(dashboard)/exams/test-series/actions.ts", "utf8");
  const gated = (fn: string) => new RegExp(`export async function ${fn}[\\s\\S]*?\\{\\s*const session = await requirePermission\\(PERMISSIONS\\.TEST_SERIES_MANAGE\\)`).test(src);
  check("saveOfferDisplayAction checks TEST_SERIES_MANAGE first", gated("saveOfferDisplayAction"));
  check("resetOfferDisplayAction checks TEST_SERIES_MANAGE first", gated("resetOfferDisplayAction"));
  check("FULL_ADMIN lacks TEST_SERIES_MANAGE (view only)", !DEFAULT_ROLE_PERMISSIONS[RoleName.FULL_ADMIN].includes(PERMISSIONS.TEST_SERIES_MANAGE));
  check("MASTER_ADMIN has TEST_SERIES_MANAGE", DEFAULT_ROLE_PERMISSIONS[RoleName.MASTER_ADMIN].includes(PERMISSIONS.TEST_SERIES_MANAGE));

  console.log("\nG. Dashboard block");
  check("access-status registered first", STUDENT_DASHBOARD_BLOCKS[0].id === "access-status");
  const legacy = normalizeStudentDashboardLayout([{ id: "performance-summary", visible: true }, { id: "subscription-status", visible: false }]);
  // Only the anchored "student-reviews" block (registry insertBefore: access-status) may precede it.
  check("Saved layouts gain access-status at the top, visible", legacy[0].id === "student-reviews" && legacy[1].id === "access-status" && legacy[1].visible);

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
