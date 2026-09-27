import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OfferDisplayCell, OfferDisplayRow } from "@/lib/payments/offer-display-shared";

/**
 * The ONE Free vs Complete comparison renderer (public Mock Test Series page,
 * Student Dashboard, Test Series page). Rows come from getSeriesComparison()
 * in lib/mock-series.ts — never typed into a page. md+: table; phones:
 * stacked cards, no horizontal scroll.
 */
export function PlanComparison({
  rows,
  completeLabel = "Complete Series",
  compact = false,
  className,
}: {
  rows: OfferDisplayRow[];
  completeLabel?: string;
  compact?: boolean;
  className?: string;
}) {
  if (rows.length === 0) return null;
  const pad = compact ? "px-3 py-2" : "px-4 py-3";
  return (
    <div className={className}>
      <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-[var(--color-surface)]">
            <tr className="text-xs uppercase text-[var(--color-muted-foreground)]">
              <th className={cn(pad, "font-medium")}>Feature</th>
              <th className={cn(pad, "font-medium")}>Free</th>
              <th className={cn(pad, "font-medium text-[var(--color-foreground)]")}>{completeLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={cn("border-t border-[var(--color-border)]", r.highlight && "bg-[var(--color-primary)]/5")}>
                <td className={cn(pad, "font-medium text-[var(--color-foreground)]")}>
                  {r.feature}
                  {r.note && !compact ? <span className="block text-xs font-normal text-[var(--color-muted-foreground)]">{r.note}</span> : null}
                </td>
                <td className={cn(pad, "text-[var(--color-muted-foreground)]")}>
                  <Cell cell={r.free} />
                </td>
                <td className={cn(pad, "text-[var(--color-foreground)]")}>
                  <Cell cell={r.paid} strong />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <div
            key={r.key}
            className={cn(
              "rounded-[var(--radius-card)] border border-[var(--color-border)] p-3",
              r.highlight && "border-[var(--color-primary)]/40 bg-[var(--color-primary)]/5"
            )}
          >
            <p className="text-sm font-medium text-[var(--color-foreground)]">{r.feature}</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-[11px] uppercase text-[var(--color-muted-foreground)]">Free</dt>
                <dd className="text-[var(--color-muted-foreground)]">
                  <Cell cell={r.free} />
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-[var(--color-muted-foreground)]">Complete</dt>
                <dd className="text-[var(--color-foreground)]">
                  <Cell cell={r.paid} strong />
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function Cell({ cell, strong = false }: { cell: OfferDisplayCell; strong?: boolean }) {
  if (cell.state === "check")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Check className={cn("h-4 w-4 shrink-0", strong ? "text-[var(--color-success)]" : "text-[var(--color-success)]/80")} aria-hidden />
        <span className={cell.text === "Included" ? "sr-only" : undefined}>{cell.text}</span>
      </span>
    );
  if (cell.state === "cross")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Minus className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
        <span className={cell.text === "Not included" ? "sr-only" : undefined}>{cell.text}</span>
      </span>
    );
  return <>{cell.text}</>;
}
