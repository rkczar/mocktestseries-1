import "server-only";
import { OrderStatus, PaymentGateway, PaymentStatus, RefundStatus, WebhookEventStatus, type PaymentEnvironment } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Read-only mismatch scan for Admin → Payments → Reconciliation. Every row
 * links to an order; the MASTER_ADMIN repair actions (reconcileOrder — a
 * trusted gateway re-read — and ensureFulfilment) are the only writers, and
 * neither ever fabricates a payment.
 */

export type MismatchKind =
  | "PAID_WITHOUT_CAPTURE"
  | "CAPTURED_WITHOUT_ENTITLEMENT"
  | "CAPTURED_WITHOUT_INVOICE"
  | "CAPTURED_ORDER_NOT_PAID"
  | "REFUND_MISMATCH"
  | "REFUND_STUCK"
  | "STALE_GATEWAY_ORDER"
  | "WEBHOOK_FAILED";

export interface Mismatch {
  kind: MismatchKind;
  orderId: string | null;
  orderNumber: string | null;
  environment: PaymentEnvironment | null;
  detail: string;
  at: Date;
}

const CAPTURED_LIKE: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED];
const PAID_LIKE: OrderStatus[] = [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED];

export async function findPaymentMismatches(): Promise<Mismatch[]> {
  const out: Mismatch[] = [];
  const staleBefore = new Date(Date.now() - 60 * 60_000);

  const [paidNoCapture, capturedNoEnt, capturedNoInv, capturedNotPaid, payments, stuckRefunds, staleOrders, failedHooks] = await Promise.all([
    prisma.paymentOrder.findMany({
      where: { gateway: PaymentGateway.RAZORPAY, status: { in: PAID_LIKE }, payments: { none: { status: { in: CAPTURED_LIKE } } } },
      select: { id: true, orderNumber: true, environment: true, updatedAt: true },
      take: 100,
    }),
    prisma.paymentOrder.findMany({
      where: { status: { in: PAID_LIKE }, entitlement: null },
      select: { id: true, orderNumber: true, environment: true, updatedAt: true },
      take: 100,
    }),
    prisma.paymentOrder.findMany({
      where: { gateway: PaymentGateway.RAZORPAY, status: { in: PAID_LIKE }, amountPaise: { gt: 0 }, invoice: null },
      select: { id: true, orderNumber: true, environment: true, updatedAt: true },
      take: 100,
    }),
    prisma.paymentOrder.findMany({
      where: { status: { notIn: PAID_LIKE }, payments: { some: { status: { in: CAPTURED_LIKE } } } },
      select: { id: true, orderNumber: true, environment: true, updatedAt: true, status: true },
      take: 100,
    }),
    prisma.payment.findMany({
      where: { refunds: { some: {} } },
      select: { id: true, refundedPaise: true, orderId: true, environment: true, updatedAt: true, order: { select: { orderNumber: true } }, refunds: { select: { status: true, amountPaise: true } } },
      take: 500,
    }),
    prisma.refund.findMany({
      where: { status: { in: [RefundStatus.REQUESTED, RefundStatus.PROCESSING] }, createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
      select: { orderId: true, createdAt: true, order: { select: { orderNumber: true, environment: true } } },
      take: 100,
    }),
    prisma.paymentOrder.findMany({
      where: { status: { in: [OrderStatus.GATEWAY_ORDER_CREATED, OrderStatus.PAYMENT_PENDING] }, createdAt: { lt: staleBefore } },
      select: { id: true, orderNumber: true, environment: true, createdAt: true },
      take: 100,
    }),
    prisma.paymentWebhookEvent.findMany({
      where: { status: WebhookEventStatus.FAILED },
      select: { orderId: true, eventType: true, errorCategory: true, receivedAt: true, environment: true },
      orderBy: { receivedAt: "desc" },
      take: 50,
    }),
  ]);

  for (const o of paidNoCapture) out.push({ kind: "PAID_WITHOUT_CAPTURE", orderId: o.id, orderNumber: o.orderNumber, environment: o.environment, detail: "Order marked paid but no captured payment is recorded.", at: o.updatedAt });
  for (const o of capturedNoEnt) out.push({ kind: "CAPTURED_WITHOUT_ENTITLEMENT", orderId: o.id, orderNumber: o.orderNumber, environment: o.environment, detail: "Paid order has no entitlement.", at: o.updatedAt });
  for (const o of capturedNoInv) out.push({ kind: "CAPTURED_WITHOUT_INVOICE", orderId: o.id, orderNumber: o.orderNumber, environment: o.environment, detail: "Paid order has no invoice.", at: o.updatedAt });
  for (const o of capturedNotPaid) out.push({ kind: "CAPTURED_ORDER_NOT_PAID", orderId: o.id, orderNumber: o.orderNumber, environment: o.environment, detail: `Captured payment exists but order is ${o.status}.`, at: o.updatedAt });
  for (const p of payments) {
    const processed = p.refunds.filter((r) => r.status === RefundStatus.PROCESSED).reduce((s, r) => s + r.amountPaise, 0);
    if (processed !== p.refundedPaise)
      out.push({ kind: "REFUND_MISMATCH", orderId: p.orderId, orderNumber: p.order.orderNumber, environment: p.environment, detail: `Processed refunds ${processed} paise vs payment refunded ${p.refundedPaise} paise.`, at: p.updatedAt });
  }
  for (const r of stuckRefunds) out.push({ kind: "REFUND_STUCK", orderId: r.orderId, orderNumber: r.order.orderNumber, environment: r.order.environment, detail: "Refund not settled after 24h.", at: r.createdAt });
  for (const o of staleOrders) out.push({ kind: "STALE_GATEWAY_ORDER", orderId: o.id, orderNumber: o.orderNumber, environment: o.environment, detail: "Gateway order still pending after 1h — re-check with Razorpay.", at: o.createdAt });
  for (const w of failedHooks) out.push({ kind: "WEBHOOK_FAILED", orderId: w.orderId, orderNumber: null, environment: w.environment, detail: `${w.eventType} failed (${w.errorCategory ?? "unknown"}).`, at: w.receivedAt });
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}
