import "server-only";
import crypto from "node:crypto";
import { PaymentVerifiedVia, Prisma, WebhookEventStatus, type PaymentEnvironment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRazorpayWebhookSecrets } from "@/lib/razorpay-config";
import { webhookSignatureIsValid, captureRazorpayPayment, fetchRazorpayPayment, type RzpPayment, type RzpRefund } from "@/lib/payments/razorpay";
import { recordTrustedPayment } from "@/lib/payments/orders";
import { applyGatewayRefund } from "@/lib/payments/refunds";

/**
 * Razorpay webhook processing.
 *
 *  - Signature: HMAC_SHA256(raw body, webhook secret), checked against every
 *    configured environment's secret; the one that matches tells us the
 *    environment. Unsigned/invalid deliveries are rejected before any DB write.
 *  - Idempotency: PaymentWebhookEvent.eventId (x-razorpay-event-id) is
 *    UNIQUE. A redelivery of an already-PROCESSED/IGNORED event is a no-op;
 *    a FAILED one is retried. Fulfilment itself is idempotent too
 *    (recordTrustedPayment), so even a racing duplicate can't double-grant.
 *  - Only a safe summary (ids, status, amount) is stored — never the payload.
 */

export type WebhookResult = { httpStatus: number; body: { ok: boolean; status?: string } };

interface WebhookPayload {
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: RzpPayment };
    order?: { entity?: { id?: string } };
    refund?: { entity?: RzpRefund };
  };
}

export async function handleRazorpayWebhook(rawBody: string, signature: string | null, eventIdHeader: string | null): Promise<WebhookResult> {
  if (!signature) return { httpStatus: 400, body: { ok: false } };
  const secrets = await getRazorpayWebhookSecrets();
  const match = secrets.find((s) => webhookSignatureIsValid(s.secret, rawBody, signature));
  if (!match) return { httpStatus: 400, body: { ok: false } };
  const environment: PaymentEnvironment = match.environment;

  let data: WebhookPayload;
  try {
    data = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return { httpStatus: 400, body: { ok: false } };
  }
  const eventType = String(data.event ?? "unknown").slice(0, 64);
  // Razorpay sends x-razorpay-event-id; fall back to a body hash so a
  // missing header still dedups identical redeliveries.
  const eventId = (eventIdHeader && /^[A-Za-z0-9_-]{6,64}$/.test(eventIdHeader) ? eventIdHeader : null) ??
    "sha256:" + crypto.createHash("sha256").update(rawBody).digest("hex");

  const payment = data.payload?.payment?.entity;
  const refund = data.payload?.refund?.entity;
  const gatewayOrderId = payment?.order_id ?? data.payload?.order?.entity?.id ?? null;
  const summary = {
    paymentId: payment?.id ?? refund?.payment_id ?? null,
    orderId: gatewayOrderId,
    refundId: refund?.id ?? null,
    status: payment?.status ?? refund?.status ?? null,
    amount: payment?.amount ?? refund?.amount ?? null,
  };

  // Fast path for redeliveries (the UNIQUE insert below still settles races).
  const seen = await prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
  if (seen && seen.status !== WebhookEventStatus.FAILED && seen.status !== WebhookEventStatus.RECEIVED) {
    return { httpStatus: 200, body: { ok: true, status: "duplicate" } };
  }

  let event = seen;
  if (!event) {
    try {
      event = await prisma.paymentWebhookEvent.create({
        data: { eventId, eventType, environment, summary, status: WebhookEventStatus.RECEIVED },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      const prior = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { eventId } });
      if (prior.status !== WebhookEventStatus.FAILED && prior.status !== WebhookEventStatus.RECEIVED) {
        return { httpStatus: 200, body: { ok: true, status: "duplicate" } };
      }
      event = prior;
    }
  }
  const eventRowId = event.id;

  const finish = (status: WebhookEventStatus, extra: { orderId?: string | null; paymentId?: string | null; errorCategory?: string | null } = {}) =>
    prisma.paymentWebhookEvent.update({
      where: { id: eventRowId },
      data: { status, processedAt: new Date(), ...extra },
    });

  try {
    if ((eventType === "payment.captured" || eventType === "payment.authorized" || eventType === "payment.failed" || eventType === "order.paid") && payment) {
      const order = await prisma.paymentOrder.findUnique({ where: { gatewayOrderId: payment.order_id } });
      if (!order || order.environment !== environment) {
        await finish(WebhookEventStatus.IGNORED, { errorCategory: "ORPHAN_GATEWAY_ORDER" });
        return { httpStatus: 200, body: { ok: true, status: "ignored" } };
      }
      let p = payment;
      if (p.status === "authorized") {
        try {
          p = await captureRazorpayPayment(environment, p.id, order.amountPaise, order.currency);
        } catch {
          p = await fetchRazorpayPayment(environment, p.id).catch(() => payment);
        }
      }
      const outcome = await recordTrustedPayment(order.id, p, PaymentVerifiedVia.WEBHOOK);
      await finish(outcome === "MISMATCH" ? WebhookEventStatus.FAILED : WebhookEventStatus.PROCESSED, {
        orderId: order.id,
        paymentId: p.id,
        errorCategory: outcome === "MISMATCH" ? "PAYMENT_ORDER_MISMATCH" : null,
      });
      return { httpStatus: 200, body: { ok: true, status: outcome } };
    }

    if ((eventType === "refund.created" || eventType === "refund.processed" || eventType === "refund.failed") && refund) {
      const r = await applyGatewayRefund(environment, refund);
      await finish(r ? WebhookEventStatus.PROCESSED : WebhookEventStatus.IGNORED, {
        orderId: r?.orderId ?? null,
        paymentId: refund.payment_id,
        errorCategory: r ? null : "UNKNOWN_PAYMENT",
      });
      return { httpStatus: 200, body: { ok: true } };
    }

    await finish(WebhookEventStatus.IGNORED, { errorCategory: "UNHANDLED_EVENT" });
    return { httpStatus: 200, body: { ok: true, status: "ignored" } };
  } catch (e) {
    const category = e instanceof Prisma.PrismaClientKnownRequestError ? `DB_${e.code}` : e instanceof Error ? e.name.slice(0, 40) : "UNKNOWN";
    await finish(WebhookEventStatus.FAILED, { errorCategory: category }).catch(() => undefined);
    // 500 → Razorpay retries later; the FAILED row is reprocessed on redelivery.
    return { httpStatus: 500, body: { ok: false } };
  }
}
