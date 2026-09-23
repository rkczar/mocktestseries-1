import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";
import { entitlementDisplayStatus } from "@/lib/payments/product-links";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { getPaymentsAccess } from "./access";
import { ActionForm } from "./action-form";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "./shared";
import { grantEntitlementAction, revokeEntitlementAction } from "../actions";

/**
 * Admin → Students → [student] → Payments & Access. Visible to PAYMENTS_VIEW;
 * grant/revoke controls only for PAYMENTS_MANAGE (MASTER_ADMIN) and the
 * actions re-check that permission server-side.
 */
export async function StudentPaymentProfile({ studentId }: { studentId: string }) {
  const { canView, canManage } = await getPaymentsAccess();
  if (!canView) return null;
  const now = new Date();
  const [ents, orders, products] = await Promise.all([
    prisma.studentEntitlement.findMany({
      where: { studentId },
      include: { product: { select: { name: true } }, order: { select: { orderNumber: true, id: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.paymentOrder.findMany({
      where: { studentId },
      include: {
        product: { select: { name: true } },
        payments: { select: { gatewayPaymentId: true, status: true, method: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
        refunds: { select: { status: true, amountPaise: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    canManage ? prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments &amp; Access</CardTitle>
        <CardDescription>Subscriptions, entitlements, purchases, coupons, invoices and refunds for this student.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div>
          <p className="mb-2 text-sm font-medium">Entitlements</p>
          {ents.length === 0 ? (
            <Empty>No entitlements.</Empty>
          ) : (
            <TableShell minWidth={820}>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Source</Th>
                  <Th>Starts</Th>
                  <Th>Expires</Th>
                  <Th>Order / reason</Th>
                  <Th>Status</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody>
                {ents.map((e) => {
                  const status = entitlementDisplayStatus(e, now);
                  return (
                    <tr key={e.id}>
                      <Td>{e.product.name}</Td>
                      <Td>{e.source.replace(/_/g, " ")}</Td>
                      <Td>{fmtDate(e.startsAt)}</Td>
                      <Td>{e.expiresAt ? fmtDate(e.expiresAt) : "Lifetime"}</Td>
                      <Td>
                        {e.order ? (
                          <Link href={`/admin/payments/orders/${e.order.id}`} className="font-mono text-xs text-[var(--color-primary)] hover:underline">
                            {e.order.orderNumber}
                          </Link>
                        ) : (
                          <span className="text-xs">{e.reason ?? "—"}</span>
                        )}
                        {e.revokeReason ? <div className="text-[10px] text-[var(--color-error)]">Revoked: {e.revokeReason}</div> : null}
                      </Td>
                      <Td>
                        <StatusBadge status={status} />
                      </Td>
                      <Td>
                        {canManage && e.status === "ACTIVE" ? (
                          <ActionForm action={revokeEntitlementAction} submitLabel="Revoke" variant="outline" className="flex items-center gap-2">
                            <input type="hidden" name="id" value={e.id} />
                            <Input name="reason" placeholder="Reason" required maxLength={500} className="h-8 w-36" aria-label="Revoke reason" />
                          </ActionForm>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableShell>
          )}
        </div>

        {canManage ? (
          <div>
            <p className="mb-2 text-sm font-medium">Grant access</p>
            <ActionForm action={grantEntitlementAction} submitLabel="Grant access" className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
              <input type="hidden" name="studentId" value={studentId} />
              <div className="flex flex-col gap-1">
                <Label htmlFor="g-product">Product</Label>
                <SelectNative id="g-product" name="productId" required>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="g-source">Type</Label>
                <SelectNative id="g-source" name="source">
                  <option value="ADMIN_GRANT">Admin grant</option>
                  <option value="PROMOTION">Promotion</option>
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="g-reason">Reason</Label>
                <Input id="g-reason" name="reason" required maxLength={500} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="g-start">Starts (IST, blank = now)</Label>
                <Input id="g-start" name="startsAt" type="datetime-local" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="g-end">Expires (IST, blank = lifetime)</Label>
                <Input id="g-end" name="expiresAt" type="datetime-local" />
              </div>
            </ActionForm>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-sm font-medium">Purchase &amp; payment history</p>
          {orders.length === 0 ? (
            <Empty>No orders.</Empty>
          ) : (
            <TableShell minWidth={900}>
              <thead>
                <tr>
                  <Th>Order</Th>
                  <Th>Date</Th>
                  <Th>Product</Th>
                  <Th>Coupon</Th>
                  <Th right>Paid</Th>
                  <Th>Payment</Th>
                  <Th>Invoice</Th>
                  <Th>Refunds</Th>
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
                    <Td>{o.product.name}</Td>
                    <Td>{o.couponCode ?? "—"}</Td>
                    <Td right>{formatInr(o.amountPaise)}</Td>
                    <Td>
                      {o.payments.map((p) => (
                        <div key={p.gatewayPaymentId} className="font-mono text-[10px]">
                          {p.gatewayPaymentId} · {p.status} {p.method ? `· ${p.method}` : ""}
                        </div>
                      ))}
                    </Td>
                    <Td>
                      {o.invoice ? (
                        <a href={`/api/admin/payments/invoices/${o.invoice.id}`} className="text-xs text-[var(--color-primary)] hover:underline">
                          {o.invoice.invoiceNumber}
                        </a>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>{o.refunds.length ? o.refunds.map((r) => `${r.status} ${formatInr(r.amountPaise)}`).join(", ") : "—"}</Td>
                    <Td>
                      <StatusBadge status={o.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
