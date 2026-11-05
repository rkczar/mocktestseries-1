/**
 * The importer's budget rule (owner decision 1, 2026-11-05), pure so it can be tested on its own. The gateway
 * (lib/ai-import/ai.ts reserve) applies it to every paid request under a database lock; the worker applies it before a
 * run so that a blocked job keeps doing its local / deterministic work instead of stopping.
 */
import { formatInr } from "@/lib/ai-engine/config";

/** Owner decision 2026-11-05 (final): monthly and initial-test (all-time) caps only — no per-job or per-request cap. */
export interface ImporterCaps {
  monthlyInr: number;
  totalInr: number;
}

export interface BudgetBlock {
  /** "job" = the maximum an administrator confirmed for this import (an approval, not a budget): Resume asks again. */
  scope: "job" | "month" | "total";
  message: string;
}

const EPS = 0.005;

/**
 * Why a request of `amountInr` (its worst case) may not be sent, or null. Spend figures include requests still in flight
 * (open reservations), so the result is safe while other requests are running. A request that would only fit by being
 * cheaper than its worst case is refused: the worst case is what may be billed.
 */
export function budgetBlock(input: {
  amountInr: number;
  caps: ImporterCaps;
  job: { spentInr: number; inFlightInr: number; confirmedMaxInr: number | null };
  spend: { monthInr: number; allInr: number };
}): BudgetBlock | null {
  const { amountInr: a, caps, job, spend } = input;
  const tail = "Nothing was sent. Local reading, OCR and the deterministic checks continue; paid AI resumes only when the budget allows it (Import Settings).";
  if (spend.monthInr + a > caps.monthlyInr + EPS)
    return { scope: "month", message: `The importer's monthly budget is ${formatInr(caps.monthlyInr)}; ${formatInr(spend.monthInr)} is already spent or in flight this month, so a request of up to ${formatInr(a)} would exceed it. ${tail}` };
  if (spend.allInr + a > caps.totalInr + EPS)
    return { scope: "total", message: `The importer's total budget is ${formatInr(caps.totalInr)}; ${formatInr(spend.allInr)} has been spent or is in flight in all, so a request of up to ${formatInr(a)} would exceed it. ${tail}` };
  // Never spend beyond what an administrator approved: Resume shows the remaining cost and asks for a new confirmation.
  if (job.confirmedMaxInr === null || job.confirmedMaxInr < 0) return null;
  const committed = job.spentInr + job.inFlightInr;
  if (committed + a > job.confirmedMaxInr + EPS)
    return { scope: "job", message: `This import may spend at most ${formatInr(job.confirmedMaxInr)} (the maximum confirmed for it); ${formatInr(committed)} is already spent or in flight, so a request of up to ${formatInr(a)} would exceed it. Nothing was sent. Local reading, OCR and the deterministic checks continue; Resume shows the cost of the remaining work and asks you to confirm it.` };
  return null;
}

/** The enforced limits from the stored settings, never above the pilot bounds. */
export function capsOf(budget: { monthlyInr: number; totalInr: number }, bounds: { monthlyInr: number; totalInr: number }): ImporterCaps {
  const v = (x: number, max: number) => (Number.isFinite(x) && x >= 0 ? Math.min(x, max) : max);
  return { monthlyInr: v(budget.monthlyInr, bounds.monthlyInr), totalInr: v(budget.totalInr, bounds.totalInr) };
}

const inr = (v: number | null) => (v === null ? "—" : `₹${v.toFixed(2)}`);

/**
 * Owner 2026-11-05: every approval shows the budget left and names any shortfall before anything is spent. The gateway
 * still enforces the budget; this only explains it.
 */
export function budgetShortfall(maxInr: number | null, budget: { monthlyInr: number; totalInr: number; monthUsedInr: number; allUsedInr: number } | undefined | null) {
  const monthLeft = budget ? Math.max(0, budget.monthlyInr - budget.monthUsedInr) : null;
  const totalLeft = budget ? Math.max(0, budget.totalInr - budget.allUsedInr) : null;
  const short: string[] = [];
  if (budget && maxInr !== null && maxInr > 0) {
    if (maxInr > monthLeft! + 0.005) short.push(`The estimated maximum (${inr(maxInr)}) is ${inr(maxInr - monthLeft!)} more than the monthly budget left (${inr(monthLeft)} of ${inr(budget.monthlyInr)}).`);
    if (maxInr > totalLeft! + 0.005) short.push(`It would exceed the initial ${inr(budget.totalInr)} paid-testing cap by up to ${inr(maxInr - totalLeft!)} (${inr(totalLeft)} left).`);
  }
  return { monthLeft, totalLeft, short };
}
