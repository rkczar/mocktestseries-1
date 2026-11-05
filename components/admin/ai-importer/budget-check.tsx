"use client";

import { useEffect, useState } from "react";
import { importerBudgetAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import type { SpendSummary } from "@/lib/ai-import/ledger";
import { ShortfallNote } from "@/components/admin/ai-importer/cost-summary";
import { budgetShortfall } from "@/lib/ai-import/budget-guard";

const inr = (v: number | null) => (v === null ? "—" : `₹${v.toFixed(2)}`);

/** The budget left and any shortfall for an operation of up to `maxInr`, shown inside a cost approval dialog. */
export function BudgetCheck({ maxInr }: { maxInr: number | null }) {
  const [budget, setBudget] = useState<SpendSummary["budget"] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    importerBudgetAction().then((r) => (r.ok ? setBudget(r.data) : setFailed(true)), () => setFailed(true));
  }, []);
  if (failed) return <p className="text-xs text-[var(--color-warning)]" data-testid="budget-check">The remaining budget could not be read; the budget is still enforced for every request.</p>;
  if (!budget) return <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="budget-check">Reading the remaining budget…</p>;
  const { monthLeft, totalLeft, short } = budgetShortfall(maxInr, budget);
  return (
    <div className="flex flex-col gap-1" data-testid="budget-check">
      <p className="text-xs">
        Monthly budget left: <b data-testid="budget-month-left">{inr(monthLeft)}</b> of {inr(budget.monthlyInr)} · initial paid-testing cap left: <b data-testid="budget-total-left">{inr(totalLeft)}</b> of {inr(budget.totalInr)}
      </p>
      <ShortfallNote short={short} />
    </div>
  );
}
