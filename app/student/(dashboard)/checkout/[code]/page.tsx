import { notFound } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { getCheckoutQuote } from "@/lib/payments/orders";
import { productHref } from "@/lib/payments/product-links";
import { BackButton } from "@/components/student/back-button";
import { CheckoutClient } from "./checkout-client";

export const metadata = { title: "Checkout — Mock Test Series.in" };
export const dynamic = "force-dynamic";

/**
 * Server-priced checkout. Everything displayed here (MRP, sale, final
 * price, access state) is computed server-side by getCheckoutQuote; the
 * client component only sends the product id + a coupon code back.
 */
export default async function CheckoutPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const student = await requireStudent();
  const quote = await getCheckoutQuote(student.id, decodeURIComponent(code).slice(0, 64));
  if (!quote) notFound();

  const [product, profile] = await Promise.all([
    prisma.product.findUniqueOrThrow({ where: { id: quote.product.id }, select: { productType: true, examId: true } }),
    prisma.student.findUnique({ where: { id: student.id }, select: { name: true, email: true, mobile: true } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/plans" />
      <CheckoutClient
        product={quote.product}
        price={{
          isFree: quote.price.isFree,
          mrpPaise: quote.price.mrpPaise,
          pricePaise: quote.price.pricePaise,
          discountPercent: quote.price.discountPercent,
          savingsPaise: quote.price.savingsPaise,
          saleEndsAt: quote.price.saleEndsAt ? quote.price.saleEndsAt.toISOString() : null,
        }}
        access={{
          status: quote.access.status,
          mode: quote.access.mode,
          purchasesPaused: quote.access.purchasesPaused,
          expiresAt: quote.access.expiresAt ? quote.access.expiresAt.toISOString() : null,
        }}
        gatewayReady={quote.gatewayReady}
        environment={quote.environment}
        openHref={productHref(product)}
        prefill={{ name: profile?.name ?? "", email: profile?.email ?? "", contact: profile?.mobile ?? "" }}
      />
    </div>
  );
}
