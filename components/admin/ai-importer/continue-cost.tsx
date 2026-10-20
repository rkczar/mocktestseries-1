"use client";

import { Button } from "@/components/ui/button";
import type { ContinueCost } from "@/lib/ai-import/jobs";

const inr = (v: number) => `₹${v.toFixed(2)}`;

/**
 * Shown when Resume / Retry would need more than the import's confirmed maximum: nothing has started. The
 * administrator sees what was spent, what the remaining work could cost at most and the new maximum, and
 * confirms exactly that amount (the server prices it again and refuses a lower one).
 */
export function ContinueCostConfirm({ cost, changed, pending, label, onConfirm, onCancel }: { cost: ContinueCost; changed?: boolean; pending: boolean; label: string; onConfirm: (neededMaxInr: number) => void; onCancel: () => void }) {
  const work = [`${cost.pages} page(s)`, cost.keyFiles ? `${cost.keyFiles} answer-key file(s)` : null, cost.questionsToClassify ? `subject / topic classification of ${cost.questionsToClassify} question(s)` : null].filter(Boolean).join(", ");
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--color-warning)_55%,transparent)] p-3" role="alertdialog" aria-label="Confirm the cost to continue" data-testid="continue-cost" data-needed={cost.neededMaxInr.toFixed(2)}>
      <p className="text-sm font-medium">{changed ? "The cost changed since it was shown — confirm the new amount" : "Confirm the cost to continue"}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--color-muted-foreground)]">Actual spend so far</dt>
          <dd data-testid="continue-cost-spent">{inr(cost.spentInr)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--color-muted-foreground)]">Confirmed maximum until now</dt>
          <dd data-testid="continue-cost-confirmed">{inr(cost.confirmedMaxInr)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--color-muted-foreground)]">Remaining work, estimated maximum</dt>
          <dd data-testid="continue-cost-remaining">{inr(cost.remainingMaxInr)}</dd>
        </div>
        <div className="flex justify-between gap-2 font-medium">
          <dt>New confirmed maximum</dt>
          <dd data-testid="continue-cost-needed">{inr(cost.neededMaxInr)}</dd>
        </div>
      </dl>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Remaining work: {work}. The maximum assumes every request at its worst case, including one re-send to another model after an unusable answer; the actual spend is usually far lower. Finished pages are not read or charged again. Nothing has been sent yet.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => onConfirm(cost.neededMaxInr)} data-testid="continue-cost-confirm">
          {label}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onCancel} data-testid="continue-cost-cancel">
          Not now
        </Button>
      </div>
    </div>
  );
}
