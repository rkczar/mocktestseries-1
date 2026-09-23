import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { Badge } from "@/components/ui/badge";
import { getPaymentMode } from "@/lib/payments/settings";
import { getRazorpayConfig } from "@/lib/razorpay-config";
import { parsePaymentFilters } from "@/lib/payments/analytics";
import { getPaymentsAccess, getFilterOptions } from "./_components/access";
import { FilterBar } from "./_components/shared";
import { OverviewPanel, OrdersPanel, TransactionsPanel, RevenuePanel } from "./_components/panels-core";
import { ProductsPanel, CouponsPanel, SubscriptionsPanel, InvoicesPanel, RefundsPanel } from "./_components/panels-catalog";
import { GatewayPanel, WebhooksPanel, ReconciliationPanel, AuditPanel, SettingsPanel } from "./_components/panels-ops";

export const metadata = { title: "Payments — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "transactions", label: "Transactions" },
  { value: "orders", label: "Orders" },
  { value: "products", label: "Products & Pricing" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "coupons", label: "Coupons" },
  { value: "invoices", label: "Invoices" },
  { value: "refunds", label: "Refunds" },
  { value: "gateway", label: "Gateway Settings" },
  { value: "webhooks", label: "Webhook Events" },
  { value: "reconciliation", label: "Reconciliation" },
  { value: "audit", label: "Audit Logs" },
  { value: "revenue", label: "Revenue Analytics" },
  { value: "settings", label: "Mode & Invoice Settings" },
] as const;

const FILTERED = new Set(["overview", "transactions", "orders", "subscriptions", "invoices", "refunds", "revenue"]);

/**
 * Payment Control Center — the canonical admin surface for commerce. Only the
 * ACTIVE tab is rendered server-side (switching tabs updates ?tab=, which
 * re-renders this page), so each tab only queries what it shows.
 */
export default async function PaymentsControlCenter({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { canView, canManage } = await getPaymentsAccess();
  if (!canView) return <RestrictedCard title="Payments" />;

  const sp = await searchParams;
  const rawTab = typeof sp.tab === "string" ? sp.tab : "overview";
  const tab = TABS.some((t) => t.value === rawTab) ? rawTab : "overview";
  const filters = parsePaymentFilters(sp);
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 60) || null : null;

  const [mode, rzp, options] = await Promise.all([getPaymentMode(), getRazorpayConfig(), FILTERED.has(tab) ? getFilterOptions() : null]);

  const panel = (() => {
    switch (tab) {
      case "transactions":
        return <TransactionsPanel filters={filters} />;
      case "orders":
        return <OrdersPanel filters={filters} />;
      case "products":
        return <ProductsPanel canManage={canManage} />;
      case "subscriptions":
        return <SubscriptionsPanel filters={filters} />;
      case "coupons":
        return <CouponsPanel canManage={canManage} />;
      case "invoices":
        return <InvoicesPanel filters={filters} q={q} />;
      case "refunds":
        return <RefundsPanel filters={filters} />;
      case "gateway":
        return <GatewayPanel canManage={canManage} />;
      case "webhooks":
        return <WebhooksPanel />;
      case "reconciliation":
        return <ReconciliationPanel canManage={canManage} />;
      case "audit":
        return <AuditPanel />;
      case "revenue":
        return <RevenuePanel filters={filters} />;
      case "settings":
        return <SettingsPanel canManage={canManage} />;
      default:
        return <OverviewPanel filters={filters} />;
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Payments</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Payment Control Center — pricing, coupons, orders, entitlements, invoices and Razorpay.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={mode === "PAID" ? "primary" : mode === "FREE" ? "success" : "warning"}>Mode: {mode}</Badge>
          {rzp.environment === "TEST" ? <Badge variant="warning">TEST MODE</Badge> : <Badge variant="error">LIVE</Badge>}
          {!canManage ? <Badge>View only</Badge> : null}
        </div>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={TABS.map((t) => ({
          value: t.value,
          label: t.label,
          content:
            t.value === tab ? (
              <div className="flex flex-col gap-4">
                {options ? <FilterBar tab={tab} filters={filters} options={options} showStatus={tab !== "subscriptions"} /> : null}
                {panel}
              </div>
            ) : null,
        }))}
      />
    </div>
  );
}
