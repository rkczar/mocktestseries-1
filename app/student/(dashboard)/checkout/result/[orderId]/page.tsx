import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
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
  const student = await requireStudent();
  const order = await prisma.paymentOrder.findFirst({
    where: { id: orderId, studentId: student.id },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      amountPaise: true,
      couponCode: true,
      environment: true,
      product: { select: { code: true, name: true, productType: true, examId: true } },
      entitlement: { select: { expiresAt: true } },
      invoice: { select: { id: true } },
    },
  });
  if (!order) notFound();

  return (
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
        hasEntitlement: Boolean(order.entitlement),
        invoiceId: order.invoice?.id ?? null,
      }}
      verifyFailed={sp.verify === "failed"}
    />
  );
}
