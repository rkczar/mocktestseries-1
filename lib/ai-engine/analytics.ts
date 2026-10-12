import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { istStartOfDay, toIstDateString, parseIstDateTimeLocal } from "@/lib/ist-time";
import { correctSettledBudget } from "@/lib/ai-engine/budget";
import { getGenerationCost } from "@/lib/ai-engine/openrouter";
import { getOpenRouterApiKey } from "@/lib/ai-engine/settings";

/**
 * AI cost & usage reporting (Admin dashboard cards, AI → Overview / Analytics /
 * History). IST (Asia/Kolkata) day and month boundaries. Every INR figure is
 * the sum of `actualCostInr` — the cost OpenRouter itself reported — so rows
 * from before cost tracking (and legacy Gemini/Claude/OpenAI calls, whose
 * providers report no cost) are counted as requests but never as ₹0.
 */

export function istMonthStart(d = new Date()): Date {
  return parseIstDateTimeLocal(`${toIstDateString(d).slice(0, 7)}-01T00:00`)!;
}

export interface CostTotals {
  requests: number;
  ok: number;
  failed: number;
  /** INR from provider-reported costs only. */
  costInr: number;
  /** Requests whose cost is unknown (legacy providers, pending, unknown). */
  uncosted: number;
}

async function totalsBetween(from: Date | null, to: Date | null): Promise<CostTotals> {
  const where = Prisma.sql`WHERE TRUE ${from ? Prisma.sql`AND "createdAt" >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND "createdAt" < ${to}` : Prisma.empty}`;
  const [r] = await prisma.$queryRaw<{ requests: number; ok: number; cost: number; uncosted: number }[]>`
    SELECT COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE "ok")::int AS ok,
           COALESCE(SUM("actualCostInr"), 0)::float8 AS cost,
           COUNT(*) FILTER (WHERE "ok" AND "actualCostInr" IS NULL)::int AS uncosted
    FROM "AiGatewayCall" ${where}`;
  return { requests: r.requests, ok: r.ok, failed: r.requests - r.ok, costInr: r.cost, uncosted: r.uncosted };
}

export interface DashboardAiStats {
  today: CostTotals;
  yesterday: CostTotals;
  month: CostTotals;
  lifetime: CostTotals;
  /** First request with a recorded actual cost (cost tracking start); null = none yet. */
  costTrackingSince: Date | null;
}

