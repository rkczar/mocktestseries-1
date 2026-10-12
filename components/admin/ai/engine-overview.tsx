import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getEngineConfig, getOpenRouterConfig } from "@/lib/ai-engine/settings";
import { dashboardAiStats } from "@/lib/ai-engine/analytics";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { peekUsdInr } from "@/lib/ai-engine/fx";
import { getAiSettings } from "@/lib/ai-settings";
import { ENGINE_FEATURES, ENGINE_FEATURE_MAP, ROUTING_MODE_LABELS, formatInr } from "@/lib/ai-engine/config";
import { formatIst } from "@/lib/ist-time";

/**
 * Admin → AI → Overview: the AI Engine at a glance — provider status, which
 * features run on OpenRouter, today's usage and cost, lifetime and monthly
 * spend against the budget, and the latest requests. Read-only.
 */
export async function AiEngineOverview() {
  const [or, engine, stats, usage, fx, legacy, recent] = await Promise.all([
    getOpenRouterConfig(),
    getEngineConfig(),
    dashboardAiStats(),
    budgetUsage(),
    peekUsdInr(),
    getAiSettings(),
    prisma.aiGatewayCall.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, createdAt: true, feature: true, provider: true, model: true, ok: true, actualCostInr: true, costStatus: true, errorCategory: true },
    }),
  ]);
  const onOpenRouter = ENGINE_FEATURES.filter((f) => f.inUse && engine.features[f.key].provider === "openrouter");
  const disabled = ENGINE_FEATURES.filter((f) => f.inUse && !engine.features[f.key].enabled);
  const ask = engine.features.explanation;
  const remaining = Math.max(0, engine.budgets.monthlyInr - usage.monthInr);
  const statusVariant = or.status === "CONNECTED" ? "success" : or.status === "ERROR" ? "error" : or.status === "NOT_CONFIGURED" ? "warning" : "neutral";

  return (
    <div className="flex flex-col gap-4" data-testid="ai-engine-overview">
      {engine.budgets.emergencyStop ? (
        <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-4 py-2.5 text-sm" data-testid="emergency-stop-banner">
          <strong>AI emergency stop is ON.</strong> No new AI request is sent to any provider. Cached explanations are still served.{" "}
          <Link className="underline" href="/admin/ai/budgets">
            AI → Budgets
          </Link>
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>AI Engine</CardTitle>
          <CardDescription>Central AI gateway: provider, routing, usage and cost. Costs are the amounts OpenRouter reported; legacy providers report none.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Tile label="OpenRouter" value={<Badge variant={statusVariant}>{or.status.replace("_", " ")}</Badge>} sub={or.keyHint ? `Key ${or.keyHint}` : "No key installed"} testid="tile-openrouter" />
          <Tile
            label="Active provider"
            value={onOpenRouter.length ? `OpenRouter · ${onOpenRouter.length}/${ENGINE_FEATURES.filter((f) => f.inUse).length}` : `Legacy (${legacy.activeProvider === "gemini" ? "Gemini" : "OpenAI"})`}
            sub={onOpenRouter.length ? "features on OpenRouter" : "no feature uses OpenRouter yet"}
          />
          <Tile label="Student Ask AI model" value={ask.provider === "openrouter" ? (ask.mode === "manual" ? (ask.model ?? "—") : ROUTING_MODE_LABELS[ask.mode]) : "Legacy route"} sub={ask.provider === "openrouter" ? `Routing: ${ROUTING_MODE_LABELS[ask.mode]}` : "AI → Features to switch"} />
          <Tile label="AI usage today" value={stats.today.requests.toLocaleString("en-IN")} sub={`${stats.today.ok} ok · ${stats.today.failed} failed`} testid="tile-usage-today" />
          <Tile label="AI cost today" value={formatInr(stats.today.costInr)} sub={stats.today.uncosted ? `${stats.today.uncosted} request(s) without reported cost` : "provider-reported"} testid="tile-cost-today" />
          <Tile
            label="Total AI cost till now"
            value={formatInr(stats.lifetime.costInr)}
            sub={stats.costTrackingSince ? `tracked since ${formatIst(stats.costTrackingSince)}` : "cost tracking starts with the first OpenRouter request"}
          />
          <Tile label="Monthly AI spend" value={`${formatInr(usage.monthInr)} / ${formatInr(engine.budgets.monthlyInr, 0)}`} sub={`${formatInr(remaining)} left this month`} testid="tile-month" />
          <Tile label="Failed requests today" value={String(stats.today.failed)} sub={`${stats.yesterday.failed} yesterday`} />
          <Tile label="USD→INR" value={fx.rate ? String(fx.rate) : "—"} sub={fx.at ? `${fx.source} · ${formatIst(fx.at)}${fx.stale ? " · STALE" : ""}` : (fx.unavailableReason ?? "")} />
          <Tile label="Features turned off" value={String(disabled.length)} sub={disabled.length ? disabled.map((d) => d.label).join(", ").slice(0, 80) : "all features on"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>Recent AI activity</CardTitle>
            <CardDescription>The last 8 provider requests (no prompts or answers are stored).</CardDescription>
          </div>
          <Link href="/admin/ai/history" className="text-sm text-[var(--color-primary)]">
            Full history →
          </Link>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-3 font-medium">Time (IST)</th>
                <th className="py-1 pr-3 font-medium">Feature</th>
                <th className="py-1 pr-3 font-medium">Model</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatIst(r.createdAt)}</td>
                  <td className="py-1.5 pr-3">{ENGINE_FEATURE_MAP[r.feature as keyof typeof ENGINE_FEATURE_MAP]?.label ?? r.feature}</td>
                  <td className="py-1.5 pr-3 break-all font-mono text-xs">{`${r.provider} · ${r.model}`}</td>
                  <td className="py-1.5 pr-3">{r.ok ? <Badge variant="success">OK</Badge> : <Badge variant="error">{r.errorCategory ?? "failed"}</Badge>}</td>
                  <td className="py-1.5">{r.actualCostInr !== null ? formatInr(r.actualCostInr, 4) : r.costStatus === "pending" ? "pending" : "not reported"}</td>
                </tr>
              ))}
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-[var(--color-muted-foreground)]">
                    No AI requests yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value, sub, testid }: { label: string; value: React.ReactNode; sub?: string; testid?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid={testid}>
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</p>
      <div className="break-words text-lg font-semibold text-[var(--color-foreground)]">{value}</div>
      {sub ? <p className="break-words text-xs text-[var(--color-muted-foreground)]">{sub}</p> : null}
    </div>
  );
}
