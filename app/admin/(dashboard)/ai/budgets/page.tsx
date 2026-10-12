import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getEngineConfig } from "@/lib/ai-engine/settings";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { ENGINE_FEATURES } from "@/lib/ai-engine/config";
import { BudgetsView } from "@/components/admin/ai/budgets-view";

export const metadata = { title: "AI Budgets — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI → Budgets: platform daily / monthly AI budgets (IST), per-request
 * limits, feature limits, the emergency stop, budget alerts and the USD→INR
 * rate. Enforced on the server for every OpenRouter request.
 */
export default async function AiBudgetsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_ENGINE_VIEW))) return <RestrictedCard title="AI Budgets" />;
  const canManage = await hasPermission(PERMISSIONS.AI_ENGINE_MANAGE);
  const [engine, usage, fx] = await Promise.all([getEngineConfig(), budgetUsage(), getUsdInr()]);
  const featureLimits = ENGINE_FEATURES.filter((f) => f.inUse).map((f) => ({
    key: f.key,
    label: f.label,
    maxCostInr: engine.features[f.key].maxCostInr,
    dailyBudgetInr: engine.features[f.key].dailyBudgetInr,
    spentTodayInr: usage.byFeatureToday[f.key] ?? 0,
    provider: engine.features[f.key].provider,
  }));
  return (
    <BudgetsView
      canManage={canManage}
      budgets={engine.budgets}
      usage={usage}
      fx={{ rate: fx.rate, at: fx.at?.toISOString() ?? null, rateDate: fx.rateDate, source: fx.source, mode: fx.mode, stale: fx.stale, unavailableReason: fx.unavailableReason, lastError: fx.lastError, manualRate: fx.manualRate }}
      featureLimits={featureLimits}
    />
  );
}
