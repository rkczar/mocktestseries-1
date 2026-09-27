import Link from "next/link";
import { BadgeCheck, CalendarClock, Check, Clock, Lock, LockOpen, Receipt, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatInr } from "@/lib/payments/money";
import { PlanComparison } from "@/components/payments/plan-comparison";
import { RENEWAL_REMINDER_DAYS, type ExamAccessSummary } from "@/lib/payments/student-access";

/**
 * Access / subscription card for one exam (Student Dashboard block
 * "access-status", and the compact banner on the Test Series page). Every
 * value comes from getStudentExamAccessSummaries() — the canonical
 * entitlement engine + canonical Product price. Display only: checkout and
 * test start re-check everything server-side.
 */

const longDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
const DASHBOARD_COMPARISON_ROWS = 6;

export function AccessPanel({ summary, variant = "full" }: { summary: ExamAccessSummary; variant?: "full" | "compact" }) {
  if (variant === "compact") return <CompactAccessBanner summary={summary} />;
  switch (summary.state) {
    case "ACTIVE":
      return <ActiveCard summary={summary} />;
    case "EXPIRED":
      return <ExpiredCard summary={summary} />;
    case "FREE":
    case "UNAVAILABLE":
      return summary.display.promoVisible ? <UpgradeCard summary={summary} /> : <FreeStatusStrip summary={summary} />;
    case "FREE_MODE":
      return (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div className="flex flex-col gap-1">
              <Eyebrow summary={summary} badge={<Badge variant="success">ALL TESTS FREE</Badge>} />
              <p className="text-sm text-[var(--color-foreground)]">Every test in {summary.series?.name ?? summary.exam.name} is currently free for signed-in students.</p>
            </div>
            <Button asChild size="sm">
              <Link href="/student/test-series">View Test Series</Link>
            </Button>
          </CardContent>
        </Card>
      );
  }
}

function Eyebrow({ summary, badge }: { summary: ExamAccessSummary; badge: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{summary.exam.name}</span>
      {badge}
    </div>
  );
}

