import Link from "next/link";
import { CouponRedemptionStatus, OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";
import { computeProductPrice, describeAccessDuration } from "@/lib/payments/pricing";
import { PRODUCT_TYPE_LABELS, entitlementDisplayStatus } from "@/lib/payments/product-links";
import { orderWhere, type PaymentFilters } from "@/lib/payments/analytics";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "./shared";
import { ActionForm } from "./action-form";
import { toggleCouponAction } from "../actions";

export async function ProductsPanel({ canManage }: { canManage: boolean }) {
  const now = new Date();
  const products = await prisma.product.findMany({
    include: {
      exam: { select: { name: true } },
      _count: { select: { entitlements: true, orders: { where: { status: { in: [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED] } } } } },
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Products &amp; Pricing</CardTitle>
          <CardDescription>
            The one canonical pricing source. A PAID product gates the content it covers once Payment Mode is PAID; a FREE product keeps it open.
          </CardDescription>
        </div>
        {canManage ? (
          <Button asChild size="sm">
            <Link href="/admin/payments/products/new">New product</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {products.length === 0 ? (
          <Empty>No products yet. Content stays free until a PAID product covers it.</Empty>
        ) : (
          <TableShell minWidth={980}>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Type</Th>
                <Th>Access</Th>
                <Th right>MRP</Th>
                <Th right>Price now</Th>
                <Th>Sale</Th>
                <Th>Duration</Th>
                <Th right>Sold</Th>
                <Th>State</Th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const price = computeProductPrice(p, now);
                return (
                  <tr key={p.id}>
                    <Td>
                      <Link href={`/admin/payments/products/${p.id}`} className="font-medium text-[var(--color-primary)] hover:underline">
                        {p.name}
                      </Link>
                      <div className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{p.code}</div>
                    </Td>
                    <Td>
                      {PRODUCT_TYPE_LABELS[p.productType]}
                      {p.exam ? <div className="text-xs text-[var(--color-muted-foreground)]">{p.exam.name}</div> : null}
                    </Td>
                    <Td>
                      <Badge variant={p.accessType === "PAID" ? "primary" : "info"}>{p.accessType}</Badge>
                    </Td>
                    <Td right>{formatInr(price.mrpPaise)}</Td>
                    <Td right>
                      {price.isFree ? "Free" : formatInr(price.pricePaise)}
                      {price.discountPercent > 0 && !price.isFree ? <div className="text-[10px] text-[var(--color-success)]">{price.discountPercent}% off</div> : null}
                    </Td>
                    <Td>{price.saleActive ? <Badge variant="success">Live until {fmtDate(p.saleEndAt)}</Badge> : p.saleEnabled ? <Badge>Scheduled</Badge> : "—"}</Td>
                    <Td>{describeAccessDuration(p)}</Td>
                    <Td right>{p._count.orders}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {p.isActive ? <Badge variant="success">Active</Badge> : <Badge>Inactive</Badge>}
                        {!p.isVisible ? <Badge>Hidden</Badge> : null}
                        {!p.purchaseEnabled ? <Badge variant="warning">Sales off</Badge> : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

export async function CouponsPanel({ canManage }: { canManage: boolean }) {
  const now = new Date();
  const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
  const stats = await prisma.couponRedemption.groupBy({
    by: ["couponId", "status"],
    _count: true,
    _sum: { discountPaise: true },
    where: { couponId: { in: coupons.map((c) => c.id) } },
  });
  const revenue = await prisma.paymentOrder.groupBy({
    by: ["couponId"],
    where: { couponId: { in: coupons.map((c) => c.id) }, status: { in: [OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED] } },
    _sum: { amountPaise: true },
    _count: true,
  });
  const freeGrants = await prisma.paymentOrder.groupBy({
    by: ["couponId"],
    where: { couponId: { in: coupons.map((c) => c.id) }, status: OrderStatus.PAID, amountPaise: 0 },
    _count: true,
  });
  const consumed = (id: string) => stats.find((s) => s.couponId === id && s.status === CouponRedemptionStatus.CONSUMED)?._count ?? 0;
  const reserved = (id: string) => stats.find((s) => s.couponId === id && s.status === CouponRedemptionStatus.RESERVED)?._count ?? 0;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Coupons</CardTitle>
          <CardDescription>Validated server-side and transactionally at checkout. Attribution (source / campaign / referrer) feeds revenue reporting.</CardDescription>
        </div>
        {canManage ? (
          <Button asChild size="sm">
            <Link href="/admin/payments/coupons/new">New coupon</Link>
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {coupons.length === 0 ? (
          <Empty>No coupons yet.</Empty>
        ) : (
          <TableShell minWidth={1100}>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Discount</Th>
                <Th>Validity</Th>
                <Th right>Used / limit</Th>
                <Th right>Revenue</Th>
                <Th right>Free grants</Th>
                <Th>Attribution</Th>
                <Th>Status</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => {
                const expired = c.validUntil && c.validUntil <= now;
                const rev = revenue.find((r) => r.couponId === c.id);
                return (
                  <tr key={c.id}>
                    <Td>
                      <Link href={`/admin/payments/coupons/${c.id}`} className="font-mono font-medium text-[var(--color-primary)] hover:underline">
                        {c.code}
                      </Link>
                      {c.displayName ? <div className="text-xs text-[var(--color-muted-foreground)]">{c.displayName}</div> : null}
                    </Td>
                    <Td>
                      {c.discountType === "FREE_ACCESS" ? "100% (free access)" : c.discountType === "PERCENTAGE" ? `${c.discountValue}%` : formatInr(c.discountValue)}
                      {c.maxDiscountPaise ? <div className="text-[10px] text-[var(--color-muted-foreground)]">max {formatInr(c.maxDiscountPaise)}</div> : null}
                    </Td>
                    <Td>
                      <div className="text-xs">
                        {fmtDate(c.validFrom)} → {fmtDate(c.validUntil)}
                      </div>
                    </Td>
                    <Td right>
                      {consumed(c.id)}
                      {reserved(c.id) ? <span className="text-[10px] text-[var(--color-muted-foreground)]"> (+{reserved(c.id)} held)</span> : null} / {c.totalUsageLimit ?? "∞"}
                      {c.perStudentLimit ? <div className="text-[10px] text-[var(--color-muted-foreground)]">{c.perStudentLimit}/student</div> : null}
                    </Td>
                    <Td right>{formatInr(rev?._sum.amountPaise ?? 0)}</Td>
                    <Td right>{freeGrants.find((f) => f.couponId === c.id)?._count ?? 0}</Td>
                    <Td>
                      <div className="text-xs">
                        {[c.source, c.campaign, c.referrerName ?? c.referrerCode].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </Td>
                    <Td>{!c.isActive ? <Badge>Inactive</Badge> : expired ? <Badge variant="warning">Expired</Badge> : <Badge variant="success">Active</Badge>}</Td>
                    <Td>
                      {canManage ? (
                        <ActionForm action={toggleCouponAction} submitLabel={c.isActive ? "Deactivate" : "Activate"} variant="outline" className="flex items-center gap-2">
                          <input type="hidden" name="id" value={c.id} />
                        </ActionForm>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

export async function SubscriptionsPanel({ filters }: { filters: PaymentFilters }) {
  const now = new Date();
  const ents = await prisma.studentEntitlement.findMany({
    where: {
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.examId ? { product: { examId: filters.examId } } : {}),
      ...(filters.student
        ? {
            student: {
              OR: [
                { studentId: { contains: filters.student, mode: "insensitive" } },
                { name: { contains: filters.student, mode: "insensitive" } },
                { email: { contains: filters.student, mode: "insensitive" } },
              ],
            },
          }
        : {}),
    },
    include: {
      student: { select: { id: true, name: true, studentId: true } },
      product: { select: { name: true } },
      order: { select: { orderNumber: true, environment: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Subscriptions / Entitlements</CardTitle>
        <CardDescription>What actually grants access. Grant or revoke from a student&apos;s profile (Admin → Students → student).</CardDescription>
      </CardHeader>
      <CardContent>
        {ents.length === 0 ? (
          <Empty>No entitlements yet.</Empty>
        ) : (
          <TableShell minWidth={900}>
            <thead>
              <tr>
                <Th>Student</Th>
                <Th>Product</Th>
                <Th>Source</Th>
                <Th>Starts</Th>
                <Th>Expires</Th>
                <Th>Order</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {ents.map((e) => (
                <tr key={e.id}>
                  <Td>
                    <Link href={`/admin/students/${e.student.id}`} className="hover:underline">
                      {e.student.name}
                    </Link>
                    <div className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{e.student.studentId}</div>
                  </Td>
                  <Td>{e.product.name}</Td>
                  <Td>{e.source.replace(/_/g, " ")}</Td>
                  <Td>{fmtDate(e.startsAt)}</Td>
                  <Td>{e.expiresAt ? fmtDate(e.expiresAt) : "Lifetime"}</Td>
                  <Td mono>
                    {e.order?.orderNumber ?? "—"} <EnvBadge env={e.order?.environment} />
                  </Td>
                  <Td>
                    <StatusBadge status={entitlementDisplayStatus(e, now)} />
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

export async function InvoicesPanel({ filters, q }: { filters: PaymentFilters; q: string | null }) {
  const invoices = await prisma.invoice.findMany({
    where: {
      environment: filters.environment,
      order: orderWhere({ ...filters, status: null }),
      ...(q ? { invoiceNumber: { contains: q, mode: "insensitive" } } : {}),
    },
    include: { student: { select: { id: true, name: true, studentId: true } }, order: { select: { orderNumber: true, product: { select: { name: true } } } } },
    orderBy: { issuedAt: "desc" },
    take: 300,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invoices</CardTitle>
        <CardDescription>Immutable snapshots issued once per paid order. Numbering is per prefix + financial year (TEST invoices use a separate series).</CardDescription>
        <form method="get" className="flex max-w-sm gap-2 pt-2">
          <input type="hidden" name="tab" value="invoices" />
          <input type="hidden" name="env" value={filters.environment} />
          <Input name="q" defaultValue={q ?? ""} placeholder="Search invoice number" aria-label="Search invoice number" />
          <Button type="submit" size="sm" className="h-10">
            Search
          </Button>
        </form>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <Empty>No invoices.</Empty>
        ) : (
          <TableShell minWidth={800}>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Issued</Th>
                <Th>Student</Th>
                <Th>Product</Th>
                <Th>Order</Th>
                <Th right>Total</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <Td mono>
                    {i.invoiceNumber} <EnvBadge env={i.environment} />
                  </Td>
                  <Td>{fmtDate(i.issuedAt)}</Td>
                  <Td>
                    <Link href={`/admin/students/${i.student.id}`} className="hover:underline">
                      {i.student.name}
                    </Link>
                  </Td>
                  <Td>{i.order.product.name}</Td>
                  <Td mono>{i.order.orderNumber}</Td>
                  <Td right>{formatInr(i.totalPaise)}</Td>
                  <Td>
                    <a href={`/api/admin/payments/invoices/${i.id}`} className="text-[var(--color-primary)] hover:underline">
                      PDF
                    </a>
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

export async function RefundsPanel({ filters }: { filters: PaymentFilters }) {
  const refunds = await prisma.refund.findMany({
    where: { order: orderWhere({ ...filters, status: null }) },
    include: { order: { select: { id: true, orderNumber: true, environment: true, student: { select: { name: true } } } }, payment: { select: { gatewayPaymentId: true } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Refunds</CardTitle>
        <CardDescription>
          Start a refund from an order&apos;s detail page (Master Admin). Status only changes from Razorpay&apos;s response or refund webhooks — never from the click.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {refunds.length === 0 ? (
          <Empty>No refunds.</Empty>
        ) : (
          <TableShell minWidth={900}>
            <thead>
              <tr>
                <Th>Requested</Th>
                <Th>Order</Th>
                <Th>Student</Th>
                <Th>Payment</Th>
                <Th right>Amount</Th>
                <Th>Access policy</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id}>
                  <Td>{fmtDate(r.createdAt, true)}</Td>
                  <Td mono>
                    <Link href={`/admin/payments/orders/${r.order.id}`} className="text-[var(--color-primary)] hover:underline">
                      {r.order.orderNumber}
                    </Link>{" "}
                    <EnvBadge env={r.order.environment} />
                  </Td>
                  <Td>{r.order.student.name}</Td>
                  <Td mono>{r.payment.gatewayPaymentId}</Td>
                  <Td right>{formatInr(r.amountPaise)}</Td>
                  <Td>{r.accessPolicy.replace(/_/g, " ")}</Td>
                  <Td>
                    <StatusBadge status={r.status} />
                    {r.failureReason ? <div className="text-[10px] text-[var(--color-error)]">{r.failureReason}</div> : null}
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
