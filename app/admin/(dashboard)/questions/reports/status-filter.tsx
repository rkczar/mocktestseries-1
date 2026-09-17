"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReportStatus } from "@prisma/client";

const STATUS_FILTERS: { key: ReportStatus | undefined; label: string }[] = [
  { key: undefined, label: "All" },
  { key: "OPEN", label: "Pending" },
  { key: "REVIEWED", label: "In Progress" },
  { key: "RESOLVED", label: "Resolved" },
];

/**
 * Merges `status` into the current query string via router.replace — rather
 * than a plain <Link href="?status=..."> — so this keeps working when
 * embedded under a ControlCenterTabs `?tab=` param (this page is reachable
 * both standalone at /admin/questions/reports and as the Reports/Queries
 * tab under /admin/questions): a plain relative link would silently drop
 * `tab` and bounce the admin back to the first tab on click.
 */
export function ReportStatusFilter({ countByStatus, totalCount }: { countByStatus: Record<string, number>; totalCount: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get("status");

  return (
    <div className="flex flex-wrap gap-2">
      {STATUS_FILTERS.map((f) => {
        const isActive = (f.key ?? null) === (active ?? null) || (!f.key && !active);
        return (
          <button
            key={f.label}
            type="button"
            onClick={() => {
              const params = new URLSearchParams(searchParams.toString());
              if (f.key) params.set("status", f.key);
              else params.delete("status");
              router.replace(`${pathname}?${params.toString()}`, { scroll: false });
            }}
            className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-sm ${
              isActive
                ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"
            }`}
          >
            {f.label} ({f.key ? (countByStatus[f.key] ?? 0) : totalCount})
          </button>
        );
      })}
    </div>
  );
}
