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
    startsAt: string | null;
    hasEntitlement: boolean;
    paidAt: string | null;
    paymentRef: string | null;
    paymentMethod: string | null;
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
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

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
          <div className="flex flex-col gap-1" aria-live="polite">
            <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
              {success ? "Payment successful" : pending ? "Payment confirmation pending" : "Payment failed"}
            </h1>
            {success && order.hasEntitlement ? <p className="text-sm font-medium text-[var(--color-success)]">Complete Access activated</p> : null}
          </div>
          {order.environment === "TEST" ? <Badge variant="warning">TEST MODE — no real money was charged</Badge> : null}

          <dl className="grid w-full grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left text-sm">
            <dt className="text-[var(--color-muted-foreground)]">Product</dt>
            <dd className="text-right font-medium text-[var(--color-foreground)]">{order.productName}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Amount</dt>
            <dd className="text-right text-[var(--color-foreground)]">
              {order.amountPaise > 0 ? formatInr(order.amountPaise) : order.couponCode ? `Free with ${order.couponCode}` : formatInr(0)}
            </dd>
            <dt className="text-[var(--color-muted-foreground)]">Order</dt>
            <dd className="break-all text-right font-mono text-xs text-[var(--color-foreground)]">{order.orderNumber}</dd>
            {order.paymentRef ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">Transaction</dt>
                <dd className="break-all text-right font-mono text-xs text-[var(--color-foreground)]">
                  {order.paymentRef}
                  {order.paymentMethod ? <span className="ml-1 font-sans uppercase text-[var(--color-muted-foreground)]">· {order.paymentMethod}</span> : null}
                </dd>
              </>
            ) : null}
            {success && order.hasEntitlement ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">Access validity</dt>
                <dd className="text-right text-[var(--color-foreground)]">
                  {order.expiresAt ? `${order.startsAt ? `${fmt(order.startsAt)} – ` : "Until "}${fmt(order.expiresAt)}` : "Lifetime"}
                </dd>
              </>
            ) : null}
          </dl>

          {pending ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {polls >= 12
                ? "Still confirming with the bank. If money was deducted, your access activates automatically once Razorpay confirms it — check My Subscription shortly. There's no need to pay again."
                : "Confirming your payment with Razorpay. You can keep this page open; access activates automatically."}
            </p>
          ) : null}
          {!success && !pending ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {verifyFailed
                ? "We couldn't verify this payment. If money was deducted it will be reconciled automatically, or refunded by your bank."
                : "No access was granted for this order. If money was deducted for a failed payment, your bank reverses it automatically. You can try again safely."}
            </p>
          ) : null}

          <div className="flex w-full flex-col gap-2">
            {success ? (
              <Button asChild>
                <Link href={order.openHref}>Start Learning — View Test Series</Link>
              </Button>
            ) : !pending ? (
              // Retry goes back through checkout, whose server-side order guard
              // reuses an open order / blocks in-flight duplicates.
              <Button asChild>
                <Link href={`/student/checkout/${encodeURIComponent(order.productCode)}`}>Try again</Link>
              </Button>
            ) : null}
            {order.invoiceId ? (
              <Button asChild variant="outline">
                <a href={`/api/student/invoices/${order.invoiceId}`}>Download Invoice</a>
              </Button>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Button asChild variant="ghost">
                <Link href="/student/subscriptions">My Subscription</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/student/payments">Payments &amp; Invoices</Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
