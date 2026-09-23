import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Button } from "@/components/ui/button";
import type { PaymentFilters } from "@/lib/payments/analytics";

export function fmtDate(d: Date | null | undefined, withTime = false): string {
  if (!d) return "—";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

const ORDER_VARIANT: Record<string, "success" | "warning" | "error" | "neutral" | "info"> = {
  PAID: "success",
  PARTIALLY_REFUNDED: "info",
  REFUNDED: "info",
  CREATED: "warning",
  GATEWAY_ORDER_CREATED: "warning",
  PAYMENT_PENDING: "warning",
  FAILED: "error",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  CAPTURED: "success",
  AUTHORIZED: "warning",
  PROCESSED: "success",
  PROCESSING: "warning",
  REQUESTED: "warning",
  RECEIVED: "warning",
  IGNORED: "neutral",
  ACTIVE: "success",
  REVOKED: "error",
  LIFETIME: "success",
  FREE: "info",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={ORDER_VARIANT[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}

export function EnvBadge({ env }: { env: string | null | undefined }) {
  if (env !== "TEST") return null;
  return <Badge variant="warning">TEST</Badge>;
}

export function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`py-2 pr-3 text-xs font-medium uppercase text-[var(--color-muted-foreground)] ${right ? "text-right" : ""}`}>{children}</th>;
}

export function Td({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }) {
  return <td className={`py-2 pr-3 align-top ${right ? "text-right" : ""} ${mono ? "font-mono text-xs" : ""}`}>{children}</td>;
}

export function TableShell({ children, minWidth = 800 }: { children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-[var(--color-border)] [&_thead_tr]:border-b [&_thead_tr]:border-[var(--color-border)]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">{children}</p>;
}

export interface FilterOptions {
  exams: { id: string; name: string }[];
  products: { id: string; name: string }[];
  coupons: { id: string; code: string }[];
}

const toDateInput = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : "");

/** GET filter bar — keeps the active tab; environment defaults to LIVE so TEST data is opt-in. */
export function FilterBar({ tab, filters, options, showStatus = true }: { tab: string; filters: PaymentFilters; options: FilterOptions; showStatus?: boolean }) {
  return (
    <form method="get" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      <input type="hidden" name="tab" value={tab} />
      <SelectNative name="env" defaultValue={filters.environment} aria-label="Environment">
        <option value="LIVE">LIVE</option>
        <option value="TEST">TEST</option>
      </SelectNative>
      <Input type="date" name="from" defaultValue={toDateInput(filters.from)} aria-label="From date" />
      <Input type="date" name="to" defaultValue={toDateInput(filters.to)} aria-label="To date" />
      <SelectNative name="exam" defaultValue={filters.examId ?? ""} aria-label="Exam">
        <option value="">All exams</option>
        {options.exams.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </SelectNative>
      <SelectNative name="product" defaultValue={filters.productId ?? ""} aria-label="Product">
        <option value="">All products</option>
        {options.products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectNative>
      <SelectNative name="coupon" defaultValue={filters.couponId ?? ""} aria-label="Coupon">
        <option value="">All coupons</option>
        {options.coupons.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code}
          </option>
        ))}
      </SelectNative>
      {showStatus ? (
        <SelectNative name="status" defaultValue={filters.status ?? ""} aria-label="Order status">
          <option value="">Any status</option>
          {["PAID", "PAYMENT_PENDING", "GATEWAY_ORDER_CREATED", "FAILED", "EXPIRED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"].map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </SelectNative>
      ) : null}
      <div className="flex gap-2">
        <Input name="student" defaultValue={filters.student ?? ""} placeholder="Student" aria-label="Student" />
        <Button type="submit" size="sm" className="h-10">
          Filter
        </Button>
      </div>
      {filters.environment === "TEST" ? (
        <p className="col-span-full text-xs text-[var(--color-warning)]">Showing TEST-mode transactions — these are not real revenue.</p>
      ) : null}
      <Link href={`/admin/payments?tab=${tab}`} className="col-span-full text-xs text-[var(--color-muted-foreground)] hover:underline">
        Reset filters
      </Link>
    </form>
  );
}
