import Link from "next/link";
import { BadgeCheck } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Dashboard strip for the student's current entitlements: what's active,
 * when it expires, and a 7/3/1-day expiry warning. Renders nothing for a
 * student with no subscriptions (the free-site experience is unchanged).
 * Never auto-renews — this phase is one-time purchase + timed access.
 */
export async function SubscriptionStatusCard({ studentId }: { studentId: string }) {
  const now = new Date();
  const active = await prisma.studentEntitlement.findMany({
    where: { studentId, status: "ACTIVE", startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    include: { product: { select: { name: true, code: true } } },
    orderBy: { expiresAt: { sort: "asc", nulls: "last" } },
    take: 3,
  });
  if (active.length === 0) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
            <BadgeCheck className="h-4 w-4 text-[var(--color-success)]" aria-hidden /> Active subscription{active.length > 1 ? "s" : ""}
          </p>
          <Button asChild size="sm" variant="ghost">
            <Link href="/student/subscriptions">View all</Link>
          </Button>
        </div>
        {active.map((e) => {
          const days = e.expiresAt ? Math.ceil((e.expiresAt.getTime() - now.getTime()) / 86_400_000) : null;
          const warn = days !== null && (days <= 1 ? "Expires tomorrow" : days <= 3 ? "Expires in 3 days" : days <= 7 ? "Expires in 7 days" : null);
          return (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-[var(--color-foreground)]">{e.product.name}</span>
              <span className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                {e.expiresAt
                  ? `Expires on ${e.expiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })} · ${days} day${days === 1 ? "" : "s"} remaining`
                  : "Lifetime access"}
                {warn ? (
                  <Link href={`/student/checkout/${encodeURIComponent(e.product.code)}`}>
                    <Badge variant="warning">{warn} — Renew</Badge>
                  </Link>
                ) : null}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
