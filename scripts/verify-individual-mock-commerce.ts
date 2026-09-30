/**
 * Focused regression for selling INDIVIDUAL MOCK TESTS alongside Complete
 * Series, on the one canonical commerce path (Product → quote → coupon →
 * PaymentOrder → Razorpay → verify/webhook → Payment → Entitlement →
 * Invoice). A MOCK_TEST product (Product.mockTestId) must unlock ONLY its
 * mock; a TEST_SERIES product unlocks every PAID mock of its series.
 *
 * SAFETY: flips the payment mode, writes gateway config, fixtures, orders and
 * payments, so it REFUSES to run unless DATABASE_URL points at a scratch
 * database whose name contains "payverify". Razorpay's REST API is replaced
 * in-process by a fake that signs with the real HMAC scheme — no network.
 *
 *   DATABASE_URL=<scratch url> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-individual-mock-commerce.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
import { StudentAuthProvider, QuestionStatus, QuestionDifficulty, MockTestStatus } from "@prisma/client";
import { createFixtureSubject } from "./fixture-taxonomy";

if (!/payverify/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *payverify* scratch database.");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fake Razorpay (TEST keys only). Real HMAC signing with the configured secret.
// ---------------------------------------------------------------------------
const KEY_ID = "rzp_test_IndivMock123";
const KEY_SECRET = "indiv_secret_" + crypto.randomBytes(8).toString("hex");
const WEBHOOK_SECRET = "indiv_whsec_" + crypto.randomBytes(8).toString("hex");
type FakeOrder = { id: string; amount: number; currency: string; receipt: string; status: string };
type FakePayment = { id: string; order_id: string; amount: number; currency: string; status: string; method: string; amount_refunded: number };
const fake = { orders: new Map<string, FakeOrder>(), payments: new Map<string, FakePayment>(), orderCreates: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.razorpay.com/v1")) return realFetch(input, init);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (new Headers(init?.headers).get("authorization") !== "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")) return json({}, 401);
  const path = url.replace("https://api.razorpay.com/v1", "").split("?")[0];
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  let m: RegExpMatchArray | null;
  if (init?.method === "POST" && path === "/orders") {
    fake.orderCreates++;
    const o: FakeOrder = { id: "order_" + crypto.randomBytes(7).toString("hex"), amount: body.amount, currency: body.currency, receipt: body.receipt, status: "created" };
    fake.orders.set(o.id, o);
    return json(o);
  }
  if ((m = path.match(/^\/orders\/([^/]+)\/payments$/))) return json({ items: [...fake.payments.values()].filter((p) => p.order_id === m![1]) });
  if ((m = path.match(/^\/orders\/([^/]+)$/))) return fake.orders.has(m[1]) ? json(fake.orders.get(m[1])) : json({}, 404);
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

function fakePay(gatewayOrderId: string) {
  const o = fake.orders.get(gatewayOrderId)!;
  const p: FakePayment = { id: "pay_" + crypto.randomBytes(7).toString("hex"), order_id: o.id, amount: o.amount, currency: o.currency, status: "captured", method: "upi", amount_refunded: 0 };
  fake.payments.set(p.id, p);
  return { payment: p, signature: crypto.createHmac("sha256", KEY_SECRET).update(`${o.id}|${p.id}`).digest("hex") };
}
const sign = (body: string) => crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
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
  const { startMockTestAttempt } = await import("@/lib/test-attempt");
  const { PaymentRequiredError, loadAccessContext, evaluateContentAccess, canStudentAccessProduct, paywallHref } = await import("@/lib/payments/access");
  const { createCheckoutOrder, verifyCheckoutPayment, getCheckoutQuote, reconcileOrder, CheckoutError } = await import("@/lib/payments/orders");
  const { handleRazorpayWebhook } = await import("@/lib/payments/webhooks");
  const { requestRefund } = await import("@/lib/payments/refunds");
  const { getStudentExamAccessSummaries } = await import("@/lib/payments/student-access");
  const { validateProductTarget } = await import("@/lib/payments/product-targets");
  const { purchasableProductsFor, sellingCoverageLabel, loadCoverageProducts, mockIsFree, inertIndividualProducts } = await import("@/lib/test-series-assignment");

  const setMode = async (m: "FREE" | "PAID") => {
    await setPaymentMode(m, undefined);
    bumpPaymentSettingsCache();
  };
  const codeOf = (e: Error | null) => (e instanceof CheckoutError ? e.code : e ? e.message : null);

  console.log("=== Individual Mock Test commerce (scratch DB, fake Razorpay) ===\n");
  const sfx = Date.now().toString(36);
  const exam = await prisma.exam.create({ data: { name: `Indiv Exam ${sfx}`, code: `IND-${sfx}`, durationMinutes: 30 } });
  const otherExam = await prisma.exam.create({ data: { name: `Other Exam ${sfx}`, code: `OTH-${sfx}`, durationMinutes: 30 } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "Indiv Subject" });
  const q = await prisma.question.create({
    data: {
      examId: exam.id,
      subjectId: subject.id,
      code: `Q-IND-${sfx}`,
      text: "Indiv question?",
      difficulty: QuestionDifficulty.EASY,
      status: QuestionStatus.PUBLISHED,
      options: { create: [{ label: "A", text: "x", isCorrect: true }, { label: "B", text: "y", isCorrect: false }] },
    },
  });
  const series = await prisma.testSeries.create({ data: { examId: exam.id, name: `Indiv Series ${sfx}`, status: "PUBLISHED" } });
  const mkMock = (title: string, accessType: "FREE" | "PAID", order: number, examId = exam.id, testSeriesId: string | null = series.id, status: MockTestStatus = MockTestStatus.PUBLISHED) =>
    prisma.mockTest.create({ data: { examId, testSeriesId, title, order, durationMinutes: 30, status, accessType, questions: { create: [{ questionId: q.id, order: 0 }] } } });
  const mockA = await mkMock("Mock A (free)", "FREE", 1);
  const mockB = await mkMock("Mock B (paid, sold individually)", "PAID", 2);
  const mockC = await mkMock("Mock C (paid)", "PAID", 3);
  const mockD = await mkMock("Mock D (paid)", "PAID", 4);
  const archived = await mkMock("Archived", "PAID", 5, exam.id, series.id, MockTestStatus.ARCHIVED);
  const foreign = await prisma.mockTest.create({ data: { examId: otherExam.id, title: "Other exam mock", durationMinutes: 30, status: MockTestStatus.PUBLISHED, accessType: "PAID" } });
  const allPaid = [mockB, mockC, mockD];

  const seriesProduct = await prisma.product.create({
    data: { code: `ind-series-${sfx}`, name: "Complete Series Pass", productType: "TEST_SERIES", examId: exam.id, testSeriesId: series.id, accessType: "PAID", mrpPaise: 200000, sellingPricePaise: 49900, accessDurationType: "DAYS", accessDays: 100 },
  });
  const mockProduct = await prisma.product.create({
    data: { code: `ind-mock-b-${sfx}`, name: "Mock B only", productType: "MOCK_TEST", examId: exam.id, mockTestId: mockB.id, accessType: "PAID", mrpPaise: 10000, sellingPricePaise: 5000, accessDurationType: "DAYS", accessDays: 30 },
  });
  const mkStudent = (t: string) =>
    prisma.student.create({ data: { studentId: `IND-${t}-${sfx}`, name: `Indiv ${t}`, email: `ind-${t}-${sfx}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
  const [N, P1, P3, V, CP, R, RC] = await Promise.all(["N", "P1", "P3", "V", "CP", "R", "RC"].map(mkStudent));

  await saveRazorpayConfig({ slot: "TEST", keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
  await saveRazorpayConfig({ environment: "TEST", enabled: true });

  const desc = (m: { id: string; examId: string; testSeriesId: string | null; accessType: "FREE" | "PAID" }) =>
    ({ kind: "MOCK_TEST" as const, id: m.id, examId: m.examId, testSeriesId: m.testSeriesId, accessType: m.accessType });
  const accessOf = async (sid: string, m: Parameters<typeof desc>[0]) => evaluateContentAccess(await loadAccessContext(sid), desc(m));

  /** Buy `productId` for `sid` through the canonical path; returns the order id. */
  async function buy(sid: string, productId: string, coupon?: string) {
    const o = await createCheckoutOrder(sid, productId, coupon ?? null);
    if (o.kind !== "RAZORPAY") throw new Error("expected a Razorpay order");
    const { payment, signature } = fakePay(o.gatewayOrderId);
    const args = { orderId: o.orderId, razorpayOrderId: o.gatewayOrderId, razorpayPaymentId: payment.id, razorpaySignature: signature };
    const [v1, v2] = await Promise.all([verifyCheckoutPayment(sid, args), verifyCheckoutPayment(sid, args)]);
    const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: fake.payments.get(payment.id) } }, created_at: Math.floor(Date.now() / 1000) });
    const evt = "evt_" + crypto.randomBytes(6).toString("hex");
    const w1 = await handleRazorpayWebhook(body, sign(body), evt);
    const w2 = await handleRazorpayWebhook(body, sign(body), evt);
    return { orderId: o.orderId, amountPaise: o.amountPaise, ok: v1.status === "SUCCESS" && v2.status === "SUCCESS" && w1.httpStatus === 200 && w2.body.status === "duplicate", paymentGatewayId: payment.id };
  }
  const recordsFor = async (orderId: string) => ({
    orders: await prisma.paymentOrder.count({ where: { id: orderId, status: "PAID" } }),
    payments: await prisma.payment.count({ where: { orderId, status: "CAPTURED" } }),
    entitlements: await prisma.studentEntitlement.count({ where: { orderId } }),
    invoices: await prisma.invoice.count({ where: { orderId } }),
  });

  // -------------------------------------------------------------------------
  console.log("1. Global PAID — FREE mock");
  await setMode("PAID");
  const aN = await accessOf(N.id, mockA);
  check("Scenario 1: FREE mock accessible without purchase", aN.allowed && aN.status === "FREE_ACCESS");
  check("…test start allowed", Boolean((await startMockTestAttempt(N.id, mockA.id)).id));

  console.log("\n2. PAID mock with individual + series products, no entitlement");
  const bN = await accessOf(N.id, mockB);
  const optionIds = bN.products.map((p) => p.id).sort();
  check("Scenario 2: PAYMENT_REQUIRED", bN.status === "PAYMENT_REQUIRED" && !bN.allowed);
  check("…both purchase choices offered (individual + Complete Series)", optionIds.join() === [seriesProduct.id, mockProduct.id].sort().join(), bN.products);
  check("…individual choice is typed MOCK_TEST", bN.products.some((p) => p.id === mockProduct.id && p.productType === "MOCK_TEST"));
  const qN = await getCheckoutQuote(N.id, mockProduct.code);
  check("…individual price comes from the Product row (₹50, MRP ₹100)", qN?.price.pricePaise === 5000 && qN?.price.mrpPaise === 10000 && qN?.payablePaise === 5000);
  check("…paywall with two choices goes to the mock's details page", paywallHref(bN, desc(mockB)) === `/student/test-series/${mockB.id}`);
  const cN = await accessOf(N.id, mockC);
  check("…mock C (series only) offers just Complete Series", cN.status === "PAYMENT_REQUIRED" && cN.products.length === 1 && cN.products[0].id === seriesProduct.id);
  check("…paywall with one choice goes straight to its checkout", paywallHref(cN, desc(mockC)) === `/student/checkout/${encodeURIComponent(seriesProduct.code)}`);
  const denied = await rejects(() => startMockTestAttempt(N.id, mockB.id));
  check("…test start denied server-side (PaymentRequiredError carries the mock)", denied instanceof PaymentRequiredError && denied.content?.id === mockB.id);
  check("…no attempt created", (await prisma.testAttempt.count({ where: { studentId: N.id, mockTestId: mockB.id } })) === 0);

  console.log("\n3/6/11/12. Individual purchase of Mock B");
  const ordersBefore = await prisma.paymentOrder.count({ where: { studentId: P1.id } });
  const p1b = await buy(P1.id, mockProduct.id);
  check("Scenario 11: canonical checkout charged the DB price (₹50)", p1b.amountPaise === 5000);
  check("Scenario 12: concurrent verify + duplicate webhook handled idempotently", p1b.ok);
  const r1 = await recordsFor(p1b.orderId);
  check("…exactly 1 order / 1 captured payment / 1 entitlement / 1 invoice", r1.orders === 1 && r1.payments === 1 && r1.entitlements === 1 && r1.invoices === 1, r1);
  check("…only one new order for this student", (await prisma.paymentOrder.count({ where: { studentId: P1.id } })) === ordersBefore + 1);
  const ent1 = await prisma.studentEntitlement.findUniqueOrThrow({ where: { orderId: p1b.orderId } });
  check("…entitlement scoped to the Mock B product, 30 days", ent1.productId === mockProduct.id && Math.round((ent1.expiresAt!.getTime() - ent1.startsAt.getTime()) / 86_400_000) === 30);
  const order1 = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: p1b.orderId } });
  check("…order keeps the exact product link (productId + snapshot.mockTestId)", order1.productId === mockProduct.id && (order1.productSnapshot as { mockTestId?: string }).mockTestId === mockB.id);
  const bP1 = await accessOf(P1.id, mockB);
  check("Scenario 3: Mock B → ACCESS via the individual product", bP1.status === "ACTIVE_SUBSCRIPTION" && bP1.products.map((p) => p.id).join() === mockProduct.id);
  check("…test start on Mock B allowed", Boolean((await startMockTestAttempt(P1.id, mockB.id)).id));
  for (const m of [mockC, mockD]) {
    const a = await accessOf(P1.id, m);
    check(`Scenario 6: ${m.title} stays PAYMENT_REQUIRED (no leakage)`, a.status === "PAYMENT_REQUIRED");
  }
  check("…Mock C test start still denied", (await rejects(() => startMockTestAttempt(P1.id, mockC.id))) instanceof PaymentRequiredError);
  check("…other exam's paid mock not unlocked", (await accessOf(P1.id, foreign)).status !== "ACTIVE_SUBSCRIPTION");
  const [sumP1] = await getStudentExamAccessSummaries(P1.id, [{ id: exam.id, name: exam.name }]);
  check("…dashboard does NOT show Complete Series as ACTIVE", sumP1.state !== "ACTIVE", sumP1.state);
  check("…Complete Series still purchasable for this student", (await canStudentAccessProduct(P1.id, seriesProduct.id)).status === "PAYMENT_REQUIRED");
  check("…re-buying the owned mock without explicit renew → ALREADY_OWNED", codeOf(await rejects(() => createCheckoutOrder(P1.id, mockProduct.id))) === "ALREADY_OWNED");

  console.log("\n5. Individual owner later buys Complete Series");
  const p1s = await buy(P1.id, seriesProduct.id);
  check("Series checkout charged ₹499 from DB", p1s.amountPaise === 49900 && p1s.ok);
  for (const m of allPaid) check(`Scenario 5: ${m.title} → ACCESS`, (await accessOf(P1.id, m)).status === "ACTIVE_SUBSCRIPTION");
  const p1Ents = await prisma.studentEntitlement.findMany({ where: { studentId: P1.id, status: "ACTIVE" } });
  check("…both purchase entitlements preserved (individual + series)", p1Ents.length === 2 && p1Ents.some((e) => e.productId === mockProduct.id) && p1Ents.some((e) => e.productId === seriesProduct.id));
  check("…both orders PAID with an invoice each", (await prisma.paymentOrder.count({ where: { studentId: P1.id, status: "PAID" } })) === 2 && (await prisma.invoice.count({ where: { studentId: P1.id } })) === 2);
  const [sumP1b] = await getStudentExamAccessSummaries(P1.id, [{ id: exam.id, name: exam.name }]);
  check("…dashboard now shows Complete Series ACTIVE", sumP1b.state === "ACTIVE");

  console.log("\n4/13. Complete Series owner");
  await buy(P3.id, seriesProduct.id);
  for (const m of allPaid) check(`Scenario 4: ${m.title} → ACCESS`, (await accessOf(P3.id, m)).status === "ACTIVE_SUBSCRIPTION");
  check("…Mock B access attributed to the series product", (await accessOf(P3.id, mockB)).products.every((p) => p.productType === "TEST_SERIES"));
  const covered = await canStudentAccessProduct(P3.id, mockProduct.id);
  check("Scenario 13: individual product treated as already covered", covered.allowed && covered.coveredBy?.id === seriesProduct.id);
  const qP3 = await getCheckoutQuote(P3.id, mockProduct.code);
  check("…checkout quote offers no renewal/extension", qP3?.renewal === null && qP3?.access.coveredBy?.id === seriesProduct.id);
  const p3Orders = await prisma.paymentOrder.count({ where: { studentId: P3.id } });
  const p3Err = await rejects(() => createCheckoutOrder(P3.id, mockProduct.id));
  check("…buying it anyway is refused (ALREADY_OWNED) and creates no order", codeOf(p3Err) === "ALREADY_OWNED" && (await prisma.paymentOrder.count({ where: { studentId: P3.id } })) === p3Orders);
  check("…even as an explicit renewal", codeOf(await rejects(() => createCheckoutOrder(P3.id, mockProduct.id, null, { renew: true }))) === "ALREADY_OWNED");

  console.log("\n7. Admin product target validation");
  const base = { id: null, productType: "MOCK_TEST" as const, accessType: "PAID" as const, isActive: true, testSeriesId: null };
  check("Scenario 7: mock of another exam rejected", /different exam/.test((await validateProductTarget({ ...base, examId: exam.id, mockTestId: foreign.id })) ?? ""));
  check("…archived mock rejected", /non-archived/.test((await validateProductTarget({ ...base, examId: exam.id, mockTestId: archived.id })) ?? ""));
  check("…nonexistent mock rejected", /non-archived/.test((await validateProductTarget({ ...base, examId: null, mockTestId: "nope_" + sfx })) ?? ""));
  check("…PAID product for a FREE mock rejected", /FREE for everyone/.test((await validateProductTarget({ ...base, examId: exam.id, mockTestId: mockA.id })) ?? ""));
  check("…second active product for the same mock rejected", /already sells this Mock Test/.test((await validateProductTarget({ ...base, examId: exam.id, mockTestId: mockB.id })) ?? ""));
  check("…editing the existing product itself is allowed", (await validateProductTarget({ ...base, id: mockProduct.id, examId: exam.id, mockTestId: mockB.id })) === null);
  check("…an inactive second product is allowed (no competing price)", (await validateProductTarget({ ...base, isActive: false, examId: exam.id, mockTestId: mockB.id })) === null);
  check("…valid new product for Mock C accepted", (await validateProductTarget({ ...base, examId: exam.id, mockTestId: mockC.id })) === null);
  check("…Complete Series of another exam rejected", /different exam/.test((await validateProductTarget({ ...base, productType: "TEST_SERIES", mockTestId: null, examId: otherExam.id, testSeriesId: series.id })) ?? ""));
  check("…existing series product still valid", (await validateProductTarget({ ...base, id: seriesProduct.id, productType: "TEST_SERIES", mockTestId: null, examId: exam.id, testSeriesId: series.id })) === null);

  console.log("\n10. Admin mock-page selling coverage");
  const prods = await loadCoverageProducts(prisma);
  const now = new Date();
  check("Mock B: sold individually AND in Complete Series", /^Sold individually \(Mock B only\) and included in Complete Series Pass/.test(sellingCoverageLabel(purchasableProductsFor(mockB, prods, now)) ?? ""));
  check("Mock C: Complete Series only", /^Included in Complete Series only/.test(sellingCoverageLabel(purchasableProductsFor(mockC, prods, now)) ?? ""));
  const orphan = await mkMock("Orphan paid", "PAID", 9, exam.id, null);
  check("Orphan PAID mock: not covered → warning case", sellingCoverageLabel(purchasableProductsFor(orphan, prods, now)) === null && !mockIsFree(orphan, prods));
  const legacyFree = await prisma.product.create({
    data: { code: `ind-legacy-a-${sfx}`, name: "Legacy Mock A product", productType: "MOCK_TEST", examId: exam.id, mockTestId: mockA.id, accessType: "PAID", mrpPaise: 5000, sellingPricePaise: 2500, accessDurationType: "DAYS", accessDays: 30 },
  });
  const prods2 = await loadCoverageProducts(prisma);
  check("FREE mock with a (legacy) PAID individual product is flagged as never sold", inertIndividualProducts(mockA, prods2).includes("Legacy Mock A product"));
  check("…and the FREE mock stays open (FREE always means open)", (await accessOf(N.id, mockA)).status === "FREE_ACCESS");
  check("…its checkout refuses to sell it", codeOf(await rejects(() => createCheckoutOrder(N.id, legacyFree.id))) === "PRODUCT_UNAVAILABLE");
  await prisma.product.update({ where: { id: legacyFree.id }, data: { isActive: false } });

  console.log("\n10. Coupons on an individual Mock product");
  const pct = await prisma.coupon.create({ data: { code: `IND20${sfx}`.toUpperCase().slice(0, 32), discountType: "PERCENTAGE", discountValue: 20, productIds: [mockProduct.id], perStudentLimit: 1, totalUsageLimit: 5, referrerName: "Creator X", commissionType: "PERCENTAGE", commissionValue: 1000 } });
  const fixed = await prisma.coupon.create({ data: { code: `INDF${sfx}`.toUpperCase().slice(0, 32), discountType: "FIXED_AMOUNT", discountValue: 1000, examIds: [exam.id] } });
  const seriesOnly = await prisma.coupon.create({ data: { code: `INDS${sfx}`.toUpperCase().slice(0, 32), discountType: "PERCENTAGE", discountValue: 10, productIds: [seriesProduct.id] } });
  const qPct = await getCheckoutQuote(CP.id, mockProduct.code, pct.code);
  check("Scenario 10: 20% product-scoped coupon → ₹40 payable", qPct?.coupon?.discountPaise === 1000 && qPct?.payablePaise === 4000);
  const qFixed = await getCheckoutQuote(CP.id, mockProduct.code, fixed.code);
  check("…₹10 exam-scoped fixed coupon → ₹40 payable", qFixed?.coupon?.discountPaise === 1000 && qFixed?.payablePaise === 4000);
  const qWrong = await getCheckoutQuote(CP.id, mockProduct.code, seriesOnly.code);
  check("…coupon limited to the series product is rejected for the mock", qWrong?.coupon === null && Boolean(qWrong?.couponError));
  const cpOrder = await createCheckoutOrder(CP.id, mockProduct.id, pct.code);
  check("…order created at the discounted amount (₹40)", cpOrder.kind === "RAZORPAY" && cpOrder.amountPaise === 4000);
  check("…no entitlement before a successful payment", (await prisma.studentEntitlement.count({ where: { studentId: CP.id } })) === 0);
  check("…redemption RESERVED (not consumed) before payment", (await prisma.couponRedemption.findUniqueOrThrow({ where: { orderId: cpOrder.orderId } })).status === "RESERVED");
  if (cpOrder.kind === "RAZORPAY") {
    const { payment, signature } = fakePay(cpOrder.gatewayOrderId);
    await verifyCheckoutPayment(CP.id, { orderId: cpOrder.orderId, razorpayOrderId: cpOrder.gatewayOrderId, razorpayPaymentId: payment.id, razorpaySignature: signature });
  }
  const rcp = await recordsFor(cpOrder.orderId);
  check("…after payment: 1 order / 1 payment / 1 entitlement / 1 invoice", rcp.orders === 1 && rcp.payments === 1 && rcp.entitlements === 1 && rcp.invoices === 1, rcp);
  check("…redemption CONSUMED exactly once, for this student", (await prisma.couponRedemption.count({ where: { couponId: pct.id, studentId: CP.id, status: "CONSUMED" } })) === 1);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { orderId: cpOrder.orderId } });
  check("…invoice total = captured amount (₹40)", inv.totalPaise === 4000 && (await prisma.payment.findFirstOrThrow({ where: { orderId: cpOrder.orderId } })).amountPaise === 4000);
  check("…per-student limit: same coupon again rejected", Boolean((await getCheckoutQuote(CP.id, seriesProduct.code, pct.code))?.couponError));
  check("…creator attribution kept on the coupon/order", (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: cpOrder.orderId } })).couponId === pct.id);

  console.log("\n9. Refund + reconciliation stay scoped to the individual order");
  const rOrder = await buy(R.id, mockProduct.id);
  const rPay = await prisma.payment.findFirstOrThrow({ where: { orderId: rOrder.orderId } });
  await requestRefund({ paymentId: rPay.id, amountPaise: rPay.amountPaise, reason: "verify", accessPolicy: "REVOKE_IMMEDIATELY", retainUntil: null, adminId: undefined });
  check("Full refund (REVOKE) → the individual entitlement is revoked", (await prisma.studentEntitlement.findUniqueOrThrow({ where: { orderId: rOrder.orderId } })).status === "REVOKED");
  check("…Mock B locked again for that student", (await accessOf(R.id, mockB)).status === "PAYMENT_REQUIRED");
  check("…P1's entitlements untouched by R's refund", (await prisma.studentEntitlement.count({ where: { studentId: P1.id, status: "ACTIVE" } })) === 2);
  const rcOrder = await createCheckoutOrder(RC.id, mockProduct.id);
  if (rcOrder.kind === "RAZORPAY") fakePay(rcOrder.gatewayOrderId); // captured, but the browser callback never arrives
  const rec = await reconcileOrder(rcOrder.orderId);
  const rrc = await recordsFor(rcOrder.orderId);
  check("Missed callback → reconciliation fulfils once", rec.outcome === "PAID" && rrc.orders === 1 && rrc.payments === 1 && rrc.entitlements === 1 && rrc.invoices === 1, { rec, rrc });
  check("…again: no duplicate", (await reconcileOrder(rcOrder.orderId)).outcome !== "PAID" || (await recordsFor(rcOrder.orderId)).entitlements === 1);
  check("…reconciled entitlement unlocks only Mock B", (await accessOf(RC.id, mockB)).allowed && !(await accessOf(RC.id, mockC)).allowed);

  console.log("\n8. Global FREE");
  await setMode("FREE");
  for (const m of [mockA, ...allPaid]) check(`Scenario 8: ${m.title} open for a normal student in FREE mode`, (await accessOf(N.id, m)).status === "FREE_ACCESS");
  check("…individual product checkout refused in FREE mode", codeOf(await rejects(() => createCheckoutOrder(N.id, mockProduct.id))) === "PLATFORM_FREE");

  console.log("\n9. Verification student under global FREE");
  await setVerificationStudentIds([V.id], undefined);
  bumpPaymentSettingsCache();
  const bV = await accessOf(V.id, mockB);
  check("Scenario 9: verification student sees PAID presentation (both choices)", bV.status === "PAYMENT_REQUIRED" && bV.products.length === 2);
  check("…individual quote from DB (₹50)", (await getCheckoutQuote(V.id, mockProduct.code))?.payablePaise === 5000);
  check("…normal student still FREE", (await accessOf(N.id, mockB)).status === "FREE_ACCESS");
  await setVerificationStudentIds([], undefined);
  bumpPaymentSettingsCache();

  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
