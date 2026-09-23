"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatInr } from "@/lib/payments/money";
import { orderStatusAction } from "../../actions";

interface Props {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    amountPaise: number;
    couponCode: string | null;
    environment: "TEST" | "LIVE";
    productName: string;
    productCode: string;
    openHref: string;
    expiresAt: string | null;
    hasEntitlement: boolean;
    invoiceId: string | null;
  };
  verifyFailed: boolean;
}

const SUCCESS = ["PAID", "PARTIALLY_REFUNDED"];
const PENDING = ["CREATED", "GATEWAY_ORDER_CREATED", "PAYMENT_PENDING"];

export function OrderResultClient({ order, verifyFailed }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(order.status);
  const [polls, setPolls] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending order is re-checked server-side (which reconciles with
  // Razorpay), so access is restored even if the browser callback was lost.
  useEffect(() => {
    if (!PENDING.includes(status) || polls >= 12) return;
    timer.current = setTimeout(async () => {
      const r = await orderStatusAction(order.id);
      setPolls((n) => n + 1);
      if (r.ok && r.data.status !== status) {
        setStatus(r.data.status);
        if (!PENDING.includes(r.data.status)) router.refresh();
      }
    }, polls < 4 ? 2500 : 6000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [status, polls, order.id, router]);

  const success = SUCCESS.includes(status);
  const pending = PENDING.includes(status);

  return (
    <div className="mx-auto w-full max-w-lg">
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          {success ? (
            <CheckCircle2 className="h-10 w-10 text-[var(--color-success)]" aria-hidden />
          ) : pending ? (
            <Loader2 className="h-10 w-10 animate-spin text-[var(--color-primary)]" aria-hidden />
          ) : (
            <XCircle className="h-10 w-10 text-[var(--color-error)]" aria-hidden />
          )}
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]" aria-live="polite">
            {success ? "Payment Successful" : pending ? "Payment Processing" : "Payment Failed"}
          </h1>
          {order.environment === "TEST" ? <Badge variant="warning">TEST MODE</Badge> : null}
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {order.productName}
            {order.amountPaise > 0 ? ` — ${formatInr(order.amountPaise)}` : order.couponCode ? ` — free with ${order.couponCode}` : ""}
          </p>
          <p className="font-mono text-xs text-[var(--color-muted-foreground)]">Order {order.orderNumber}</p>

          {success && order.hasEntitlement ? (
            <p className="text-sm text-[var(--color-success)]">
              {order.expiresAt
                ? `Access active until ${new Date(order.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.`
                : "Lifetime access activated."}
            </p>
          ) : null}
          {pending ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {polls >= 12
                ? "Still confirming with the bank. If money was deducted, your access will activate automatically — check My Subscriptions shortly."
                : "Confirming your payment with Razorpay. Please don't close this page."}
            </p>
          ) : null}
          {!success && !pending ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {verifyFailed
                ? "We couldn't verify this payment. If money was deducted it will be reconciled automatically, or refunded by your bank."
                : "No access was granted for this order. You can try again."}
            </p>
          ) : null}

          <div className="flex w-full flex-col gap-2">
            {success ? (
              <Button asChild>
                <Link href={order.openHref}>Start Learning</Link>
              </Button>
            ) : !pending ? (
              <Button asChild>
                <Link href={`/student/checkout/${encodeURIComponent(order.productCode)}`}>Retry</Link>
              </Button>
            ) : null}
            {order.invoiceId ? (
              <Button asChild variant="outline">
                <a href={`/api/student/invoices/${order.invoiceId}`}>Download Invoice</a>
              </Button>
            ) : null}
            <Button asChild variant="ghost">
              <Link href="/student/subscriptions">My Subscriptions</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