/** Four cheap aggregate queries (indexed on createdAt) — for the main admin dashboard and AI Overview. */
export async function dashboardAiStats(): Promise<DashboardAiStats> {
  const now = new Date();
  const today = istStartOfDay(now);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const [t, y, m, l, first] = await Promise.all([
    totalsBetween(today, null),
    totalsBetween(yesterday, today),
    totalsBetween(istMonthStart(now), null),
    totalsBetween(null, null),
    prisma.aiGatewayCall.findFirst({ where: { actualCostInr: { not: null } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  return { today: t, yesterday: y, month: m, lifetime: l, costTrackingSince: first?.createdAt ?? null };
}

export interface AnalyticsFilter {
  from: Date;
  to: Date;
  feature?: string | null;
  model?: string | null;
  provider?: string | null;
  status?: "ok" | "failed" | null;
}

function filterSql(f: AnalyticsFilter): Prisma.Sql {
  return Prisma.sql`WHERE "createdAt" >= ${f.from} AND "createdAt" < ${f.to}
    ${f.feature ? Prisma.sql`AND "feature" = ${f.feature}` : Prisma.empty}
    ${f.model ? Prisma.sql`AND "model" = ${f.model}` : Prisma.empty}
    ${f.provider ? Prisma.sql`AND "provider" = ${f.provider}` : Prisma.empty}
    ${f.status === "ok" ? Prisma.sql`AND "ok"` : f.status === "failed" ? Prisma.sql`AND NOT "ok"` : Prisma.empty}`;
}

export interface GroupRow {
  key: string;
  requests: number;
  ok: number;
  costInr: number;
  costed: number;
  inputTokens: number;
  outputTokens: number;
}

export async function analytics(f: AnalyticsFilter) {
  const w = filterSql(f);
  const group = (col: "model" | "feature" | "provider") =>
    prisma.$queryRaw<GroupRow[]>`
      SELECT ${Prisma.raw(`"${col}"`)} AS key, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE "ok")::int AS ok,
             COALESCE(SUM("actualCostInr"), 0)::float8 AS "costInr", COUNT("actualCostInr")::int AS costed,
             COALESCE(SUM("inputTokens"), 0)::int AS "inputTokens", COALESCE(SUM("outputTokens"), 0)::int AS "outputTokens"
      FROM "AiGatewayCall" ${w} GROUP BY 1 ORDER BY "costInr" DESC, requests DESC LIMIT 50`;
  const [[tot], byModel, byFeature, byProvider, daily] = await Promise.all([
    prisma.$queryRaw<{ requests: number; ok: number; cost: number; costed: number; fallback: number; estimated: number }[]>`
      SELECT COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE "ok")::int AS ok, COALESCE(SUM("actualCostInr"),0)::float8 AS cost,
             COUNT("actualCostInr")::int AS costed, COUNT(*) FILTER (WHERE "fallbackUsed")::int AS fallback,
             COALESCE(SUM("estCostInr") FILTER (WHERE "actualCostInr" IS NOT NULL), 0)::float8 AS estimated
      FROM "AiGatewayCall" ${w}`,
    group("model"),
    group("feature"),
    group("provider"),
    prisma.$queryRaw<{ day: string; requests: number; cost: number }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, COUNT(*)::int AS requests, COALESCE(SUM("actualCostInr"),0)::float8 AS cost
      FROM "AiGatewayCall" ${w} GROUP BY 1 ORDER BY 1`,
  ]);
  return {
    totals: { requests: tot.requests, ok: tot.ok, failed: tot.requests - tot.ok, costInr: tot.cost, costed: tot.costed, fallback: tot.fallback, estimatedForCostedInr: tot.estimated },
    byModel,
    byFeature,
    byProvider,
    daily,
  };
}

/** Student Ask AI views served from the explanation cache vs generated (StudentActivity, logged per access). */
export async function cacheStats(from: Date, to: Date): Promise<{ views: number; hits: number }> {
  const [r] = await prisma.$queryRaw<{ views: number; hits: number }[]>`
    SELECT COUNT(*)::int AS views, COUNT(*) FILTER (WHERE "metadata"->>'cacheHit' = 'true')::int AS hits
    FROM "StudentActivity" WHERE "activity" = 'AI_EXPLANATION_VIEWED' AND "createdAt" >= ${from} AND "createdAt" < ${to}`;
  return r;
}

export async function history(f: AnalyticsFilter & { take: number; skip: number }) {
  const where: Prisma.AiGatewayCallWhereInput = {
    createdAt: { gte: f.from, lt: f.to },
    ...(f.feature ? { feature: f.feature } : {}),
    ...(f.model ? { model: f.model } : {}),
    ...(f.provider ? { provider: f.provider } : {}),
    ...(f.status === "ok" ? { ok: true } : f.status === "failed" ? { ok: false } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.aiGatewayCall.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: f.take,
      skip: f.skip,
      select: {
        id: true, createdAt: true, feature: true, provider: true, model: true, modelRequested: true, ok: true, errorCategory: true, errorSummary: true,
        latencyMs: true, inputTokens: true, outputTokens: true, estCostInr: true, actualCostInr: true, fxRate: true, costStatus: true, fallbackUsed: true,
        attempt: true, instagramPostId: true, kind: true, routingMode: true,
      },
    }),
    prisma.aiGatewayCall.count({ where }),
  ]);
  return { rows, total };
}

/**
 * Per-Instagram-post AI cost (text / image / diagram / regenerations). One
 * admin action = one quote (several calls, e.g. Examiner Trap + its blind
 * re-solve); the first action per feature is the initial generation, every
 * later one is a regeneration.
 */
export async function postCost(postId: string) {
  const rows = await prisma.aiGatewayCall.findMany({
    where: { instagramPostId: postId },
    orderBy: { createdAt: "asc" },
    select: { id: true, feature: true, ok: true, actualCostInr: true, quoteId: true, requestId: true },
  });
  const firstAction = new Map<string, string>();
  let text = 0, image = 0, diagram = 0, regeneration = 0, uncosted = 0;
  for (const r of rows) {
    const action = r.quoteId ?? r.requestId ?? r.id;
    if (!firstAction.has(r.feature)) firstAction.set(r.feature, action);
    if (r.ok && r.actualCostInr === null) uncosted++;
    const c = r.actualCostInr;
    if (c === null) continue;
    if (firstAction.get(r.feature) !== action) regeneration += c;
    else if (r.feature === "ig_image") image += c;
    else if (r.feature === "ig_diagram") diagram += c;
    else text += c;
  }
  return { requests: rows.length, text, image, diagram, regeneration, total: text + image + diagram + regeneration, uncosted };
}

/**
 * Fill in costs OpenRouter had not reported yet (costStatus "pending"), via
 * GET /generation. Idempotent: only pending rows are touched; the budget
 * reservation is corrected to the real amount.
 */
export async function reconcilePending(limit = 20): Promise<{ checked: number; resolved: number }> {
  const apiKey = await getOpenRouterApiKey();
  if (!apiKey) return { checked: 0, resolved: 0 };
  const rows = await prisma.aiGatewayCall.findMany({
    where: { provider: "openrouter", costStatus: "pending", generationId: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, generationId: true, fxRate: true, requestId: true, attempt: true },
  });
  let resolved = 0;
  for (const r of rows) {
    try {
      const g = await getGenerationCost(apiKey, r.generationId!);
      if (g.costUsd === null) continue;
      const inr = r.fxRate ? Math.round(g.costUsd * r.fxRate * 10_000) / 10_000 : null;
      const done = await prisma.aiGatewayCall.updateMany({ where: { id: r.id, costStatus: "pending" }, data: { actualCostUsd: g.costUsd, actualCostInr: inr, costStatus: "actual" } });
      if (done.count === 1 && inr !== null && r.requestId) await correctSettledBudget(`${r.requestId}:${r.attempt}`, inr);
      resolved += done.count;
    } catch {
      // try again next time
    }
  }
  return { checked: rows.length, resolved };
}

/** Requests and reported cost per feature over the last 30 days (Features page). */
export async function featureUsage30(): Promise<Record<string, { requests: number; costInr: number | null }>> {
  const rows = await prisma.aiGatewayCall.groupBy({ by: ["feature"], where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: { _all: true }, _sum: { actualCostInr: true } });
  return Object.fromEntries(rows.map((u) => [u.feature, { requests: u._count._all, costInr: u._sum.actualCostInr }]));
}
