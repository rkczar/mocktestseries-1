import "server-only";
import { OrderStatus, PaymentGateway, PaymentStatus, RefundStatus, WebhookEventStatus, type PaymentEnvironment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRazorpayCredentials } from "@/lib/razorpay-config";
import { RazorpayApiError } from "@/lib/payments/razorpay";
import { ensureFulfilment, expireStaleOrders, reconcileOrder } from "@/lib/payments/orders";

/**
 * Read-only mismatch scan for Admin → Payments → Reconciliation. Every row
 * links to an order; the MASTER_ADMIN repair actions (reconcileOrder — a
 * trusted gateway re-read — and ensureFulfilment) are the only writers, and
 * neither ever fabricates a payment. runScheduledReconciliation (below) is
 * the cron safety net that calls the same two repair functions.
 */

export type MismatchKind =
  | "PAID_WITHOUT_CAPTURE"
  | "CAPTURED_WITHOUT_ENTITLEMENT"
  | "CAPTURED_WITHOUT_INVOICE"
  | "CAPTURED_ORDER_NOT_PAID"
  | "REFUND_MISMATCH"
  | "REFUND_STUCK"
  | "STALE_GATEWAY_ORDER"
  | "WEBHOOK_FAILED"
  | "POSSIBLE_DUPLICATE_PURCHASE";

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

  const [paidNoCapture, capturedNoEnt, capturedNoInv, capturedNotPaid, payments, stuckRefunds, staleOrders, failedHooks, recentPaid] = await Promise.all([
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
    prisma.paymentOrder.findMany({
      where: { status: { in: PAID_LIKE }, paidAt: { gte: new Date(Date.now() - 30 * 24 * 3600_000) } },
      select: { id: true, orderNumber: true, environment: true, studentId: true, productId: true, paidAt: true },
      orderBy: { paidAt: "asc" },
      take: 1000,
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
  // Two paid orders for the same student + product within an hour are almost
  // certainly one purchase made twice (e.g. two tabs) — surface for a refund.
  const lastPaid = new Map<string, Date>();
  for (const o of recentPaid) {
    const key = `${o.environment}:${o.studentId}:${o.productId}`;
    const prev = lastPaid.get(key);
    if (prev && o.paidAt && o.paidAt.getTime() - prev.getTime() < 3600_000)
      out.push({ kind: "POSSIBLE_DUPLICATE_PURCHASE", orderId: o.id, orderNumber: o.orderNumber, environment: o.environment, detail: "Same student bought this product twice within an hour — review for a refund.", at: o.paidAt });
    if (o.paidAt) lastPaid.set(key, o.paidAt);
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ---------------------------------------------------------------------------
// Scheduled recovery (cron → scripts/reconcile-payments.ts)
// ---------------------------------------------------------------------------
//
// The signed webhook is the PRIMARY, real-time fulfilment path. This is the
// safety net for a captured payment whose callback AND webhook were both
// missed (browser closed, webhook not delivered), including orders that
// already expired or were retired locally. It only re-reads Razorpay through
// reconcileOrder() and fulfils through recordTrustedPayment()/
// ensureFulfilment(), so every existing UNIQUE/row-lock idempotency rule
// still applies and a repeated run can't duplicate anything. Each order is
// re-read with its OWN environment's credentials (TEST never touches LIVE).

const RECOVERABLE: OrderStatus[] = [OrderStatus.GATEWAY_ORDER_CREATED, OrderStatus.PAYMENT_PENDING, OrderStatus.EXPIRED, OrderStatus.CANCELLED];
/** Leave fresh orders to the checkout callback / webhook first. */
export const RECONCILE_MIN_AGE_MS = 10 * 60_000;
const RECONCILE_LOOKBACK_MS = 7 * 24 * 3600_000;
/** Gateway re-reads per order: 10m, 20m, 40m … capped at 24h, 10 checks max (~2.5 days). */
export const RECONCILE_MAX_CHECKS = 10;
const RECONCILE_BASE_BACKOFF_MS = 10 * 60_000;
const RECONCILE_MAX_BACKOFF_MS = 24 * 3600_000;
const RECONCILE_PER_RUN = 25;

export function reconcileDue(o: { reconcileCheckedAt: Date | null; reconcileChecks: number }, now: Date): boolean {
  if (o.reconcileChecks >= RECONCILE_MAX_CHECKS) return false;
  if (!o.reconcileCheckedAt) return true;
  const wait = Math.min(RECONCILE_MAX_BACKOFF_MS, RECONCILE_BASE_BACKOFF_MS * 2 ** Math.max(0, o.reconcileChecks - 1));
  return now.getTime() - o.reconcileCheckedAt.getTime() >= wait;
}

export interface ScheduledReconcileEntry {
  orderId: string;
  environment: PaymentEnvironment;
  result: string;
  ms: number;
}

export interface ScheduledReconcileReport {
  dryRun: boolean;
  expired: number;
  candidates: number;
  due: number;
  skippedNoCredentials: number;
  entries: ScheduledReconcileEntry[];
}

export async function runScheduledReconciliation(opts: { dryRun?: boolean; now?: Date } = {}): Promise<ScheduledReconcileReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const report: ScheduledReconcileReport = { dryRun, expired: 0, candidates: 0, due: 0, skippedNoCredentials: 0, entries: [] };

  // 1. Release coupon holds on abandoned orders (DB only).
  if (!dryRun) report.expired = await expireStaleOrders(now);

  // 2. Re-read unresolved gateway orders from Razorpay, with backoff.
  const candidates = await prisma.paymentOrder.findMany({
    where: {
      gateway: PaymentGateway.RAZORPAY,
      gatewayOrderId: { not: null },
      status: { in: RECOVERABLE },
      createdAt: { gte: new Date(now.getTime() - RECONCILE_LOOKBACK_MS), lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
      reconcileChecks: { lt: RECONCILE_MAX_CHECKS },
    },
    select: { id: true, environment: true, reconcileCheckedAt: true, reconcileChecks: true },
    orderBy: [{ reconcileCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: 200,
  });
  report.candidates = candidates.length;
  const due = candidates.filter((o) => reconcileDue(o, now)).slice(0, RECONCILE_PER_RUN);
  report.due = due.length;

  const hasCreds = new Map<PaymentEnvironment, boolean>();
  for (const env of new Set(due.map((o) => o.environment))) hasCreds.set(env, Boolean(await getRazorpayCredentials(env)));

  for (const o of due) {
    if (!hasCreds.get(o.environment)) {
      report.skippedNoCredentials++;
      report.entries.push({ orderId: o.id, environment: o.environment, result: "SKIPPED_NO_CREDENTIALS", ms: 0 });
      continue;
    }
    if (dryRun) {
      report.entries.push({ orderId: o.id, environment: o.environment, result: "DUE", ms: 0 });
      continue;
    }
    const t0 = Date.now();
    let result: string;
    try {
      result = (await reconcileOrder(o.id)).outcome;
    } catch (e) {
      result = `ERROR_${e instanceof RazorpayApiError ? e.category : e instanceof Error ? e.name.slice(0, 40) : "UNKNOWN"}`;
    }
    await prisma.paymentOrder.update({
      where: { id: o.id },
      data: { reconcileCheckedAt: new Date(), reconcileChecks: { increment: 1 } },
    });
    report.entries.push({ orderId: o.id, environment: o.environment, result, ms: Date.now() - t0 });
  }

  // 3. PAID orders with a captured payment but a missing entitlement/invoice (DB only).
  const unfulfilled = await prisma.paymentOrder.findMany({
    where: {
      status: OrderStatus.PAID,
      OR: [{ entitlement: null }, { gateway: PaymentGateway.RAZORPAY, amountPaise: { gt: 0 }, invoice: null }],
    },
    select: { id: true, environment: true },
    take: 50,
  });
  for (const o of unfulfilled) {
    if (dryRun) {
      report.entries.push({ orderId: o.id, environment: o.environment, result: "FULFILMENT_DUE", ms: 0 });
      continue;
    }
    const t0 = Date.now();
    let result: string;
    try {
      result = `FULFILMENT_${await ensureFulfilment(o.id)}`;
    } catch (e) {
      result = `ERROR_${e instanceof Error ? e.name.slice(0, 40) : "UNKNOWN"}`;
    }
    report.entries.push({ orderId: o.id, environment: o.environment, result, ms: Date.now() - t0 });
  }
  return report;
}
