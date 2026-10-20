/**
 * Job budget checks for the job page (pure, no I/O — safe in client components). They mirror the
 * server's own checks in confirmJob / resumeJob (lib/ai-import/jobs.ts), in the same order, so the
 * page can show every reason and disable Confirm / Resume before a request that would be refused.
 * The server still re-checks everything with fresh prices and spend; this never replaces that.
 */
import type { CostEstimate } from "@/lib/ai-import/estimate";

export interface BudgetLimits {
  /** Hard limit per job (Import Settings). */
  maxJobInr: number;
  /** Per-request limit (Import Settings): models whose single request could cost more are never chosen. */
  maxRequestInr: number;
  totalCapInr: number;
  monthCapInr: number;
  /** What is left of the importer's all-time / this IST month's budget (worst case held for unknown costs). */
  allTimeLeftInr: number;
  monthLeftInr: number;
}

export interface BudgetCheck {
  /** The parsed budget (₹), or null when the field is empty or not a number. */
  value: number | null;
  /** Every reason the server would refuse this budget now (empty: allowed). */
  problems: string[];
  /** Budgets that would be accepted, or null when no budget can start this job as it is. */
  range: { minInr: number; maxInr: number } | null;
  /** Why no budget can start this job (changing the budget cannot help). */
  impossible: string | null;
}

const inr = (v: number) => `₹${v.toFixed(2)}`;
/** The smallest whole-paise budget that is at least `v` (a ₹0.7837 maximum needs ₹0.79). */
const paiseUp = (v: number) => Math.ceil(v * 100 - 1e-9) / 100;

/** A rupee amount with at most 2 decimals; anything else is refused with the reason. */
export function parseBudget(raw: string): { value: number | null; error: string | null } {
  const s = raw.trim();
  if (!s) return { value: null, error: "Enter a job budget in rupees (for example 5 or 7.50)." };
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return { value: null, error: "Enter the budget as a rupee amount with up to 2 decimals (for example 5 or 7.50)." };
  return { value: Number(s), error: null };
}

/** Whether confirming would make paid AI calls (the server's own rule: a priced line with calls and a usable model). */
export function willCallAi(estimate: CostEstimate | null, aiEnabled: boolean): boolean {
  return aiEnabled && !!estimate && estimate.lines.some((l) => l.calls > 0 && l.model !== null && l.problem === null);
}

export function confirmBudgetCheck(input: { raw: string; aiEnabled: boolean; estimate: CostEstimate | null; limits: BudgetLimits }): BudgetCheck {
  const { estimate: est, limits: l, aiEnabled } = input;
  const parsed = parseBudget(input.raw);
  const problems: string[] = [];
  if (parsed.error) problems.push(parsed.error);
  const v = parsed.value;
  if (v !== null && v > l.maxJobInr) problems.push(`The job budget (${inr(v)}) is above the hard limit per job (${inr(l.maxJobInr)}, Import Settings).`);

  let impossible: string | null = null;
  // Pages or answer keys that need AI but have no affordable, suitable model: no budget helps.
  if (aiEnabled && est) for (const line of est.lines.filter((x) => x.calls > 0 && (x.task === "extract" || x.task === "key") && x.problem)) impossible ??= `${line.label}: ${line.problem}`;
  const ai = willCallAi(est, aiEnabled);
  let min = 0;
  if (ai && est) {
    if (est.totalInr === null || est.maxInr === null) impossible ??= `The AI cost cannot be established (${est.notes[0] ?? "missing model price or exchange rate"}).`;
    else {
      min = paiseUp(Math.max(est.totalInr, est.maxInr));
      if (v !== null && est.totalInr > v) problems.push(`The estimated AI cost (${inr(est.totalInr)}) is above the job budget (${inr(v)}).`);
      if (v !== null && est.maxInr > v) problems.push(`The conservative maximum AI cost (${inr(est.maxInr)}: every request at its reserved worst case) is above the job budget (${inr(v)}).`);
      if (est.maxInr > l.maxJobInr) impossible ??= `The conservative maximum AI cost (${inr(est.maxInr)}) is above the hard limit per job (${inr(l.maxJobInr)}), so no job budget can cover it.`;
      if (est.maxInr > l.allTimeLeftInr) impossible ??= `The conservative maximum AI cost (${inr(est.maxInr)}) is above what is left of the importer's all-time budget (${inr(Math.max(0, l.allTimeLeftInr))} of ${inr(l.totalCapInr)}).`;
      if (est.maxInr > l.monthLeftInr) impossible ??= `The conservative maximum AI cost (${inr(est.maxInr)}) is above what is left of this month's importer budget (${inr(Math.max(0, l.monthLeftInr))} of ${inr(l.monthCapInr)}).`;
    }
  }
  if (impossible) problems.push(impossible);
  return { value: v, problems, range: impossible ? null : { minInr: min, maxInr: l.maxJobInr }, impossible };
}

/** Resume (optionally with a new budget): the server's resumeJob rules. */
export function resumeBudgetCheck(input: { raw: string; currentInr: number; spentInr: number; maxJobInr: number; budgetPaused: boolean }): BudgetCheck {
  const parsed = parseBudget(input.raw);
  const problems: string[] = [];
  if (parsed.error) problems.push(parsed.error);
  const v = parsed.value;
  if (v !== null && v !== input.currentInr && v > input.maxJobInr) problems.push(`The job budget (${inr(v)}) is above the hard limit per job (${inr(input.maxJobInr)}, Import Settings).`);
  if (v !== null && v <= input.spentInr && (v !== input.currentInr || input.budgetPaused)) problems.push(`The job budget must be above what this import has already spent (${inr(input.spentInr)}).`);
  // "Above what was spent": the smallest whole-paise budget strictly greater than the spend.
  const min = Math.floor(input.spentInr * 100 + 1e-9) / 100 + 0.01;
  return { value: v, problems, range: min <= input.maxJobInr ? { minInr: min, maxInr: input.maxJobInr } : null, impossible: null };
}
