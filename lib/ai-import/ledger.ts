import "server-only";
import { prisma } from "@/lib/prisma";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { PILOT_LIMITS, type ImporterSettings } from "@/lib/ai-import/config";

/**
 * The AI Question Importer's cost ledger, read for the AI Cost Center. Two existing records, each
 * used for what it is authoritative for, so nothing is counted twice:
 *
 *  - AiBudgetReservation (feature "qimport_*"; one row per request attempt, unique request key):
 *    money. The same rows the budget guard (lib/ai-import/ai.ts reserve) enforces against, so the
 *    dashboard's "used" equals what the limits see. They survive job deletion.
 *      RESERVED            in flight: the maximum is held
 *      SETTLED + costKnown actual cost reported by OpenRouter
 *      SETTLED + !costKnown cost unknown: the reserved maximum is kept as held (never shown as actual)
 *      RELEASED            refused or failed before any charge: nothing counted
 *  - AiGatewayCall (feature "qimport_*"): typical estimate, provider, model, outcome, attempt and
 *    fallback per call, for usage counts. Never added to the money totals.
 *
 * Only importer rows are read; student Ask AI, Instagram and the other features are excluded by feature.
 */

export interface LedgerPeriod {
  /** Requests sent (or in flight): settled + reserved attempts. */
  requests: number;
  /** Sum of the maximum reserved before each request (the worst case, not a charge). */
  reservedMaxInr: number;
  /** Provider-reported cost of requests whose cost is known. */
  actualInr: number;
  actualRequests: number;
  /** Requests whose cost OpenRouter never reported; their reserved maximum stays held against the budget. */
  unknownRequests: number;
  unknownHeldInr: number;
  inflightRequests: number;
  inflightInr: number;
  /** Requests refused or failed before any charge. */
  releasedRequests: number;
  /** What the budget counts: actual + unknown held + in flight. */
  committedInr: number;
}

export interface ImporterLedger {
  istDay: string;
  istMonth: string;
  periods: { today: LedgerPeriod; month: LedgerPeriod; all: LedgerPeriod };
  /**
   * Typical estimates (AiGatewayCall) — what a request was expected to cost, for comparison with actual.
   * todayInr sums exactly the todayCalls calls (today's IST day, with an estimate); todayUnestimated are today's calls without one.
   */
  estimates: { todayInr: number | null; todayCalls: number; todayUnestimated: number; allInr: number | null; comparedEstimateInr: number | null; comparedActualInr: number | null; comparedRequests: number };
  limits: { totalInr: number; monthlyInr: number; maxJobInr: number; maxRequestInr: number };
  remaining: { totalInr: number; monthInr: number };
  usage: {
    calls: number;
    ok: number;
    failed: number;
    retries: number;
    fallbacks: number;
    byProvider: { provider: string; family: string; calls: number; failed: number; actualInr: number | null; unknownCost: number }[];
    /** The direct Gemini API is never used by the importer (see GEMINI_DIRECT_REASONS). */
    geminiDirectCalls: 0;
  };
  history: { day: string; requests: number; reservedMaxInr: number; actualInr: number; actualRequests: number; unknownRequests: number; heldInr: number; inflightRequests: number }[];
  jobs: { jobId: string; title: string | null; deleted: boolean; jobEstimateInr: number | null; budgetInr: number | null; requests: number; actualInr: number; actualRequests: number; unknownRequests: number; heldInr: number; inflightRequests: number; inflightInr: number; committedInr: number; questions: number | null }[];
}

type PeriodRow = { status: string; known: boolean; n: number; reserved: number; settled: number };

export function toPeriod(rows: readonly PeriodRow[]): LedgerPeriod {
  const p: LedgerPeriod = { requests: 0, reservedMaxInr: 0, actualInr: 0, actualRequests: 0, unknownRequests: 0, unknownHeldInr: 0, inflightRequests: 0, inflightInr: 0, releasedRequests: 0, committedInr: 0 };
  for (const r of rows) {
    if (r.status === "RELEASED") {
      p.releasedRequests += r.n;
      continue;
    }
    p.requests += r.n;
    p.reservedMaxInr += r.reserved;
    if (r.status === "RESERVED") {
      p.inflightRequests += r.n;
      p.inflightInr += r.reserved;
    } else if (r.known) {
      p.actualRequests += r.n;
      p.actualInr += r.settled;
    } else {
      p.unknownRequests += r.n;
      p.unknownHeldInr += r.settled;
    }
  }
  p.committedInr = p.actualInr + p.unknownHeldInr + p.inflightInr;
  return p;
}

