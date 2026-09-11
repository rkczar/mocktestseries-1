import type { Metadata } from "next";
import { Check } from "lucide-react";
import Link from "next/link";

import { Container } from "@/components/common/Container";
import { cn } from "@/lib/utils";
import { prisma } from "@/lib/db";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple pricing to start free and unlock full access when you're ready.",
};

function formatPrice(priceInPaise: number) {
  if (priceInPaise === 0) return "₹0";
  return `₹${(priceInPaise / 100).toLocaleString("en-IN")}`;
}

export default async function PricingPage() {
  const plans = await prisma.pricingPlan.findMany({
    where: { isActive: true },
    orderBy: { order: "asc" },
  });

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
        Pricing
      </p>
      <h1 className="mt-2 font-display text-[clamp(28px,3.4vw,40px)] leading-[1.1] font-bold tracking-[-.02em] text-text-heading">
        Start free, upgrade when you&apos;re ready
      </h1>
      <p className="mt-2 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
        No subscriptions to cancel. Full access is a one-time unlock per exam.
      </p>

      {plans.length === 0 ? (
        <p className="mt-8 text-[15px] text-text-faint">Pricing is being set up — check back soon.</p>
      ) : (
        <div className="mt-9 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-6">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={cn(
                "flex flex-col rounded-2xl border bg-surface p-7",
                plan.isPopular ? "border-[1.5px] border-primary shadow-[0_10px_30px_-20px_rgba(15,76,129,.4)]" : "border-border",
              )}
            >
              {plan.isPopular ? (
                <span className="mb-3 inline-flex w-fit rounded-full bg-primary-tint px-3 py-1 font-mono text-[11px] font-semibold tracking-[.06em] text-primary uppercase">
                  Most popular
                </span>
              ) : null}
              <h2 className="text-xl font-extrabold text-text-heading">{plan.name}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{plan.description}</p>
              <p className="mt-5 flex items-baseline gap-1.5">
                <span className="font-display text-4xl font-bold text-text-heading">
                  {formatPrice(plan.priceInPaise)}
                </span>
                <span className="text-sm text-text-faint">/ {plan.period}</span>
              </p>
              <ul className="mt-6 flex flex-col gap-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5 text-sm text-text-muted">
                    <Check className="mt-0.5 size-4 flex-none text-success" strokeWidth={2.4} />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                href="/student/register"
                className={cn(
                  "mt-7 inline-flex items-center justify-center rounded-[10px] px-6 py-3 text-[15px] font-bold",
                  plan.isPopular
                    ? "bg-primary text-primary-foreground hover:bg-primary-hover"
                    : "border border-border-strong text-primary hover:bg-accent",
                )}
              >
                {plan.ctaLabel}
              </Link>
            </div>
          ))}
        </div>
      )}
    </Container>
  );
}
