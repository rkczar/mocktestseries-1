import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatInr, paiseToRupeeString } from "@/lib/payments/money";
import { getPaymentPolicy } from "@/lib/payments/settings";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { BackButton } from "@/components/student/back-button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { getPaymentsAccess } from "../../_components/access";
import { ActionForm } from "../../_components/action-form";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "../../_components/shared";
import { reconcileOrderAction, requestRefundAction } from "../../actions";

export const metadata = { title: "Order — Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-muted-foreground)]">{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { canView, canManage } = await getPaymentsAccess();
  if (!canView) return <RestrictedCard title="Payments" />;
  const { id } = await params;
  const [order, policy] = await Promise.all([
    prisma.paymentOrder.findUnique({
      where: { id },
      include: {
        student: { select: { id: true, name: true, studentId: true, email: true } },
        product: { select: { id: true, name: true, code: true } },
        payments: { orderBy: { createdAt: "asc" } },
        refunds: { orderBy: { createdAt: "asc" } },
        entitlement: true,
        invoice: { select: { id: true, invoiceNumber: true, issuedAt: true } },
        couponRedemption: true,
      },
    }),
    getPaymentPolicy(),
  ]);
  if (!order) notFound();
  const hooks = await prisma.paymentWebhookEvent.findMany({ where: { orderId: order.id }, orderBy: { receivedAt: "asc" } });
  const refundable = order.payments.filter((p) => p.status === "CAPTURED" || p.status === "PARTIALLY_REFUNDED");

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/admin/payments?tab=orders" />
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 font-mono">
            {order.orderNumber} <StatusBadge status={order.status} /> <EnvBadge env={order.environment} />
          </CardTitle>
          <CardDescription>
            <Link href={`/admin/students/${order.student.id}`} className="hover:underline">
              {order.student.name} ({order.student.studentId})
            </Link>{" "}
            · {order.product.name}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <Row k="Created" v={fmtDate(order.createdAt, true)} />
            <Row k="Paid" v={fmtDate(order.paidAt, true)} />
            <Row k="Gateway" v={`${order.gateway}${order.gatewayOrderId ? ` · ${order.gatewayOrderId}` : ""}`} />
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
                  <a href={`/api/admin/payments/invoices/${order.invoice.id}`} className="text-[var(--color-primary)] hover:underline">
                    {order.invoice.invoiceNumber}
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </dl>
          {canManage && order.gateway === "RAZORPAY" ? (
            <ActionForm action={reconcileOrderAction} submitLabel="Re-check with Razorpay & repair" variant="outline">
              <input type="hidden" name="orderId" value={order.id} />
            </ActionForm>
          ) : null}
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
                  <Th>Payment ID</Th>
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
                    <Td mono>{p.gatewayPaymentId}</Td>
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
                  {r.gatewayRefundId ? <span className="font-mono text-xs">{r.gatewayRefundId}</span> : null}
                  {r.failureReason ? <span className="text-xs text-[var(--color-error)]">{r.failureReason}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {canManage && refundable.length > 0 ? (
            <ActionForm action={requestRefundAction} submitLabel="Request refund" variant="danger" className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
              <div className="flex flex-col gap-1">
                <Label htmlFor="rf-payment">Payment</Label>
                <SelectNative id="rf-payment" name="paymentId">
                  {refundable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.gatewayPaymentId} · {formatInr(p.amountPaise - p.refundedPaise)} refundable
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rf-amount">Amount (₹)</Label>
                <Input id="rf-amount" name="amount" inputMode="decimal" defaultValue={paiseToRupeeString(refundable[0].amountPaise - refundable[0].refundedPaise)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rf-policy">Access after full refund</Label>
                <SelectNative id="rf-policy" name="accessPolicy" defaultValue={policy.refundAccessPolicy}>
                  <option value="RETAIN">Retain access</option>
                  <option value="REVOKE_IMMEDIATELY">Revoke immediately</option>
                  <option value="RETAIN_UNTIL_DATE">Retain until date</option>
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rf-until">Retain until (if chosen)</Label>
                <Input id="rf-until" name="retainUntil" type="datetime-local" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rf-reason">Reason</Label>
                <Input id="rf-reason" name="reason" required maxLength={500} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rf-confirm">Type REFUND to confirm</Label>
                <Input id="rf-confirm" name="confirm" autoComplete="off" required />
              </div>
            </ActionForm>
          ) : null}
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
    </div>
  );
}
