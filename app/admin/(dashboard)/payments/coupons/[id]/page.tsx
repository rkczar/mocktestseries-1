import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";
import { describeCommission, getCouponPerformance, type CouponPerformance } from "@/lib/payments/coupon-report";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { BackButton } from "@/components/student/back-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getPaymentsAccess } from "../../_components/access";
import { CouponForm } from "../../_components/coupon-form";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "../../_components/shared";

export const metadata = { title: "Coupon — Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

export default async function CouponPage({ params }: { params: Promise<{ id: string }> }) {
  const { canView, canManage } = await getPaymentsAccess();
  if (!canView) return <RestrictedCard title="Payments" />;
  const { id } = await params;
  const coupon = id === "new" ? null : await prisma.coupon.findUnique({ where: { id } });
  if (id !== "new" && !coupon) notFound();
  if (!coupon && !canManage) return <RestrictedCard title="New coupon" />;
  const redemptions = coupon
    ? await prisma.couponRedemption.findMany({
        where: { couponId: coupon.id },
        include: {
          student: { select: { id: true, name: true, studentId: true } },
          order: { select: { id: true, orderNumber: true, amountPaise: true, status: true, environment: true, product: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      })
    : [];
  const perf = coupon
    ? await Promise.all(
        (["LIVE", "TEST"] as const).map(async (environment) => {
          const m = await getCouponPerformance({ environment, from: null, to: null, couponId: coupon.id, creator: null }, [coupon.id]);
          return { environment, p: m.get(coupon.id)! };
        })
      )
    : [];

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/admin/payments?tab=coupons" />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {coupon ? coupon.code : "New coupon"} {!canManage ? <Badge>View only</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CouponForm coupon={coupon} readOnly={!canManage} />
        </CardContent>
      </Card>
      {coupon ? <PerformanceCard couponId={coupon.id} creator={coupon.referrerName} campaign={coupon.campaign} rule={describeCommission(coupon)} perf={perf} /> : null}
      {coupon ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Redemptions</CardTitle>
          </CardHeader>
          <CardContent>
            {redemptions.length === 0 ? (
              <Empty>Not used yet.</Empty>
            ) : (
              <TableShell minWidth={800}>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Student</Th>
                    <Th>Product</Th>
                    <Th>Order</Th>
                    <Th right>Discount</Th>
                    <Th right>Paid</Th>
                    <Th>Redemption</Th>
                  </tr>
                </thead>
                <tbody>
                  {redemptions.map((r) => (
                    <tr key={r.id}>
                      <Td>{fmtDate(r.createdAt, true)}</Td>
                      <Td>
                        <Link href={`/admin/students/${r.student.id}`} className="hover:underline">
                          {r.student.name}
                        </Link>
                      </Td>
                      <Td>{r.order.product.name}</Td>
                      <Td mono>
                        <Link href={`/admin/payments/orders/${r.order.id}`} className="text-[var(--color-primary)] hover:underline">
                          {r.order.orderNumber}
                        </Link>{" "}
                        <EnvBadge env={r.order.environment} />
                      </Td>
                      <Td right>{formatInr(r.discountPaise)}</Td>
                      <Td right>{formatInr(r.order.amountPaise)}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PerformanceCard({
  couponId,
  creator,
  campaign,
  rule,
  perf,
}: {
  couponId: string;
  creator: string | null;
  campaign: string | null;
  rule: string;
  perf: { environment: "LIVE" | "TEST"; p: CouponPerformance }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Creator performance</CardTitle>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Creator: <strong>{creator || "—"}</strong> · Campaign: {campaign || "—"} · Commission: {rule}. Successful orders only (abandoned / failed checkouts
          never count). Eligible net = collected − refunded. Commission is calculated for reporting — nothing is paid automatically.
        </p>
      </CardHeader>
      <CardContent>
        <TableShell minWidth={1000}>
          <thead>
            <tr>
              <Th>Environment</Th>
              <Th right>Paid orders</Th>
              <Th right>Unique students</Th>
              <Th right>Gross value</Th>
              <Th right>Discount given</Th>
              <Th right>Collected</Th>
              <Th right>Refunded</Th>
              <Th right>Eligible net</Th>
              <Th right>Commission</Th>
              <Th>Settlement CSV</Th>
            </tr>
          </thead>
          <tbody>
            {perf.map(({ environment, p }) => (
              <tr key={environment}>
                <Td>{environment === "LIVE" ? <Badge variant="success">LIVE</Badge> : <EnvBadge env="TEST" />}</Td>
                <Td right>
                  {p.successfulOrders}
                  {p.freeAccessOrders ? <div className="text-[10px] text-[var(--color-muted-foreground)]">{p.freeAccessOrders} at ₹0</div> : null}
                </Td>
                <Td right>{p.uniqueStudents}</Td>
                <Td right>{formatInr(p.grossPaise)}</Td>
                <Td right>{formatInr(p.discountPaise)}</Td>
                <Td right>{formatInr(p.collectedPaise)}</Td>
                <Td right>
                  {formatInr(p.refundedPaise)}
                  {p.refundedOrders ? <div className="text-[10px] text-[var(--color-muted-foreground)]">{p.refundedOrders} order(s)</div> : null}
                </Td>
                <Td right>{formatInr(p.eligibleNetPaise)}</Td>
                <Td right>{formatInr(p.commissionPaise)}</Td>
                <Td>
                  <a
                    href={`/api/admin/payments/coupons/settlement?env=${environment}&coupon=${encodeURIComponent(couponId)}`}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    Download
                  </a>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </CardContent>
    </Card>
  );
}
