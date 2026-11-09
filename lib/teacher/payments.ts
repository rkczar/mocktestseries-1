import "server-only";
import { prisma } from "@/lib/prisma";
import { parsePaymentFilters, type PaymentFilters } from "@/lib/payments/analytics";
import { ORDER_DETAIL_INCLUDE } from "@/lib/payments/order-detail";
import { TeacherAccessError, type TeacherScope } from "@/lib/teacher/scope";
import type { FilterOptions } from "@/app/admin/(dashboard)/payments/_components/shared";

/**
 * Teacher Portal payments (read-only) — the Admin → Payments calculations,
 * always with `scope = the teacher's ACTIVE exams` and environment LIVE.
 * Filters from the URL are intersected with the scope, never trusted.
 */

/** Filters for a teacher request: exam / product / coupon outside the scope are dropped. */
export async function teacherPaymentFilters(scope: TeacherScope, sp: Record<string, string | string[] | undefined>): Promise<{ filters: PaymentFilters; options: FilterOptions }> {
  const raw = parsePaymentFilters(sp);
  const options = await teacherFilterOptions(scope);
  const filters: PaymentFilters = {
    ...raw,
    environment: "LIVE",
    examId: raw.examId && scope.examIds.includes(raw.examId) ? raw.examId : null,
    productId: raw.productId && options.products.some((p) => p.id === raw.productId) ? raw.productId : null,
    couponId: raw.couponId && options.coupons.some((c) => c.id === raw.couponId) ? raw.couponId : null,
    scope: { examIds: scope.examIds },
  };
  return { filters, options };
}

async function teacherFilterOptions(scope: TeacherScope): Promise<FilterOptions> {
  const [exams, products, couponRows] = await Promise.all([
    prisma.exam.findMany({ where: { id: { in: scope.examIds } }, orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { examId: { in: scope.examIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // Only coupons actually used on this teacher's exams' orders.
    prisma.paymentOrder.findMany({
      where: { environment: "LIVE", couponId: { not: null }, product: { examId: { in: scope.examIds } } },
      distinct: ["couponId"],
      select: { coupon: { select: { id: true, code: true } } },
    }),
  ]);
  const coupons = couponRows.flatMap((r) => (r.coupon ? [r.coupon] : [])).sort((a, b) => a.code.localeCompare(b.code));
  return { exams, products, coupons };
}

/** One order of the teacher's exams (LIVE), with its history; anything else is "not found". */
export async function teacherOrder(scope: TeacherScope, orderId: string) {
  const order = await prisma.paymentOrder.findFirst({
    where: { id: String(orderId), environment: "LIVE", product: { examId: { in: scope.examIds } } },
    include: ORDER_DETAIL_INCLUDE,
  });
  if (!order || scope.examIds.length === 0) throw new TeacherAccessError();
  const hooks = await prisma.paymentWebhookEvent.findMany({
    where: { orderId: order.id },
    orderBy: { receivedAt: "asc" },
    select: { id: true, eventType: true, status: true, receivedAt: true, errorCategory: true },
  });
  return { order, hooks };
}
