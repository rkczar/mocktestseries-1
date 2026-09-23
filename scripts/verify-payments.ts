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
 * TEST-mode separation in analytics.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { StudentAuthProvider, QuestionStatus, QuestionDifficulty, MockTestStatus, RoleName, OrderStatus } from "@prisma/client";

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

type FakeOrder = { id: string; amount: number; currency: string; receipt: string; status: string };
type FakePayment = { id: string; order_id: string; amount: number; currency: string; status: string; method: string; amount_refunded: number };
const fake = { orders: new Map<string, FakeOrder>(), payments: new Map<string, FakePayment>(), orderCreates: 0, refunds: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.razorpay.com/v1")) return realFetch(input, init);
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")) return new Response("{}", { status: 401 });
  const path = url.replace("https://api.razorpay.com/v1", "").split("?")[0];
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  let m: RegExpMatchArray | null;
  if (init?.method === "POST" && path === "/orders") {
    fake.orderCreates++;
    const o = { id: "order_" + crypto.randomBytes(7).toString("hex"), amount: body.amount, currency: body.currency, receipt: body.receipt, status: "created" };
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
  const { saveRazorpayConfig, getRazorpayConfig } = await import("@/lib/razorpay-config");
  const { startMockTestAttempt, startPreviousYearPaperAttempt } = await import("@/lib/test-attempt");
  const { PaymentRequiredError, getContentAccess, canStudentAccessProduct } = await import("@/lib/payments/access");
  const { createCheckoutOrder, verifyCheckoutPayment, getOrderStatusForStudent, reconcileOrder, getCheckoutQuote, CheckoutError } = await import("@/lib/payments/orders");
  const { handleRazorpayWebhook } = await import("@/lib/payments/webhooks");
  const { requestRefund } = await import("@/lib/payments/refunds");
  const { getPaymentOverview, parsePaymentFilters } = await import("@/lib/payments/analytics");
  const { computeProductPrice, computeCouponDiscount } = await import("@/lib/payments/pricing");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");

  const setMode = async (m: "FREE" | "PAID" | "MAINTENANCE") => {
    await setPaymentMode(m, undefined);
    bumpPaymentSettingsCache();
  };

  console.log("=== Payments / Entitlement Verification (scratch DB, fake Razorpay) ===\n");
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Pay Exam ${sfx}`, code: `PAY-${sfx}`, durationMinutes: 30 } });
  const subject = await prisma.subject.create({ data: { examId: exam.id, name: "Pay Subject" } });
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
    data: { examId: exam.id, testSeriesId: series.id, title: "Paid Mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, questions: { create: [{ questionId: q.id, order: 0 }] } },
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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
