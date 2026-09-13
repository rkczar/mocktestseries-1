import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import OrdersPage from "./orders/page";
import TransactionsPage from "./transactions/page";
import RevenuePage from "./revenue/page";

export const metadata = { title: "Payments — Mock Test Series.in Admin" };

function PaymentsOverview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>Orders, transactions, and revenue reporting.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Payment gateway integration (Razorpay) is configured under Settings → Authentication. Order,
          transaction, and revenue data will populate here once checkout is live.
        </p>
      </CardContent>
    </Card>
  );
}

export default function PaymentsControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Payments</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Orders, transactions, and revenue.</p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <PaymentsOverview /> },
          { value: "orders", label: "Orders", content: <OrdersPage /> },
          { value: "transactions", label: "Transactions", content: <TransactionsPage /> },
          { value: "revenue", label: "Revenue", content: <RevenuePage /> },
        ]}
      />
    </div>
  );
}
