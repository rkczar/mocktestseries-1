import { notFound } from "next/navigation";
import { TrackOnce } from "@/components/analytics/track-once";
import { requireStudentOrLogin } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { productHref } from "@/lib/payments/product-links";
import { OrderResultClient } from "./order-result-client";

export const metadata = { title: "Payment Status — Mock Test Series.in" };
export const dynamic = "force-dynamic";

/** Canonical order status from the DB (student-scoped). The browser's own callback is never trusted for this. */
export default async function OrderResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ verify?: string }>;
}) {
  const [{ orderId }, sp] = await Promise.all([params, searchParams]);
  const student = await requireStudentOrLogin();
  const order = await prisma.paymentOrder.findFirst({
    where: { id: orderId, studentId: student.id },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      amountPaise: true,
      couponCode: true,
      environment: true,
      product: { select: { code: true, name: true, productType: true, examId: true, mockTestId: true, exam: { select: { code: true } } } },
      paidAt: true,
      entitlement: { select: { startsAt: true, expiresAt: true, status: true } },
      payments: { where: { status: { in: ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] } }, select: { gatewayPaymentId: true, method: true }, take: 1 },
      invoice: { select: { id: true } },
    },
  });
  if (!order) notFound();

  // GA4 purchase: once per order, LIVE money only, from the server-confirmed status (never the browser callback).
  const tracked = order.environment === "LIVE" && (order.status === "PAID" || order.status === "PARTIALLY_REFUNDED");
  return (
    <>
      {tracked ? (
        <TrackOnce
          event="purchase"
          onceKey={`purchase:${order.id}`}
          params={{ transaction_id: order.orderNumber, value: order.amountPaise / 100, currency: "INR", item_id: order.product.code, exam_code: order.product.exam?.code ?? null }}
        />
      ) : null}
    <OrderResultClient
      order={{
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        amountPaise: order.amountPaise,
        couponCode: order.couponCode,
        environment: order.environment,
        productName: order.product.name,
        productCode: order.product.code,
        openHref: productHref(order.product),
        expiresAt: order.entitlement?.expiresAt ? order.entitlement.expiresAt.toISOString() : null,
        startsAt: order.entitlement?.startsAt ? order.entitlement.startsAt.toISOString() : null,
        hasEntitlement: order.entitlement?.status === "ACTIVE",
        paidAt: order.paidAt ? order.paidAt.toISOString() : null,
        paymentRef: order.payments[0]?.gatewayPaymentId ?? null,
        paymentMethod: order.payments[0]?.method ?? null,
        invoiceId: order.invoice?.id ?? null,
      }}
      verifyFailed={sp.verify === "failed"}
    />
    </>
  );
}
