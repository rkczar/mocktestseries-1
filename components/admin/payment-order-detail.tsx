import Link from "next/link";
import type { OrderDetail } from "@/lib/payments/order-detail";
import { formatInr } from "@/lib/payments/money";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "@/app/admin/(dashboard)/payments/_components/shared";

type Hook = { id: string; eventType: string; status: string; receivedAt: Date; errorCategory: string | null };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-muted-foreground)]">{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/**
 * One payment order: summary, payment attempts, refunds and status history
 * (webhook events). Shared by Admin → Payments → Order and the Teacher Portal
 * (`teacher`: read-only, no Razorpay order / payment / refund ids, no invoice
 * download, no actions — the admin page passes its action forms as slots).
 */
export function OrderDetailView({
  order,
  hooks,
  studentHref,
  teacher = false,
  reconcileSlot = null,
  refundSlot = null,
}: {
  order: OrderDetail;
  hooks: Hook[];
  studentHref: (studentDbId: string) => string;
  teacher?: boolean;
  reconcileSlot?: React.ReactNode;
  refundSlot?: React.ReactNode;
}) {
  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 font-mono">
          {order.orderNumber} <StatusBadge status={order.status} /> <EnvBadge env={order.environment} />
        </CardTitle>
        <CardDescription>
          <Link href={studentHref(order.student.id)} className="hover:underline">
            {order.student.name} ({order.student.studentId})
          </Link>{" "}
          · {order.product.name}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <Row k="Created" v={fmtDate(order.createdAt, true)} />
          <Row k="Paid" v={fmtDate(order.paidAt, true)} />
          <Row k="Gateway" v={teacher ? order.gateway : `${order.gateway}${order.gatewayOrderId ? ` · ${order.gatewayOrderId}` : ""}`} />
          <Row k="MRP" v={formatInr(order.mrpPaise)} />
          <Row k="Selling price" v={formatInr(order.sellingPricePaise)} />
          <Row k="Sale discount" v={formatInr(order.saleDiscountPaise)} />
          <Row k="Coupon" v={order.couponCode ? `${order.couponCode} (−${formatInr(order.couponDiscountPaise)}) · ${order.couponRedemption?.status ?? ""}` : "—"} />
          <Row k="Amount" v={<strong>{formatInr(order.amountPaise)}</strong>} />
          <Row k="Failure" v={order.failureReason ?? "—"} />
          <Row
            k="Entitlement"
            v={
              order.entitlement
                ? `${order.entitlement.status} · ${fmtDate(order.entitlement.startsAt)} → ${order.entitlement.expiresAt ? fmtDate(order.entitlement.expiresAt) : "Lifetime"}`
                : "—"
            }
          />
          <Row
            k="Invoice"
            v={
              order.invoice ? (
                teacher ? (
                  `${order.invoice.invoiceNumber} · ${fmtDate(order.invoice.issuedAt)}`
                ) : (
                  <a href={`/api/admin/payments/invoices/${order.invoice.id}`} className="text-[var(--color-primary)] hover:underline">
                    {order.invoice.invoiceNumber}
                  </a>
                )
              ) : (
                "—"
              )
            }
          />
        </dl>
        {reconcileSlot}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payments</CardTitle>
      </CardHeader>
      <CardContent>
        {order.payments.length === 0 ? (
          <Empty>No payment attempts recorded.</Empty>
        ) : (
          <TableShell minWidth={760}>
            <thead>
              <tr>
                {teacher ? null : <Th>Payment ID</Th>}
                <Th>Created</Th>
                <Th right>Amount</Th>
                <Th right>Refunded</Th>
                <Th>Method</Th>
                <Th>Verified via</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {order.payments.map((p) => (
                <tr key={p.id}>
                  {teacher ? null : <Td mono>{p.gatewayPaymentId}</Td>}
                  <Td>{fmtDate(p.createdAt, true)}</Td>
                  <Td right>{formatInr(p.amountPaise)}</Td>
                  <Td right>{formatInr(p.refundedPaise)}</Td>
                  <Td>{p.method?.toUpperCase() ?? "—"}</Td>
                  <Td>{p.verifiedVia ?? "—"}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                    {p.failureDescription ? <div className="text-[10px] text-[var(--color-error)]">{p.failureDescription}</div> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle className="text-base">Refunds</CardTitle>
        <CardDescription>Refund state only changes from Razorpay&apos;s response or refund webhooks.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {order.refunds.length === 0 ? (
          <Empty>No refunds.</Empty>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {order.refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge status={r.status} /> {formatInr(r.amountPaise)} · {r.accessPolicy.replace(/_/g, " ")} · {fmtDate(r.createdAt, true)}
                {r.gatewayRefundId && !teacher ? <span className="font-mono text-xs">{r.gatewayRefundId}</span> : null}
                {r.failureReason ? <span className="text-xs text-[var(--color-error)]">{r.failureReason}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {refundSlot}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle className="text-base">Webhook events</CardTitle>
      </CardHeader>
      <CardContent>
        {hooks.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {hooks.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{h.eventType}</span> <StatusBadge status={h.status} /> {fmtDate(h.receivedAt, true)}
                {h.errorCategory ? <span className="text-xs text-[var(--color-muted-foreground)]">{h.errorCategory}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
    </>
  );
}
