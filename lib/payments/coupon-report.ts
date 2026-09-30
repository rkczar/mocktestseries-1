import "server-only";
import { OrderStatus, RefundStatus, type Coupon, type PaymentEnvironment, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";

/**
 * Creator / collaborator coupon reporting. Every number comes from
 * SUCCESSFUL orders only (PAID, or PAID and later refunded) — typing a code at
 * checkout, abandoned or failed orders never count as sales. Amounts per order:
 *
 *   Gross product value  = price before the coupon (selling price − any sale)
 *   − Student discount   = the coupon discount frozen on the order
 *   = Amount collected   = PaymentOrder.amountPaise (what Razorpay captured)
 *   − Refunded           = PROCESSED refunds on that order
 *   = Eligible net collected
 *
 * Commission is calculated for reporting only (never paid automatically):
 *   PERCENTAGE   → floor(eligible net × rate)
 *   FIXED_AMOUNT → the fixed amount per order with eligible net > 0, capped
 *                  at that order's eligible net
 * A fully refunded order (or a ₹0 free-access order) therefore earns nothing.
 * Environment is always explicit (default LIVE) so TEST purchases never mix
 * into creator settlements.
 */

const SUCCESSFUL: OrderStatus[] = [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED];

export interface CouponReportFilters {
  environment: PaymentEnvironment;
  from: Date | null;
  to: Date | null;
  couponId: string | null;
  /** Case-insensitive match on the coupon's creator (referrerName) or campaign. */
  creator: string | null;
}

type CommissionRule = Pick<Coupon, "commissionType" | "commissionValue">;

export function describeCommission(c: CommissionRule): string {
  if (!c.commissionType || !c.commissionValue) return "None";
  if (c.commissionType === "PERCENTAGE") return `${(c.commissionValue / 100).toString()}% of eligible net collected`;
  return `${formatInr(c.commissionValue)} per eligible sale`;
}

export function commissionFor(c: CommissionRule, eligibleNetPaise: number): number {
  if (!c.commissionType || !c.commissionValue || eligibleNetPaise <= 0) return 0;
  if (c.commissionType === "PERCENTAGE") return Math.floor((eligibleNetPaise * c.commissionValue) / 10_000);
  return Math.min(c.commissionValue, eligibleNetPaise);
}

/** "MTS-000123" → "MTS-…0123": enough to debug attribution, not a contact detail. */
export function maskStudentRef(studentId: string): string {
  return studentId.length > 6 ? `${studentId.slice(0, 4)}…${studentId.slice(-4)}` : "…";
}

export interface SettlementRow {
  couponId: string;
  couponCode: string;
  creator: string;
  campaign: string;
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  purchasedAt: Date;
  productName: string;
  studentKey: string;
  studentRef: string;
  grossPaise: number;
  discountPaise: number;
  collectedPaise: number;
  refundedPaise: number;
  eligibleNetPaise: number;
  commissionRule: string;
  commissionPaise: number;
}

export async function getCouponSettlementRows(f: CouponReportFilters): Promise<SettlementRow[]> {
  const creator = f.creator?.trim() || null;
  const where: Prisma.PaymentOrderWhereInput = {
    environment: f.environment,
    status: { in: SUCCESSFUL },
    couponId: f.couponId ? f.couponId : { not: null },
    ...(f.from || f.to ? { paidAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(creator
      ? {
          coupon: {
            OR: [{ referrerName: { contains: creator, mode: "insensitive" as const } }, { campaign: { contains: creator, mode: "insensitive" as const } }],
          },
        }
      : {}),
  };
  const orders = await prisma.paymentOrder.findMany({
    where,
    orderBy: { paidAt: "asc" },
    take: 20_000,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paidAt: true,
      createdAt: true,
      studentId: true,
      sellingPricePaise: true,
      saleDiscountPaise: true,
      couponDiscountPaise: true,
      amountPaise: true,
      student: { select: { studentId: true } },
      product: { select: { name: true } },
      coupon: { select: { id: true, code: true, referrerName: true, campaign: true, commissionType: true, commissionValue: true } },
      refunds: { where: { status: RefundStatus.PROCESSED }, select: { amountPaise: true } },
    },
  });
  return orders
    .filter((o) => o.coupon)
    .map((o) => {
      const c = o.coupon!;
      const refunded = Math.min(o.amountPaise, o.refunds.reduce((s, r) => s + r.amountPaise, 0));
      const eligible = Math.max(0, o.amountPaise - refunded);
      return {
        couponId: c.id,
        couponCode: c.code,
        creator: c.referrerName ?? "",
        campaign: c.campaign ?? "",
        orderId: o.id,
        orderNumber: o.orderNumber,
        orderStatus: o.status,
        purchasedAt: o.paidAt ?? o.createdAt,
        productName: o.product.name,
        studentKey: o.studentId,
        studentRef: maskStudentRef(o.student.studentId),
        grossPaise: o.sellingPricePaise - o.saleDiscountPaise,
        discountPaise: o.couponDiscountPaise,
        collectedPaise: o.amountPaise,
        refundedPaise: refunded,
        eligibleNetPaise: eligible,
        commissionRule: describeCommission(c),
        commissionPaise: commissionFor(c, eligible),
      };
    });
}

export interface CouponPerformance {
  successfulOrders: number;
  uniqueStudents: number;
  freeAccessOrders: number;
  refundedOrders: number;
  grossPaise: number;
  discountPaise: number;
  collectedPaise: number;
  refundedPaise: number;
  eligibleNetPaise: number;
  commissionPaise: number;
}

export function summarizeSettlement(rows: SettlementRow[]): CouponPerformance {
  const students = new Set<string>();
  const out: CouponPerformance = {
    successfulOrders: 0,
    uniqueStudents: 0,
    freeAccessOrders: 0,
    refundedOrders: 0,
    grossPaise: 0,
    discountPaise: 0,
    collectedPaise: 0,
    refundedPaise: 0,
    eligibleNetPaise: 0,
    commissionPaise: 0,
  };
  for (const r of rows) {
    out.successfulOrders++;
    students.add(r.studentKey);
    if (r.collectedPaise === 0) out.freeAccessOrders++;
    if (r.refundedPaise > 0) out.refundedOrders++;
    out.grossPaise += r.grossPaise;
    out.discountPaise += r.discountPaise;
    out.collectedPaise += r.collectedPaise;
    out.refundedPaise += r.refundedPaise;
    out.eligibleNetPaise += r.eligibleNetPaise;
    out.commissionPaise += r.commissionPaise;
  }
  out.uniqueStudents = students.size;
  return out;
}

/** Per-coupon performance for the given filters (coupons with no sales get an all-zero row). */
export async function getCouponPerformance(f: CouponReportFilters, couponIds: string[]): Promise<Map<string, CouponPerformance>> {
  const rows = await getCouponSettlementRows(f);
  const byCoupon = new Map<string, SettlementRow[]>();
  for (const r of rows) byCoupon.set(r.couponId, [...(byCoupon.get(r.couponId) ?? []), r]);
  return new Map(couponIds.map((id) => [id, summarizeSettlement(byCoupon.get(id) ?? [])]));
}

const csvCell = (v: string | number) => {
  const s = String(v);
  // Quote everything; neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};
const rupees = (p: number) => (p / 100).toFixed(2);

export function settlementCsv(rows: SettlementRow[]): string {
  const header = [
    "Creator",
    "Campaign",
    "Coupon",
    "Order reference",
    "Order status",
    "Purchase date (IST)",
    "Product",
    "Student (masked)",
    "Gross value (INR)",
    "Discount (INR)",
    "Collected (INR)",
    "Refunded (INR)",
    "Eligible net (INR)",
    "Commission rule",
    "Calculated commission (INR)",
  ];
  const lines = rows.map((r) =>
    [
      r.creator,
      r.campaign,
      r.couponCode,
      r.orderNumber,
      r.orderStatus,
      new Date(r.purchasedAt.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16).replace("T", " "),
      r.productName,
      r.studentRef,
      rupees(r.grossPaise),
      rupees(r.discountPaise),
      rupees(r.collectedPaise),
      rupees(r.refundedPaise),
      rupees(r.eligibleNetPaise),
      r.commissionRule,
      rupees(r.commissionPaise),
    ]
      .map(csvCell)
      .join(",")
  );
  return [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}
