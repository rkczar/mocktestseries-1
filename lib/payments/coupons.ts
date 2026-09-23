import "server-only";
import { CouponRedemptionStatus, OrderStatus, type Coupon, type Prisma, type Product } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeCouponDiscount } from "@/lib/payments/pricing";

/**
 * Server-side coupon validation. The browser sends only a code; everything
 * else (applicability, limits, discount value) is read from the DB here.
 *
 * Usage limits count CONSUMED redemptions plus still-live RESERVED ones
 * (a reservation is taken when a paid order is created and lives until that
 * order expires). Order creation calls evaluateCoupon inside a transaction
 * after `lockCoupon` (SELECT ... FOR UPDATE on the coupon row), so two
 * concurrent checkouts on any PM2 worker can never both take the last use.
 */

export const COUPON_CODE_RE = /^[A-Z0-9_-]{3,32}$/;

export function normalizeCouponCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return COUPON_CODE_RE.test(code) ? code : null;
}

export type CouponRejection =
  | "INVALID"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "PRODUCT_MISMATCH"
  | "MIN_ORDER"
  | "EXHAUSTED"
  | "STUDENT_LIMIT"
  | "NOT_NEW_STUDENT"
  | "NOT_NEEDED";

export const COUPON_REJECTION_MESSAGES: Record<CouponRejection, string> = {
  INVALID: "This coupon code is not valid.",
  INACTIVE: "This coupon is no longer active.",
  NOT_STARTED: "This coupon is not active yet.",
  EXPIRED: "This coupon has expired.",
  PRODUCT_MISMATCH: "This coupon can't be used for this product.",
  MIN_ORDER: "Your order doesn't meet this coupon's minimum amount.",
  EXHAUSTED: "This coupon has reached its usage limit.",
  STUDENT_LIMIT: "You've already used this coupon the maximum number of times.",
  NOT_NEW_STUDENT: "This coupon is only for first-time purchases.",
  NOT_NEEDED: "This product is already free — no coupon needed.",
};

export type CouponEvaluation =
  | { ok: true; coupon: Coupon; discountPaise: number }
  | { ok: false; reason: CouponRejection };

type Db = Prisma.TransactionClient | typeof prisma;

export async function lockCoupon(tx: Prisma.TransactionClient, couponId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Coupon" WHERE id = ${couponId} FOR UPDATE`;
}

function liveUsageWhere(now: Date, excludeOrderId?: string): Prisma.CouponRedemptionWhereInput {
  return {
    OR: [
      { status: CouponRedemptionStatus.CONSUMED },
      { status: CouponRedemptionStatus.RESERVED, reservedUntil: { gt: now } },
    ],
    ...(excludeOrderId ? { orderId: { not: excludeOrderId } } : {}),
  };
}

export async function evaluateCoupon(
  db: Db,
  input: {
    code: string;
    studentId: string;
    product: Pick<Product, "id" | "examId" | "testSeriesId">;
    pricePaise: number;
    now: Date;
    excludeOrderId?: string;
  }
): Promise<CouponEvaluation> {
  const coupon = await db.coupon.findUnique({ where: { code: input.code } });
  if (!coupon) return { ok: false, reason: "INVALID" };
  if (!coupon.isActive) return { ok: false, reason: "INACTIVE" };
  if (coupon.validFrom && input.now < coupon.validFrom) return { ok: false, reason: "NOT_STARTED" };
  if (coupon.validUntil && input.now >= coupon.validUntil) return { ok: false, reason: "EXPIRED" };
  if (input.pricePaise <= 0) return { ok: false, reason: "NOT_NEEDED" };

  if (coupon.productIds.length > 0 && !coupon.productIds.includes(input.product.id)) return { ok: false, reason: "PRODUCT_MISMATCH" };
  if (coupon.examIds.length > 0 && (!input.product.examId || !coupon.examIds.includes(input.product.examId)))
    return { ok: false, reason: "PRODUCT_MISMATCH" };
  if (coupon.testSeriesIds.length > 0 && (!input.product.testSeriesId || !coupon.testSeriesIds.includes(input.product.testSeriesId)))
    return { ok: false, reason: "PRODUCT_MISMATCH" };
  if (coupon.minOrderPaise != null && input.pricePaise < coupon.minOrderPaise) return { ok: false, reason: "MIN_ORDER" };

  if (coupon.totalUsageLimit != null) {
    const used = await db.couponRedemption.count({ where: { couponId: coupon.id, ...liveUsageWhere(input.now, input.excludeOrderId) } });
    if (used >= coupon.totalUsageLimit) return { ok: false, reason: "EXHAUSTED" };
  }
  if (coupon.perStudentLimit != null) {
    const mine = await db.couponRedemption.count({
      where: { couponId: coupon.id, studentId: input.studentId, ...liveUsageWhere(input.now, input.excludeOrderId) },
    });
    if (mine >= coupon.perStudentLimit) return { ok: false, reason: "STUDENT_LIMIT" };
  }
  if (coupon.newStudentOnly) {
    const prior = await db.paymentOrder.count({
      where: {
        studentId: input.studentId,
        status: { in: [OrderStatus.PAID, OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED] },
        ...(input.excludeOrderId ? { id: { not: input.excludeOrderId } } : {}),
      },
    });
    if (prior > 0) return { ok: false, reason: "NOT_NEW_STUDENT" };
  }

  return { ok: true, coupon, discountPaise: computeCouponDiscount(coupon, input.pricePaise) };
}
