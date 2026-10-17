import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { toIstDateString } from "@/lib/ist-time";
import { formatInr, type BudgetConfig } from "@/lib/ai-engine/config";

/**
 * Server-side AI budget enforcement (Admin → AI → Budgets).
 *
 * Before every priced provider request the engine RESERVES the request's
 * worst-case INR cost. The check-and-insert runs in one transaction under a
 * Postgres advisory lock, so two simultaneous requests (any PM2 worker) can
 * never both pass a budget that only has room for one. After the call the
 * reservation is SETTLED to the provider-reported cost, or RELEASED when the
 * provider reported the request as not billed. When the provider never said
 * (timeout, crash), the reserved worst case is kept — spend is over-counted,
 * never under-counted. Estimates and reservations cannot guarantee the exact
 * final provider charge; the OpenRouter key's own spending limit is the
 * provider-side backstop.
 */

export class AiBudgetError extends AiNotConfiguredError {}

const LOCK_KEY = 7_301_442_019; // arbitrary constant: "AI budget" advisory lock
const STALE_RESERVATION_MS = 30 * 60_000;

export function istDayMonth(d = new Date()): { istDay: string; istMonth: string } {
  const istDay = toIstDateString(d);
  return { istDay, istMonth: istDay.slice(0, 7) };
}

/** Spend that counts against budgets: settled amounts + open reservations (never RELEASED rows). */
const SPEND = Prisma.sql`COALESCE(SUM(COALESCE("settledInr", "reservedInr")), 0)::float8`;
/**
 * The AI Question Importer has its OWN budget (lib/ai-import/ai.ts, features
 * "qimport_*"): its reservations share this table but never count against the
 * platform (student Ask AI / admin / Instagram) daily and monthly budgets.
 */
const PLATFORM = Prisma.sql`left("feature", 8) <> 'qimport_'`;

export async function reserveBudget(input: { requestKey: string; feature: string; featureLabel: string; reservedInr: number; budgets: BudgetConfig; featureDailyInr: number | null }): Promise<void> {
  const { budgets } = input;
  if (budgets.emergencyStop) throw new AiBudgetError("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const { istDay, istMonth } = istDayMonth();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint)`;
    // A reservation left RESERVED by a crashed request keeps its worst case (cost unknown).
    await tx.$executeRaw`UPDATE "AiBudgetReservation" SET "status" = 'SETTLED', "settledInr" = "reservedInr", "costKnown" = false, "settledAt" = now()
      WHERE "status" = 'RESERVED' AND "createdAt" < ${new Date(Date.now() - STALE_RESERVATION_MS)}`;
    const [row] = await tx.$queryRaw<{ day: number; month: number; feature: number }[]>`
      SELECT
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istDay" = ${istDay} AND "status" <> 'RELEASED' AND ${PLATFORM}) AS day,
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istMonth" = ${istMonth} AND "status" <> 'RELEASED' AND ${PLATFORM}) AS month,
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istDay" = ${istDay} AND "feature" = ${input.feature} AND "status" <> 'RELEASED') AS feature`;
    const amt = input.reservedInr;
    if (row.day + amt > budgets.dailyInr) {
      throw new AiBudgetError(`The daily AI budget is reached (${formatInr(row.day)} of ${formatInr(budgets.dailyInr)} used; this request may cost up to ${formatInr(amt)}). A Master Admin can raise it in AI → Budgets.`);
    }
    if (row.month + amt > budgets.monthlyInr) {
      throw new AiBudgetError(`The monthly AI budget is reached (${formatInr(row.month)} of ${formatInr(budgets.monthlyInr)} used). A Master Admin can raise it in AI → Budgets.`);
    }
    if (input.featureDailyInr !== null && row.feature + amt > input.featureDailyInr) {
      throw new AiBudgetError(`The daily budget for ${input.featureLabel} is reached (${formatInr(row.feature)} of ${formatInr(input.featureDailyInr)}).`);
    }
    await tx.aiBudgetReservation.create({ data: { requestKey: input.requestKey, feature: input.feature, reservedInr: amt, istDay, istMonth } });
  });
}

/** Provider reported the cost (INR), or null = billed but amount unknown (keep the worst case). Idempotent. */
export async function settleBudget(requestKey: string, actualInr: number | null): Promise<void> {
  await prisma.aiBudgetReservation.updateMany({
    where: { requestKey, status: "RESERVED" },
    data: actualInr === null ? { status: "SETTLED", costKnown: false, settledAt: new Date() } : { status: "SETTLED", settledInr: actualInr, costKnown: true, settledAt: new Date() },
  });
  if (actualInr === null) await prisma.$executeRaw`UPDATE "AiBudgetReservation" SET "settledInr" = "reservedInr" WHERE "requestKey" = ${requestKey} AND "settledInr" IS NULL`;
}

/** Provider reported the request as not billed. Idempotent. */
export async function releaseBudget(requestKey: string): Promise<void> {
  await prisma.aiBudgetReservation.updateMany({ where: { requestKey, status: "RESERVED" }, data: { status: "RELEASED", settledInr: 0, costKnown: true, settledAt: new Date() } });
}

/** A later reconciliation found the real cost of a request whose cost was unknown. */
export async function correctSettledBudget(requestKey: string, actualInr: number): Promise<void> {
  await prisma.aiBudgetReservation.updateMany({ where: { requestKey, status: "SETTLED", costKnown: false }, data: { settledInr: actualInr, costKnown: true } });
}

export interface BudgetUsage {
  dayInr: number;
  monthInr: number;
  /** Part of the above that is still in flight or whose cost was never reported (worst case held). */
  dayHeldInr: number;
  monthHeldInr: number;
  byFeatureToday: Record<string, number>;
  istDay: string;
  istMonth: string;
}

export async function budgetUsage(): Promise<BudgetUsage> {
  const { istDay, istMonth } = istDayMonth();
  const [[row], features] = await Promise.all([
    prisma.$queryRaw<{ day: number; month: number; dayHeld: number; monthHeld: number }[]>`
      SELECT
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istDay" = ${istDay} AND "status" <> 'RELEASED' AND ${PLATFORM}) AS day,
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istMonth" = ${istMonth} AND "status" <> 'RELEASED' AND ${PLATFORM}) AS month,
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istDay" = ${istDay} AND ("status" = 'RESERVED' OR ("status" = 'SETTLED' AND NOT "costKnown")) AND ${PLATFORM}) AS "dayHeld",
        (SELECT ${SPEND} FROM "AiBudgetReservation" WHERE "istMonth" = ${istMonth} AND ("status" = 'RESERVED' OR ("status" = 'SETTLED' AND NOT "costKnown")) AND ${PLATFORM}) AS "monthHeld"`,
    prisma.$queryRaw<{ feature: string; spend: number }[]>`
      SELECT "feature", ${SPEND} AS spend FROM "AiBudgetReservation" WHERE "istDay" = ${istDay} AND "status" <> 'RELEASED' AND ${PLATFORM} GROUP BY "feature"`,
  ]);
  return {
    dayInr: row.day,
    monthInr: row.month,
    dayHeldInr: row.dayHeld,
    monthHeldInr: row.monthHeld,
    byFeatureToday: Object.fromEntries(features.map((f) => [f.feature, f.spend])),
    istDay,
    istMonth,
  };
}
