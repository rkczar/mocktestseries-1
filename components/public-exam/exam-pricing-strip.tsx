import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getPaymentMode } from "@/lib/payments/settings";
import { computeProductPrice, describeAccessDuration } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Public exam page pricing CTA. Renders nothing in FREE mode or when the
 * exam has no visible PAID product, so today's free pages are unchanged.
 * Prices are computed server-side from the canonical Product rows.
 */
export async function ExamPricingStrip({ examId }: { examId: string }) {
  if ((await getPaymentMode()) === "FREE") return null;
  const products = await prisma.product.findMany({
    where: { examId, isActive: true, isVisible: true, purchaseEnabled: true, accessType: "PAID" },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    take: 3,
  });
  if (products.length === 0) return null;
  const now = new Date();
  return (
    <div className="mt-6 flex flex-wrap gap-3">
      {products.map((p) => {
        const price = computeProductPrice(p, now);
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">{p.name}</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">{describeAccessDuration(p)}</p>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold">{formatInr(price.pricePaise)}</span>
              {price.mrpPaise > price.pricePaise ? (
                <>
                  <span className="text-xs text-[var(--color-muted-foreground)] line-through">{formatInr(price.mrpPaise)}</span>
                  <Badge variant="success">{price.discountPercent}% OFF</Badge>
                </>
              ) : null}
            </div>
            <Button asChild size="sm">
              <Link href={`/student/checkout/${encodeURIComponent(p.code)}`}>Get Access</Link>
            </Button>
          </div>
        );
      })}
    </div>
  );
}
