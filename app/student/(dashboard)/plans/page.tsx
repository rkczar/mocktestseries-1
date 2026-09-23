import Link from "next/link";
import { requireStudent } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { getPaymentMode } from "@/lib/payments/settings";
import { computeProductPrice, describeAccessDuration } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";
import { PRODUCT_TYPE_LABELS } from "@/lib/payments/product-links";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Plans & Pricing — Mock Test Series.in" };
export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const student = await requireStudent();
  const now = new Date();
  const [mode, products, entitlements] = await Promise.all([
    getPaymentMode(),
    prisma.product.findMany({
      where: { isActive: true, isVisible: true },
      include: { exam: { select: { name: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
    prisma.studentEntitlement.findMany({
      where: { studentId: student.id, status: "ACTIVE", startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { productId: true },
    }),
  ]);
  const owned = new Set(entitlements.map((e) => e.productId));

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Plans &amp; Pricing</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {mode === "FREE" ? "Everything is currently free — enjoy full access." : "Unlock premium test series and exam packages."}
        </p>
      </div>
      {products.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">No plans are available right now.</CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => {
            const price = computeProductPrice(p, now);
            const isFree = mode === "FREE" || price.isFree;
            return (
              <Card key={p.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex flex-wrap gap-1">
                    <Badge>{PRODUCT_TYPE_LABELS[p.productType]}</Badge>
                    {p.exam ? <Badge variant="info">{p.exam.name}</Badge> : null}
                    {owned.has(p.id) ? <Badge variant="success">Active</Badge> : null}
                  </div>
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  {p.description ? <CardDescription className="line-clamp-3">{p.description}</CardDescription> : null}
                </CardHeader>
                <CardContent className="mt-auto flex flex-col gap-3">
                  {isFree ? (
                    <p className="text-lg font-semibold text-[var(--color-success)]">Free</p>
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-lg font-semibold">{formatInr(price.pricePaise)}</span>
                      {price.mrpPaise > price.pricePaise ? (
                        <>
                          <span className="text-sm text-[var(--color-muted-foreground)] line-through">{formatInr(price.mrpPaise)}</span>
                          <Badge variant="success">{price.discountPercent}% OFF</Badge>
                        </>
                      ) : null}
                    </div>
                  )}
                  <p className="text-xs text-[var(--color-muted-foreground)]">{describeAccessDuration(p)}</p>
                  <Button asChild variant={owned.has(p.id) || isFree ? "outline" : "primary"}>
                    <Link href={`/student/checkout/${encodeURIComponent(p.code)}`}>
                      {owned.has(p.id) ? "Continue" : isFree ? "Start Learning" : "View & Buy"}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
