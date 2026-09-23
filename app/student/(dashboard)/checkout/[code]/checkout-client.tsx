"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BadgeCheck, Clock, Loader2, Lock, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatInr } from "@/lib/payments/money";
import { applyCouponAction, createOrderAction, verifyPaymentAction } from "../actions";

interface Props {
  product: { id: string; code: string; name: string; description: string | null; accessLabel: string; examName: string | null };
  price: { isFree: boolean; mrpPaise: number; pricePaise: number; discountPercent: number; savingsPaise: number; saleEndsAt: string | null };
  access: { status: string; mode: string; purchasesPaused: boolean; expiresAt: string | null };
  gatewayReady: boolean;
  environment: "TEST" | "LIVE";
  openHref: string;
  prefill: { name: string; email: string; contact: string };
}

interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, cb: (r: { error?: { description?: string } }) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadCheckoutScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    const s = existing ?? document.createElement("script");
    s.addEventListener("load", () => resolve(true));
    s.addEventListener("error", () => resolve(false));
    if (!existing) {
      s.src = CHECKOUT_SRC;
      s.async = true;
      document.body.appendChild(s);
    }
  });
}

function useCountdown(target: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!target) return null;
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return "Deal ended";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${pad(d)}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

export function CheckoutClient({ product, price, access, gatewayReady, environment, openHref, prefill }: Props) {
  const router = useRouter();
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<{ code: string; discountPaise: number; label: string | null } | null>(null);
  const [payablePaise, setPayablePaise] = useState(price.pricePaise);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingCoupon, startCoupon] = useTransition();
  const countdown = useCountdown(price.saleEndsAt);

  const owned = access.status === "ACTIVE_SUBSCRIPTION";
  const free = access.status === "FREE_ACCESS";
  const expired = access.status === "EXPIRED";
  const lifetimeOwned = owned && !access.expiresAt;
  const canBuy = !free && !lifetimeOwned && !access.purchasesPaused && access.status !== "NOT_AVAILABLE";

  function applyCoupon() {
    setCouponMsg(null);
    setError(null);
    startCoupon(async () => {
      const r = await applyCouponAction(product.code, couponInput);
      if (!r.ok) return setCouponMsg(r.error);
      if (r.data.couponError || !r.data.couponCode) {
        setCoupon(null);
        setPayablePaise(price.pricePaise);
        return setCouponMsg(r.data.couponError ?? "Coupon not applied.");
      }
      setCoupon({ code: r.data.couponCode, discountPaise: r.data.couponDiscountPaise, label: r.data.couponLabel });
      setPayablePaise(r.data.payablePaise);
    });
  }

  function removeCoupon() {
    setCoupon(null);
    setCouponInput("");
    setCouponMsg(null);
    setPayablePaise(price.pricePaise);
  }

  async function buy() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await createOrderAction(product.id, coupon?.code ?? null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.data.kind === "FREE_GRANT") {
        router.push(`/student/checkout/result/${r.data.orderId}`);
        return;
      }
      const order = r.data;
      const loaded = await loadCheckoutScript();
      if (!loaded || !window.Razorpay) {
        setError("Couldn't load the payment window. Check your connection and try again.");
        return;
      }
      const rzp = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: order.currency,
        order_id: order.gatewayOrderId,
        name: "MockTestSeries.in",
        description: order.productName,
        prefill,
        notes: { orderNumber: order.orderNumber },
        theme: { color: getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim() || undefined },
        handler: async (resp: RazorpayResponse) => {
          setBusy(true);
          setNotice("Payment received — verifying…");
          const v = await verifyPaymentAction({ orderId: order.orderId, ...resp });
          // Whatever the verify outcome, the result page shows the
          // server's canonical status (and polls if still processing).
          router.push(`/student/checkout/result/${order.orderId}${v.ok && v.data.status === "FAILED" ? "?verify=failed" : ""}`);
        },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setNotice("Payment window closed. You can try again anytime — you won't be charged twice.");
          },
        },
      });
      rzp.on("payment.failed", (resp) => {
        setError(resp.error?.description ? `Payment failed: ${resp.error.description}` : "Payment failed. Please try again.");
      });
      rzp.open();
    } finally {
      setBusy(false);
    }
  }

  const effectiveDiscountPct = price.mrpPaise > 0 ? Math.round(((price.mrpPaise - payablePaise) * 100) / price.mrpPaise) : 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader>
          {product.examName ? <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{product.examName}</p> : null}
          <CardTitle className="text-xl">{product.name}</CardTitle>
          {product.description ? <CardDescription className="whitespace-pre-line">{product.description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-[var(--color-muted-foreground)]">
          <p className="flex items-center gap-2">
            <Clock className="h-4 w-4" aria-hidden /> {product.accessLabel}
          </p>
          {owned ? (
            <p className="flex items-center gap-2 text-[var(--color-success)]">
              <BadgeCheck className="h-4 w-4" aria-hidden />
              {access.expiresAt
                ? `You have access until ${new Date(access.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.`
                : "You have lifetime access."}
            </p>
          ) : null}
          {expired ? <p className="text-[var(--color-warning)]">Your previous access has expired.</p> : null}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader className="gap-2">
          {environment === "TEST" && canBuy && !price.isFree ? (
            <Badge variant="warning" className="w-fit">TEST MODE — no real money is charged</Badge>
          ) : null}
          {free ? (
            <p className="text-2xl font-semibold text-[var(--color-success)]">Free</p>
          ) : (
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-3xl font-semibold text-[var(--color-foreground)]">{formatInr(payablePaise)}</span>
              {price.mrpPaise > payablePaise ? (
                <>
                  <span className="text-base text-[var(--color-muted-foreground)] line-through">{formatInr(price.mrpPaise)}</span>
                  <Badge variant="success">{effectiveDiscountPct}% OFF</Badge>
                </>
              ) : null}
            </div>
          )}
          {!free && price.mrpPaise > payablePaise ? (
            <p className="text-sm text-[var(--color-success)]">You save {formatInr(price.mrpPaise - payablePaise)}</p>
          ) : null}
          {countdown && !free ? (
            <p className="text-xs font-medium text-[var(--color-warning)]" aria-live="polite">
              Deal ends in {countdown}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {canBuy ? (
            <div className="flex flex-col gap-2">
              {coupon ? (
                <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 text-[var(--color-success)]">
                    <Tag className="h-4 w-4" aria-hidden /> {coupon.code} applied — −{formatInr(coupon.discountPaise)}
                  </span>
                  <button type="button" onClick={removeCoupon} className="text-xs text-[var(--color-muted-foreground)] underline">
                    Remove
                  </button>
                </div>
              ) : (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (couponInput.trim()) applyCoupon();
                  }}
                >
                  <Input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    placeholder="Enter coupon"
                    aria-label="Coupon code"
                    maxLength={32}
                    autoCapitalize="characters"
                  />
                  <Button type="submit" variant="outline" disabled={pendingCoupon || !couponInput.trim()}>
                    {pendingCoupon ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Apply"}
                  </Button>
                </form>
              )}
              {couponMsg ? <p className="text-xs text-[var(--color-error)]">{couponMsg}</p> : null}
            </div>
          ) : null}

          {coupon ? (
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-[var(--color-muted-foreground)]">Price</dt>
              <dd className="text-right">{formatInr(price.pricePaise)}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Coupon discount</dt>
              <dd className="text-right text-[var(--color-success)]">−{formatInr(coupon.discountPaise)}</dd>
              <dt className="font-medium">Payable</dt>
              <dd className="text-right font-semibold">{formatInr(payablePaise)}</dd>
            </dl>
          ) : null}

          {free || (owned && !canBuy) ? (
            <Button asChild size="lg">
              <Link href={openHref}>{free ? "Start Learning" : "Continue"}</Link>
            </Button>
          ) : canBuy ? (
            <>
              <Button size="lg" onClick={buy} disabled={busy || (!gatewayReady && payablePaise > 0)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Lock className="h-4 w-4" aria-hidden />}
                {payablePaise === 0 ? "Get Access" : expired ? "Renew Access" : owned ? "Extend Access" : "Buy Now"}
              </Button>
              {owned ? (
                <Button asChild variant="outline">
                  <Link href={openHref}>Continue</Link>
                </Button>
              ) : null}
              {!gatewayReady && payablePaise > 0 ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">Online payment isn&apos;t available yet. Please check back soon.</p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {access.purchasesPaused ? "Purchases are temporarily paused. Please try again later." : "This product isn't available for purchase right now."}
            </p>
          )}

          {notice ? <p className="text-xs text-[var(--color-muted-foreground)]" aria-live="polite">{notice}</p> : null}
          {error ? <p className="text-sm text-[var(--color-error)]" role="alert">{error}</p> : null}
          <p className="text-[11px] text-[var(--color-muted-foreground)]">
            Payments are processed securely by Razorpay. We never see or store your card, UPI PIN or OTP.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
