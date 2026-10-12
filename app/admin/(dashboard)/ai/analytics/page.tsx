import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { analytics, cacheStats, dashboardAiStats, history, istMonthStart } from "@/lib/ai-engine/analytics";
import { ENGINE_FEATURES, ENGINE_FEATURE_MAP, formatInr } from "@/lib/ai-engine/config";
import { formatIst, istStartOfDay } from "@/lib/ist-time";
import { parseRange } from "@/lib/ai-engine/range";
import { prisma } from "@/lib/prisma";
import { AiFilters, ReconcileButton } from "@/components/admin/ai/analytics-controls";

export const metadata = { title: "AI Cost Analytics — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI → Analytics. Every ₹ figure is the provider-reported cost
 * (OpenRouter `usage.cost` at the stored USD→INR rate). Requests to legacy
 * providers — and everything before cost tracking began — count as requests
 * but never as ₹0; they are listed as "without reported cost".
 */
export default async function AiAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_ENGINE_VIEW))) return <RestrictedCard title="AI Cost Analytics" />;
  const canManage = await hasPermission(PERMISSIONS.AI_ENGINE_MANAGE);
  const r = parseRange(await searchParams, 30);
  const now = new Date();
  const sevenFrom = new Date(istStartOfDay(now).getTime() - 6 * 86_400_000);
  const [stats, a, last7, cache, recent, pending] = await Promise.all([
    dashboardAiStats(),
    analytics({ from: r.from, to: r.to, feature: r.feature, model: r.model, provider: r.provider, status: r.status }),
    analytics({ from: sevenFrom, to: new Date(now.getTime() + 60_000) }),
    cacheStats(r.from, r.to),
    history({ from: r.from, to: r.to, feature: r.feature, model: r.model, provider: r.provider, status: r.status, take: 15, skip: 0 }),
    prisma.aiGatewayCall.count({ where: { costStatus: "pending" } }),
  ]);
  const featureCost = (keys: string[]) => a.byFeature.filter((f) => keys.includes(f.key)).reduce((s, f) => s + f.costInr, 0);
  const igKeys = ENGINE_FEATURES.filter((f) => f.group === "Instagram").map((f) => f.key as string);
  const costedModels = a.byModel.filter((m) => m.costed > 0).map((m) => ({ ...m, avg: m.costInr / m.costed }));
  const priciest = costedModels.reduce<(typeof costedModels)[number] | null>((x, m) => (!x || m.avg > x.avg ? m : x), null);
  const cheapest = costedModels.reduce<(typeof costedModels)[number] | null>((x, m) => (!x || m.avg < x.avg ? m : x), null);
  const maxDay = Math.max(0.0001, ...a.daily.map((d) => d.cost));
  const label = (k: string) => ENGINE_FEATURE_MAP[k as keyof typeof ENGINE_FEATURE_MAP]?.label ?? k;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Cost Analytics</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {`IST days. ₹ = cost reported by OpenRouter. ${stats.costTrackingSince ? `Cost tracking since ${formatIst(stats.costTrackingSince)}.` : "No request with a reported cost yet."}`}
          </p>
        </div>
        {canManage ? <ReconcileButton pending={pending} /> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="analytics-tiles">
        <Tile label="AI cost today" value={formatInr(stats.today.costInr)} />
        <Tile label="AI cost yesterday" value={formatInr(stats.yesterday.costInr)} />
        <Tile label="Last 7 days" value={formatInr(last7.totals.costInr)} />
        <Tile label="Current month" value={formatInr(stats.month.costInr)} sub={`since ${formatIst(istMonthStart(now)).replace(/,.*$/, "")}`} />
        <Tile label="Total AI cost till now" value={formatInr(stats.lifetime.costInr)} sub={`${stats.lifetime.requests.toLocaleString("en-IN")} requests all time`} />
      </div>

      <AiFilters range={{ from: r.fromDay, to: r.toDay, feature: r.feature, model: r.model, provider: r.provider, status: r.status }} models={a.byModel.map((m) => m.key)} features={ENGINE_FEATURES.map((f) => ({ key: f.key, label: f.label }))} base="/admin/ai/analytics" />

      <Card>
        <CardHeader>
          <CardTitle>{`${r.fromDay} → ${r.toDay}`}</CardTitle>
          <CardDescription>Filtered totals</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="analytics-range">
          <Tile label="Total requests" value={a.totals.requests.toLocaleString("en-IN")} sub={`${a.totals.ok} ok`} />
          <Tile label="Total cost" value={formatInr(a.totals.costInr)} sub={`${a.totals.costed} request(s) with reported cost`} />
          <Tile label="Average cost / request" value={a.totals.costed ? formatInr(a.totals.costInr / a.totals.costed, 4) : "—"} sub="requests with reported cost" />
          <Tile label="Failed requests" value={String(a.totals.failed)} />
          <Tile label="Fallback requests" value={String(a.totals.fallback)} sub="answered by a fallback model" />
          <Tile label="Cache hit rate (Ask AI)" value={cache.views ? `${Math.round((cache.hits / cache.views) * 100)}%` : "—"} sub={`${cache.hits} of ${cache.views} student views from cache (no AI cost)`} />
          <Tile label="Estimate vs actual" value={a.totals.costed ? `${formatInr(a.totals.estimatedForCostedInr, 4)} → ${formatInr(a.totals.costInr, 4)}` : "—"} sub="typical estimate → reported cost" />
          <Tile label="Most / least expensive model" value={priciest ? priciest.key.split("/").pop()! : "—"} sub={priciest && cheapest ? `${formatInr(priciest.avg, 4)} vs ${cheapest.key.split("/").pop()} ${formatInr(cheapest.avg, 4)} per request` : undefined} />
          <Tile label="Instagram AI" value={formatInr(featureCost(igKeys))} />
          <Tile label="Student Ask AI" value={formatInr(featureCost(["explanation"]))} />
          <Tile label="AI Variants" value={formatInr(featureCost(["variant", "variant_admin"]))} />
          <Tile label="Medical images" value={formatInr(featureCost(["ig_image"]))} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Breakdown title="By model" rows={a.byModel} label={(k) => k} testid="by-model" />
        <Breakdown title="By feature" rows={a.byFeature} label={label} testid="by-feature" />
      </div>
      <Breakdown title="By provider" rows={a.byProvider} label={(k) => k} testid="by-provider" />

      <Card>
        <CardHeader>
          <CardTitle>Daily cost</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-xs" data-testid="daily-cost">
          {a.daily.length === 0 ? <p className="text-[var(--color-muted-foreground)]">No requests in this range.</p> : null}
          {a.daily.map((d) => (
            <div key={d.day} className="grid grid-cols-[6.5rem_minmax(0,1fr)_7rem] items-center gap-2">
              <span>{d.day}</span>
              <span className="h-2 rounded bg-[var(--color-primary)]/70" style={{ width: `${Math.max(1, (d.cost / maxDay) * 100)}%` }} aria-hidden />
              <span className="text-right">{`${formatInr(d.cost)} · ${d.requests}`}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Recent transactions</CardTitle>
          <Link className="text-sm text-[var(--color-primary)]" href="/admin/ai/history">
            Full history →
          </Link>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Time (IST)</th>
                <th className="py-1 pr-2 font-medium">Feature</th>
                <th className="py-1 pr-2 font-medium">Model</th>
                <th className="py-1 pr-2 font-medium">Tokens</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {recent.rows.map((x) => (
                <tr key={x.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1 pr-2 whitespace-nowrap">{formatIst(x.createdAt)}</td>
                  <td className="py-1 pr-2">{label(x.feature)}</td>
                  <td className="py-1 pr-2 break-all font-mono">{x.model}</td>
                  <td className="py-1 pr-2">{x.inputTokens !== null ? `${x.inputTokens} / ${x.outputTokens ?? "?"}` : "—"}</td>
                  <td className="py-1 pr-2">{x.ok ? "OK" : (x.errorCategory ?? "failed")}</td>
                  <td className="py-1">{x.actualCostInr !== null ? formatInr(x.actualCostInr, 4) : x.costStatus === "pending" ? "pending" : "not reported"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</p>
      <p className="break-words text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
      {sub ? <p className="break-words text-xs text-[var(--color-muted-foreground)]">{sub}</p> : null}
    </div>
  );
}

function Breakdown({ title, rows, label, testid }: { title: string; rows: { key: string; requests: number; ok: number; costInr: number; costed: number; inputTokens: number; outputTokens: number }[]; label: (k: string) => string; testid: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-xs" data-testid={testid}>
          <thead className="text-[var(--color-muted-foreground)]">
            <tr>
              <th className="py-1 pr-2 font-medium">Name</th>
              <th className="py-1 pr-2 font-medium">Requests</th>
              <th className="py-1 pr-2 font-medium">Failed</th>
              <th className="py-1 pr-2 font-medium">Tokens in / out</th>
              <th className="py-1 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key} className="border-t border-[var(--color-border)]">
                <td className="py-1 pr-2 break-all">{label(x.key)}</td>
                <td className="py-1 pr-2">{x.requests}</td>
                <td className="py-1 pr-2">{x.requests - x.ok}</td>
                <td className="py-1 pr-2">{`${x.inputTokens.toLocaleString("en-IN")} / ${x.outputTokens.toLocaleString("en-IN")}`}</td>
                <td className="py-1">{x.costed ? formatInr(x.costInr, 4) : "not reported"}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-2 text-[var(--color-muted-foreground)]">
                  No data.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