function Price({ summary, size = "md" }: { summary: ExamAccessSummary; size?: "md" | "sm" }) {
  const offer = summary.offer;
  if (!offer?.showPrice) return null;
  const p = offer.price;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={size === "md" ? "text-3xl font-semibold text-[var(--color-foreground)]" : "text-lg font-semibold text-[var(--color-foreground)]"}>
        {formatInr(p.pricePaise)}
      </span>
      {p.mrpPaise > p.pricePaise ? (
        <>
          <span className="text-sm text-[var(--color-muted-foreground)] line-through">{formatInr(p.mrpPaise)}</span>
          <Badge variant="success">{p.discountPercent}% OFF</Badge>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</p>
      <p className="text-sm font-semibold text-[var(--color-foreground)]">{value}</p>
    </div>
  );
}

function UpgradeCard({ summary }: { summary: ExamAccessSummary }) {
  const { display, offer, series } = summary;
  const planned = series?.planned ?? 0;
  const description =
    display.description ||
    `You currently have Free Access. Complete Access unlocks ${planned > 0 ? `all ${planned} planned mocks` : "every mock"}${series ? ` in ${series.name}` : ""} as they release.`;
  return (
    <Card className="overflow-hidden border-[var(--color-primary)]/35">
      <CardContent className="grid gap-5 pt-5 lg:grid-cols-[1fr_280px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Eyebrow summary={summary} badge={<Badge variant="info">FREE ACCESS</Badge>} />
            <h2 className="text-lg font-semibold text-[var(--color-foreground)]">{display.heading}</h2>
            <p className="text-sm text-[var(--color-muted-foreground)]">{description}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {series ? <Stat label="Test Series" value={<span className="line-clamp-2">{series.name}</span>} /> : null}
            <Stat label="Free tests" value={summary.freeMocks} />
            <Stat label="Complete Access tests" value={summary.lockedMocks > 0 ? `${summary.lockedMocks} locked` : planned > 0 ? `All ${planned} planned` : "All"} />
          </div>
          {summary.benefits.length > 0 ? (
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {summary.benefits.slice(0, 6).map((b) => (
                <li key={b} className="flex items-start gap-2 text-[var(--color-foreground)]">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden /> {b}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-primary)]">Complete Access</p>
          <Price summary={summary} />
          {offer ? (
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
              <Clock className="h-3.5 w-3.5" aria-hidden /> {offer.product.accessDuration}
            </p>
          ) : null}
          {summary.checkoutHref ? (
            <Button asChild>
              <Link href={summary.checkoutHref}>
                <LockOpen className="h-4 w-4" aria-hidden /> {display.ctaLabel}
              </Link>
            </Button>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">{summary.unavailableReason ?? "Complete Access is not available for purchase right now."}</p>
          )}
          <Button asChild variant="ghost" size="sm">
            <Link href={summary.comparisonHref}>View full comparison</Link>
          </Button>
        </div>
      </CardContent>
      {summary.comparison.length > 0 ? (
        <CardContent className="border-t border-[var(--color-border)] pt-4">
          <p className="mb-2 text-sm font-medium text-[var(--color-foreground)]">Free vs Complete Access</p>
          <PlanComparison rows={summary.comparison.slice(0, DASHBOARD_COMPARISON_ROWS)} completeLabel="Complete Access" compact />
        </CardContent>
      ) : null}
    </Card>
  );
}

function FreeStatusStrip({ summary }: { summary: ExamAccessSummary }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
        <div className="flex flex-col gap-1">
          <Eyebrow summary={summary} badge={<Badge variant="info">FREE ACCESS</Badge>} />
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {summary.freeMocks} free test{summary.freeMocks === 1 ? "" : "s"} open
            {summary.lockedMocks > 0 ? ` · ${summary.lockedMocks} need Complete Access` : ""}.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href={summary.comparisonHref}>View plans</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ActiveCard({ summary }: { summary: ExamAccessSummary }) {
  const ent = summary.entitlement!;
  const lifetime = ent.expiresAt === null;
  const nearExpiry = ent.daysLeft !== null && ent.daysLeft <= RENEWAL_REMINDER_DAYS;
  const scope = summary.series
    ? `All ${summary.series.published} published mock${summary.series.published === 1 ? "" : "s"}${summary.series.planned > summary.series.published ? ` (${summary.series.planned} planned)` : ""}`
    : "Full exam access";
  return (
    <Card className="border-[var(--color-success)]/40">
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Eyebrow summary={summary} badge={<Badge variant="success"><BadgeCheck className="h-3 w-3" aria-hidden /> Complete Access — Active</Badge>} />
            <h2 className="text-lg font-semibold text-[var(--color-foreground)]">{ent.productName}</h2>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {lifetime ? "You have lifetime Complete Access." : `Your Complete Access is active until ${longDate(ent.expiresAt!)}.`}
            </p>
          </div>
          <Button asChild>
            <Link href="/student/test-series">View Test Series</Link>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Status" value={<span className="text-[var(--color-success)]">Active</span>} />
          {ent.since ? <Stat label="Active since" value={longDate(ent.since)} /> : null}
          <Stat label="Valid until" value={lifetime ? "No expiry" : longDate(ent.expiresAt!)} />
          {ent.daysLeft !== null ? <Stat label="Days remaining" value={ent.daysLeft} /> : <Stat label="Access scope" value={scope} />}
          {ent.daysLeft !== null ? <Stat label="Access scope" value={scope} /> : null}
        </div>
        {nearExpiry ? (
          <p className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-[var(--color-foreground)]">
            <CalendarClock className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
            {ent.daysLeft! <= 1 ? "Your access ends within a day." : `Your access ends in ${ent.daysLeft} days.`}
            {summary.checkoutHref ? " Extend now to keep practising without a break." : ""}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/student/subscriptions">
              <BadgeCheck className="h-4 w-4" aria-hidden /> My Subscription
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/student/payments">
              <Receipt className="h-4 w-4" aria-hidden /> Payments &amp; Invoices
            </Link>
          </Button>
          {summary.checkoutHref && !lifetime ? (
            <Button asChild size="sm" variant={nearExpiry ? "primary" : "ghost"}>
              <Link href={summary.checkoutHref}>Extend Access</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ExpiredCard({ summary }: { summary: ExamAccessSummary }) {
  const ent = summary.entitlement!;
  return (
    <Card className="border-[var(--color-warning)]/45">
      <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Eyebrow summary={summary} badge={<Badge variant="warning">EXPIRED</Badge>} />
          <h2 className="text-lg font-semibold text-[var(--color-foreground)]">Your Complete Access has expired</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {ent.productName}
            {ent.expiresAt ? ` · expired on ${longDate(ent.expiresAt)}` : ""}. Free tests stay open; renew to unlock every mock again.
          </p>
          {summary.offer?.showPrice ? (
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <Price summary={summary} size="sm" />
              <span className="text-xs text-[var(--color-muted-foreground)]">{summary.offer.product.accessDuration}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {summary.checkoutHref ? (
            <Button asChild>
              <Link href={summary.checkoutHref}>Renew Access</Link>
            </Button>
          ) : (
            <p className="max-w-xs text-sm text-[var(--color-muted-foreground)]">{summary.unavailableReason ?? "Renewal is not available right now."}</p>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link href="/student/subscriptions">My Subscription</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** One-line banner above the Test Series list. */
function CompactAccessBanner({ summary }: { summary: ExamAccessSummary }) {
  if (summary.state === "FREE_MODE") return null;
  const ent = summary.entitlement;
  if (summary.state === "ACTIVE" && ent) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/5 px-4 py-3 text-sm">
        <span className="flex items-center gap-2 text-[var(--color-foreground)]">
          <BadgeCheck className="h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
          <span>
            <strong>Complete Access — Active</strong> · {summary.series?.name ?? summary.exam.name}
            {ent.expiresAt ? ` · valid until ${longDate(ent.expiresAt)}` : " · lifetime"}
          </span>
        </span>
        <Link href="/student/subscriptions" className="text-xs font-medium text-[var(--color-primary)] hover:underline">
          My Subscription
        </Link>
      </div>
    );
  }
  const expired = summary.state === "EXPIRED";
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        {expired ? (
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
        ) : (
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
        )}
        <div>
          <p className="font-medium text-[var(--color-foreground)]">
            {expired ? "Your Complete Access has expired" : `You have Free Access to ${summary.series?.name ?? summary.exam.name}`}
          </p>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {summary.freeMocks} free test{summary.freeMocks === 1 ? "" : "s"}
            {summary.lockedMocks > 0 ? ` · ${summary.lockedMocks} marked "Complete Access required"` : ""}
            {expired && ent?.expiresAt ? ` · expired on ${longDate(ent.expiresAt)}` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Price summary={summary} size="sm" />
        {summary.checkoutHref ? (
          <Button asChild size="sm">
            <Link href={summary.checkoutHref}>{expired ? "Renew Access" : summary.display.ctaLabel}</Link>
          </Button>
        ) : summary.unavailableReason ? (
          <span className="text-xs text-[var(--color-muted-foreground)]">{summary.unavailableReason}</span>
        ) : null}
        <Link href={summary.comparisonHref} className="text-xs font-medium text-[var(--color-primary)] hover:underline">
          Compare plans
        </Link>
      </div>
    </div>
  );
}
