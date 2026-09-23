import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { computeProductPrice, describeAccessDuration } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { BackButton } from "@/components/student/back-button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPaymentsAccess } from "../../_components/access";
import { ProductForm } from "../../_components/product-form";

export const metadata = { title: "Product — Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { canView, canManage } = await getPaymentsAccess();
  if (!canView) return <RestrictedCard title="Payments" />;
  const { id } = await params;
  const product = id === "new" ? null : await prisma.product.findUnique({ where: { id } });
  if (id !== "new" && !product) notFound();
  if (!product && !canManage) return <RestrictedCard title="New product" />;
  const price = product ? computeProductPrice(product) : null;

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/admin/payments?tab=products" />
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {product ? product.name : "New product"} {!canManage ? <Badge>View only</Badge> : null}
          </CardTitle>
          {price && product ? (
            <CardDescription>
              Students see: {price.isFree ? "Free" : formatInr(price.pricePaise)}
              {price.mrpPaise > price.pricePaise && !price.isFree ? ` (MRP ${formatInr(price.mrpPaise)}, ${price.discountPercent}% off, save ${formatInr(price.savingsPaise)})` : ""} ·{" "}
              {describeAccessDuration(product)} · Checkout: /student/checkout/{product.code}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          <ProductForm product={product} readOnly={!canManage} />
        </CardContent>
      </Card>
    </div>
  );
}
