import Link from "next/link";
import { Crown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatInr } from "@/lib/payments/money";
import { formatIst } from "@/lib/ist-time";
import { PLANS_AND_PRICING_PATH } from "@/lib/plans-path";
import type { ExamAccessSummary } from "@/lib/payments/student-access";
import type { TrialStatus } from "@/lib/premium-trial";

/**
 * Compact "Upgrade to Premium" card (Student Dashboard block
 * "premium-upgrade"). Decided only from server data: the exam's canonical
 * access summary (paid entitlements; the trial never counts as a purchase
 * there) and the one-time trial status. Shown to Free, trial (active or
 * ended) and expired-plan students when a purchase can actually complete;
 * never to a student with active paid access. No countdown, no popup —
 * the trial popup stays the only modal.
 */
export function shouldShowUpgradeBanner(summary: ExamAccessSummary, trial: TrialStatus | null): boolean {
  return (summary.state === "FREE" || summary.state === "EXPIRED") && Boolean(summary.checkoutHref) && trial?.phase !== "PAID";
}

export function UpgradeBanner({ summary, trial }: { summary: ExamAccessSummary; trial: TrialStatus | null }) {
  if (!shouldShowUpgradeBanner(summary, trial)) return null;

  const examName = summary.exam.name;
  const trialEndsAt = trial?.trial?.endsAt ?? null;
  const text =
    (trial?.phase === "ACTIVE" || trial?.phase === "ENDING") && trialEndsAt
      ? `Your free trial is active until ${formatIst(trialEndsAt)}. Buy Premium to keep complete access after it ends.`
      : trial?.phase === "EXPIRED"
        ? `Your free trial has ended. Upgrade to unlock every test and answer review in ${examName} again.`
        : summary.state === "EXPIRED"
          ? `Your Complete Access has expired. Upgrade to unlock every test in ${examName} again.`
          : `You're on the Free plan. Upgrade to unlock every test and answer review in ${examName}.`;
  const offer = summary.offer?.showPrice ? summary.offer : null;

  return (
    <Card className="border-[var(--color-primary)]/40" data-testid="upgrade-banner">
      <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white">
            <Crown className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--color-foreground)]">Upgrade to Premium</p>
            <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="upgrade-banner-text">
              {text}
            </p>
            {offer ? (
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                {formatInr(offer.price.pricePaise)} · {offer.product.accessDuration}
              </p>
            ) : null}
          </div>
        </div>
        <Button asChild className="w-full shrink-0 sm:w-auto">
          <Link href={PLANS_AND_PRICING_PATH}>Get Complete Access</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
