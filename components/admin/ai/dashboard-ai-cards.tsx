import Link from "next/link";
import { Bot, IndianRupee, PiggyBank } from "lucide-react";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { dashboardAiStats } from "@/lib/ai-engine/analytics";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { getEngineConfig } from "@/lib/ai-engine/settings";
import { formatInr } from "@/lib/ai-engine/config";
import { formatIst } from "@/lib/ist-time";

const cardCls =
  "rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]";

function Head({ title, icon: Icon }: { title: string; icon: typeof Bot }) {
  return (
    <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
      <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{title}</CardTitle>
      <Icon className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
    </CardHeader>
  );
}

/**
 * Main Admin Dashboard: AI Usage Today, AI Cost Today, Monthly AI Spend.
 * A handful of indexed aggregate queries per page load — no polling, no
 * provider calls. IST day/month. Costs are provider-reported only; requests
 * without a reported cost (legacy providers, history before tracking) are
 * never counted as ₹0. Shown to admins with AI Engine view access.
 */
export async function DashboardAiCards() {
  if (!(await hasPermission(PERMISSIONS.AI_ENGINE_VIEW))) return null;
  const [stats, usage, engine] = await Promise.all([dashboardAiStats(), budgetUsage(), getEngineConfig()]);
  const monthly = engine.budgets.monthlyInr;
  const pct = monthly > 0 ? Math.min(100, Math.round((usage.monthInr / monthly) * 100)) : 0;
  const tone = pct >= 100 ? "var(--color-error)" : pct >= engine.budgets.alertPercent ? "var(--color-warning)" : "var(--color-primary)";
  const change = stats.yesterday.costInr > 0 ? Math.round(((stats.today.costInr - stats.yesterday.costInr) / stats.yesterday.costInr) * 100) : null;

  return (
    <>
      <Link href="/admin/ai/analytics" className={cardCls} data-testid="dash-ai-usage">
        <Head title="AI Usage Today" icon={Bot} />
        <CardContent>
          <p className="text-2xl font-semibold text-[var(--color-foreground)]">
            {stats.today.requests.toLocaleString("en-IN")} <span className="text-sm font-normal text-[var(--color-muted-foreground)]">requests</span>
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">{`${stats.today.ok} successful · ${stats.today.failed} failed · yesterday ${stats.yesterday.requests}`}</p>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">{`Total AI Requests Till Now: ${stats.lifetime.requests.toLocaleString("en-IN")}`}</p>
        </CardContent>
      </Link>
      <Link href="/admin/ai/analytics" className={cardCls} data-testid="dash-ai-cost">
        <Head title="AI Cost Today" icon={IndianRupee} />
        <CardContent>
          <p className="text-2xl font-semibold text-[var(--color-foreground)]">{formatInr(stats.today.costInr)}</p>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">{`Yesterday ${formatInr(stats.yesterday.costInr)}${change !== null ? ` · ${change >= 0 ? "+" : ""}${change}%` : ""}`}</p>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">
            {`Total AI Cost Till Now: ${formatInr(stats.lifetime.costInr)}`}
            {stats.costTrackingSince ? ` (since ${formatIst(stats.costTrackingSince).replace(/,.*$/, "")})` : " (cost tracking starts with the first OpenRouter request)"}
          </p>
        </CardContent>
      </Link>
      <Link href="/admin/ai/budgets" className={cardCls} data-testid="dash-ai-month">
        <Head title="Monthly AI Spend" icon={PiggyBank} />
        <CardContent>
          <p className="text-2xl font-semibold text-[var(--color-foreground)]">
            {formatInr(usage.monthInr)} <span className="text-sm font-normal text-[var(--color-muted-foreground)]">{`/ ${formatInr(monthly, 0)}`}</span>
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-[color-mix(in_srgb,var(--color-foreground)_10%,transparent)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly AI budget used">
            <div className="h-full rounded" style={{ width: `${pct}%`, background: tone }} />
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">{`${pct}% of Monthly Budget Used${engine.budgets.emergencyStop ? " · AI STOPPED" : ""}`}</p>
        </CardContent>
      </Link>
    </>
  );
}
