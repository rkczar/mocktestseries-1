import type { LedgerPeriod } from "@/lib/ai-import/ledger";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Actual spend as it must be read: provider-reported cost, plus requests whose cost is unknown or still running (never shown as ₹0). */
function actual(p: LedgerPeriod | null): { value: string; detail: string | null } {
  if (!p || p.requests === 0) return { value: "₹0.00", detail: "no AI request yet" };
  const extra: string[] = [];
  if (p.unknownRequests) extra.push(`${p.unknownRequests} request${p.unknownRequests === 1 ? "" : "s"} with unknown cost (up to ${inr(p.unknownHeldInr)})`);
  if (p.inflightRequests) extra.push(`${p.inflightRequests} in progress (up to ${inr(p.inflightInr)})`);
  if (!p.actualRequests && p.unknownRequests) return { value: "Unknown", detail: extra.join(" · ") };
  return { value: inr(p.actualInr), detail: extra.length ? `plus ${extra.join(" · ")}` : null };
}

/** One priced step of the estimate (page reading, second read, classification, answer key). */
export interface CostBreakdownLine {
  label: string;
  calls: number;
  inr: number | null;
  maxInr: number | null;
}

/**
 * The importer's cost figures for one job: its estimate and estimated maximum (before processing), its actual
 * spend, and this month's actual importer spend (AI Question Importer only — no Ask AI, Instagram or other features).
 */
export function CostSummary({ estimateInr, maxInr, job, month, istMonth, priced = true, breakdown, confirmedMaxInr }: { estimateInr: number | null; maxInr: number | null; job: LedgerPeriod | null; month: LedgerPeriod; istMonth: string; priced?: boolean; breakdown?: CostBreakdownLine[]; confirmedMaxInr?: number | null }) {
  const [y, m] = istMonth.split("-");
  const j = actual(job);
  const mo = actual(month);
  const rows: { id: string; label: string; value: string; detail?: string | null }[] = [
    { id: "cost-estimate", label: "Estimated cost", value: priced ? inr(estimateInr) : "Unknown — not priced" },
    { id: "cost-max", label: "Estimated maximum", value: priced ? inr(maxInr) : "Unknown — not priced", detail: "an estimate: every request at its worst case" },
    // After confirmation: the maximum an administrator approved for this job (raised only by a new confirmation).
    ...(confirmedMaxInr !== undefined ? [{ id: "cost-confirmed-max", label: "Confirmed maximum", value: inr(confirmedMaxInr), detail: "approved by an administrator — never exceeded without a new confirmation" }] : []),
    { id: "cost-job-actual", label: "This job's actual spend", value: j.value, detail: j.detail },
    { id: "cost-month-actual", label: `Importer spend in ${MONTHS[Number(m) - 1] ?? m} ${y}`, value: mo.value, detail: mo.detail ?? "actual, all imports" },
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="cost-summary">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid={r.id}>
            <dt className="text-xs text-[var(--color-muted-foreground)]">{r.label}</dt>
            <dd className="text-base font-semibold" data-testid={`${r.id}-value`}>
              {r.value}
            </dd>
            {r.detail && <dd className="text-xs text-[var(--color-muted-foreground)]">{r.detail}</dd>}
          </div>
        ))}
      </dl>
      {breakdown && breakdown.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs" data-testid="cost-breakdown">
          {breakdown.map((l) => (
            <li key={l.label} className="flex flex-wrap justify-between gap-x-3" data-testid="cost-breakdown-line">
              <span>
                {l.label} · {l.calls} AI request{l.calls === 1 ? "" : "s"}
              </span>
              <span>
                {l.inr === null ? "Unknown — not priced" : inr(l.inr)}
                {l.maxInr !== null && <span className="text-[var(--color-muted-foreground)]"> (max {inr(l.maxInr)})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="cost-note">
        Estimates use current provider prices (refreshed again when you confirm); the final cost may differ. Actual spend is what OpenRouter reported for the AI Question Importer only.
      </p>
    </div>
  );
}
