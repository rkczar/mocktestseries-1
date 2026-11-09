import Link from "next/link";
import { requireTeacherPage } from "@/lib/teacher/page";
import { teacherPaymentFilters } from "@/lib/teacher/payments";
import { FilterBar } from "@/app/admin/(dashboard)/payments/_components/shared";
import { OrdersPanel, OverviewPanel, RevenuePanel, TransactionsPanel, type PaymentsTeacherView } from "@/app/admin/(dashboard)/payments/_components/panels-core";

export const metadata = { title: "Payments — Teacher Portal" };
export const dynamic = "force-dynamic";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "orders", label: "Transactions" },
  { value: "payments", label: "Payment attempts" },
  { value: "revenue", label: "Revenue" },
] as const;

const VIEW: PaymentsTeacherView = {
  orderHref: (id) => `/teacher/payments/orders/${id}`,
  studentHref: (id) => `/teacher/students/${id}`,
};

/**
 * Teacher Portal → Payments (read-only). The Admin → Payments panels and
 * calculations, scoped server-side to the teacher's ACTIVE exams and LIVE
 * transactions (lib/teacher/payments.ts). No refunds, edits or gateway ids.
 */
export default async function TeacherPayments({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const scope = await requireTeacherPage();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.value === sp.tab)?.value ?? "overview";
  const { filters, options } = await teacherPaymentFilters(scope, sp);
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Payments</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Read-only view of payments for your exams. Figures follow Admin → Payments (live transactions only).</p>
      </div>
      <nav className="flex flex-wrap gap-3 text-sm" aria-label="Payments sections">
        {TABS.map((t) => (
          <Link key={t.value} href={`/teacher/payments?tab=${t.value}`} className={t.value === tab ? "font-semibold underline" : "text-[var(--color-muted-foreground)] underline"}>
            {t.label}
          </Link>
        ))}
      </nav>
      {scope.examIds.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No exam is assigned to you yet.</p>
      ) : (
        <>
          <FilterBar tab={tab} filters={filters} options={options} basePath="/teacher/payments" showStatus={tab === "orders"} />
          {tab === "overview" ? <OverviewPanel filters={filters} teacher={VIEW} /> : null}
          {tab === "orders" ? <OrdersPanel filters={filters} teacher={VIEW} /> : null}
          {tab === "payments" ? <TransactionsPanel filters={filters} teacher={VIEW} /> : null}
          {tab === "revenue" ? <RevenuePanel filters={filters} teacher={VIEW} /> : null}
        </>
      )}
    </>
  );
}
