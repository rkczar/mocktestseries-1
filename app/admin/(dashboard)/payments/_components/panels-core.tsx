import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";
import { getPaymentOverview, getRevenueBreakdowns, getExpiringEntitlements, orderWhere, type PaymentFilters } from "@/lib/payments/analytics";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "./shared";

export async function OverviewPanel({ filters }: { filters: PaymentFilters }) {
  const o = await getPaymentOverview(filters);
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Gross Sales" value={formatInr(o.grossPaise)} />
      <StatCard label="Successful Payments" value={o.successfulPayments} />
      <StatCard label="Failed Payments" value={o.failedPayments} />
      <StatCard label="Pending Payments" value={o.pendingOrders} />
      <StatCard label="Refunded Amount" value={formatInr(o.refundedPaise)} />
      <StatCard label="Net Collected" value={formatInr(o.netPaise)} />
      <StatCard label="Active Subscriptions" value={o.activeSubscriptions} />
      <StatCard label="Expired Subscriptions" value={o.expiredSubscriptions} />
      <StatCard label="Free Access Grants" value={o.freeAccessGrants} />
      <StatCard label="Coupon Redemptions" value={o.couponRedemptions} />
    </div>
  );
}

export async function OrdersPanel({ filters }: { filters: PaymentFilters }) {
  const orders = await prisma.paymentOrder.findMany({
    where: orderWhere(filters),
    include: { student: { select: { id: true, name: true, studentId: true } }, product: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Orders</CardTitle>
        <CardDescription>Internal orders (created before any Razorpay call). Newest 200 matching the filters.</CardDescription>
      </CardHeader>
      <CardContent>
        {orders.length === 0 ? (
          <Empty>No orders match these filters.</Empty>
        ) : (
          <TableShell minWidth={960}>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Created</Th>
                <Th>Student</Th>
                <Th>Product</Th>
                <Th right>MRP</Th>
                <Th right>Discount</Th>
                <Th>Coupon</Th>
                <Th right>Amount</Th>
                <Th>Gateway</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <Td mono>
                    <Link href={`/admin/payments/orders/${o.id}`} className="text-[var(--color-primary)] hover:underline">
                      {o.orderNumber}
                    </Link>{" "}
                    <EnvBadge env={o.environment} />
                  </Td>
                  <Td>{fmtDate(o.createdAt, true)}</Td>
                  <Td>
                    <Link href={`/admin/students/${o.student.id}`} className="hover:underline">
                      {o.student.name}
                    </Link>
                    <div className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{o.student.studentId}</div>
                  </Td>
                  <Td>{o.product.name}</Td>
                  <Td right>{formatInr(o.mrpPaise)}</Td>
                  <Td right>{formatInr(o.mrpPaise - o.amountPaise)}</Td>
                  <Td>{o.couponCode ?? "—"}</Td>
                  <Td right>{formatInr(o.amountPaise)}</Td>
                  <Td>{o.gateway}</Td>
                  <Td>
                    <StatusBadge status={o.status} />
                    {o.failureReason ? <div className="text-[10px] text-[var(--color-error)]">{o.failureReason}</div> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

export async function TransactionsPanel({ filters }: { filters: PaymentFilters }) {
  const payments = await prisma.payment.findMany({
    where: { environment: filters.environment, order: orderWhere(filters) },
    include: { order: { select: { id: true, orderNumber: true, product: { select: { name: true } } } }, student: { select: { id: true, name: true, studentId: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Transactions</CardTitle>
        <CardDescription>Razorpay payment attempts recorded from verified checkout callbacks, signed webhooks or reconciliation.</CardDescription>
      </CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <Empty>No transactions match these filters.</Empty>
        ) : (
          <TableShell minWidth={960}>
            <thead>
              <tr>
                <Th>Payment ID</Th>
                <Th>Date</Th>
                <Th>Order</Th>
                <Th>Student</Th>
                <Th>Product</Th>
                <Th right>Amount</Th>
                <Th right>Refunded</Th>
                <Th>Method</Th>
                <Th>Verified via</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <Td mono>
                    {p.gatewayPaymentId} <EnvBadge env={p.environment} />
                  </Td>
                  <Td>{fmtDate(p.createdAt, true)}</Td>
                  <Td mono>
                    <Link href={`/admin/payments/orders/${p.order.id}`} className="text-[var(--color-primary)] hover:underline">
                      {p.order.orderNumber}
                    </Link>
                  </Td>
                  <Td>
                    <Link href={`/admin/students/${p.student.id}`} className="hover:underline">
                      {p.student.name}
                    </Link>
                  </Td>
                  <Td>{p.order.product.name}</Td>
                  <Td right>{formatInr(p.amountPaise)}</Td>
                  <Td right>{p.refundedPaise ? formatInr(p.refundedPaise) : "—"}</Td>
                  <Td>{p.method?.toUpperCase() ?? "—"}</Td>
                  <Td>{p.verifiedVia?.replace(/_/g, " ") ?? "—"}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                    {p.failureCode ? <div className="text-[10px] text-[var(--color-error)]">{p.failureCode}</div> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

function BarList({ rows, total }: { rows: { key: string; label: string; paise: number; count: number }[]; total: number }) {
  if (rows.length === 0) return <Empty>No revenue in this range.</Empty>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <div className="flex justify-between text-sm">
            <span>{r.label}</span>
            <span className="font-medium">
              {formatInr(r.paise)} <span className="text-xs text-[var(--color-muted-foreground)]">· {r.count}</span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--color-muted)]">
            <div className="h-1.5 rounded-full bg-[var(--color-primary)]" style={{ width: `${total > 0 ? Math.max(2, (r.paise / total) * 100) : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export async function RevenuePanel({ filters }: { filters: PaymentFilters }) {
  const [o, b, expiring, refunds] = await Promise.all([
    getPaymentOverview(filters),
    getRevenueBreakdowns(filters),
    getExpiringEntitlements(7),
    prisma.refund.findMany({ where: { order: orderWhere(filters) }, select: { status: true, amountPaise: true } }),
  ]);
  const maxDay = Math.max(1, ...b.byDate.map((d) => d.paise));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Revenue" value={formatInr(o.grossPaise)} />
        <StatCard label="Paid orders" value={o.paidOrders} />
        <StatCard label="Failure rate" value={`${(o.failureRate * 100).toFixed(1)}%`} />
        <StatCard label="Avg order value" value={formatInr(o.averageOrderPaise)} />
        <StatCard label="Discounts given" value={formatInr(o.discountPaise)} />
        <StatCard label="Refunds" value={`${formatInr(o.refundedPaise)} · ${refunds.length}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revenue by date</CardTitle>
        </CardHeader>
        <CardContent>
          {b.byDate.length === 0 ? (
            <Empty>No revenue in this range.</Empty>
          ) : (
            <div className="flex h-40 items-end gap-1 overflow-x-auto" role="img" aria-label="Revenue per day">
              {b.byDate.map((d) => (
                <div key={d.date} className="flex min-w-[18px] flex-1 flex-col items-center justify-end gap-1" title={`${d.date}: ${formatInr(d.paise)} (${d.count})`}>
                  <div className="w-full rounded-t bg-[var(--color-primary)]" style={{ height: `${Math.max(3, (d.paise / maxDay) * 140)}px` }} />
                  <span className="text-[9px] text-[var(--color-muted-foreground)]">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue by exam</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={b.byExam.map((r) => ({ key: r.key, label: r.name, paise: r.paise, count: r.count }))} total={o.grossPaise} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue by product</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={b.byProduct.map((r) => ({ key: r.key, label: r.name, paise: r.paise, count: r.count }))} total={o.grossPaise} />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coupon performance</CardTitle>
          </CardHeader>
          <CardContent>
            {b.byCoupon.length === 0 ? (
              <Empty>No coupon redemptions in this range.</Empty>
            ) : (
              <TableShell minWidth={420}>
                <thead>
                  <tr>
                    <Th>Coupon</Th>
                    <Th right>Uses</Th>
                    <Th right>Revenue</Th>
                    <Th right>Discount</Th>
                    <Th right>Free grants</Th>
                  </tr>
                </thead>
                <tbody>
                  {b.byCoupon.map((c) => (
                    <tr key={c.code}>
                      <Td mono>{c.code}</Td>
                      <Td right>{c.redemptions}</Td>
                      <Td right>{formatInr(c.revenuePaise)}</Td>
                      <Td right>{formatInr(c.discountPaise)}</Td>
                      <Td right>{c.freeGrants}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expiring in 7 days</CardTitle>
            <CardDescription>Active: {o.activeSubscriptions} · Expired: {o.expiredSubscriptions}</CardDescription>
          </CardHeader>
          <CardContent>
            {expiring.length === 0 ? (
              <Empty>Nothing expiring this week.</Empty>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {expiring.map((e) => (
                  <li key={e.id} className="flex justify-between gap-2">
                    <Link href={`/admin/students/${e.student.id}`} className="hover:underline">
                      {e.student.name} <span className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{e.student.studentId}</span>
                    </Link>
                    <span className="text-[var(--color-muted-foreground)]">
                      {e.product.name} · {fmtDate(e.expiresAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
