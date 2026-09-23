import "server-only";
import {
  CouponRedemptionStatus,
  EntitlementSource,
  EntitlementStatus,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  type PaymentEnvironment,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Payment Control Center metrics — every number is a live DB aggregate.
 * Environment defaults to LIVE so TEST-mode transactions never contaminate
 * production revenue unless explicitly selected.
 */

export interface PaymentFilters {
  environment: PaymentEnvironment;
  from: Date | null;
  to: Date | null;
  examId: string | null;
  productId: string | null;
  couponId: string | null;
  status: OrderStatus | null;
  student: string | null;
}

const PAID_LIKE: OrderStatus[] = [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED];

export function parsePaymentFilters(sp: Record<string, string | string[] | undefined>): PaymentFilters {
  const one = (k: string) => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim().slice(0, 100) : null;
  };
  const date = (k: string, endOfDay = false) => {
    const s = one(k);
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const status = one("status");
  return {
    environment: one("env") === "TEST" ? "TEST" : "LIVE",
    from: date("from"),
    to: date("to", true),
    examId: one("exam"),
    productId: one("product"),
    couponId: one("coupon"),
    status: status && (Object.values(OrderStatus) as string[]).includes(status) ? (status as OrderStatus) : null,
    student: one("student"),
  };
}

export function orderWhere(f: PaymentFilters): Prisma.PaymentOrderWhereInput {
  return {
    environment: f.environment,
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.productId ? { productId: f.productId } : {}),
    ...(f.examId ? { product: { examId: f.examId } } : {}),
    ...(f.couponId ? { couponId: f.couponId } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.student
      ? {
          student: {
            OR: [
              { studentId: { contains: f.student, mode: "insensitive" as const } },
              { name: { contains: f.student, mode: "insensitive" as const } },
              { email: { contains: f.student, mode: "insensitive" as const } },
              { mobile: { contains: f.student } },
            ],
          },
        }
      : {}),
  };
}

export async function getPaymentOverview(f: PaymentFilters) {
  const where = orderWhere(f);
  const paidWhere: Prisma.PaymentOrderWhereInput = { ...where, status: f.status ?? { in: PAID_LIKE } };
  const now = new Date();
  const [gross, successfulPayments, failedPayments, pending, refunded, activeSubs, expiredSubs, freeGrants, couponRedemptions] = await Promise.all([
    prisma.paymentOrder.aggregate({ where: paidWhere, _sum: { amountPaise: true, couponDiscountPaise: true, saleDiscountPaise: true }, _count: true }),
    prisma.payment.count({ where: { environment: f.environment, status: { in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] }, order: where } }),
    prisma.payment.count({ where: { environment: f.environment, status: PaymentStatus.FAILED, order: where } }),
    prisma.paymentOrder.count({ where: { ...where, status: { in: [OrderStatus.CREATED, OrderStatus.GATEWAY_ORDER_CREATED, OrderStatus.PAYMENT_PENDING] } } }),
    prisma.refund.aggregate({ where: { status: RefundStatus.PROCESSED, order: where }, _sum: { amountPaise: true } }),
    prisma.studentEntitlement.count({
      where: { status: EntitlementStatus.ACTIVE, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
    prisma.studentEntitlement.count({ where: { status: EntitlementStatus.ACTIVE, expiresAt: { lte: now } } }),
    prisma.studentEntitlement.count({
      where: { source: { in: [EntitlementSource.COUPON, EntitlementSource.ADMIN_GRANT, EntitlementSource.FREE, EntitlementSource.PROMOTION] } },
    }),
    prisma.couponRedemption.count({ where: { status: CouponRedemptionStatus.CONSUMED, order: where } }),
  ]);
  const grossPaise = gross._sum.amountPaise ?? 0;
  const refundedPaise = refunded._sum.amountPaise ?? 0;
  return {
    grossPaise,
    paidOrders: gross._count,
    successfulPayments,
    failedPayments,
    pendingOrders: pending,
    refundedPaise,
    netPaise: grossPaise - refundedPaise,
    discountPaise: (gross._sum.couponDiscountPaise ?? 0) + (gross._sum.saleDiscountPaise ?? 0),
    activeSubscriptions: activeSubs,
    expiredSubscriptions: expiredSubs,
    freeAccessGrants: freeGrants,
    couponRedemptions,
    averageOrderPaise: gross._count > 0 ? Math.round(grossPaise / gross._count) : 0,
    failureRate: successfulPayments + failedPayments > 0 ? failedPayments / (successfulPayments + failedPayments) : 0,
  };
}

export async function getRevenueBreakdowns(f: PaymentFilters) {
  const where: Prisma.PaymentOrderWhereInput = { ...orderWhere(f), status: f.status ?? { in: PAID_LIKE } };
  const orders = await prisma.paymentOrder.findMany({
    where,
    select: {
      amountPaise: true,
      couponDiscountPaise: true,
      paidAt: true,
      createdAt: true,
      couponCode: true,
      product: { select: { id: true, name: true, exam: { select: { id: true, name: true } } } },
    },
    take: 20_000,
  });
  const byDate = new Map<string, { paise: number; count: number }>();
  const byExam = new Map<string, { name: string; paise: number; count: number }>();
  const byProduct = new Map<string, { name: string; paise: number; count: number }>();
  const byCoupon = new Map<string, { redemptions: number; revenuePaise: number; discountPaise: number; freeGrants: number }>();
  for (const o of orders) {
    const d = new Date((o.paidAt ?? o.createdAt).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const bd = byDate.get(d) ?? { paise: 0, count: 0 };
    bd.paise += o.amountPaise;
    bd.count++;
    byDate.set(d, bd);
    const ek = o.product.exam?.id ?? "none";
    const be = byExam.get(ek) ?? { name: o.product.exam?.name ?? "No exam", paise: 0, count: 0 };
    be.paise += o.amountPaise;
    be.count++;
    byExam.set(ek, be);
    const bp = byProduct.get(o.product.id) ?? { name: o.product.name, paise: 0, count: 0 };
    bp.paise += o.amountPaise;
    bp.count++;
    byProduct.set(o.product.id, bp);
    if (o.couponCode) {
      const bc = byCoupon.get(o.couponCode) ?? { redemptions: 0, revenuePaise: 0, discountPaise: 0, freeGrants: 0 };
      bc.redemptions++;
      bc.revenuePaise += o.amountPaise;
      bc.discountPaise += o.couponDiscountPaise;
      if (o.amountPaise === 0) bc.freeGrants++;
      byCoupon.set(o.couponCode, bc);
    }
  }
  const sortDesc = <T extends { paise: number }>(m: Map<string, T>) => [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.paise - a.paise);
  return {
    byDate: [...byDate.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    byExam: sortDesc(byExam),
    byProduct: sortDesc(byProduct),
    byCoupon: [...byCoupon.entries()].map(([code, v]) => ({ code, ...v })).sort((a, b) => b.redemptions - a.redemptions),
  };
}

export async function getExpiringEntitlements(days = 7) {
  const now = new Date();
  return prisma.studentEntitlement.findMany({
    where: { status: EntitlementStatus.ACTIVE, expiresAt: { gt: now, lte: new Date(now.getTime() + days * 86_400_000) } },
    include: { student: { select: { id: true, name: true, studentId: true } }, product: { select: { name: true } } },
    orderBy: { expiresAt: "asc" },
    take: 100,
  });
}
