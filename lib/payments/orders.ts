import "server-only";
import crypto from "node:crypto";
import {
  CouponRedemptionStatus,
  EntitlementSource,
  EntitlementStatus,
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  PaymentVerifiedVia,
  Prisma,
  type PaymentEnvironment,
  type Product,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRazorpayConfig, getRazorpayCredentials } from "@/lib/razorpay-config";
import { getPaymentMode, getPaymentPolicy } from "@/lib/payments/settings";
import { computeProductPrice, computeAccessWindow, describeAccessDuration, type ProductPrice } from "@/lib/payments/pricing";
import { evaluateCoupon, lockCoupon, normalizeCouponCode, COUPON_REJECTION_MESSAGES, type CouponRejection } from "@/lib/payments/coupons";
import { canStudentAccessProduct, type AccessResult } from "@/lib/payments/access";
import { issueInvoiceTx } from "@/lib/payments/invoices";
import {
  RazorpayApiError,
  captureRazorpayPayment,
  checkoutSignatureIsValid,
  createRazorpayOrder,
  fetchRazorpayOrderPayments,
  fetchRazorpayPayment,
  mapRazorpayPaymentStatus,
  safeMethodLabel,
  type RzpPayment,
} from "@/lib/payments/razorpay";

/**
 * Order lifecycle (all transitions server-side):
 *
 *   CREATED → GATEWAY_ORDER_CREATED → PAID
 *        ↘ (₹0 after coupon) → PAID via INTERNAL gateway, no Razorpay call
 *   open orders → EXPIRED / CANCELLED / FAILED (gateway order creation failed)
 *   PAID → PARTIALLY_REFUNDED / REFUNDED
 *
 * Idempotency, safe across PM2 workers (DB constraints, not memory locks):
 *   - PaymentOrder.openKey UNIQUE → one open order per student+product
 *     (double-click / two tabs reuse it)
 *   - Payment.gatewayPaymentId UNIQUE → one row per Razorpay payment
 *   - StudentEntitlement.orderId UNIQUE → one grant per order
 *   - Invoice.orderId UNIQUE → one invoice per order
 *   - CouponRedemption.orderId UNIQUE + coupon row FOR UPDATE → no double use
 *   - fulfilment locks the order row FOR UPDATE, so verify + webhook +
 *     reconcile racing each other serialize and the loser sees PAID.
 */

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PRODUCT_UNAVAILABLE"
      | "PLATFORM_FREE"
      | "PURCHASES_PAUSED"
      | "ALREADY_OWNED"
      | "COUPON_REJECTED"
      | "GATEWAY_NOT_CONFIGURED"
      | "GATEWAY_ERROR"
      | "ORDER_IN_PROGRESS"
      | "ORDER_NOT_FOUND"
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

const OPEN_STATUSES: OrderStatus[] = [OrderStatus.CREATED, OrderStatus.GATEWAY_ORDER_CREATED, OrderStatus.PAYMENT_PENDING];
const PAID_LIKE: OrderStatus[] = [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED];

const PAYMENT_RANK: Record<PaymentStatus, number> = {
  CREATED: 0,
  FAILED: 1,
  AUTHORIZED: 2,
  CAPTURED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
};