/**
 * How an actual figure must be read: "none" = no request; "known" = every request has a reported cost;
 * "pending" = only requests still in flight; "mixed" = some reported, some unknown; "unknown" = requests exist but no cost was reported — the
 * actual spend is then UNKNOWN, never ₹0.
 */
export function actualState(p: { actualRequests: number; unknownRequests: number; inflightRequests?: number }): "none" | "pending" | "known" | "mixed" | "unknown" {
  if (!p.actualRequests && !p.unknownRequests) return p.inflightRequests ? "pending" : "none";
  if (!p.unknownRequests) return "known";
  return p.actualRequests ? "mixed" : "unknown";
}

const FAMILY = (model: string) => (model.startsWith("google/") ? "Gemini models (google/*) via OpenRouter" : "Other models via OpenRouter");

export async function importerLedger(settings: ImporterSettings, now = new Date()): Promise<ImporterLedger> {
  const { istDay, istMonth } = istDayMonth(now);
  const since = new Date(now.getTime() - 13 * 86_400_000);
  const { istDay: firstDay } = istDayMonth(since);
  // One IST day for both the estimated total and its call count.
  const dayStart = istStart(istDay);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const [periodRows, est, calls, byModel, history, jobRows] = await Promise.all([
    prisma.$queryRaw<(PeriodRow & { day: boolean; month: boolean })[]>`
      SELECT "status"::text AS status, "costKnown" AS known, ("istDay" = ${istDay}) AS day, ("istMonth" = ${istMonth}) AS month,
             COUNT(*)::int AS n, COALESCE(SUM("reservedInr"), 0)::float8 AS reserved, COALESCE(SUM("settledInr"), 0)::float8 AS settled
      FROM "AiBudgetReservation" WHERE left("feature", 8) = 'qimport_'
      GROUP BY 1, 2, 3, 4`,
    prisma.$queryRaw<{ today: number | null; today_calls: number; today_unestimated: number; total: number | null; known_est: number | null; known_actual: number | null; compared: number }[]>`
      SELECT SUM("estCostInr") FILTER (WHERE "createdAt" >= ${dayStart} AND "createdAt" < ${dayEnd})::float8 AS today,
             COUNT(*) FILTER (WHERE "createdAt" >= ${dayStart} AND "createdAt" < ${dayEnd} AND "estCostInr" IS NOT NULL)::int AS today_calls,
             COUNT(*) FILTER (WHERE "createdAt" >= ${dayStart} AND "createdAt" < ${dayEnd} AND "estCostInr" IS NULL)::int AS today_unestimated,
             SUM("estCostInr")::float8 AS total,
             SUM("estCostInr") FILTER (WHERE "costStatus" = 'actual' AND "actualCostInr" IS NOT NULL)::float8 AS known_est,
             SUM("actualCostInr") FILTER (WHERE "costStatus" = 'actual' AND "estCostInr" IS NOT NULL)::float8 AS known_actual,
             COUNT(*) FILTER (WHERE "costStatus" = 'actual' AND "actualCostInr" IS NOT NULL AND "estCostInr" IS NOT NULL)::int AS compared
      FROM "AiGatewayCall" WHERE left("feature", 8) = 'qimport_'`,
    prisma.$queryRaw<{ calls: number; ok: number; retries: number; fallbacks: number }[]>`
      SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE "ok")::int AS ok, COUNT(*) FILTER (WHERE "attempt" > 1)::int AS retries,
             COUNT(*) FILTER (WHERE "fallbackUsed")::int AS fallbacks
      FROM "AiGatewayCall" WHERE left("feature", 8) = 'qimport_'`,
    prisma.$queryRaw<{ provider: string; model: string; calls: number; failed: number; actual: number | null; unknown: number }[]>`
      SELECT "provider", "model", COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE NOT "ok")::int AS failed,
             SUM("actualCostInr") FILTER (WHERE "costStatus" = 'actual')::float8 AS actual,
             COUNT(*) FILTER (WHERE "costStatus" IN ('unknown', 'pending'))::int AS unknown
      FROM "AiGatewayCall" WHERE left("feature", 8) = 'qimport_' GROUP BY 1, 2`,
    prisma.$queryRaw<(PeriodRow & { d: string })[]>`
      SELECT "istDay" AS d, "status"::text AS status, "costKnown" AS known, COUNT(*)::int AS n,
             COALESCE(SUM("reservedInr"), 0)::float8 AS reserved, COALESCE(SUM("settledInr"), 0)::float8 AS settled
      FROM "AiBudgetReservation" WHERE left("feature", 8) = 'qimport_' AND "istDay" >= ${firstDay}
      GROUP BY 1, 2, 3`,
    prisma.$queryRaw<(PeriodRow & { job: string })[]>`
      SELECT split_part("requestKey", ':', 2) AS job, "status"::text AS status, "costKnown" AS known, COUNT(*)::int AS n,
             COALESCE(SUM("reservedInr"), 0)::float8 AS reserved, COALESCE(SUM("settledInr"), 0)::float8 AS settled
      FROM "AiBudgetReservation" WHERE left("feature", 8) = 'qimport_' AND "requestKey" LIKE 'qi:%'
      GROUP BY 1, 2, 3`,
  ]);

  const pick = (f: (r: (typeof periodRows)[number]) => boolean) => toPeriod(periodRows.filter(f));
  const periods = { today: pick((r) => r.day), month: pick((r) => r.month), all: pick(() => true) };

  const families = new Map<string, ImporterLedger["usage"]["byProvider"][number]>();
  for (const r of byModel) {
    const key = `${r.provider}|${FAMILY(r.model)}`;
    const f = families.get(key) ?? { provider: r.provider === "openrouter" ? "OpenRouter" : r.provider, family: FAMILY(r.model), calls: 0, failed: 0, actualInr: null, unknownCost: 0 };
    f.calls += r.calls;
    f.failed += r.failed;
    if (r.actual !== null) f.actualInr = (f.actualInr ?? 0) + r.actual;
    f.unknownCost += r.unknown;
    families.set(key, f);
  }

  const days = new Map<string, PeriodRow[]>();
  for (const r of history) days.set(r.d, [...(days.get(r.d) ?? []), r]);
  const historyOut = [...days.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, rows]) => {
      const p = toPeriod(rows);
      return { day, requests: p.requests, reservedMaxInr: p.reservedMaxInr, actualInr: p.actualInr, actualRequests: p.actualRequests, unknownRequests: p.unknownRequests, heldInr: p.unknownHeldInr, inflightRequests: p.inflightRequests };
    });

  const byJob = new Map<string, PeriodRow[]>();
  for (const r of jobRows) byJob.set(r.job, [...(byJob.get(r.job) ?? []), r]);
  const live = await prisma.aiImportJob.findMany({ where: { id: { in: [...byJob.keys()] } }, select: { id: true, title: true, estCostInr: true, budgetInr: true, _count: { select: { questions: true } } } });
  const liveById = new Map(live.map((j) => [j.id, j]));
  const jobs = [...byJob.entries()]
    .map(([jobId, rows]) => {
      const p = toPeriod(rows);
      const j = liveById.get(jobId);
      return { jobId, title: j?.title ?? null, deleted: !j, jobEstimateInr: j?.estCostInr ?? null, budgetInr: j?.budgetInr ?? null, requests: p.requests, actualInr: p.actualInr, actualRequests: p.actualRequests, unknownRequests: p.unknownRequests, heldInr: p.unknownHeldInr, inflightRequests: p.inflightRequests, inflightInr: p.inflightInr, committedInr: p.committedInr, questions: j ? j._count.questions : null };
    })
    .filter((j) => j.requests > 0)
    .sort((a, b) => b.committedInr - a.committedInr);

  const limits = {
    totalInr: Math.min(settings.budget.totalInr ?? PILOT_LIMITS.totalInr, PILOT_LIMITS.totalInr),
    monthlyInr: Math.min(settings.budget.monthlyInr, PILOT_LIMITS.monthlyInr),
    maxJobInr: Math.min(settings.budget.maxJobInr, PILOT_LIMITS.maxJobInr),
    maxRequestInr: Math.min(settings.budget.maxRequestInr, PILOT_LIMITS.maxRequestInr),
  };
  const c = calls[0] ?? { calls: 0, ok: 0, retries: 0, fallbacks: 0 };
  const e = est[0];
  return {
    istDay,
    istMonth,
    periods,
    estimates: { todayInr: e?.today ?? null, todayCalls: e?.today_calls ?? 0, todayUnestimated: e?.today_unestimated ?? 0, allInr: e?.total ?? null, comparedEstimateInr: e?.known_est ?? null, comparedActualInr: e?.known_actual ?? null, comparedRequests: e?.compared ?? 0 },
    limits,
    // The budget guard also checks the monthly cap against this month's rows and the all-time cap against every row.
    remaining: { totalInr: Math.max(0, limits.totalInr - periods.all.committedInr), monthInr: Math.max(0, Math.min(limits.monthlyInr - periods.month.committedInr, limits.totalInr - periods.all.committedInr)) },
    usage: { calls: c.calls, ok: c.ok, failed: c.calls - c.ok, retries: c.retries, fallbacks: c.fallbacks, byProvider: [...families.values()].sort((a, b) => b.calls - a.calls), geminiDirectCalls: 0 },
    history: historyOut,
    jobs,
  };
}

/** Start of an IST calendar day ("2026-10-18") as a Date. */
function istStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}
