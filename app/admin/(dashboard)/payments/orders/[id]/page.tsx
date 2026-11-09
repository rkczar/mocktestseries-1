import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatInr, paiseToRupeeString } from "@/lib/payments/money";
import { getPaymentPolicy } from "@/lib/payments/settings";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { BackButton } from "@/components/student/back-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { getPaymentsAccess } from "../../_components/access";
import { ActionForm } from "../../_components/action-form";
import { reconcileOrderAction, requestRefundAction } from "../../actions";
import { OrderDetailView } from "@/components/admin/payment-order-detail";
import { ORDER_DETAIL_INCLUDE } from "@/lib/payments/order-detail";

export const metadata = { title: "Order — Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { canView, canManage } = await getPaymentsAccess();
  if (!canView) return <RestrictedCard title="Payments" />;
  const { id } = await params;
  const [order, policy] = await Promise.all([
    prisma.paymentOrder.findUnique({
      where: { id },
      include: {
        ...ORDER_DETAIL_INCLUDE,
        student: { select: { id: true, name: true, studentId: true, email: true } },
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
      <OrderDetailView
        order={order}
        hooks={hooks}
        studentHref={(id) => `/admin/students/${id}`}
        reconcileSlot={
          canManage && order.gateway === "RAZORPAY" ? (
            <ActionForm action={reconcileOrderAction} submitLabel="Re-check with Razorpay & repair" variant="outline">
              <input type="hidden" name="orderId" value={order.id} />
            </ActionForm>
          ) : null
        }
        refundSlot={
          canManage && refundable.length > 0 ? (
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
          ) : null
        }
      />
    </div>
  );
}
