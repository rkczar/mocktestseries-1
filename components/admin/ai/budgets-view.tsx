"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatInr, type BudgetConfig } from "@/lib/ai-engine/config";
import type { BudgetUsage } from "@/lib/ai-engine/budget";
import { refreshFxAction, saveBudgetsAction, setEmergencyStopAction, setFxModeAction } from "@/app/admin/(dashboard)/ai/engine-actions";

interface FxView {
  rate: number | null;
  at: string | null;
  rateDate: string | null;
  source: string | null;
  mode: "auto" | "manual";
  stale: boolean;
  unavailableReason: string | null;
  lastError: string | null;
  manualRate: number | null;
}

const ist = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST" : "—");
const inputCls = "h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-sm";

function Meter({ label, used, limit, held, alertPercent, testid }: { label: string; used: number; limit: number; held: number; alertPercent: number; testid: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const tone = pct >= 100 ? "var(--color-error)" : pct >= alertPercent ? "var(--color-warning)" : "var(--color-primary)";
  return (
    <div className="flex flex-col gap-1" data-testid={testid} data-percent={Math.round(pct)}>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span>{`${formatInr(used)} / ${formatInr(limit, 0)} · ${Math.round(pct)}%`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-[color-mix(in_srgb,var(--color-foreground)_10%,transparent)]" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded" style={{ width: `${pct}%`, background: tone }} />
      </div>
      {held > 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">{`Includes ${formatInr(held)} held for in-flight requests or requests whose cost was not reported (counted at their maximum).`}</p> : null}
    </div>
  );
}

export function BudgetsView({
  canManage,
  budgets,
  usage,
  fx,
  featureLimits,
}: {
  canManage: boolean;
  budgets: BudgetConfig;
  usage: BudgetUsage;
  fx: FxView;
  featureLimits: { key: string; label: string; maxCostInr: number | null; dailyBudgetInr: number | null; spentTodayInr: number; provider: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [b, setB] = useState<BudgetConfig>(budgets);
  const [manual, setManual] = useState(fx.manualRate?.toString() ?? "");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const go = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, ok: string) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      setMsg({ tone: "ok", text: ok });
      router.refresh();
    });
  const dayPct = budgets.dailyInr > 0 ? (usage.dayInr / budgets.dailyInr) * 100 : 100;
  const monthPct = budgets.monthlyInr > 0 ? (usage.monthInr / budgets.monthlyInr) * 100 : 100;
  const alerts = [
    dayPct >= budgets.alertPercent ? `Today's AI spend is at ${Math.round(dayPct)}% of the daily budget.` : null,
    monthPct >= budgets.alertPercent ? `This month's AI spend is at ${Math.round(monthPct)}% of the monthly budget.` : null,
    fx.unavailableReason ? fx.unavailableReason : fx.stale ? "The USD→INR rate is more than 3 days old." : null,
  ].filter(Boolean) as string[];
  const num = (k: keyof BudgetConfig) => (e: React.ChangeEvent<HTMLInputElement>) => setB({ ...b, [k]: Number(e.target.value) });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Budgets</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enforced on the server before every OpenRouter request: the request&apos;s maximum possible cost is reserved first, and the request is refused if a budget would be exceeded. Budgets cannot
          guarantee the exact final provider charge — also set a spending limit on the OpenRouter key itself.
        </p>
      </div>
      {msg ? (
        <p role={msg.tone === "error" ? "alert" : "status"} className={`rounded-md px-3 py-2 text-sm ${msg.tone === "error" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-success)]/10"}`} data-testid="budgets-message">
          {msg.text}
        </p>
      ) : null}
      {alerts.length ? (
        <div role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-2.5 text-sm" data-testid="budget-alerts">
          {alerts.map((a) => (
            <p key={a}>{a}</p>
          ))}
        </div>
      ) : null}

      <Card data-testid="emergency-card" data-stop={String(budgets.emergencyStop)}>
        <CardHeader>
          <CardTitle>Emergency AI stop</CardTitle>
          <CardDescription>Stops every new AI request — OpenRouter and the legacy providers — immediately on all server workers. Cached explanations and stored content are still served.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <span className={`text-sm font-semibold ${budgets.emergencyStop ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>{budgets.emergencyStop ? "AI is STOPPED" : "AI is running"}</span>
          {canManage ? (
            budgets.emergencyStop ? (
              <Button variant="outline" disabled={pending} onClick={() => go(() => setEmergencyStopAction(false), "AI requests are allowed again.")} data-testid="emergency-off">
                Resume AI
              </Button>
            ) : (
              <Button variant="danger" disabled={pending} onClick={() => confirm("Stop ALL new AI requests now?") && go(() => setEmergencyStopAction(true), "Emergency stop is ON. No new AI request will be sent.")} data-testid="emergency-on">
                Stop all AI now
              </Button>
            )
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Utilization</CardTitle>
          <CardDescription>{`IST day ${usage.istDay} · month ${usage.istMonth}`}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Meter label="Today" used={usage.dayInr} limit={budgets.dailyInr} held={usage.dayHeldInr} alertPercent={budgets.alertPercent} testid="meter-day" />
          <Meter label="This month" used={usage.monthInr} limit={budgets.monthlyInr} held={usage.monthHeldInr} alertPercent={budgets.alertPercent} testid="meter-month" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limits</CardTitle>
          <CardDescription>Initial safety defaults: ₹100/day, ₹1,500/month, ₹2 per text request, ₹10 per image. Change them any time.</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!canManage || pending} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs">
              Daily platform AI budget (₹)
              <input className={inputCls} type="number" min={0} step={1} value={b.dailyInr} onChange={num("dailyInr")} data-testid="b-daily" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Monthly platform AI budget (₹)
              <input className={inputCls} type="number" min={0} step={1} value={b.monthlyInr} onChange={num("monthlyInr")} data-testid="b-monthly" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Alert at (% of budget)
              <input className={inputCls} type="number" min={1} max={100} value={b.alertPercent} onChange={num("alertPercent")} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Maximum per text request (₹)
              <input className={inputCls} type="number" min={0.01} step={0.01} value={b.maxTextRequestInr} onChange={num("maxTextRequestInr")} data-testid="b-max-text" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Maximum per image request (₹)
              <input className={inputCls} type="number" min={0.01} step={0.01} value={b.maxImageRequestInr} onChange={num("maxImageRequestInr")} data-testid="b-max-image" />
            </label>
            {canManage ? (
              <div className="flex items-end">
                <Button disabled={pending || (["dailyInr", "monthlyInr", "alertPercent", "maxTextRequestInr", "maxImageRequestInr"] as const).every((k) => b[k] === budgets[k])} onClick={() => go(() => saveBudgetsAction({ dailyInr: b.dailyInr, monthlyInr: b.monthlyInr, alertPercent: b.alertPercent, maxTextRequestInr: b.maxTextRequestInr, maxImageRequestInr: b.maxImageRequestInr }), "Budgets saved.")} data-testid="b-save">
                  Save limits
                </Button>
              </div>
            ) : null}
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Feature limits</CardTitle>
          <CardDescription>
            Per-request and per-day limits for individual features are set in <Link href="/admin/ai/features" className="underline">AI → Features</Link>.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs" data-testid="feature-limits">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Feature</th>
                <th className="py-1 pr-2 font-medium">Provider</th>
                <th className="py-1 pr-2 font-medium">Max per request</th>
                <th className="py-1 pr-2 font-medium">Daily budget</th>
                <th className="py-1 font-medium">Spent today</th>
              </tr>
            </thead>
            <tbody>
              {featureLimits.map((f) => (
                <tr key={f.key} className="border-t border-[var(--color-border)]">
                  <td className="py-1 pr-2">{f.label}</td>
                  <td className="py-1 pr-2">{f.provider === "openrouter" ? "OpenRouter" : "Legacy"}</td>
                  <td className="py-1 pr-2">{f.maxCostInr === null ? "global" : formatInr(f.maxCostInr)}</td>
                  <td className="py-1 pr-2">{f.dailyBudgetInr === null ? "platform only" : formatInr(f.dailyBudgetInr, 0)}</td>
                  <td className="py-1">{formatInr(f.spentTodayInr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card data-testid="fx-card">
        <CardHeader>
          <CardTitle>USD → INR rate</CardTitle>
          <CardDescription>Automatic: Frankfurter (European Central Bank reference rates), refreshed when the stored rate is a day old. Every cost row stores the rate it used.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p data-testid="fx-current">
            {fx.rate ? `1 USD = ₹${fx.rate} · ${fx.source}${fx.rateDate ? ` (ECB date ${fx.rateDate})` : ""} · updated ${ist(fx.at)}${fx.stale ? " · STALE" : ""}` : (fx.unavailableReason ?? "No rate yet.")}
          </p>
          {fx.lastError ? <p className="text-xs text-[var(--color-warning)]">{`Last refresh problem: ${fx.lastError}`}</p> : null}
          {canManage ? (
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="outline" size="sm" disabled={pending} onClick={() => go(refreshFxAction, "Rate refreshed.")} data-testid="fx-refresh">
                Refresh now
              </Button>
              <label className="flex flex-col gap-1 text-xs">
                Manual override (₹ per USD)
                <input className="h-8 w-28 rounded-md border border-[var(--color-border)] bg-transparent px-2" type="number" step="0.01" min="40" max="250" value={manual} onChange={(e) => setManual(e.target.value)} data-testid="fx-manual" />
              </label>
              <Button size="sm" variant="outline" disabled={pending || !manual} onClick={() => go(() => setFxModeAction({ mode: "manual", manualRate: Number(manual) }), "Manual rate set.")} data-testid="fx-set-manual">
                Use manual rate
              </Button>
              {fx.mode === "manual" ? (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => go(() => setFxModeAction({ mode: "auto" }), "Back to the automatic daily rate.")}>
                  Use automatic rate
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