function newOrderNumber(now: Date): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const ymd = ist.toISOString().slice(2, 10).replace(/-/g, "");
  return `ORD-${ymd}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

function productSnapshot(product: Product, price: ProductPrice) {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    productType: product.productType,
    examId: product.examId,
    testSeriesId: product.testSeriesId,
    accessDurationType: product.accessDurationType,
    accessDays: product.accessDays,
    accessExpiresAt: product.accessExpiresAt?.toISOString() ?? null,
    accessLabel: describeAccessDuration(product),
    saleActive: price.saleActive,
  };
}

// ---------------------------------------------------------------------------
// Quote (read-only; used by checkout page + "Apply coupon")
// ---------------------------------------------------------------------------

export interface CheckoutQuote {
  product: { id: string; code: string; name: string; description: string | null; accessLabel: string; examName: string | null };
  price: ProductPrice;
  coupon: { code: string; discountPaise: number; label: string | null } | null;
  couponError: string | null;
  payablePaise: number;
  access: AccessResult;
  gatewayReady: boolean;
  environment: PaymentEnvironment;
}

export async function getCheckoutQuote(studentId: string, productCode: string, couponInput?: string | null): Promise<CheckoutQuote | null> {
  const product = await prisma.product.findUnique({ where: { code: productCode }, include: { exam: { select: { name: true } } } });
  if (!product || !product.isActive || !product.isVisible) return null;
  const now = new Date();
  const price = computeProductPrice(product, now);
  const access = await canStudentAccessProduct(studentId, product.id, now);
  const rzp = await getRazorpayConfig();

  let coupon: CheckoutQuote["coupon"] = null;
  let couponError: string | null = null;
  if (couponInput) {
    const code = normalizeCouponCode(couponInput);
    if (!code) couponError = COUPON_REJECTION_MESSAGES.INVALID;
    else {
      const r = await evaluateCoupon(prisma, { code, studentId, product, pricePaise: price.pricePaise, now });
      if (r.ok) coupon = { code, discountPaise: r.discountPaise, label: r.coupon.displayName };
      else couponError = COUPON_REJECTION_MESSAGES[r.reason];
    }
  }
  return {
    product: {
      id: product.id,
      code: product.code,
      name: product.name,
      description: product.description,
      accessLabel: describeAccessDuration(product),
      examName: product.exam?.name ?? null,
    },
    price,
    coupon,
    couponError,
    payablePaise: price.pricePaise - (coupon?.discountPaise ?? 0),
    access,
    gatewayReady: rzp.enabled && rzp.configured,
    environment: rzp.environment,
  };
}

// ---------------------------------------------------------------------------
// Create order
// ---------------------------------------------------------------------------

export type CreateOrderResult =
  | {
      kind: "RAZORPAY";
      orderId: string;
      orderNumber: string;
      keyId: string;
      gatewayOrderId: string;
      amountPaise: number;
      currency: string;
      productName: string;
      environment: PaymentEnvironment;
    }
  | { kind: "FREE_GRANT"; orderId: string; orderNumber: string };

export async function createCheckoutOrder(studentId: string, productId: string, couponInput?: string | null): Promise<CreateOrderResult> {
  const mode = await getPaymentMode();
  if (mode === "FREE") throw new CheckoutError("Everything is free right now — no purchase needed.", "PLATFORM_FREE");
  if (mode === "MAINTENANCE") throw new CheckoutError("Purchases are temporarily paused. Please try again later.", "PURCHASES_PAUSED");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  const now = new Date();
  if (!product || !product.isActive || !product.isVisible || !product.purchaseEnabled || product.accessType !== "PAID")
    throw new CheckoutError("This product isn't available for purchase.", "PRODUCT_UNAVAILABLE");
  if (product.accessDurationType === "FIXED_DATE" && (!product.accessExpiresAt || product.accessExpiresAt <= now))
    throw new CheckoutError("This product's access period has ended.", "PRODUCT_UNAVAILABLE");

  // Lifetime / fixed-date access already held → nothing to buy. Day-based
  // access can be renewed early (extends from the current expiry).
  const access = await canStudentAccessProduct(studentId, product.id, now);
  if (access.status === "ACTIVE_SUBSCRIPTION" && (access.expiresAt === null || product.accessDurationType === "FIXED_DATE"))
    throw new CheckoutError("You already have access to this product.", "ALREADY_OWNED");

  const couponCode = couponInput ? normalizeCouponCode(couponInput) : null;
  if (couponInput && !couponCode) throw new CheckoutError(COUPON_REJECTION_MESSAGES.INVALID, "COUPON_REJECTED");

  const price = computeProductPrice(product, now);
  const rzp = await getRazorpayConfig();
  const environment: PaymentEnvironment = rzp.environment;
  const policy = await getPaymentPolicy();
  const openKey = `${studentId}:${product.id}`;

  const attempt = async () =>
    prisma.$transaction(
      async (tx) => {
        let couponId: string | null = null;
        if (couponCode) {
          const c = await tx.coupon.findUnique({ where: { code: couponCode }, select: { id: true } });
          if (c) {
            await lockCoupon(tx, c.id);
            couponId = c.id;
          }
        }

        // Reuse or retire the existing open order for this student+product.
        const open = await tx.paymentOrder.findUnique({ where: { openKey } });
        if (open) {
          const stillValid = OPEN_STATUSES.includes(open.status) && (!open.expiresAt || open.expiresAt > now);
          const sameTerms = open.couponCode === couponCode && open.environment === environment;
          if (stillValid && sameTerms) {
            if (!open.gatewayOrderId) throw new CheckoutError("Your order is being prepared — please try again in a moment.", "ORDER_IN_PROGRESS");
            return { kind: "reuse" as const, order: open };
          }
          await tx.paymentOrder.update({
            where: { id: open.id },
            data: { openKey: null, status: stillValid ? OrderStatus.CANCELLED : OrderStatus.EXPIRED },
          });
          await tx.couponRedemption.updateMany({
            where: { orderId: open.id, status: CouponRedemptionStatus.RESERVED },
            data: { status: CouponRedemptionStatus.RELEASED },
          });
        }

        let couponDiscount = 0;
        if (couponCode) {
          const r = await evaluateCoupon(tx, { code: couponCode, studentId, product, pricePaise: price.pricePaise, now });
          if (!r.ok) throw new CheckoutError(COUPON_REJECTION_MESSAGES[r.reason as CouponRejection], "COUPON_REJECTED");
          couponDiscount = r.discountPaise;
        }
        const amount = price.pricePaise - couponDiscount;
        const isZero = amount <= 0;
        if (!isZero && !(rzp.enabled && rzp.configured))
          throw new CheckoutError("Online payment isn't set up yet. Please try again later.", "GATEWAY_NOT_CONFIGURED");

        const orderNumber = newOrderNumber(now);
        const expiresAt = new Date(now.getTime() + policy.orderTtlMinutes * 60_000);
        const order = await tx.paymentOrder.create({
          data: {
            orderNumber,
            receipt: orderNumber,
            studentId,
            productId: product.id,
            status: OrderStatus.CREATED,
            gateway: isZero ? PaymentGateway.INTERNAL : PaymentGateway.RAZORPAY,
            environment,
            currency: product.currency,
            mrpPaise: price.mrpPaise,
            sellingPricePaise: price.sellingPricePaise,
            saleDiscountPaise: price.saleDiscountPaise,
            couponId,
            couponCode,
            couponDiscountPaise: couponDiscount,
            amountPaise: Math.max(0, amount),
            productSnapshot: productSnapshot(product, price),
            openKey: isZero ? null : openKey,
            expiresAt: isZero ? null : expiresAt,
          },
        });
        if (couponId) {
          await tx.couponRedemption.create({
            data: {
              couponId,
              studentId,
              orderId: order.id,
              discountPaise: couponDiscount,
              status: isZero ? CouponRedemptionStatus.CONSUMED : CouponRedemptionStatus.RESERVED,
              reservedUntil: isZero ? null : expiresAt,
              consumedAt: isZero ? now : null,
            },
          });
        }
        if (isZero) {
          // ₹0 after coupon: no Razorpay order/payment is created. Grant the
          // entitlement in this same transaction.
          await tx.paymentOrder.update({ where: { id: order.id }, data: { status: OrderStatus.PAID, paidAt: now } });
          await grantEntitlementTx(tx, order.id, EntitlementSource.COUPON, now);
          if (policy.invoiceZeroValueOrders) await issueInvoiceTx(tx, order.id, { gatewayPaymentId: null, method: null, paidAt: now });
        }
        return { kind: "created" as const, order, isZero };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 }
    );

  // Another worker/tab may win the openKey race (P2002) or still be calling
  // Razorpay for the same open order (ORDER_IN_PROGRESS): wait briefly and
  // retry, which then reuses that single order instead of creating another.
  let result: Awaited<ReturnType<typeof attempt>> | null = null;
  for (let i = 0; result === null; i++) {
    try {
      result = await attempt();
    } catch (e) {
      const retryable =
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
        (e instanceof CheckoutError && e.code === "ORDER_IN_PROGRESS");
      if (!retryable || i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (result.kind === "reuse") {
    const o = result.order;
    const creds = await getRazorpayCredentials(o.environment);
    if (!creds) throw new CheckoutError("Online payment isn't set up yet. Please try again later.", "GATEWAY_NOT_CONFIGURED");
    return {
      kind: "RAZORPAY",
      orderId: o.id,
      orderNumber: o.orderNumber,
      keyId: creds.keyId,
      gatewayOrderId: o.gatewayOrderId!,
      amountPaise: o.amountPaise,
      currency: o.currency,
      productName: product.name,
      environment: o.environment,
    };
  }
  const order = result.order;
  if (result.isZero) return { kind: "FREE_GRANT", orderId: order.id, orderNumber: order.orderNumber };

  // Internal order exists BEFORE Razorpay is called; its receipt is our
  // unique orderNumber, so a retried create is traceable to one order.
  try {
    const rzpOrder = await createRazorpayOrder(environment, {
      amountPaise: order.amountPaise,
      currency: order.currency,
      receipt: order.receipt,
      notes: { orderNumber: order.orderNumber, productCode: product.code },
    });
    if (rzpOrder.amount !== order.amountPaise) throw new RazorpayApiError("BAD_REQUEST");
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { gatewayOrderId: rzpOrder.id, status: OrderStatus.GATEWAY_ORDER_CREATED },
    });
    const creds = await getRazorpayCredentials(environment);
    return {
      kind: "RAZORPAY",
      orderId: order.id,
      orderNumber: order.orderNumber,
      keyId: creds!.keyId,
      gatewayOrderId: rzpOrder.id,
      amountPaise: order.amountPaise,
      currency: order.currency,
      productName: product.name,
      environment,
    };
  } catch (e) {
    await prisma.$transaction([
      prisma.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.FAILED,
          openKey: null,
          failureReason: e instanceof RazorpayApiError ? `GATEWAY_${e.category}` : "GATEWAY_UNKNOWN",
        },
      }),
      prisma.couponRedemption.updateMany({
        where: { orderId: order.id, status: CouponRedemptionStatus.RESERVED },
        data: { status: CouponRedemptionStatus.RELEASED },
      }),
    ]);
    throw new CheckoutError("We couldn't start the payment. Please try again.", "GATEWAY_ERROR");
  }
}

// ---------------------------------------------------------------------------
// Fulfilment (the one place access is granted for a paid order)
// ---------------------------------------------------------------------------

async function grantEntitlementTx(tx: Prisma.TransactionClient, orderId: string, source: EntitlementSource, now: Date) {
  const existing = await tx.studentEntitlement.findUnique({ where: { orderId } });
  if (existing) return existing;
  const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId }, include: { product: true } });
  const current = await tx.studentEntitlement.findMany({
    where: { studentId: order.studentId, productId: order.productId, status: EntitlementStatus.ACTIVE },
    select: { expiresAt: true, startsAt: true },
  });
  const currentExpiry = current
    .filter((e) => e.startsAt <= now && e.expiresAt && e.expiresAt > now)
    .reduce<Date | null>((m, e) => (m && m > e.expiresAt! ? m : e.expiresAt), null);
  const window = computeAccessWindow(order.product, now, currentExpiry);
  return tx.studentEntitlement.create({
    data: {
      studentId: order.studentId,
      productId: order.productId,
      source,
      status: EntitlementStatus.ACTIVE,
      startsAt: window.startsAt,
      expiresAt: window.expiresAt,
      orderId,
    },
  });
}

export type FulfilOutcome = "PAID" | "ALREADY_PAID" | "NOT_CAPTURED" | "MISMATCH";

/**
 * Records a TRUSTED Razorpay payment entity (fetched from the API with our
 * secret, or delivered in a signature-verified webhook) against our order.
 * Grants entitlement + consumes coupon + issues invoice exactly once.
 */
export async function recordTrustedPayment(orderId: string, p: RzpPayment, via: PaymentVerifiedVia): Promise<FulfilOutcome> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentOrder" WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
      const now = new Date();

      // The payment must belong to THIS order and match its amount exactly.
      if (!order.gatewayOrderId || p.order_id !== order.gatewayOrderId || p.amount !== order.amountPaise || p.currency !== order.currency) {
        await tx.paymentOrder.update({ where: { id: order.id }, data: { failureReason: "PAYMENT_ORDER_MISMATCH" } });
        return "MISMATCH";
      }

      const status = mapRazorpayPaymentStatus(p);
      const captured = p.status === "captured" || p.status === "refunded";
      const existing = await tx.payment.findUnique({ where: { gatewayPaymentId: p.id } });
      if (existing && existing.orderId !== order.id) return "MISMATCH";
      const failure = {
        failureCode: p.error_code?.slice(0, 64) ?? null,
        failureDescription: p.error_description?.slice(0, 200) ?? null,
      };
      if (!existing) {
        await tx.payment.create({
          data: {
            orderId: order.id,
            studentId: order.studentId,
            gateway: PaymentGateway.RAZORPAY,
            environment: order.environment,
            gatewayPaymentId: p.id,
            status,
            amountPaise: p.amount,
            currency: p.currency,
            method: safeMethodLabel(p.method),
            verifiedVia: captured ? via : null,
            refundedPaise: p.amount_refunded ?? 0,
            ...(status === PaymentStatus.FAILED ? failure : {}),
            capturedAt: captured ? now : null,
          },
        });
      } else if (PAYMENT_RANK[status] >= PAYMENT_RANK[existing.status]) {
        // Status only ever moves forward (a captured payment never drops back).
        await tx.payment.update({
          where: { id: existing.id },
          data: {
            status,
            method: safeMethodLabel(p.method) ?? existing.method,
            refundedPaise: Math.max(existing.refundedPaise, p.amount_refunded ?? 0),
            ...(captured && !existing.capturedAt ? { capturedAt: now, verifiedVia: via } : {}),
            ...(status === PaymentStatus.FAILED ? failure : {}),
          },
        });
      }

      if (PAID_LIKE.includes(order.status)) return "ALREADY_PAID";
      if (!captured) {
        if (status === PaymentStatus.FAILED) {
          await tx.paymentOrder.update({
            where: { id: order.id },
            data: { failureReason: "PAYMENT_FAILED", status: OPEN_STATUSES.includes(order.status) ? OrderStatus.PAYMENT_PENDING : order.status },
          });
        } else if (order.status === OrderStatus.GATEWAY_ORDER_CREATED) {
          await tx.paymentOrder.update({ where: { id: order.id }, data: { status: OrderStatus.PAYMENT_PENDING } });
        }
        return "NOT_CAPTURED";
      }

      // Captured: PAID even if the order had expired/cancelled locally —
      // money was taken, so access is owed.
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { status: OrderStatus.PAID, paidAt: now, openKey: null, failureReason: null },
      });
      await tx.couponRedemption.updateMany({
        where: { orderId: order.id, status: { in: [CouponRedemptionStatus.RESERVED, CouponRedemptionStatus.RELEASED] } },
        data: { status: CouponRedemptionStatus.CONSUMED, consumedAt: now },
      });
      await grantEntitlementTx(tx, order.id, EntitlementSource.PURCHASE, now);
      await issueInvoiceTx(tx, order.id, { gatewayPaymentId: p.id, method: safeMethodLabel(p.method), paidAt: now });
      return "PAID";
    },
    { timeout: 20_000 }
  );
}

/** Capture an authorized payment (if the account doesn't auto-capture), then return the fresh entity. */
async function ensureCaptured(environment: PaymentEnvironment, p: RzpPayment, amountPaise: number, currency: string): Promise<RzpPayment> {
  if (p.status !== "authorized") return p;
  try {
    return await captureRazorpayPayment(environment, p.id, amountPaise, currency);
  } catch {
    // Possibly captured concurrently (auto-capture / webhook path) — re-read.
    return fetchRazorpayPayment(environment, p.id);
  }
}

// ---------------------------------------------------------------------------
// Checkout callback verification
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { status: "SUCCESS"; orderId: string }
  | { status: "PROCESSING"; orderId: string }
  | { status: "FAILED"; orderId: string; message: string };

export async function verifyCheckoutPayment(
  studentId: string,
  input: { orderId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }
): Promise<VerifyResult> {
  // Canonical order comes from OUR DB, scoped to the signed-in student.
  const order = await prisma.paymentOrder.findFirst({ where: { id: input.orderId, studentId } });
  if (!order) throw new CheckoutError("Order not found.", "ORDER_NOT_FOUND");
  if (PAID_LIKE.includes(order.status)) return { status: "SUCCESS", orderId: order.id };
  if (order.gateway !== PaymentGateway.RAZORPAY || !order.gatewayOrderId)
    return { status: "FAILED", orderId: order.id, message: "This order can't be verified." };

  const fail = async (reason: string) => {
    await prisma.paymentOrder.update({ where: { id: order.id }, data: { failureReason: reason } });
    return { status: "FAILED" as const, orderId: order.id, message: "Payment verification failed. If money was deducted, it will be reconciled automatically." };
  };

  if (input.razorpayOrderId !== order.gatewayOrderId) return fail("VERIFY_ORDER_MISMATCH");
  if (!/^pay_[A-Za-z0-9]{6,40}$/.test(input.razorpayPaymentId)) return fail("VERIFY_BAD_PAYMENT_ID");

  const creds = await getRazorpayCredentials(order.environment);
  if (!creds) return { status: "PROCESSING", orderId: order.id };
  // Signature is computed over OUR stored gateway order id — never the browser's.
  if (!checkoutSignatureIsValid(creds.keySecret, order.gatewayOrderId, input.razorpayPaymentId, input.razorpaySignature))
    return fail("VERIFY_SIGNATURE_INVALID");

  // Signature proves authorization; confirm capture with a trusted API read.
  let payment: RzpPayment;
  try {
    payment = await fetchRazorpayPayment(order.environment, input.razorpayPaymentId);
    payment = await ensureCaptured(order.environment, payment, order.amountPaise, order.currency);
  } catch {
    await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: OrderStatus.PAYMENT_PENDING } });
    return { status: "PROCESSING", orderId: order.id };
  }
  const outcome = await recordTrustedPayment(order.id, payment, PaymentVerifiedVia.CHECKOUT_SIGNATURE);
  if (outcome === "PAID" || outcome === "ALREADY_PAID") return { status: "SUCCESS", orderId: order.id };
  if (outcome === "MISMATCH") return fail("VERIFY_PAYMENT_MISMATCH");
  return payment.status === "failed"
    ? { status: "FAILED", orderId: order.id, message: "The payment failed. You can try again." }
    : { status: "PROCESSING", orderId: order.id };
}

// ---------------------------------------------------------------------------
// Reconciliation (browser closed / missed callback / admin repair)
// ---------------------------------------------------------------------------

/**
 * Pulls the order's payments from Razorpay (trusted) and fulfils any that
 * were captured. Never fabricates success: without a captured payment from
 * the API nothing is granted.
 */
export async function reconcileOrder(orderId: string): Promise<{ outcome: FulfilOutcome | "NO_PAYMENT" | "SKIPPED" | "GATEWAY_ERROR" }> {
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order || order.gateway !== PaymentGateway.RAZORPAY || !order.gatewayOrderId) return { outcome: "SKIPPED" };
  let payments: RzpPayment[];
  try {
    payments = await fetchRazorpayOrderPayments(order.environment, order.gatewayOrderId);
  } catch {
    return { outcome: "GATEWAY_ERROR" };
  }
  if (payments.length === 0) return { outcome: "NO_PAYMENT" };
  const best =
    payments.find((p) => p.status === "captured" || p.status === "refunded") ??
    payments.find((p) => p.status === "authorized") ??
    payments[0];
  let p = best;
  try {
    p = await ensureCaptured(order.environment, best, order.amountPaise, order.currency);
  } catch {
    return { outcome: "GATEWAY_ERROR" };
  }
  // Record the other attempts too (failed tries) for history.
  for (const other of payments) if (other.id !== p.id) await recordTrustedPayment(order.id, other, PaymentVerifiedVia.RECONCILIATION);
  return { outcome: await recordTrustedPayment(order.id, p, PaymentVerifiedVia.RECONCILIATION) };
}

/** Student-facing status poll; reconciles the student's OWN pending order at most once per call. */
export async function getOrderStatusForStudent(studentId: string, orderId: string) {
  const order = await prisma.paymentOrder.findFirst({ where: { id: orderId, studentId } });
  if (!order) return null;
  if ((order.status === OrderStatus.GATEWAY_ORDER_CREATED || order.status === OrderStatus.PAYMENT_PENDING) && order.gatewayOrderId) {
    await reconcileOrder(order.id);
  }
  const fresh = await prisma.paymentOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: { id: true, orderNumber: true, status: true, amountPaise: true, failureReason: true, product: { select: { code: true, name: true } } },
  });
  return fresh;
}

/** Marks stale open orders EXPIRED and releases their coupon reservations. */
export async function expireStaleOrders(now: Date = new Date()): Promise<number> {
  const stale = await prisma.paymentOrder.findMany({
    where: { status: { in: OPEN_STATUSES }, expiresAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
    select: { id: true },
    take: 200,
  });
  for (const { id } of stale) {
    await prisma.$transaction([
      prisma.paymentOrder.updateMany({ where: { id, status: { in: OPEN_STATUSES } }, data: { status: OrderStatus.EXPIRED, openKey: null } }),
      prisma.couponRedemption.updateMany({ where: { orderId: id, status: CouponRedemptionStatus.RESERVED }, data: { status: CouponRedemptionStatus.RELEASED } }),
    ]);
  }
  return stale.length;
}

/**
 * Admin repair for a PAID order whose entitlement or invoice is missing.
 * Only acts when a CAPTURED (or later-refunded) payment row already exists —
 * it never fabricates a payment. Idempotent (UNIQUE orderId on both).
 */
export async function ensureFulfilment(orderId: string): Promise<"REPAIRED" | "NOTHING_TO_DO" | "NO_CAPTURED_PAYMENT"> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PaymentOrder" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.paymentOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { entitlement: true, invoice: true, payments: true },
    });
    if (!PAID_LIKE.includes(order.status)) return "NOTHING_TO_DO";
    const policy = await getPaymentPolicy();
    if (order.gateway === PaymentGateway.INTERNAL) {
      if (order.entitlement) return "NOTHING_TO_DO";
      await grantEntitlementTx(tx, order.id, EntitlementSource.COUPON, new Date());
      return "REPAIRED";
    }
    const captured = order.payments.find((p) => PAYMENT_RANK[p.status] >= PAYMENT_RANK.CAPTURED);
    if (!captured) return "NO_CAPTURED_PAYMENT";
    let repaired = false;
    if (!order.entitlement) {
      await grantEntitlementTx(tx, order.id, EntitlementSource.PURCHASE, new Date());
      repaired = true;
    }
    if (!order.invoice && (order.amountPaise > 0 || policy.invoiceZeroValueOrders)) {
      await issueInvoiceTx(tx, order.id, {
        gatewayPaymentId: captured.gatewayPaymentId,
        method: captured.method,
        paidAt: captured.capturedAt ?? order.paidAt ?? new Date(),
      });
      repaired = true;
    }
    return repaired ? "REPAIRED" : "NOTHING_TO_DO";
  });
}
