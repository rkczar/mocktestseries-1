import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatInr } from "@/lib/payments/money";
import type { PremiumAccessSummary } from "@/lib/plans-catalog";

type Cell = true | false | string;
interface Row {
  key: string;
  feature: string;
  free: Cell;
  trial: Cell;
  premium: Cell;
}

/**
 * FREE FOREVER | PREMIUM TRIAL | PREMIUM — shown on Plans & Pricing only while
 * Premium Access Enforcement is ON (lib/premium-policy.ts). Every cell
 * mirrors a server-side rule in lib/payments/access.ts; the free test titles,
 * price and validity come from the database. md+: table; phones: stacked
 * cards, no horizontal scroll.
 */
export function PremiumAccessComparison({ summary, className }: { summary: PremiumAccessSummary; className?: string }) {
  const trialLabel = summary.trialHours === 48 ? "2-Day Premium Trial" : `${summary.trialHours}-Hour Premium Trial`;
  const trialOn = summary.trialEnabled;
  const t = (v: Cell): Cell => (trialOn ? v : false);
  const freeTests = summary.free.filter((f) => /^(PYQ|Mock Test|Subject Test):/.test(f));
  const rows: Row[] = [
    {
      key: "price",
      feature: "Price",
      free: "₹0",
      trial: trialOn ? "₹0 — no payment details needed" : "Not available right now",
      premium: summary.premiumPlan ? formatInr(summary.premiumPlan.price.pricePaise) : "—",
    },
    {
      key: "validity",
      feature: "Validity",
      free: "Forever",
      trial: t(`${summary.trialHours} hours, once per student`),
      premium: summary.premiumPlan?.accessDuration ?? "—",
    },
    ...(freeTests.length > 0 ? [{ key: "free-tests", feature: `Selected free tests (${freeTests.join(" · ")})`, free: true, trial: t(true), premium: true } as Row] : []),
    { key: "pyq", feature: "All Previous Year Papers", free: false, trial: t(true), premium: true },
    { key: "mocks", feature: "All Mock Tests", free: false, trial: t(true), premium: true },
    { key: "subject", feature: "All Subject Tests", free: false, trial: t(true), premium: true },
    { key: "custom", feature: "Custom Modules", free: false, trial: t(true), premium: true },
    { key: "live-cbt", feature: "Premium Live CBT", free: false, trial: t(true), premium: true },
    { key: "analytics", feature: "Student Analytics & Performance Tracking", free: true, trial: t(true), premium: true },
    { key: "history", feature: "Attempt History & Previous Results", free: true, trial: t(true), premium: true },
  ];
  const heads = ["Free Forever", trialLabel, "Premium"];

  return (
    <div className={className} data-testid="premium-access-comparison">
      <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-[var(--color-surface)]">
            <tr className="text-xs uppercase text-[var(--color-muted-foreground)]">
              <th className="px-4 py-3 font-medium">Feature</th>
              {heads.map((h, i) => (
                <th key={h} className={cn("px-4 py-3 font-medium", i === 2 && "text-[var(--color-foreground)]")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-3 font-medium text-[var(--color-foreground)]">{r.feature}</td>
                <td className="px-4 py-3 text-[var(--color-muted-foreground)]">
                  <CellView cell={r.free} />
                </td>
                <td className="px-4 py-3 text-[var(--color-muted-foreground)]">
                  <CellView cell={r.trial} />
                </td>
                <td className="px-4 py-3 text-[var(--color-foreground)]">
                  <CellView cell={r.premium} strong />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <div key={r.key} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <p className="text-sm font-medium text-[var(--color-foreground)]">{r.feature}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              {[r.free, r.trial, r.premium].map((c, i) => (
                <div key={heads[i]} className="min-w-0">
                  <dt className="text-[var(--color-muted-foreground)]">{heads[i]}</dt>
                  <dd className="mt-0.5 break-words text-[var(--color-foreground)]">
                    <CellView cell={c} strong={i === 2} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

function CellView({ cell, strong = false }: { cell: Cell; strong?: boolean }) {
  if (cell === true) return <Check className="h-4 w-4 text-[var(--color-success)]" aria-label="Included" />;
  if (cell === false) return <Minus className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-label="Not included" />;
  return <span className={strong ? "font-medium" : undefined}>{cell}</span>;
}
