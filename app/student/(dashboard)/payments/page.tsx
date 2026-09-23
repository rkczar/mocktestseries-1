import Link from "next/link";
import { requireStudent } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Payments & Invoices — Mock Test Series.in" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { label: string; variant: "success" | "warning" | "error" | "neutral" | "info" }> = {
  PAID: { label: "Successful", variant: "success" },
  PARTIALLY_REFUNDED: { label: "Partially refunded", variant: "info" },
  REFUNDED: { label: "Refunded", variant: "info" },
  CREATED: { label: "Processing", variant: "warning" },
  GATEWAY_ORDER_CREATED: { label: "Awaiting payment", variant: "warning" },
  PAYMENT_PENDING: { label: "Processing", variant: "warning" },
  FAILED: { label: "Failed", variant: "error" },
  CANCELLED: { label: "Cancelled", variant: "neutral" },
  EXPIRED: { label: "Expired", variant: "neutral" },
};

/** Every query is scoped by the session's studentId — no other student's orders are reachable. */
export default async function PaymentsPage() {
  const student = await requireStudent();
  const orders = await prisma.paymentOrder.findMany({
    where: { studentId: student.id },
    include: {
      product: { select: { name: true } },
      payments: { select: { method: true, status: true }, orderBy: { createdAt: "desc" } },
      invoice: { select: { id: true, invoiceNumber: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Payments &amp; Invoices</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Your order and payment history.</p>
      </div>
      {orders.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">No payments yet.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment History</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase text-[var(--color-muted-foreground)]">
                <tr className="border-b border-[var(--color-border)]">
                  <th className="py-2 pr-3">Order</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Product</th>
                  <th className="py-2 pr-3 text-right">Price</th>
                  <th className="py-2 pr-3 text-right">Discount</th>
                  <th className="py-2 pr-3">Coupon</th>
                  <th className="py-2 pr-3 text-right">Paid</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Method</th>
                  <th className="py-2">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const s = STATUS_LABEL[o.status] ?? { label: o.status, variant: "neutral" as const };
                  const method = o.payments.find((p) => p.method)?.method ?? (o.gateway === "INTERNAL" ? "coupon" : null);
                  return (
                    <tr key={o.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">
                        <Link href={`/student/checkout/result/${o.id}`} className="hover:underline">
                          {o.orderNumber}
                        </Link>
                        {o.environment === "TEST" ? <Badge variant="warning" className="ml-1">TEST</Badge> : null}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">{o.createdAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</td>
                      <td className="py-2 pr-3">{o.product.name}</td>
                      <td className="py-2 pr-3 text-right">{formatInr(o.mrpPaise)}</td>
                      <td className="py-2 pr-3 text-right">{formatInr(o.mrpPaise - o.amountPaise)}</td>
                      <td className="py-2 pr-3">{o.couponCode ?? "—"}</td>
                      <td className="py-2 pr-3 text-right font-medium">{formatInr(o.amountPaise)}</td>
                      <td className="py-2 pr-3"><Badge variant={s.variant}>{s.label}</Badge></td>
                      <td className="py-2 pr-3 uppercase text-xs">{method ?? "—"}</td>
                      <td className="py-2">
                        {o.invoice ? (
                          <a href={`/api/student/invoices/${o.invoice.id}`} className="text-[var(--color-primary)] hover:underline">
                            Download
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
