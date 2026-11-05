/**
 * The importer's budget rule (owner decision 1, 2026-11-05), pure so it can be tested on its own. The gateway
 * (lib/ai-import/ai.ts reserve) applies it to every paid request under a database lock; the worker applies it before a
 * run so that a blocked job keeps doing its local / deterministic work instead of stopping.
 */
import { formatInr } from "@/lib/ai-engine/config";

export interface ImporterCaps {
  monthlyInr: number;
  jobInr: number;
  totalInr: number;
  requestInr: number;
}

export interface BudgetBlock {
  scope: "job" | "month" | "total" | "request";
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
  if (a > caps.requestInr + EPS) return { scope: "request", message: `One request could cost up to ${formatInr(a)}, above the per-request budget of ${formatInr(caps.requestInr)}. ${tail}` };
  if (spend.monthInr + a > caps.monthlyInr + EPS)
    return { scope: "month", message: `The importer's monthly budget is ${formatInr(caps.monthlyInr)}; ${formatInr(spend.monthInr)} is already spent or in flight this month, so a request of up to ${formatInr(a)} would exceed it. ${tail}` };
  if (spend.allInr + a > caps.totalInr + EPS)
    return { scope: "total", message: `The importer's total budget is ${formatInr(caps.totalInr)}; ${formatInr(spend.allInr)} has been spent or is in flight in all, so a request of up to ${formatInr(a)} would exceed it. ${tail}` };
  const jobCap = job.confirmedMaxInr !== null && job.confirmedMaxInr >= 0 ? Math.min(caps.jobInr, job.confirmedMaxInr) : caps.jobInr;
  const committed = job.spentInr + job.inFlightInr;
  if (committed + a > jobCap + EPS)
    return { scope: "job", message: `This import may spend at most ${formatInr(jobCap)}${jobCap < caps.jobInr ? " (the maximum confirmed for it)" : " (per-job budget)"}; ${formatInr(committed)} is already spent or in flight, so a request of up to ${formatInr(a)} would exceed it. ${tail}` };
  return null;
}

/** The enforced limits from the stored settings, never above the pilot bounds. */
export function capsOf(budget: { monthlyInr: number; maxJobInr: number; totalInr: number; maxRequestInr: number }, bounds: { monthlyInr: number; maxJobInr: number; totalInr: number; maxRequestInr: number }): ImporterCaps {
  const v = (x: number, max: number) => (Number.isFinite(x) && x >= 0 ? Math.min(x, max) : max);
  return { monthlyInr: v(budget.monthlyInr, bounds.monthlyInr), jobInr: v(budget.maxJobInr, bounds.maxJobInr), totalInr: v(budget.totalInr, bounds.totalInr), requestInr: v(budget.maxRequestInr, bounds.maxRequestInr) };
}
