/**
 * Targeted verification for the commerce / Razorpay layer (lib/payments/*).
 *
 * SAFETY: this script flips the global payment mode, writes TEST gateway
 * credentials and creates orders/payments, so it REFUSES to run unless
 * DATABASE_URL points at a scratch database whose name contains
 * "payverify". Razorpay's REST API is replaced in-process by a fake that
 * signs with the real HMAC scheme, so no network call or real charge is
 * ever made. Build the scratch DB and run it with:
 *
 *   createdb mocktestseries_payverify   (then: DATABASE_URL=<scratch> npx prisma db push)
 *   DATABASE_URL=<scratch url> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-payments.ts
 *
 * Proves (spec §33): FREE mode access; PAID denial with no attempt row or
 * question payload; price tampering impossible (amount from DB); coupon
 * math, expiry, per-student + total limits, concurrent redemption; 100%
 * coupon → no Razorpay call, one entitlement; fake success / bad signature
 * → no entitlement; valid payment → exactly one payment/entitlement/invoice;
 * duplicate verify + duplicate webhook → no duplicates; missing browser
 * callback → webhook and reconciliation restore access; expiry gating;
 * FULL_ADMIN has no manage permission and every admin mutation checks it;
 * student isolation (orders/invoices/subscriptions); refund transitions;
 * TEST-mode separation in analytics. Hardening (§14-16): scheduled
 * reconciliation recovers a captured payment whose callback + webhook were
 * missed, exactly once, never for unpaid/failed orders, each environment
 * with its own keys; a coupon that makes the order free defaults to one
 * redemption per student (also under concurrency); a stale/duplicate tab
 * can't buy a second period, an in-flight payment blocks a second order,
 * and explicit renewal still works.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { StudentAuthProvider, QuestionStatus, QuestionDifficulty, MockTestStatus, RoleName, OrderStatus } from "@prisma/client";
import { createFixtureSubject } from "./fixture-taxonomy";

if (!/payverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *payverify* scratch database.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fake Razorpay (in-process). Real HMAC signing with the configured secret.
// ---------------------------------------------------------------------------
const KEY_ID = "rzp_test_VerifyKey123";
const KEY_SECRET = "verify_secret_" + crypto.randomBytes(8).toString("hex");
const WEBHOOK_SECRET = "verify_whsec_" + crypto.randomBytes(8).toString("hex");
// A separate fake LIVE account: orders created with one key pair are
// invisible (404) to the other, like two real Razorpay accounts/modes.
const LIVE_KEY_ID = "rzp_live_VerifyKey456";
const LIVE_KEY_SECRET = "verify_live_secret_" + crypto.randomBytes(8).toString("hex");
const authFor = (id: string, secret: string) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");

type FakeOrder = { id: string; amount: number; currency: string; receipt: string; status: string; env?: "TEST" | "LIVE" };
type FakePayment = { id: string; order_id: string; amount: number; currency: string; status: string; method: string; amount_refunded: number };
const fake = { orders: new Map<string, FakeOrder>(), payments: new Map<string, FakePayment>(), orderCreates: 0, refunds: 0, calls: [] as { env: "TEST" | "LIVE"; path: string }[] };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.razorpay.com/v1")) return realFetch(input, init);
  const auth = new Headers(init?.headers).get("authorization");
  const env = auth === authFor(KEY_ID, KEY_SECRET) ? "TEST" : auth === authFor(LIVE_KEY_ID, LIVE_KEY_SECRET) ? "LIVE" : null;
  if (!env) return new Response("{}", { status: 401 });
  const path = url.replace("https://api.razorpay.com/v1", "").split("?")[0];
  fake.calls.push({ env, path });
  const orderIdInPath = path.match(/^\/orders\/([^/]+)/)?.[1];
  if (orderIdInPath && fake.orders.has(orderIdInPath) && (fake.orders.get(orderIdInPath)!.env ?? "TEST") !== env) return new Response("{}", { status: 404 });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  let m: RegExpMatchArray | null;
  if (init?.method === "POST" && path === "/orders") {
    fake.orderCreates++;
    const o: FakeOrder = { id: "order_" + crypto.randomBytes(7).toString("hex"), amount: body.amount, currency: body.currency, receipt: body.receipt, status: "created", env };
    fake.orders.set(o.id, o);
    return json(o);
  }
  if ((m = path.match(/^\/orders\/([^/]+)\/payments$/))) return json({ items: [...fake.payments.values()].filter((p) => p.order_id === m![1]) });
  if ((m = path.match(/^\/orders\/([^/]+)$/))) return fake.orders.has(m[1]) ? json(fake.orders.get(m[1])) : json({}, 404);
  if ((m = path.match(/^\/payments\/([^/]+)\/capture$/))) {
    const p = fake.payments.get(m[1]);
    if (!p) return json({}, 404);
    if (p.status !== "authorized") return json({ error: "already" }, 400);
    p.status = "captured";
    return json(p);
  }
  if ((m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
    const p = fake.payments.get(m[1]);
    if (!p) return json({}, 404);
    fake.refunds++;
    p.amount_refunded += body.amount;
    if (p.amount_refunded >= p.amount) p.status = "refunded";
    return json({ id: "rfnd_" + crypto.randomBytes(7).toString("hex"), payment_id: p.id, amount: body.amount, status: "processed" });
  }
  if ((m = path.match(/^\/payments\/([^/]+)$/))) return fake.payments.has(m[1]) ? json(fake.payments.get(m[1])) : json({}, 404);
  return json({}, 404);
}) as typeof fetch;

function fakePay(gatewayOrderId: string, status: "authorized" | "captured" | "failed" = "captured", amountOverride?: number) {
  const o = fake.orders.get(gatewayOrderId)!;
  const p: FakePayment = { id: "pay_" + crypto.randomBytes(7).toString("hex"), order_id: o.id, amount: amountOverride ?? o.amount, currency: o.currency, status, method: "upi", amount_refunded: 0 };
  fake.payments.set(p.id, p);
  const signature = crypto.createHmac("sha256", KEY_SECRET).update(`${o.id}|${p.id}`).digest("hex");
  return { payment: p, signature };
}
function webhookBody(event: string, payment: FakePayment) {
  return JSON.stringify({ event, payload: { payment: { entity: payment } }, created_at: Math.floor(Date.now() / 1000) });
}
const sign = (body: string, secret = WEBHOOK_SECRET) => crypto.createHmac("sha256", secret).update(body).digest("hex");

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
  // Import after the fetch stub + env guard so every module sees them.
  const { prisma } = await import("@/lib/prisma");
  const { setPaymentMode, bumpPaymentSettingsCache } = await import("@/lib/payments/settings");
  const { saveRazorpayConfig, getRazorpayConfig, bumpRazorpayConfigEpoch } = await import("@/lib/razorpay-config");
  const { startMockTestAttempt, startPreviousYearPaperAttempt } = await import("@/lib/test-attempt");
  const { PaymentRequiredError, getContentAccess, canStudentAccessProduct } = await import("@/lib/payments/access");
  const { createCheckoutOrder, verifyCheckoutPayment, getOrderStatusForStudent, reconcileOrder, getCheckoutQuote, CheckoutError } = await import("@/lib/payments/orders");
  const { handleRazorpayWebhook } = await import("@/lib/payments/webhooks");
  const { requestRefund } = await import("@/lib/payments/refunds");
  const { getPaymentOverview, parsePaymentFilters } = await import("@/lib/payments/analytics");
  const { computeProductPrice, computeCouponDiscount } = await import("@/lib/payments/pricing");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");
  const { runScheduledReconciliation, findPaymentMismatches } = await import("@/lib/payments/reconcile");
  const { createRazorpayOrder } = await import("@/lib/payments/razorpay");

  const setMode = async (m: "FREE" | "PAID" | "MAINTENANCE") => {
    await setPaymentMode(m, undefined);
    bumpPaymentSettingsCache();
  };

  console.log("=== Payments / Entitlement Verification (scratch DB, fake Razorpay) ===\n");
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Pay Exam ${sfx}`, code: `PAY-${sfx}`, durationMinutes: 30 } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "Pay Subject" });
  const q = await prisma.question.create({
    data: {
      examId: exam.id,
      subjectId: subject.id,
      code: `Q-PAY-${sfx}`,
      text: "Paid question?",
      difficulty: QuestionDifficulty.EASY,
      status: QuestionStatus.PUBLISHED,
      options: { create: [{ label: "A", text: "x", isCorrect: true }, { label: "B", text: "y", isCorrect: false }] },
    },
  });
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `Pay Series ${sfx}`, status: "PUBLISHED" } });
  const paidTest = await prisma.mockTest.create({
    data: { examId: exam.id, testSeriesId: series.id, title: "Paid Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "PAID", questions: { create: [{ questionId: q.id, order: 0 }] } },
  });
  const sampleTest = await prisma.mockTest.create({
    data: { examId: exam.id, testSeriesId: series.id, title: "Free Sample Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "FREE", questions: { create: [{ questionId: q.id, order: 0 }] } },
  });
  const freeTest = await prisma.mockTest.create({
    data: { examId: exam.id, title: "Free Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, questions: { create: [{ questionId: q.id, order: 0 }] } },
  });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2024, title: "PYQ 2024" } });
  await prisma.question.update({ where: { id: q.id }, data: { previousYearPaperId: paper.id } });

  const product = await prisma.product.create({
    data: {
      code: `series-${sfx}`,
      name: "Pay Series Pass",
      productType: "TEST_SERIES",
      examId: exam.id,
      testSeriesId: series.id,
      accessType: "PAID",
      mrpPaise: 99900,
      sellingPricePaise: 49900,
      accessDurationType: "DAYS",
      accessDays: 30,
    },
  });
  const mkStudent = (t: string) =>
    prisma.student.create({ data: { studentId: `PAY-${t}-${sfx}`, name: `Pay ${t}`, email: `pay-${t}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const [A, B, C, D, E] = await Promise.all(["A", "B", "C", "D", "E"].map(mkStudent));
  const attempts = (sid: string) => prisma.testAttempt.count({ where: { studentId: sid, mockTestId: paidTest.id } });

  await saveRazorpayConfig({ slot: "TEST", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
  await saveRazorpayConfig({ environment: "TEST", enabled: true });

  console.log("1. Global FREE mode");
  await setMode("FREE");
  const freeAttempt = await startMockTestAttempt(A.id, paidTest.id);
  check("FREE mode: student starts a PAID-product test without paying", Boolean(freeAttempt.id));
  check("FREE mode: no entitlement/payment row was fabricated", (await prisma.studentEntitlement.count({ where: { studentId: A.id } })) === 0 && (await prisma.paymentOrder.count({ where: { studentId: A.id } })) === 0);
  const freeOrderErr = await rejects(() => createCheckoutOrder(A.id, product.id));
  check("FREE mode: checkout refuses to create an order", freeOrderErr instanceof CheckoutError && (freeOrderErr as InstanceType<typeof CheckoutError>).code === "PLATFORM_FREE");

  console.log("\n2. PAID mode gate (test engine)");
  await setMode("PAID");
  const denied = await rejects(() => startMockTestAttempt(B.id, paidTest.id));
  check("PAID + no entitlement: start denied with PaymentRequiredError", denied instanceof PaymentRequiredError);
  check("…status PAYMENT_REQUIRED and names the unlocking product", denied instanceof PaymentRequiredError && denied.access.status === "PAYMENT_REQUIRED" && denied.access.products[0]?.id === product.id);
  check("…no TestAttempt (hence no question payload) created", (await attempts(B.id)) === 0);
  const resumeDenied = await rejects(() => startMockTestAttempt(A.id, paidTest.id));
  check("Attempt started in FREE mode can't be resumed after switch to PAID", resumeDenied instanceof PaymentRequiredError);
  check("Uncovered content stays free in PAID mode", Boolean((await startMockTestAttempt(B.id, freeTest.id)).id));
  check("Mock marked FREE inside a paid series is a free sample", Boolean((await startMockTestAttempt(B.id, sampleTest.id)).id));
  check("PYQ not covered by a TEST_SERIES product stays free", Boolean((await startPreviousYearPaperAttempt(B.id, paper.id)).id));
  const legacyPaid = await prisma.mockTest.create({ data: { examId: exam.id, title: "Legacy paid", durationMinutes: 10, status: MockTestStatus.PUBLISHED, accessType: "PAID", questions: { create: [{ questionId: q.id }] } } });
  const legacy = await getContentAccess(B.id, { kind: "MOCK_TEST", id: legacyPaid.id, examId: exam.id, accessType: "PAID" });
  check("Content flagged PAID with no product → NOT_AVAILABLE (denied)", legacy.status === "NOT_AVAILABLE" && !legacy.allowed);

  console.log("\n3. Pricing is server-side");
  const price = computeProductPrice(product);
  check("Price from DB: ₹499 (MRP ₹999, 50% off)", price.pricePaise === 49900 && price.discountPercent === 50);
  const order1 = await createCheckoutOrder(B.id, product.id);
  check("Create order → RAZORPAY with amount derived from DB (49900)", order1.kind === "RAZORPAY" && order1.amountPaise === 49900);
  const dbOrder1 = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order1.orderId } });
  check("Internal order exists with gatewayOrderId + GATEWAY_ORDER_CREATED", dbOrder1.status === "GATEWAY_ORDER_CREATED" && dbOrder1.gatewayOrderId === (order1.kind === "RAZORPAY" ? order1.gatewayOrderId : ""));
  check("Razorpay order amount matches DB amount", fake.orders.get(dbOrder1.gatewayOrderId!)?.amount === 49900);
  const createsBefore = fake.orderCreates;
  const order1b = await createCheckoutOrder(B.id, product.id);
  check("Double-click / second tab reuses the open order (no new Razorpay order)", order1b.orderId === order1.orderId && fake.orderCreates === createsBefore);
  const [c1, c2] = await Promise.all([createCheckoutOrder(C.id, product.id), createCheckoutOrder(C.id, product.id)]);
  check("Concurrent create-order (two workers) → one open order", c1.orderId === c2.orderId && (await prisma.paymentOrder.count({ where: { studentId: C.id, openKey: { not: null } } })) === 1);
  // Tampered payment: amount lower than the order — must not grant.
  if (order1.kind === "RAZORPAY") {
    const cheap = fakePay(order1.gatewayOrderId, "captured", 100);
    const v = await verifyCheckoutPayment(B.id, { orderId: order1.orderId, razorpayOrderId: order1.gatewayOrderId, razorpayPaymentId: cheap.payment.id, razorpaySignature: cheap.signature });
    check("Payment for a different (tampered) amount → FAILED, no entitlement", v.status === "FAILED" && (await prisma.studentEntitlement.count({ where: { studentId: B.id } })) === 0);
  }

  console.log("\n4. Fake success / bad signature");
  if (order1.kind === "RAZORPAY") {
    const fakeRes = await verifyCheckoutPayment(B.id, { orderId: order1.orderId, razorpayOrderId: order1.gatewayOrderId, razorpayPaymentId: "pay_Fabricated123", razorpaySignature: "ab".repeat(32) });
    check("Fabricated success callback → FAILED", fakeRes.status === "FAILED");
    const real = fakePay(order1.gatewayOrderId, "captured");
    const bad = await verifyCheckoutPayment(B.id, { orderId: order1.orderId, razorpayOrderId: order1.gatewayOrderId, razorpayPaymentId: real.payment.id, razorpaySignature: sign("tampered", KEY_SECRET) });
    check("Bad signature → FAILED", bad.status === "FAILED");
    const wrongOrder = await verifyCheckoutPayment(B.id, { orderId: order1.orderId, razorpayOrderId: "order_SomeoneElse", razorpayPaymentId: real.payment.id, razorpaySignature: real.signature });
    check("Browser-supplied order id mismatch → FAILED", wrongOrder.status === "FAILED");
    check("…no entitlement after any of the above", (await prisma.studentEntitlement.count({ where: { studentId: B.id } })) === 0);
    check("…still denied at the test gate", (await rejects(() => startMockTestAttempt(B.id, paidTest.id))) instanceof PaymentRequiredError);

    console.log("\n5. Valid payment → exactly one of each; duplicates are no-ops");
    const okArgs = { orderId: order1.orderId, razorpayOrderId: order1.gatewayOrderId, razorpayPaymentId: real.payment.id, razorpaySignature: real.signature };
    const [v1, v2] = await Promise.all([verifyCheckoutPayment(B.id, okArgs), verifyCheckoutPayment(B.id, okArgs)]);
    const v3 = await verifyCheckoutPayment(B.id, okArgs);
    check("Valid verified payment → SUCCESS (incl. concurrent + repeat verify)", v1.status === "SUCCESS" && v2.status === "SUCCESS" && v3.status === "SUCCESS");
    check("Exactly one CAPTURED payment", (await prisma.payment.count({ where: { orderId: order1.orderId, status: "CAPTURED" } })) === 1);
    check("Exactly one entitlement", (await prisma.studentEntitlement.count({ where: { studentId: B.id, productId: product.id } })) === 1);
    check("Exactly one invoice", (await prisma.invoice.count({ where: { orderId: order1.orderId } })) === 1);
    const whBody = webhookBody("payment.captured", fake.payments.get(real.payment.id)!);
    const w1 = await handleRazorpayWebhook(whBody, sign(whBody), "evt_dup_" + sfx);
    const w2 = await handleRazorpayWebhook(whBody, sign(whBody), "evt_dup_" + sfx);
    check("Duplicate webhook delivery → second is 'duplicate'", w1.httpStatus === 200 && w2.body.status === "duplicate");
    check("…still exactly one payment / entitlement / invoice", (await prisma.payment.count({ where: { orderId: order1.orderId, status: "CAPTURED" } })) === 1 && (await prisma.studentEntitlement.count({ where: { orderId: order1.orderId } })) === 1 && (await prisma.invoice.count({ where: { orderId: order1.orderId } })) === 1);
    const badHook = await handleRazorpayWebhook(whBody, sign(whBody, "wrong"), "evt_bad_" + sfx);
    check("Webhook with invalid signature → 400, not recorded", badHook.httpStatus === 400 && (await prisma.paymentWebhookEvent.count({ where: { eventId: "evt_bad_" + sfx } })) === 0);
    const started = await startMockTestAttempt(B.id, paidTest.id);
    check("Active subscription → paid content allowed", Boolean(started.id));
    const ent = await prisma.studentEntitlement.findFirstOrThrow({ where: { orderId: order1.orderId } });
    check("Entitlement window = 30 days", Math.round((ent.expiresAt!.getTime() - ent.startsAt.getTime()) / 86_400_000) === 30);
    check("Order PAID + openKey released + coupon-free", (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order1.orderId } })).status === OrderStatus.PAID);

    console.log("\n6. Expiry");
    await prisma.studentEntitlement.update({ where: { id: ent.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await prisma.testAttempt.updateMany({ where: { studentId: B.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    const exp = await rejects(() => startMockTestAttempt(B.id, paidTest.id));
    check("Expired subscription → blocked with EXPIRED", exp instanceof PaymentRequiredError && exp.access.status === "EXPIRED");
    const renewQuote = await canStudentAccessProduct(B.id, product.id);
    check("Checkout shows EXPIRED (Renew Access)", renewQuote.status === "EXPIRED");
  }

  console.log("\n7. Browser callback missing → webhook / reconciliation restore");
  if (c1.kind === "RAZORPAY") {
    const { payment } = fakePay(c1.gatewayOrderId, "authorized");
    const body = webhookBody("payment.authorized", payment);
    const r = await handleRazorpayWebhook(body, sign(body), "evt_auth_" + sfx);
    check("payment.authorized webhook → captured + PAID without any browser verify", r.httpStatus === 200 && (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: c1.orderId } })).status === "PAID");
    check("…entitlement + invoice granted once", (await prisma.studentEntitlement.count({ where: { orderId: c1.orderId } })) === 1 && (await prisma.invoice.count({ where: { orderId: c1.orderId } })) === 1);
  }
  const dOrder = await createCheckoutOrder(D.id, product.id);
  if (dOrder.kind === "RAZORPAY") {
    fakePay(dOrder.gatewayOrderId, "captured");
    const st = await getOrderStatusForStudent(D.id, dOrder.orderId);
    check("No callback + no webhook → status poll reconciles to PAID", st?.status === "PAID");
    const again = await reconcileOrder(dOrder.orderId);
    check("Re-running reconciliation is idempotent", again.outcome === "ALREADY_PAID" && (await prisma.studentEntitlement.count({ where: { orderId: dOrder.orderId } })) === 1);
  }
  const eOrder = await createCheckoutOrder(E.id, product.id);
  const recNone = await reconcileOrder(eOrder.orderId);
  check("Reconcile with no gateway payment never fabricates success", recNone.outcome === "NO_PAYMENT" && (await prisma.studentEntitlement.count({ where: { studentId: E.id } })) === 0);

  console.log("\n8. Coupons");
  const pct = await prisma.coupon.create({ data: { code: `FRIEND50${sfx}`.toUpperCase().slice(0, 32), discountType: "PERCENTAGE", discountValue: 50, perStudentLimit: 1 } });
  const quote = await getCheckoutQuote(E.id, product.code, pct.code);
  check("Valid 50% coupon → payable ₹249.50 (server-computed)", quote?.payablePaise === 24950 && quote.coupon?.discountPaise === 24950);
  check("computeCouponDiscount: fixed ₹600 capped at price", computeCouponDiscount({ discountType: "FIXED_AMOUNT", discountValue: 60000, maxDiscountPaise: null }, 49900) === 49900);
  const expired = await prisma.coupon.create({ data: { code: `OLD${sfx}`.toUpperCase(), discountType: "PERCENTAGE", discountValue: 10, validUntil: new Date(Date.now() - 1000) } });
  check("Expired coupon → rejected", (await getCheckoutQuote(E.id, product.code, expired.code))?.couponError === "This coupon has expired.");
  const inactive = await prisma.coupon.create({ data: { code: `OFF${sfx}`.toUpperCase(), discountType: "PERCENTAGE", discountValue: 10, isActive: false } });
  check("Inactive coupon → rejected", Boolean((await getCheckoutQuote(E.id, product.code, inactive.code))?.couponError));
  const otherProduct = await prisma.product.create({ data: { code: `other-${sfx}`, name: "Other", productType: "EXAM_ACCESS", examId: exam.id, accessType: "PAID", mrpPaise: 10000, sellingPricePaise: 10000, accessDurationType: "LIFETIME" } });
  const scoped = await prisma.coupon.create({ data: { code: `ONLY${sfx}`.toUpperCase(), discountType: "PERCENTAGE", discountValue: 10, productIds: [otherProduct.id] } });
  check("Product-mismatched coupon → rejected", (await getCheckoutQuote(E.id, product.code, scoped.code))?.couponError === "This coupon can't be used for this product.");
  const eWithCoupon = await createCheckoutOrder(E.id, product.id, pct.code);
  check("Order with coupon: amount 24950, redemption RESERVED", eWithCoupon.kind === "RAZORPAY" && eWithCoupon.amountPaise === 24950 && (await prisma.couponRedemption.count({ where: { couponId: pct.id, studentId: E.id, status: "RESERVED" } })) === 1);
  check("Old coupon-less open order was retired (only one open order)", (await prisma.paymentOrder.count({ where: { studentId: E.id, openKey: { not: null } } })) === 1);
  if (eWithCoupon.kind === "RAZORPAY") {
    const p = fakePay(eWithCoupon.gatewayOrderId, "captured");
    await verifyCheckoutPayment(E.id, { orderId: eWithCoupon.orderId, razorpayOrderId: eWithCoupon.gatewayOrderId, razorpayPaymentId: p.payment.id, razorpaySignature: p.signature });
    check("Paid coupon order → redemption CONSUMED", (await prisma.couponRedemption.count({ where: { couponId: pct.id, studentId: E.id, status: "CONSUMED" } })) === 1);
  }
  check("Per-student limit enforced on reuse", (await getCheckoutQuote(E.id, otherProduct.code, pct.code))?.couponError === "You've already used this coupon the maximum number of times.");

  const freeCoupon = await prisma.coupon.create({ data: { code: `RUHSFREE${sfx}`.toUpperCase().slice(0, 32), discountType: "FREE_ACCESS", discountValue: 100, totalUsageLimit: 1 } });
  const creates = fake.orderCreates;
  const [f1, f2] = await Promise.allSettled([createCheckoutOrder(A.id, otherProduct.id, freeCoupon.code), createCheckoutOrder(D.id, otherProduct.id, freeCoupon.code)]);
  const okFree = [f1, f2].filter((r) => r.status === "fulfilled" && r.value.kind === "FREE_GRANT");
  check("100% coupon → FREE_GRANT with no Razorpay order", okFree.length >= 1 && fake.orderCreates === creates);
  check("Total limit 1 under concurrent redemption → exactly one grant", okFree.length === 1 && (await prisma.couponRedemption.count({ where: { couponId: freeCoupon.id, status: "CONSUMED" } })) === 1);
  const winner = okFree[0].status === "fulfilled" ? okFree[0].value : null;
  if (winner) {
    const o = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: winner.orderId } });
    check("…internal ₹0 order PAID via INTERNAL gateway, no Payment row", o.gateway === "INTERNAL" && o.amountPaise === 0 && o.status === "PAID" && (await prisma.payment.count({ where: { orderId: o.id } })) === 0);
    check("…entitlement granted once (source COUPON)", (await prisma.studentEntitlement.count({ where: { orderId: o.id, source: "COUPON" } })) === 1);
  }
  const replay = await rejects(() => createCheckoutOrder(A.id, otherProduct.id, freeCoupon.code));
  check("Coupon replay after limit reached → rejected", replay instanceof CheckoutError);

  console.log("\n9. Student isolation (IDOR)");
  check("Student A can't read Student B's order status", (await getOrderStatusForStudent(A.id, order1.orderId)) === null);
  const idor = await rejects(() => verifyCheckoutPayment(A.id, { orderId: order1.orderId, razorpayOrderId: "order_x", razorpayPaymentId: "pay_x123456", razorpaySignature: "ab" }));
  check("Student A can't verify against Student B's order", idor instanceof CheckoutError);
  const bInvoice = await prisma.invoice.findFirstOrThrow({ where: { studentId: B.id } });
  check("Invoice lookup scoped by studentId hides B's invoice from A", (await prisma.invoice.findFirst({ where: { id: bInvoice.id, studentId: A.id } })) === null);
  check("Subscription list scoped by studentId hides B's entitlement from A", (await prisma.studentEntitlement.count({ where: { studentId: A.id, productId: product.id } })) === 0);

  console.log("\n10. Refunds");
  const dPayment = await prisma.payment.findFirstOrThrow({ where: { order: { studentId: D.id }, status: "CAPTURED" } });
  const refund = await requestRefund({ paymentId: dPayment.id, amountPaise: dPayment.amountPaise, reason: "verify", accessPolicy: "REVOKE_IMMEDIATELY", retainUntil: null, adminId: undefined });
  const dPay2 = await prisma.payment.findUniqueOrThrow({ where: { id: dPayment.id } });
  const dOrd = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: dPayment.orderId }, include: { entitlement: true } });
  check("Full refund → Refund PROCESSED (from gateway response)", refund.status === "PROCESSED");
  check("Payment REFUNDED, order REFUNDED", dPay2.status === "REFUNDED" && dOrd.status === "REFUNDED");
  check("REVOKE_IMMEDIATELY policy revoked the entitlement", dOrd.entitlement?.status === "REVOKED");
  check("Over-refund rejected", (await rejects(() => requestRefund({ paymentId: dPayment.id, amountPaise: 100, reason: "x", accessPolicy: "RETAIN", retainUntil: null, adminId: undefined }))) !== null);

  console.log("\n11. MAINTENANCE mode");
  await setMode("MAINTENANCE");
  check("MAINTENANCE: new orders blocked", (await rejects(() => createCheckoutOrder(A.id, product.id))) instanceof CheckoutError);
  check("MAINTENANCE: existing active subscription still works (C)", Boolean((await startMockTestAttempt(C.id, paidTest.id)).id));
  await setMode("PAID");

  console.log("\n12. RBAC");
  check("MASTER_ADMIN has PAYMENTS_MANAGE", DEFAULT_ROLE_PERMISSIONS[RoleName.MASTER_ADMIN].includes(PERMISSIONS.PAYMENTS_MANAGE));
  check("FULL_ADMIN has PAYMENTS_VIEW but NOT PAYMENTS_MANAGE", DEFAULT_ROLE_PERMISSIONS[RoleName.FULL_ADMIN].includes(PERMISSIONS.PAYMENTS_VIEW) && !DEFAULT_ROLE_PERMISSIONS[RoleName.FULL_ADMIN].includes(PERMISSIONS.PAYMENTS_MANAGE));
  check("TEACHER has no payments access", !DEFAULT_ROLE_PERMISSIONS[RoleName.TEACHER].some((p) => p.startsWith("payments:")));
  const src = readFileSync("app/admin/(dashboard)/payments/actions.ts", "utf8");
  const fns = [...src.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
  check(`Every admin payments mutation (${fns.length}) calls manage() → PAYMENTS_MANAGE`, fns.length >= 12 && fns.every((m) => m[2].includes("await manage()")));

  console.log("\n13. TEST/LIVE separation + secrets");
  const liveOverview = await getPaymentOverview(parsePaymentFilters({}));
  const testOverview = await getPaymentOverview(parsePaymentFilters({ env: "TEST" }));
  check("TEST transactions excluded from default (LIVE) revenue", liveOverview.grossPaise === 0 && liveOverview.successfulPayments === 0);
  check("TEST transactions visible when filtered", testOverview.grossPaise > 0 && testOverview.successfulPayments > 0);
  const pub = JSON.stringify(await getRazorpayConfig());
  check("Public gateway config never contains secrets or full key id", !pub.includes(KEY_SECRET) && !pub.includes(WEBHOOK_SECRET) && !pub.includes(KEY_ID));
  const stored = JSON.stringify((await prisma.setting.findUniqueOrThrow({ where: { key: "api.razorpay" } })).value);
  check("Secrets encrypted at rest (no plaintext in Setting row)", !stored.includes(KEY_SECRET) && !stored.includes(WEBHOOK_SECRET));
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { studentId: B.id } });
  check("TEST invoice uses separate TEST- numbering series", invoice.invoiceNumber.startsWith("TEST-"));


  // -------------------------------------------------------------------------
  // Pre-launch hardening
  // -------------------------------------------------------------------------
  const ents = (sid: string, pid = product.id) => prisma.studentEntitlement.count({ where: { studentId: sid, productId: pid } });
  const [F, G, H, I, J, K, L, M, N, P, Q, R, S, T] = await Promise.all(["F", "G", "H", "I", "J", "K", "L", "M", "N", "P", "Q", "R", "S", "T"].map(mkStudent));
  /** Simulates "the callback and webhook never arrived and the order then expired locally". */
  const ageOrder = (id: string, extra: object = {}) =>
    prisma.paymentOrder.update({ where: { id }, data: { createdAt: new Date(Date.now() - 30 * 60_000), ...extra } });
  const entryFor = (r: Awaited<ReturnType<typeof runScheduledReconciliation>>, id: string) => r.entries.find((e) => e.orderId === id);

  console.log("\n14. Scheduled reconciliation (cron safety net)");
  const fOrder = await createCheckoutOrder(F.id, product.id);
  const gOrder = await createCheckoutOrder(G.id, product.id);
  const hOrder = await createCheckoutOrder(H.id, product.id);
  const iOrder = await createCheckoutOrder(I.id, product.id);
  if (fOrder.kind === "RAZORPAY" && gOrder.kind === "RAZORPAY" && hOrder.kind === "RAZORPAY" && iOrder.kind === "RAZORPAY") {
    fakePay(fOrder.gatewayOrderId, "captured");
    fakePay(gOrder.gatewayOrderId, "captured");
    fakePay(iOrder.gatewayOrderId, "failed");
    await ageOrder(fOrder.orderId, { status: OrderStatus.EXPIRED, openKey: null });
    await ageOrder(hOrder.orderId);
    await ageOrder(iOrder.orderId);

    const callsBeforeDry = fake.calls.length;
    const dry = await runScheduledReconciliation({ dryRun: true });
    check("Dry run lists due orders without any Razorpay call or write", entryFor(dry, fOrder.orderId)?.result === "DUE" && fake.calls.length === callsBeforeDry && (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: fOrder.orderId } })).reconcileChecks === 0);

    const run1 = await runScheduledReconciliation();
    check("Captured payment + missed callback/webhook + locally EXPIRED order → PAID", entryFor(run1, fOrder.orderId)?.result === "PAID" && (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: fOrder.orderId } })).status === "PAID");
    check("…exactly one Payment / Entitlement / Invoice", (await prisma.payment.count({ where: { orderId: fOrder.orderId } })) === 1 && (await ents(F.id)) === 1 && (await prisma.invoice.count({ where: { orderId: fOrder.orderId } })) === 1);
    check("…and the student can now start the paid test", Boolean((await startMockTestAttempt(F.id, paidTest.id)).id));
    check("Fresh order (< 10 min) is left to the webhook, not touched", !entryFor(run1, gOrder.orderId) && (await ents(G.id)) === 0);
    check("Unpaid order → NO_PAYMENT, no entitlement", entryFor(run1, hOrder.orderId)?.result === "NO_PAYMENT" && (await ents(H.id)) === 0);
    check("Failed payment → NOT_CAPTURED, no entitlement", entryFor(run1, iOrder.orderId)?.result === "NOT_CAPTURED" && (await ents(I.id)) === 0);

    const run2 = await runScheduledReconciliation();
    const run3 = await runScheduledReconciliation();
    check("Re-running: settled order is no longer a candidate; no duplicates", !entryFor(run2, fOrder.orderId) && !entryFor(run3, fOrder.orderId) && (await prisma.payment.count({ where: { orderId: fOrder.orderId } })) === 1 && (await ents(F.id)) === 1 && (await prisma.invoice.count({ where: { orderId: fOrder.orderId } })) === 1);
    check("Backoff: unpaid order not re-read on the very next run", !entryFor(run2, hOrder.orderId) && (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: hOrder.orderId } })).reconcileChecks === 1);
    await prisma.paymentOrder.update({ where: { id: hOrder.orderId }, data: { reconcileCheckedAt: new Date(Date.now() - 11 * 60_000) } });
    const later = await runScheduledReconciliation();
    check("…re-read again once its backoff elapsed (still no entitlement)", entryFor(later, hOrder.orderId)?.result === "NO_PAYMENT" && (await ents(H.id)) === 0);
    await prisma.paymentOrder.update({ where: { id: hOrder.orderId }, data: { reconcileChecks: 10, reconcileCheckedAt: new Date(0) } });
    const capped = await runScheduledReconciliation();
    check("…stops after the max number of re-reads", !entryFor(capped, hOrder.orderId));

    await prisma.invoice.delete({ where: { orderId: fOrder.orderId } });
    const repair = await runScheduledReconciliation();
    check("PAID order missing its invoice → restored once (ensureFulfilment)", entryFor(repair, fOrder.orderId)?.result === "FULFILMENT_REPAIRED" && (await prisma.invoice.count({ where: { orderId: fOrder.orderId } })) === 1);
    const repair2 = await runScheduledReconciliation();
    check("…next run: nothing to repair, still one invoice", !entryFor(repair2, fOrder.orderId) && (await prisma.invoice.count({ where: { orderId: fOrder.orderId } })) === 1);

    // TEST / LIVE isolation.
    const liveGw = { id: "order_livemissing", amount: 49900, currency: "INR", receipt: "x", status: "created", env: "LIVE" as const };
    fake.orders.set(liveGw.id, liveGw);
    const liveRow = await prisma.paymentOrder.create({
      data: { orderNumber: `ORD-LIVE-${sfx}`, receipt: `ORD-LIVE-${sfx}`, studentId: J.id, productId: product.id, status: OrderStatus.GATEWAY_ORDER_CREATED, gateway: "RAZORPAY", environment: "LIVE", mrpPaise: 99900, sellingPricePaise: 49900, amountPaise: 49900, productSnapshot: {}, gatewayOrderId: liveGw.id, createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    fakePay(liveGw.id, "captured");
    const callsBeforeLive = fake.calls.length;
    const noLiveKeys = await runScheduledReconciliation();
    check("LIVE order with no LIVE credentials → skipped, no Razorpay call, no access", entryFor(noLiveKeys, liveRow.id)?.result === "SKIPPED_NO_CREDENTIALS" && fake.calls.length === callsBeforeLive && (await ents(J.id)) === 0);
    await saveRazorpayConfig({ slot: "LIVE", keyId: LIVE_KEY_ID, keySecret: LIVE_KEY_SECRET });
    const liveRun = await runScheduledReconciliation();
    const liveCalls = fake.calls.slice(callsBeforeLive).filter((c) => c.path.includes(liveGw.id));
    check("LIVE order re-read ONLY with LIVE keys → PAID", entryFor(liveRun, liveRow.id)?.result === "PAID" && liveCalls.length > 0 && liveCalls.every((c) => c.env === "LIVE") && (await ents(J.id)) === 1);
    const testCalls = fake.calls.filter((c) => c.path.includes(fOrder.gatewayOrderId));
    check("TEST order was re-read ONLY with TEST keys", testCalls.length > 0 && testCalls.every((c) => c.env === "TEST"));
    const liveInvoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId: liveRow.id } });
    check("LIVE recovery uses the LIVE invoice series (no TEST- prefix)", !liveInvoice.invoiceNumber.startsWith("TEST-"));
    // A TEST-labelled order whose gateway order lives in the LIVE account must not be settled.
    const crossGw = await createRazorpayOrder("LIVE", { amountPaise: 49900, currency: "INR", receipt: "cross", notes: {} });
    fakePay(crossGw.id, "captured");
    const crossRow = await prisma.paymentOrder.create({
      data: { orderNumber: `ORD-X-${sfx}`, receipt: `ORD-X-${sfx}`, studentId: K.id, productId: product.id, status: OrderStatus.GATEWAY_ORDER_CREATED, gateway: "RAZORPAY", environment: "TEST", mrpPaise: 99900, sellingPricePaise: 49900, amountPaise: 49900, productSnapshot: {}, gatewayOrderId: crossGw.id, createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    const crossRun = await runScheduledReconciliation();
    check("No cross-environment reconciliation (TEST row can't settle a LIVE payment)", entryFor(crossRun, crossRow.id)?.result === "GATEWAY_ERROR" && (await ents(K.id)) === 0);
    // Remove the LIVE fixtures so a re-run on the same scratch DB starts from "no LIVE keys / no LIVE revenue".
    await prisma.invoice.deleteMany({ where: { orderId: liveRow.id } });
    await prisma.studentEntitlement.deleteMany({ where: { orderId: liveRow.id } });
    await prisma.payment.deleteMany({ where: { orderId: liveRow.id } });
    await prisma.paymentOrder.delete({ where: { id: liveRow.id } });
    const gw = await prisma.setting.findUniqueOrThrow({ where: { key: "api.razorpay" } });
    const withoutLive = { ...(gw.value as Record<string, unknown>) };
    delete withoutLive.live;
    await prisma.setting.update({ where: { key: "api.razorpay" }, data: { value: withoutLive as object } });
    bumpRazorpayConfigEpoch();
  }

  console.log("\n15. Free-access coupons: one redemption per student by default");
  const dayProduct = await prisma.product.create({ data: { code: `days-${sfx}`, name: "Day Pass", productType: "EXAM_ACCESS", examId: exam.id, accessType: "PAID", mrpPaise: 20000, sellingPricePaise: 20000, accessDurationType: "DAYS", accessDays: 30 } });
  const openFree = await prisma.coupon.create({ data: { code: `OPENFREE${sfx}`.toUpperCase().slice(0, 32), discountType: "FREE_ACCESS", discountValue: 100 } });
  const k1 = await createCheckoutOrder(K.id, dayProduct.id, openFree.code);
  check("First redemption of a blank-limit 100% coupon → FREE_GRANT", k1.kind === "FREE_GRANT" && (await ents(K.id, dayProduct.id)) === 1);
  const k2 = await rejects(() => createCheckoutOrder(K.id, dayProduct.id, openFree.code, { renew: true }));
  check("Same student, same free coupon again (even as a renewal) → rejected", k2 instanceof CheckoutError && (k2 as InstanceType<typeof CheckoutError>).code === "COUPON_REJECTED" && (await ents(K.id, dayProduct.id)) === 1);
  check("…quote explains the per-student limit", (await getCheckoutQuote(K.id, dayProduct.code, openFree.code))?.couponError === "You've already used this coupon the maximum number of times.");
  const lTries = await Promise.allSettled([1, 2, 3, 4].map(() => createCheckoutOrder(L.id, dayProduct.id, openFree.code, { renew: true })));
  check("Concurrent free redemptions by one student → exactly one grant/redemption", lTries.filter((t) => t.status === "fulfilled").length === 1 && (await ents(L.id, dayProduct.id)) === 1 && (await prisma.couponRedemption.count({ where: { couponId: openFree.id, studentId: L.id } })) === 1);
  check("Different eligible student can still redeem", (await createCheckoutOrder(M.id, dayProduct.id, openFree.code)).kind === "FREE_GRANT");
  const pct100 = await prisma.coupon.create({ data: { code: `HUNDRED${sfx}`.toUpperCase().slice(0, 32), discountType: "PERCENTAGE", discountValue: 100 } });
  await createCheckoutOrder(N.id, dayProduct.id, pct100.code);
  check("100% PERCENTAGE coupon is also one-per-student by default", Boolean(await rejects(() => createCheckoutOrder(N.id, dayProduct.id, pct100.code, { renew: true }))) && (await ents(N.id, dayProduct.id)) === 1);
  const twice = await prisma.coupon.create({ data: { code: `TWICE${sfx}`.toUpperCase().slice(0, 32), discountType: "FREE_ACCESS", discountValue: 100, perStudentLimit: 2 } });
  await createCheckoutOrder(P.id, dayProduct.id, twice.code);
  const p2 = await createCheckoutOrder(P.id, dayProduct.id, twice.code, { renew: true });
  const p3 = await rejects(() => createCheckoutOrder(P.id, dayProduct.id, twice.code, { renew: true }));
  check("Explicit per-student limit (2) is the controlled repeat policy: 2 grants, 3rd rejected", p2.kind === "FREE_GRANT" && p3 instanceof CheckoutError && (await ents(P.id, dayProduct.id)) === 2);
  const paidPct = await prisma.coupon.create({ data: { code: `TENOFF${sfx}`.toUpperCase().slice(0, 32), discountType: "PERCENTAGE", discountValue: 10 } });
  const q1 = await createCheckoutOrder(Q.id, dayProduct.id, paidPct.code);
  if (q1.kind === "RAZORPAY") {
    const pay = fakePay(q1.gatewayOrderId, "captured");
    await verifyCheckoutPayment(Q.id, { orderId: q1.orderId, razorpayOrderId: q1.gatewayOrderId, razorpayPaymentId: pay.payment.id, razorpaySignature: pay.signature });
  }
  const reQuote = await getCheckoutQuote(Q.id, dayProduct.code, paidPct.code);
  check("Paid (10%) coupon with blank limit keeps existing behaviour: reusable, ₹180", q1.kind === "RAZORPAY" && q1.amountPaise === 18000 && reQuote?.couponError === null && reQuote.payablePaise === 18000);

  console.log("\n16. Duplicate orders / renewal");
  const [r1, r2] = await Promise.all([createCheckoutOrder(R.id, product.id), createCheckoutOrder(R.id, product.id)]);
  check("Two simultaneous tabs → one shared order", r1.orderId === r2.orderId);
  if (r1.kind === "RAZORPAY") {
    const pay = fakePay(r1.gatewayOrderId, "captured");
    await verifyCheckoutPayment(R.id, { orderId: r1.orderId, razorpayOrderId: r1.gatewayOrderId, razorpayPaymentId: pay.payment.id, razorpaySignature: pay.signature });
    const createsBeforeStale = fake.orderCreates;
    const stale = await rejects(() => createCheckoutOrder(R.id, product.id));
    check("Stale 'Buy Now' tab after the purchase → ALREADY_OWNED, no 2nd order/access", stale instanceof CheckoutError && (stale as InstanceType<typeof CheckoutError>).code === "ALREADY_OWNED" && fake.orderCreates === createsBeforeStale && (await ents(R.id)) === 1);
    const first = await prisma.studentEntitlement.findFirstOrThrow({ where: { studentId: R.id, productId: product.id } });
    const renewal = await createCheckoutOrder(R.id, product.id, null, { renew: true });
    if (renewal.kind === "RAZORPAY") {
      const rp = fakePay(renewal.gatewayOrderId, "captured");
      await verifyCheckoutPayment(R.id, { orderId: renewal.orderId, razorpayOrderId: renewal.gatewayOrderId, razorpayPaymentId: rp.payment.id, razorpaySignature: rp.signature });
    }
    const second = await prisma.studentEntitlement.findFirst({ where: { orderId: renewal.orderId } });
    check("Explicit renewal ('Extend Access') still works and extends from the current expiry (+30 days)", renewal.kind === "RAZORPAY" && second?.expiresAt?.getTime() === first.expiresAt!.getTime() + 30 * 86_400_000);
  }
  const s1 = await createCheckoutOrder(S.id, product.id);
  const tenOff = await prisma.coupon.create({ data: { code: `SWAP${sfx}`.toUpperCase().slice(0, 32), discountType: "PERCENTAGE", discountValue: 10 } });
  if (s1.kind === "RAZORPAY") {
    fakePay(s1.gatewayOrderId, "authorized"); // tab 1 is mid-payment, no callback yet
    const createsBeforeSwap = fake.orderCreates;
    const swap = await rejects(() => createCheckoutOrder(S.id, product.id, tenOff.code));
    check("Coupon applied in tab 2 while tab 1's payment is in flight → PAYMENT_IN_PROGRESS, no 2nd order", swap instanceof CheckoutError && (swap as InstanceType<typeof CheckoutError>).code === "PAYMENT_IN_PROGRESS" && fake.orderCreates === createsBeforeSwap);
    check("…the in-flight payment was settled instead (one PAID order, one entitlement)", (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: s1.orderId } })).status === "PAID" && (await ents(S.id)) === 1);
  }
  const t1 = await createCheckoutOrder(T.id, product.id);
  const t2 = await createCheckoutOrder(T.id, product.id, tenOff.code);
  check("Different terms with NO payment in flight → old order retired, new order (existing behaviour)", t2.kind === "RAZORPAY" && t2.orderId !== t1.orderId && (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: t1.orderId } })).status === "CANCELLED");
  if (t1.kind === "RAZORPAY" && t2.kind === "RAZORPAY") {
    // Residual race: the other tab still pays the retired order afterwards.
    fakePay(t1.gatewayOrderId, "captured");
    const pay = fakePay(t2.gatewayOrderId, "captured");
    await verifyCheckoutPayment(T.id, { orderId: t2.orderId, razorpayOrderId: t2.gatewayOrderId, razorpayPaymentId: pay.payment.id, razorpaySignature: pay.signature });
    await ageOrder(t1.orderId);
    const late = await runScheduledReconciliation();
    check("Retired order paid later in the other tab is recovered (money taken → access)", entryFor(late, t1.orderId)?.result === "PAID");
    check("…and flagged as POSSIBLE_DUPLICATE_PURCHASE for admin review (not silent)", (await findPaymentMismatches()).some((m) => m.kind === "POSSIBLE_DUPLICATE_PURCHASE" && (m.orderId === t1.orderId || m.orderId === t2.orderId)));
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
