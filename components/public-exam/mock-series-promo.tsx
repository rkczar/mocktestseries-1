import Link from "next/link";
import { CalendarClock, ClipboardList } from "lucide-react";
import { formatInr } from "@/lib/payments/money";
import { formatIst } from "@/lib/ist-time";
import type { ExamMockSeriesSummary, SeriesOffer } from "@/lib/mock-series";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Server-computed price from the canonical Product (lib/mock-series.ts →
 * lib/payments/pricing.ts). Renders nothing unless a real purchasable price
 * applies, so a "% OFF" badge only ever reflects MRP vs current price.
 */
export function OfferPrice({ offer, size = "md" }: { offer: SeriesOffer | null; size?: "md" | "lg" }) {
  if (!offer?.showPrice) return null;
  const { price } = offer;
  const discounted = price.mrpPaise > price.pricePaise;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={size === "lg" ? "text-3xl font-semibold text-[var(--color-foreground)]" : "text-xl font-semibold text-[var(--color-foreground)]"}>
        {formatInr(price.pricePaise)}
      </span>
      {discounted ? (
        <>
          <span className="text-sm text-[var(--color-muted-foreground)] line-through">{formatInr(price.mrpPaise)}</span>
          <Badge variant="success">{price.discountPercent}% OFF</Badge>
        </>
      ) : null}
      {price.saleEndsAt ? (
        <span className="w-full text-xs text-[var(--color-muted-foreground)]">Offer ends {formatIst(price.saleEndsAt)} IST</span>
      ) : null}
    </div>
  );
}

/** "50 planned · 3 available now" — always real counts. */
export function SeriesCounts({ summary }: { summary: ExamMockSeriesSummary }) {
  const s = summary.mockSeries;
  if (!s) return null;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-[var(--color-muted-foreground)]">
      {s.planned > 0 ? (
        <span className="flex items-center gap-1.5">
          <ClipboardList className="h-4 w-4" aria-hidden />
          <span className="font-semibold text-[var(--color-foreground)]">{s.planned}</span> Mock Tests Planned
        </span>
      ) : null}
      <span className="flex items-center gap-1.5">
        <CalendarClock className="h-4 w-4" aria-hidden />
        <span className="font-semibold text-[var(--color-foreground)]">{s.available}</span> Available Now
        {s.upcoming > 0 ? <> · {s.upcoming} scheduled</> : null}
      </span>
    </div>
  );
}

/**
 * Contextual Mock Test Series card for the Exam Hub and its deep pages
 * (PYQ, Syllabus, Exam Pattern, Question Bank). Hidden when the exam has no
 * published series — never links to a page that would be empty.
 */
export function MockSeriesPromo({
  summary,
  heading,
  blurb,
}: {
  summary: ExamMockSeriesSummary;
  heading?: string;
  blurb?: string;
}) {
  if (!summary.mockSeries || !summary.href) return null;
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 sm:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-primary)]">Mock Test Series</p>
          <h2 className="text-xl font-semibold text-[var(--color-foreground)]">{heading ?? summary.mockSeries.series.name}</h2>
          {blurb ? <p className="max-w-2xl text-sm text-[var(--color-muted-foreground)]">{blurb}</p> : null}
          <SeriesCounts summary={summary} />
        </div>
        <div className="flex flex-col gap-3 md:items-end">
          <OfferPrice offer={summary.offer} />
          <Button asChild>
            <Link href={summary.href}>View Mock Test Series</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
