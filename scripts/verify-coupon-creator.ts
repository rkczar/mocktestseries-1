/**
 * Coupon / creator-attribution / payment-verification-account regression
 * suite (complements scripts/verify-payments.ts).
 *
 * SAFETY: flips the global payment mode, writes fake gateway credentials and
 * creates orders/payments, so it REFUSES to run unless DATABASE_URL points at
 * a scratch database whose name contains "payverify". Razorpay's REST API is
 * replaced in-process by a fake that signs with the real HMAC scheme — no
 * network call, no real charge.
 *
 *   DATABASE_URL=<scratch url> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-coupon-creator.ts
 *
 * Proves: verification accounts get PAID behaviour while everyone else stays
 * FREE — including the PAID offer presentation (dashboard card, Plans mode,
 * series CTA) while public / anonymous offers follow the global mode; coupon code normalisation; invalid / inactive / not-started / expired
 * / exhausted / wrong-product rejection; product-restricted acceptance;
 * percentage, fixed and 100% discounts (server-computed, never negative, no
 * Razorpay ₹0 order); amount/currency tampering fails closed; abandoned order
 * releases its reservation; failed payment keeps it until expiry, retry
 * consumes exactly once; callback + webhook + replay → one Payment /
 * redemption / entitlement / invoice; concurrent redemption never exceeds the
 * limit (1 and 3); per-student limit survives retry/replay; TEST↔LIVE webhook
 * isolation; refund keeps redemption consumed, grants nothing new and is
 * deducted from creator eligible net; creator commission (percentage + fixed),
 * LIVE-only reporting, CSV without PII and formula-injection-safe; readiness
 * treats FREE + a verification account as safe; RBAC on the new mutation and
 * CSV route.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { StudentAuthProvider, MockTestStatus } from "@prisma/client";

if (!/payverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *payverify* scratch database.");
  process.exit(2);
}

const KEY_ID = "rzp_test_CouponKey123";
const KEY_SECRET = "cv_secret_" + crypto.randomBytes(8).toString("hex");
const WEBHOOK_SECRET = "cv_whsec_" + crypto.randomBytes(8).toString("hex");
const LIVE_KEY_ID = "rzp_live_CouponKey456";
const LIVE_KEY_SECRET = "cv_live_secret_" + crypto.randomBytes(8).toString("hex");
const LIVE_WEBHOOK_SECRET = "cv_live_whsec_" + crypto.randomBytes(8).toString("hex");
const authFor = (id: string, secret: string) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

type Env = "TEST" | "LIVE";
type FakeOrder = { id: string; amount: number; currency: string; receipt: string; status: string; env: Env };
type FakePayment = { id: string; order_id: string; amount: number; currency: string; status: string; method: string; amount_refunded: number };
const fake = { orders: new Map<string, FakeOrder>(), payments: new Map<string, FakePayment>(), orderCreates: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.razorpay.com/v1")) return realFetch(input, init);
  const auth = new Headers(init?.headers).get("authorization");
  const env: Env | null = auth === authFor(KEY_ID, KEY_SECRET) ? "TEST" : auth === authFor(LIVE_KEY_ID, LIVE_KEY_SECRET) ? "LIVE" : null;
  if (!env) return new Response("{}", { status: 401 });
  const path = url.replace("https://api.razorpay.com/v1", "").split("?")[0];
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  let m: RegExpMatchArray | null;
  if (init?.method === "POST" && path === "/orders") {
    fake.orderCreates++;
    const o: FakeOrder = { id: "order_" + crypto.randomBytes(7).toString("hex"), amount: body.amount, currency: body.currency, receipt: body.receipt, status: "created", env };
    fake.orders.set(o.id, o);
    return json(o);
  }
  const orderInPath = path.match(/^\/orders\/([^/]+)/)?.[1];
  if (orderInPath && fake.orders.get(orderInPath)?.env !== env) return json({}, 404);
  if ((m = path.match(/^\/orders\/([^/]+)\/payments$/))) return json({ items: [...fake.payments.values()].filter((p) => p.order_id === m![1]) });
  if ((m = path.match(/^\/orders\/([^/]+)$/))) return json(fake.orders.get(m[1]));
  if ((m = path.match(/^\/payments\/([^/]+)\/capture$/))) {
    const p = fake.payments.get(m[1]);
    if (!p || p.status !== "authorized") return json({}, 400);
    p.status = "captured";
    return json(p);
  }
  if ((m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
    const p = fake.payments.get(m[1]);
    if (!p) return json({}, 404);
    p.amount_refunded += body.amount;
    if (p.amount_refunded >= p.amount) p.status = "refunded";
    return json({ id: "rfnd_" + crypto.randomBytes(7).toString("hex"), payment_id: p.id, amount: body.amount, status: "processed" });
  }
  if ((m = path.match(/^\/payments\/([^/]+)$/))) return fake.payments.has(m[1]) ? json(fake.payments.get(m[1])) : json({}, 404);
  return json({}, 404);
}) as typeof fetch;

function fakePay(gatewayOrderId: string, status: "captured" | "failed" = "captured", override: Partial<FakePayment> = {}) {
  const o = fake.orders.get(gatewayOrderId)!;
  const p: FakePayment = { id: "pay_" + crypto.randomBytes(7).toString("hex"), order_id: o.id, amount: o.amount, currency: o.currency, status, method: "upi", amount_refunded: 0, ...override };
  fake.payments.set(p.id, p);
  const secret = o.env === "LIVE" ? LIVE_KEY_SECRET : KEY_SECRET;
  return { payment: p, signature: crypto.createHmac("sha256", secret).update(`${o.id}|${p.id}`).digest("hex") };
}
const hookBody = (event: string, payment: FakePayment) => JSON.stringify({ event, payload: { payment: { entity: payment } }, created_at: Math.floor(Date.now() / 1000) });
const sign = (body: string, secret: string) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const evId = () => "evt_" + crypto.randomBytes(8).toString("hex");

let failures = 0;
function check(label: string, passed: boolean) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}`);
  if (!passed) failures++;
}
async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { setPaymentMode, setVerificationStudentIds, bumpPaymentSettingsCache } = await import("@/lib/payments/settings");
  const { saveRazorpayConfig } = await import("@/lib/razorpay-config");
  const { getContentAccess, canStudentAccessProduct } = await import("@/lib/payments/access");
  const { createCheckoutOrder, verifyCheckoutPayment, getCheckoutQuote, expireStaleOrders, CheckoutError } = await import("@/lib/payments/orders");
  const { handleRazorpayWebhook } = await import("@/lib/payments/webhooks");
  const { requestRefund } = await import("@/lib/payments/refunds");
  const { getCouponSettlementRows, getCouponPerformance, settlementCsv, commissionFor } = await import("@/lib/payments/coupon-report");
  const { getLaunchReadiness } = await import("@/lib/payments/launch-readiness");
  const { getPaymentModeForStudent } = await import("@/lib/payments/settings");
  const { getStudentExamAccessSummaries } = await import("@/lib/payments/student-access");
  const { getSeriesOffer, getExamMockSeriesSummary, getSeriesCta } = await import("@/lib/mock-series");
  const { computeProductPrice, describeAccessDuration } = await import("@/lib/payments/pricing");
  const { getRazorpayConfig } = await import("@/lib/razorpay-config");

  const setMode = async (m: "FREE" | "PAID" | "MAINTENANCE") => {
    await setPaymentMode(m, undefined);
    bumpPaymentSettingsCache();
  };
  const switchGatewayEnv = async (environment: Env) => saveRazorpayConfig({ environment, enabled: true });
  const code = (e: Error | null) => (e instanceof CheckoutError ? e.code : e ? e.message : "none");

  console.log("=== Coupon / Creator / Verification-account Verification (scratch DB, fake Razorpay) ===\n");
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `CV Exam ${sfx}`, code: `CV-${sfx}`, durationMinutes: 30 } });
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `CV Series ${sfx}`, status: "PUBLISHED" } });
  const paidMock = await prisma.mockTest.create({ data: { examId: exam.id, testSeriesId: series.id, title: "CV Paid Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "PAID" } });
  const sampleMock = await prisma.mockTest.create({ data: { examId: exam.id, testSeriesId: series.id, title: "CV Free Sample", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "FREE" } });
  const product = await prisma.product.create({
    data: { code: `cv-series-${sfx}`, name: "CV Series Pass", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 200000, sellingPricePaise: 49900, accessDurationType: "DAYS", accessDays: 100 },
  });
  const otherExam = await prisma.exam.create({ data: { name: `CV Other ${sfx}`, code: `CVO-${sfx}`, durationMinutes: 30 } });
  const otherProduct = await prisma.product.create({
    data: { code: `cv-other-${sfx}`, name: "CV Other Pass", productType: "EXAM_ACCESS", examId: otherExam.id, accessType: "PAID", mrpPaise: 99900, sellingPricePaise: 99900, accessDurationType: "DAYS", accessDays: 30 },
  });
  let n = 0;
  const mkStudent = () => {
    n++;
    return prisma.student.create({ data: { studentId: `MTS-CV${String(n).padStart(4, "0")}${sfx}`, name: `CV Student ${n}`, email: `cv-${n}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  };
  const mkCoupon = (c: string, data: Record<string, unknown> = {}) =>
    prisma.coupon.create({ data: { code: `${c}${sfx.toUpperCase()}`.slice(0, 32), discountType: "PERCENTAGE", discountValue: 20, ...data } });
  const counts = async (orderId: string) => ({
    payments: await prisma.payment.count({ where: { orderId } }),
    ents: await prisma.studentEntitlement.count({ where: { orderId } }),
    invoices: await prisma.invoice.count({ where: { orderId } }),
    redemptions: await prisma.couponRedemption.count({ where: { orderId } }),
  });

  await saveRazorpayConfig({ slot: "TEST", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
  await saveRazorpayConfig({ slot: "LIVE", keyId: LIVE_KEY_ID, keySecret: LIVE_KEY_SECRET, webhookSecret: LIVE_WEBHOOK_SECRET });
  await switchGatewayEnv("TEST");

  // ------------------------------------------------------------------------
  console.log("1. Payment verification accounts (global mode FREE)");
  await setMode("FREE");
  const [V, U] = await Promise.all([mkStudent(), mkStudent()]);
  await setVerificationStudentIds([V.id], undefined);
  const uAccess = await getContentAccess(U.id, { kind: "MOCK_TEST", id: paidMock.id, examId: exam.id, testSeriesId: series.id, accessType: "PAID" });
  const vAccess = await getContentAccess(V.id, { kind: "MOCK_TEST", id: paidMock.id, examId: exam.id, testSeriesId: series.id, accessType: "PAID" });
  const vSample = await getContentAccess(V.id, { kind: "MOCK_TEST", id: sampleMock.id, examId: exam.id, testSeriesId: series.id, accessType: "FREE" });
  check("Regular student keeps FREE access to the paid mock", uAccess.allowed && uAccess.status === "FREE_ACCESS");
  check("Verification account sees the paid mock locked (PAYMENT_REQUIRED)", !vAccess.allowed && vAccess.status === "PAYMENT_REQUIRED");
  check("Verification account still gets the FREE sample mock", vSample.allowed);
  check("Regular student checkout refused (PLATFORM_FREE) — no order row", code(await rejects(() => createCheckoutOrder(U.id, product.id))) === "PLATFORM_FREE" && (await prisma.paymentOrder.count({ where: { studentId: U.id } })) === 0);
  check("Verification account product status → PAYMENT_REQUIRED", (await canStudentAccessProduct(V.id, product.id)).status === "PAYMENT_REQUIRED");
  // Presentation must follow the same effective mode as access / checkout.
  const summaryFor = async (sid: string) => (await getStudentExamAccessSummaries(sid, [exam]))[0];
  const checkoutHref = `/student/checkout/${product.code}`;
  const dbPrice = computeProductPrice(product);
  const uSum = await summaryFor(U.id);
  check("A. Regular student: effective mode FREE (Plans page mode)", (await getPaymentModeForStudent(U.id)) === "FREE");
  check("A. Regular student card → FREE_MODE, no price, no checkout", uSum?.state === "FREE_MODE" && uSum.checkoutHref === null && uSum.offer?.showPrice === false);
  check("A. Regular student series CTA → Open (no Buy)", (await getSeriesCta(U.id, uSum?.offer ?? null)).kind === "OPEN");
  const vSum = await summaryFor(V.id);
  check("B. Verification account: effective mode PAID (Plans page mode)", (await getPaymentModeForStudent(V.id)) === "PAID");
  check("B. Verification card → FREE-tier upsell, not FREE_MODE", vSum?.state === "FREE");
  check(
    "B. Verification offer shows the DB selling price + MRP",
    vSum?.offer?.showPrice === true && vSum.offer.price.pricePaise === dbPrice.pricePaise && vSum.offer.price.mrpPaise === product.mrpPaise
  );
  check("B. Verification offer duration from DB", vSum?.offer?.product.accessDuration === describeAccessDuration(product));
  check("B. Comparison price row shows the paid price", !/Free right now/.test(vSum?.comparison.find((r) => r.key === "price")?.paid.text ?? "Free right now"));
  check("B. Unlock CTA → canonical product checkout", vSum?.checkoutHref === checkoutHref && vSum.offer?.purchasable === true);
  check("B. Series CTA → BUY at checkout", (await getSeriesCta(V.id, vSum?.offer ?? null)).href === checkoutHref);
  check("B. Being a verification account grants no entitlement", (await prisma.studentEntitlement.count({ where: { studentId: V.id } })) === 0);
  const pubOffer = await getSeriesOffer(exam.id, series.id);
  const pubSummary = await getExamMockSeriesSummary({ id: exam.id, publicSlug: null });
  check("C. Public offer stays global FREE (no price, not purchasable)", pubOffer?.mode === "FREE" && !pubOffer.showPrice && !pubOffer.purchasable && pubSummary.offer?.showPrice === false);
  check("C. Anonymous CTA → Start Free (no paid CTA)", (await getSeriesCta(null, pubOffer)).kind === "START_FREE");
  check("C. Unlisted student id → FREE offer", (await getSeriesOffer(exam.id, series.id, new Date(), U.id))?.showPrice === false);
  check("No order rows created by presentation", (await prisma.paymentOrder.count({ where: { studentId: { in: [U.id, V.id] } } })) === 0);

  const vOrder = await createCheckoutOrder(V.id, product.id);
  check("Verification account can create a gateway order at the server price", vOrder.kind === "RAZORPAY" && vOrder.amountPaise === 49900);
  if (vOrder.kind === "RAZORPAY") {
    const { payment, signature } = fakePay(vOrder.gatewayOrderId);
    const r = await verifyCheckoutPayment(V.id, { orderId: vOrder.orderId, razorpayOrderId: vOrder.gatewayOrderId, razorpayPaymentId: payment.id, razorpaySignature: signature });
    const after = await getContentAccess(V.id, { kind: "MOCK_TEST", id: paidMock.id, examId: exam.id, testSeriesId: series.id, accessType: "PAID" });
    check("Paid → series unlocked for the verification account (ACTIVE_SUBSCRIPTION)", r.status === "SUCCESS" && after.status === "ACTIVE_SUBSCRIPTION");
    const vActive = await summaryFor(V.id);
    check("D. Verification account + ACTIVE entitlement → ACTIVE card, no purchase-required", vActive?.state === "ACTIVE" && vActive.entitlement?.productIds.includes(product.id) === true);
  }
  const readinessFreeWith = (await getLaunchReadiness()).groups.find((g) => g.key === "PRODUCT")!.items.find((i) => i.label === "Payment mode")!;
  await setVerificationStudentIds([], undefined);
  const readinessFreeWithout = (await getLaunchReadiness()).groups.find((g) => g.key === "PRODUCT")!.items.find((i) => i.label === "Payment mode")!;
  check("Readiness: FREE + verification account → Payment mode PASS", readinessFreeWith.status === "PASS");
  check("Readiness: FREE with no verification account → ACTION_REQUIRED", readinessFreeWithout.status === "ACTION_REQUIRED");
  check("Cleared list → former verification account is FREE again", (await canStudentAccessProduct(V.id, product.id)).status === "FREE_ACCESS");
  check("Global mode stayed FREE throughout", (await prisma.setting.findUniqueOrThrow({ where: { key: "payments.mode" } })).value?.toString() !== undefined && ((await prisma.setting.findUniqueOrThrow({ where: { key: "payments.mode" } })).value as { mode: string }).mode === "FREE");

  // Everything below exercises the paid path directly.
  await setMode("PAID");
  {
    const W = await mkStudent();
    const wSum = await summaryFor(W.id);
    const pub = await getSeriesOffer(exam.id, series.id);
    check("E. Global PAID: regular student sees price + checkout (unchanged)", wSum?.state === "FREE" && wSum.checkoutHref === checkoutHref && wSum.offer?.price.pricePaise === dbPrice.pricePaise);
    check("E. Global PAID: public offer shows price (unchanged)", pub?.showPrice === true && pub.purchasable === true);
    check("E. Global PAID: anonymous CTA → login to buy", (await getSeriesCta(null, pub)).kind === "LOGIN_TO_BUY");
  }

  console.log("\n1b. Gateway environment form (stored value drives badge + dropdown)");
  {
    const panel = readFileSync("app/admin/(dashboard)/payments/_components/panels-ops.tsx", "utf8");
    // The action form resets after submit; an unkeyed uncontrolled select would
    // fall back to its first-render option (the stale TEST display).
    check("F. Dropdown remounts from the stored environment", /<SelectNative key=\{rzp\.environment\} id="gw-env" name="environment" defaultValue=\{rzp\.environment\}>/.test(panel));
    check("F. Badge reads the same stored value", /\{rzp\.environment === "TEST" \? <Badge variant="warning">TEST MODE<\/Badge> : <Badge variant="error">LIVE MODE — real money<\/Badge>\}/.test(panel));
    await switchGatewayEnv("LIVE");
    check("F. Persisted LIVE → config LIVE (badge + dropdown source)", (await getRazorpayConfig()).environment === "LIVE");
    await switchGatewayEnv("TEST");
    check("F. Persisted TEST → config TEST (badge + dropdown source)", (await getRazorpayConfig()).environment === "TEST");
  }

  // ------------------------------------------------------------------------
  console.log("\n2. Coupon validation (server-side)");
  const S1 = await mkStudent();
  const doc20 = await mkCoupon("DOC20", { referrerName: "Dr Creator", campaign: "launch", commissionType: "PERCENTAGE", commissionValue: 1000 });
  const q = async (input: string, pid = product.code, sid = S1.id) => getCheckoutQuote(sid, pid, input);
  const norm = await q(`  ${doc20.code.toLowerCase()} `);
  check("Lower-case + surrounding spaces normalise to the stored code", norm?.coupon?.code === doc20.code && !norm.couponError);
  check("20% of ₹499 → discount ₹99.80 (floored), payable ₹399.20", norm?.coupon?.discountPaise === 9980 && norm.payablePaise === 39920);
  check("Unknown code → rejected", (await q("NOPE" + sfx.toUpperCase()))?.couponError === "This coupon code is not valid.");
  check("Malformed code (symbols) → rejected", Boolean((await q("BAD CODE!"))?.couponError));
  const inactive = await mkCoupon("OFF", { isActive: false });
  check("Disabled coupon → rejected", (await q(inactive.code))?.couponError === "This coupon is no longer active.");
  const future = await mkCoupon("SOON", { validFrom: new Date(Date.now() + 86_400_000) });
  check("Not-yet-started coupon → rejected", (await q(future.code))?.couponError === "This coupon is not active yet.");
  const expired = await mkCoupon("OLD", { validUntil: new Date(Date.now() - 60_000) });
  check("Expired coupon → rejected", (await q(expired.code))?.couponError === "This coupon has expired.");
  const restricted = await mkCoupon("ONLY", { productIds: [product.id] });
  check("Product-restricted coupon accepted for the allowed product", Boolean((await q(restricted.code))?.coupon));
  check("…and rejected for another product", (await q(restricted.code, otherProduct.code))?.couponError === "This coupon can't be used for this product.");
  const seriesOnly = await mkCoupon("SER", { testSeriesIds: [series.id] });
  check("Series-restricted coupon rejected for a non-series product", (await q(seriesOnly.code, otherProduct.code))?.couponError === "This coupon can't be used for this product.");
  check("Invalid coupon at order creation → COUPON_REJECTED, no order", code(await rejects(() => createCheckoutOrder(S1.id, product.id, expired.code))) === "COUPON_REJECTED" && (await prisma.paymentOrder.count({ where: { studentId: S1.id } })) === 0);

  // ------------------------------------------------------------------------
  console.log("\n3. Discount types");
  const fixed100 = await mkCoupon("FIX", { discountType: "FIXED_AMOUNT", discountValue: 10000 });
  check("Fixed ₹100 off ₹499 → payable ₹399", (await q(fixed100.code))?.payablePaise === 39900);
  const fixedHuge = await mkCoupon("BIG", { discountType: "FIXED_AMOUNT", discountValue: 900000 });
  const hugeQuote = await q(fixedHuge.code);
  check("Fixed discount above the price never goes negative (payable ₹0)", hugeQuote?.payablePaise === 0 && hugeQuote.coupon?.discountPaise === 49900);
  const free = await mkCoupon("FREE", { discountType: "FREE_ACCESS", discountValue: 100 });
  const S2 = await mkStudent();
  const createsBefore = fake.orderCreates;
  const freeOrder = await createCheckoutOrder(S2.id, product.id, free.code);
  const freeRow = freeOrder.kind === "FREE_GRANT" ? await prisma.paymentOrder.findUniqueOrThrow({ where: { id: freeOrder.orderId }, include: { entitlement: true, couponRedemption: true } }) : null;
  check("100% coupon → FREE_GRANT with no Razorpay order", freeOrder.kind === "FREE_GRANT" && fake.orderCreates === createsBefore);
  check("…INTERNAL gateway, ₹0, PAID, no Payment row", freeRow?.gateway === "INTERNAL" && freeRow.amountPaise === 0 && freeRow.status === "PAID" && (await prisma.payment.count({ where: { orderId: freeRow.id } })) === 0);
  check("…one COUPON entitlement + CONSUMED redemption", freeRow?.entitlement?.source === "COUPON" && freeRow.couponRedemption?.status === "CONSUMED");

  // ------------------------------------------------------------------------
  console.log("\n4. Tampering fails closed");
  const S3 = await mkStudent();
  const tOrder = await createCheckoutOrder(S3.id, product.id, doc20.code);
  check("Coupon order amount is the server figure (₹399.20) on our row AND at Razorpay", tOrder.kind === "RAZORPAY" && tOrder.amountPaise === 39920 && fake.orders.get(tOrder.gatewayOrderId)?.amount === 39920);
  if (tOrder.kind === "RAZORPAY") {
    const bad = fakePay(tOrder.gatewayOrderId, "captured", { amount: 100 });
    const r1 = await verifyCheckoutPayment(S3.id, { orderId: tOrder.orderId, razorpayOrderId: tOrder.gatewayOrderId, razorpayPaymentId: bad.payment.id, razorpaySignature: bad.signature });
    check("Captured amount ≠ order amount → FAILED, no entitlement", r1.status === "FAILED" && (await prisma.studentEntitlement.count({ where: { orderId: tOrder.orderId } })) === 0);
    const cur = fakePay(tOrder.gatewayOrderId, "captured", { currency: "USD" });
    const body = hookBody("payment.captured", cur.payment);
    const r2 = await handleRazorpayWebhook(body, sign(body, WEBHOOK_SECRET), evId());
    check("Currency mismatch via webhook → MISMATCH, no entitlement", r2.body.status === "MISMATCH" && (await prisma.studentEntitlement.count({ where: { orderId: tOrder.orderId } })) === 0);
    const r3 = await verifyCheckoutPayment(S3.id, { orderId: tOrder.orderId, razorpayOrderId: "order_Tampered123", razorpayPaymentId: cur.payment.id, razorpaySignature: cur.signature });
    check("Browser-supplied Razorpay order id mismatch → FAILED", r3.status === "FAILED");
    const unk = JSON.stringify({ event: "payment.dispute.created", payload: { payment: { entity: cur.payment } } });
    const r4 = await handleRazorpayWebhook(unk, sign(unk, WEBHOOK_SECRET), evId());
    check("Unknown event type → ignored, grants nothing", r4.body.status === "ignored" && (await prisma.studentEntitlement.count({ where: { orderId: tOrder.orderId } })) === 0);
  }

  // ------------------------------------------------------------------------
  console.log("\n5. Redemption lifecycle: abandoned / failed / success");
  const once = await mkCoupon("ONCE", { totalUsageLimit: 1, referrerName: "Dr Once" });
  const [A1, A2] = await Promise.all([mkStudent(), mkStudent()]);
  const abandoned = await createCheckoutOrder(A1.id, product.id, once.code);
  const held = await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: abandoned.orderId } });
  check("Order with coupon → redemption RESERVED (holds the single use)", held.status === "RESERVED");
  check("While held, another student is refused (EXHAUSTED)", code(await rejects(() => createCheckoutOrder(A2.id, product.id, once.code))) === "COUPON_REJECTED");
  await expireStaleOrders(new Date(Date.now() + 2 * 3600_000));
  check("Abandoned order expires → reservation RELEASED", (await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: abandoned.orderId } })).status === "RELEASED");
  const retry = await createCheckoutOrder(A2.id, product.id, once.code);
  check("Released use is available again to another student", retry.kind === "RAZORPAY");
  if (retry.kind === "RAZORPAY") {
    const failed = fakePay(retry.gatewayOrderId, "failed");
    const fb = hookBody("payment.failed", failed.payment);
    await handleRazorpayWebhook(fb, sign(fb, WEBHOOK_SECRET), evId());
    const afterFail = await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: retry.orderId } });
    check("Failed payment grants nothing; redemption stays RESERVED until the order expires", afterFail.status === "RESERVED" && (await prisma.studentEntitlement.count({ where: { orderId: retry.orderId } })) === 0);
    const again = await createCheckoutOrder(A2.id, product.id, once.code);
    check("Checkout retry reuses the same open order (no second redemption)", again.orderId === retry.orderId && (await prisma.couponRedemption.count({ where: { couponId: once.id } })) === 2);
    const ok = fakePay(retry.gatewayOrderId);
    const v = await verifyCheckoutPayment(A2.id, { orderId: retry.orderId, razorpayOrderId: retry.gatewayOrderId, razorpayPaymentId: ok.payment.id, razorpaySignature: ok.signature });
    const cb = hookBody("payment.captured", ok.payment);
    const id1 = evId();
    await handleRazorpayWebhook(cb, sign(cb, WEBHOOK_SECRET), id1);
    const replay = await handleRazorpayWebhook(cb, sign(cb, WEBHOOK_SECRET), id1);
    const op = JSON.stringify({ event: "order.paid", payload: { payment: { entity: ok.payment }, order: { entity: { id: retry.gatewayOrderId } } } });
    await handleRazorpayWebhook(op, sign(op, WEBHOOK_SECRET), evId());
    const c = await counts(retry.orderId);
    check("Callback + webhook + replay + order.paid → SUCCESS, replay is 'duplicate'", v.status === "SUCCESS" && replay.body.status === "duplicate");
    check("…one captured Payment (plus the earlier failed attempt row)", (await prisma.payment.count({ where: { orderId: retry.orderId, status: "CAPTURED" } })) === 1);
    check("…exactly one entitlement, invoice and redemption", c.ents === 1 && c.invoices === 1 && c.redemptions === 1);
    check("…redemption CONSUMED", (await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: retry.orderId } })).status === "CONSUMED");
    check("Limit-1 coupon now exhausted for everyone", (await q(once.code, product.code, A1.id))?.couponError === "This coupon has reached its usage limit.");
  }

  // ------------------------------------------------------------------------
  console.log("\n6. Concurrent redemption");
  const solo = await mkCoupon("SOLO", { totalUsageLimit: 1 });
  const [C1, C2] = await Promise.all([mkStudent(), mkStudent()]);
  const duo = await Promise.allSettled([createCheckoutOrder(C1.id, product.id, solo.code), createCheckoutOrder(C2.id, product.id, solo.code)]);
  check("Limit 1, two students at once → exactly one order holds the coupon", duo.filter((r) => r.status === "fulfilled").length === 1 && (await prisma.couponRedemption.count({ where: { couponId: solo.id } })) === 1);
  const trio = await mkCoupon("TRIO", { totalUsageLimit: 3 });
  const many = await Promise.all(Array.from({ length: 8 }, () => mkStudent()));
  const results = await Promise.allSettled(many.map((st) => createCheckoutOrder(st.id, product.id, trio.code)));
  const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createCheckoutOrder>>> => r.status === "fulfilled").map((r) => r.value);
  check(`Limit 3, eight students at once → exactly 3 orders (got ${won.length})`, won.length === 3 && (await prisma.couponRedemption.count({ where: { couponId: trio.id } })) === 3);
  await Promise.all(
    won.map(async (o) => {
      if (o.kind !== "RAZORPAY") return;
      const p = fakePay(o.gatewayOrderId);
      const b = hookBody("payment.captured", p.payment);
      await handleRazorpayWebhook(b, sign(b, WEBHOOK_SECRET), evId());
    })
  );
  check("After paying all three: consumed = 3 = limit (never above)", (await prisma.couponRedemption.count({ where: { couponId: trio.id, status: "CONSUMED" } })) === 3);

  // ------------------------------------------------------------------------
  console.log("\n7. Per-student limit");
  const perOne = await mkCoupon("PER1", { perStudentLimit: 1, discountValue: 10 });
  const P1 = await mkStudent();
  const p1 = await createCheckoutOrder(P1.id, product.id, perOne.code);
  if (p1.kind === "RAZORPAY") {
    const p = fakePay(p1.gatewayOrderId);
    await verifyCheckoutPayment(P1.id, { orderId: p1.orderId, razorpayOrderId: p1.gatewayOrderId, razorpayPaymentId: p.payment.id, razorpaySignature: p.signature });
  }
  check("Same student, same coupon on a renewal → STUDENT_LIMIT", code(await rejects(() => createCheckoutOrder(P1.id, product.id, perOne.code, { renew: true }))) === "COUPON_REJECTED");
  check("…quote shows the per-student message", (await q(perOne.code, product.code, P1.id))?.couponError === "You've already used this coupon the maximum number of times.");
  const blank = await mkCoupon("MULTI", { perStudentLimit: null, discountValue: 10 });
  const P2 = await mkStudent();
  const b1 = await createCheckoutOrder(P2.id, product.id, blank.code);
  if (b1.kind === "RAZORPAY") {
    const p = fakePay(b1.gatewayOrderId);
    await verifyCheckoutPayment(P2.id, { orderId: b1.orderId, razorpayOrderId: b1.gatewayOrderId, razorpayPaymentId: p.payment.id, razorpaySignature: p.signature });
  }
  const b2 = await createCheckoutOrder(P2.id, product.id, blank.code, { renew: true });
  check("Blank per-student limit on a paid coupon → the student may reuse it for a renewal", b2.kind === "RAZORPAY");
  check("A stale second 'Buy' (no renew) is refused while access is active", code(await rejects(() => createCheckoutOrder(P1.id, product.id))) === "ALREADY_OWNED");

  // ------------------------------------------------------------------------
  console.log("\n8. TEST ↔ LIVE isolation");
  const Iso = await mkStudent();
  const testOrder = await createCheckoutOrder(Iso.id, product.id);
  if (testOrder.kind === "RAZORPAY") {
    const p = fakePay(testOrder.gatewayOrderId);
    const body = hookBody("payment.captured", p.payment);
    const r = await handleRazorpayWebhook(body, sign(body, LIVE_WEBHOOK_SECRET), evId());
    check("LIVE-signed event for a TEST order → ignored, no Payment/entitlement", r.body.status === "ignored" && (await counts(testOrder.orderId)).payments === 0);
  }
  await switchGatewayEnv("LIVE");
  const IsoL = await mkStudent();
  const liveOrder = await createCheckoutOrder(IsoL.id, product.id);
  check("LIVE checkout creates the gateway order with LIVE keys", liveOrder.kind === "RAZORPAY" && liveOrder.environment === "LIVE" && fake.orders.get(liveOrder.gatewayOrderId)?.env === "LIVE");
  if (liveOrder.kind === "RAZORPAY") {
    const p = fakePay(liveOrder.gatewayOrderId);
    const body = hookBody("payment.captured", p.payment);
    const r = await handleRazorpayWebhook(body, sign(body, WEBHOOK_SECRET), evId());
    check("TEST-signed event for a LIVE order → ignored, no Payment/entitlement", r.body.status === "ignored" && (await counts(liveOrder.orderId)).payments === 0);
    const good = await handleRazorpayWebhook(body, sign(body, LIVE_WEBHOOK_SECRET), evId());
    const inv = await prisma.invoice.findUnique({ where: { orderId: liveOrder.orderId } });
    check("LIVE-signed event → PAID with a LIVE invoice (no TEST- prefix)", good.body.status === "PAID" && Boolean(inv && !inv.invoiceNumber.startsWith("TEST-")));
  }

  // ------------------------------------------------------------------------
  console.log("\n9. Creator reporting, refunds and commission (LIVE)");
  const creatorPct = await mkCoupon("DRPCT", { referrerName: "=HYPERLINK(\"x\")", campaign: "reel", commissionType: "PERCENTAGE", commissionValue: 1000 });
  const creatorFix = await mkCoupon("DRFIX", { referrerName: "Dr Fixed", commissionType: "FIXED_AMOUNT", commissionValue: 5000 });
  const buyers = await Promise.all([mkStudent(), mkStudent(), mkStudent()]);
  const paidLive: { orderId: string; paymentRowId: string }[] = [];
  for (const [i, st] of buyers.entries()) {
    const o = await createCheckoutOrder(st.id, product.id, i < 2 ? creatorPct.code : creatorFix.code);
    if (o.kind !== "RAZORPAY") continue;
    const p = fakePay(o.gatewayOrderId);
    await verifyCheckoutPayment(st.id, { orderId: o.orderId, razorpayOrderId: o.gatewayOrderId, razorpayPaymentId: p.payment.id, razorpaySignature: p.signature });
    paidLive.push({ orderId: o.orderId, paymentRowId: (await prisma.payment.findUniqueOrThrow({ where: { gatewayPaymentId: p.payment.id } })).id });
  }
  // An abandoned LIVE checkout with the same coupon must not count as a sale.
  const lurker = await mkStudent();
  await createCheckoutOrder(lurker.id, product.id, creatorPct.code);
  // Fully refund the first creator sale.
  const entBefore = await prisma.studentEntitlement.count({ where: { studentId: buyers[0].id } });
  await requestRefund({ paymentId: paidLive[0].paymentRowId, amountPaise: 39920, reason: "verification", accessPolicy: "RETAIN", retainUntil: null, adminId: undefined });
  const refundedOrder = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: paidLive[0].orderId }, include: { couponRedemption: true } });
  check("Refund → order REFUNDED, redemption stays CONSUMED (use not freed)", refundedOrder.status === "REFUNDED" && refundedOrder.couponRedemption?.status === "CONSUMED");
  check("Refund grants no additional entitlement", (await prisma.studentEntitlement.count({ where: { studentId: buyers[0].id } })) === entBefore);

  const liveF = { environment: "LIVE" as const, from: null, to: null, couponId: null, creator: null };
  const perf = await getCouponPerformance(liveF, [creatorPct.id, creatorFix.id]);
  const pct = perf.get(creatorPct.id)!;
  const fix = perf.get(creatorFix.id)!;
  check("Percentage creator: 2 paid orders, 2 unique students (abandoned checkout not counted)", pct.successfulOrders === 2 && pct.uniqueStudents === 2);
  check("…gross ₹998, discount ₹199.60, collected ₹798.40", pct.grossPaise === 99800 && pct.discountPaise === 19960 && pct.collectedPaise === 79840);
  check("…refunded ₹399.20 deducted → eligible net ₹399.20", pct.refundedPaise === 39920 && pct.eligibleNetPaise === 39920);
  check("…10% commission on eligible net = ₹39.92 (refunded sale earns nothing)", pct.commissionPaise === 3992);
  check("Fixed creator: ₹50 per eligible sale", fix.successfulOrders === 1 && fix.commissionPaise === 5000);
  check("Fixed commission never exceeds the sale's eligible net; zero when fully refunded", commissionFor({ commissionType: "FIXED_AMOUNT", commissionValue: 5000 }, 3000) === 3000 && commissionFor({ commissionType: "FIXED_AMOUNT", commissionValue: 5000 }, 0) === 0);
  const testPerf = await getCouponPerformance({ ...liveF, environment: "TEST" }, [creatorPct.id]);
  check("LIVE creator sales never appear in the TEST report (and vice versa)", testPerf.get(creatorPct.id)!.successfulOrders === 0);
  const byCreator = await getCouponSettlementRows({ ...liveF, creator: "dr fixed" });
  check("Creator filter (case-insensitive) selects only that creator's orders", byCreator.length === 1 && byCreator[0].couponCode === creatorFix.code);
  const csv = settlementCsv(await getCouponSettlementRows(liveF));
  const lines = csv.trim().split("\r\n");
  check("CSV: header + one row per successful coupon order", lines.length === 1 + (await getCouponSettlementRows(liveF)).length);
  check("CSV contains no student name or email", !buyers.some((b) => csv.includes(b.email!) || csv.includes(b.name)));
  check("CSV neutralises formula injection in creator names", csv.includes(`"'=HYPERLINK(""x"")"`) && !csv.includes(`"=HYPERLINK`));

  // ------------------------------------------------------------------------
  console.log("\n10. RBAC (static)");
  const actions = readFileSync("app/admin/(dashboard)/payments/actions.ts", "utf8");
  const verAction = actions.match(/export async function saveVerificationAccountsAction\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  check("saveVerificationAccountsAction requires PAYMENTS_MANAGE (MASTER_ADMIN only)", verAction.includes("await manage()"));
  const couponAction = actions.match(/export async function saveCouponAction\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  check("saveCouponAction (incl. commission) requires PAYMENTS_MANAGE", couponAction.includes("await manage()") && couponAction.includes("commissionType"));
  const route = readFileSync("app/api/admin/payments/coupons/settlement/route.ts", "utf8");
  check("Settlement CSV route requires PAYMENTS_VIEW and is GET-only", route.includes("requirePermission(PERMISSIONS.PAYMENTS_VIEW)") && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
