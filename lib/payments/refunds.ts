import "server-only";
import {
  EntitlementStatus,
  OrderStatus,
  PaymentStatus,
  RefundAccessPolicy,
  RefundStatus,
  type PaymentEnvironment,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createRazorpayRefund, RazorpayApiError, type RzpRefund } from "@/lib/payments/razorpay";

/**
 * Refunds. A click never "is" a refund: the row starts REQUESTED, moves to
 * PROCESSING when Razorpay accepts it, and only reaches PROCESSED/FAILED from
 * Razorpay's own status (API response or refund.* webhook). Access changes
 * happen only once a FULL refund is PROCESSED, and only per the explicit
 * accessPolicy chosen when the refund was requested (default: RETAIN).
 */

export class RefundError extends Error {}

function mapRefundStatus(s: RzpRefund["status"]): RefundStatus {
  return s === "processed" ? RefundStatus.PROCESSED : s === "failed" ? RefundStatus.FAILED : RefundStatus.PROCESSING;
}

export async function requestRefund(input: {
  paymentId: string;
  amountPaise: number;
  reason: string;
  accessPolicy: RefundAccessPolicy;
  retainUntil: Date | null;
  adminId: string | undefined;
}) {
  const payment = await prisma.payment.findUnique({ where: { id: input.paymentId }, include: { refunds: true } });
  if (!payment) throw new RefundError("Payment not found.");
  if (payment.status !== PaymentStatus.CAPTURED && payment.status !== PaymentStatus.PARTIALLY_REFUNDED)
    throw new RefundError("Only captured payments can be refunded.");
  const inFlight = payment.refunds
    .filter((r) => r.status !== RefundStatus.FAILED)
    .reduce((sum, r) => sum + r.amountPaise, 0);
  const refundable = payment.amountPaise - Math.max(inFlight, payment.refundedPaise);
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100 || input.amountPaise > refundable)
    throw new RefundError(`Refund amount must be between ₹1 and the refundable balance.`);
  if (input.accessPolicy === RefundAccessPolicy.RETAIN_UNTIL_DATE && !input.retainUntil)
    throw new RefundError("Choose the date access should be retained until.");

  const refund = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      orderId: payment.orderId,
      amountPaise: input.amountPaise,
      status: RefundStatus.REQUESTED,
      reason: input.reason.slice(0, 500),
      accessPolicy: input.accessPolicy,
      retainUntil: input.retainUntil,
      requestedByAdminId: input.adminId,
    },
  });

  try {
    const r = await createRazorpayRefund(payment.environment, payment.gatewayPaymentId, {
      amountPaise: input.amountPaise,
      notes: { refundRef: refund.id },
      receipt: refund.id,
    });
    await prisma.refund.update({ where: { id: refund.id }, data: { gatewayRefundId: r.id, status: RefundStatus.PROCESSING } });
    await applyGatewayRefund(payment.environment, r);
  } catch (e) {
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: RefundStatus.FAILED, failureReason: e instanceof RazorpayApiError ? `GATEWAY_${e.category}` : "UNKNOWN" },
    });
    throw new RefundError("Razorpay did not accept the refund request. Nothing was refunded.");
  }
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/**
 * Applies a trusted Razorpay refund entity (API response or signed webhook).
 * Creates the Refund row if it was initiated from the Razorpay dashboard.
 * Returns null if the payment isn't ours.
 */
export async function applyGatewayRefund(environment: PaymentEnvironment, r: RzpRefund) {
  const payment = await prisma.payment.findUnique({ where: { gatewayPaymentId: r.payment_id } });
  if (!payment || payment.environment !== environment) return null;
  const status = mapRefundStatus(r.status);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`;
    let refund = await tx.refund.findUnique({ where: { gatewayRefundId: r.id } });
    if (!refund) {
      refund = await tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: payment.orderId,
          gatewayRefundId: r.id,
          amountPaise: r.amount,
          status,
          reason: "Initiated outside the admin panel",
          accessPolicy: RefundAccessPolicy.RETAIN,
        },
      });
    } else if (refund.status !== RefundStatus.PROCESSED && refund.status !== status) {
      refund = await tx.refund.update({ where: { id: refund.id }, data: { status } });
    }
    if (status === RefundStatus.PROCESSED && !refund.processedAt) {
      refund = await tx.refund.update({ where: { id: refund.id }, data: { processedAt: new Date() } });
    }

    // Recompute refunded total from PROCESSED refunds (idempotent).
    const processed = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: RefundStatus.PROCESSED },
      _sum: { amountPaise: true },
    });
    const refundedPaise = Math.min(payment.amountPaise, processed._sum.amountPaise ?? 0);
    const full = refundedPaise >= payment.amountPaise;
    if (refundedPaise > 0) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { refundedPaise, status: full ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED },
      });
      await tx.paymentOrder.update({
        where: { id: payment.orderId },
        data: { status: full ? OrderStatus.REFUNDED : OrderStatus.PARTIALLY_REFUNDED },
      });
    }

    if (full && refund.status === RefundStatus.PROCESSED) {
      const ent = await tx.studentEntitlement.findUnique({ where: { orderId: payment.orderId } });
      if (ent && ent.status === EntitlementStatus.ACTIVE) {
        if (refund.accessPolicy === RefundAccessPolicy.REVOKE_IMMEDIATELY) {
          await tx.studentEntitlement.update({
            where: { id: ent.id },
            data: { status: EntitlementStatus.REVOKED, revokedAt: new Date(), revokeReason: "Payment fully refunded" },
          });
        } else if (refund.accessPolicy === RefundAccessPolicy.RETAIN_UNTIL_DATE && refund.retainUntil) {
          const until = ent.expiresAt && ent.expiresAt < refund.retainUntil ? ent.expiresAt : refund.retainUntil;
          await tx.studentEntitlement.update({ where: { id: ent.id }, data: { expiresAt: until } });
        }
      }
    }
    return refund;
  });
}
