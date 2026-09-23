import Link from "next/link";
import { requireStudent } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { productHref, entitlementDisplayStatus } from "@/lib/payments/product-links";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "My Subscriptions — Mock Test Series.in" };
export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const VARIANT = { ACTIVE: "success", LIFETIME: "success", FREE: "info", EXPIRED: "warning", REVOKED: "error" } as const;

export default async function SubscriptionsPage() {
  const student = await requireStudent();
  const now = new Date();
  const ents = await prisma.studentEntitlement.findMany({
    where: { studentId: student.id },
    include: {
      product: { select: { code: true, name: true, productType: true, examId: true, isActive: true, isVisible: true, exam: { select: { name: true } } } },
      order: { select: { paidAt: true, createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">My Subscriptions</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Everything you have access to, and until when.</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/student/plans">Browse plans</Link>
        </Button>
      </div>
      {ents.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
            You don&apos;t have any subscriptions yet.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {ents.map((e) => {
            const status = entitlementDisplayStatus(e, now);
            const daysLeft = e.expiresAt && status === "ACTIVE" ? Math.ceil((e.expiresAt.getTime() - now.getTime()) / 86_400_000) : null;
            const purchased = e.order?.paidAt ?? e.order?.createdAt ?? e.createdAt;
            return (
              <Card key={e.id}>
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[var(--color-foreground)]">{e.product.name}</span>
                      <Badge variant={VARIANT[status]}>{status}</Badge>
                      {daysLeft !== null && daysLeft <= 7 ? (
                        <Badge variant="warning">{daysLeft <= 1 ? "Expires tomorrow" : `Expires in ${daysLeft} days`}</Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {e.product.exam?.name ? `${e.product.exam.name} · ` : ""}
                      Purchased {fmt(purchased)} · Starts {fmt(e.startsAt)} ·{" "}
                      {e.expiresAt ? `${status === "EXPIRED" ? "Expired" : "Expires"} ${fmt(e.expiresAt)}` : "No expiry"}
                      {daysLeft !== null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {status === "ACTIVE" || status === "LIFETIME" || status === "FREE" ? (
                      <Button asChild size="sm">
                        <Link href={productHref(e.product)}>Open</Link>
                      </Button>
                    ) : null}
                    {(status === "EXPIRED" || (daysLeft !== null && daysLeft <= 7)) && e.product.isActive && e.product.isVisible ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/student/checkout/${encodeURIComponent(e.product.code)}`}>Renew</Link>
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
