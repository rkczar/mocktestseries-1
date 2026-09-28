"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface DeviceMonitoringRow {
  id: string;
  studentCode: string;
  name: string;
  /** Full values are used for search only; the table shows the masked ones. */
  email: string | null;
  mobile: string | null;
  emailMasked: string | null;
  mobileMasked: string | null;
  devices: number;
  activeSessions: number;
  lastLoginAt: string | null;
  lastLoginLabel: string;
  recentlyReset: boolean;
  status: "NORMAL" | "LIMIT_REACHED" | "SUSPICIOUS";
}

const FILTERS = [
  { key: "ALL", label: "All" },
  { key: "NORMAL", label: "Normal" },
  { key: "LIMIT_REACHED", label: "Limit Reached" },
  { key: "SUSPICIOUS", label: "Suspicious" },
  { key: "FULL", label: "Full Devices" },
  { key: "RESET", label: "Recently Reset" },
  { key: "MULTI", label: "Multiple Active Sessions" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const STATUS_BADGE = {
  NORMAL: { label: "Normal", variant: "success" },
  LIMIT_REACHED: { label: "Limit Reached", variant: "warning" },
  SUSPICIOUS: { label: "Suspicious", variant: "error" },
} as const;

export function DeviceMonitoringTable({ rows, limit }: { rows: DeviceMonitoringRow[]; limit: number }) {
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "NORMAL" && r.status !== "NORMAL") return false;
      if (filter === "LIMIT_REACHED" && r.status !== "LIMIT_REACHED") return false;
      if (filter === "SUSPICIOUS" && r.status !== "SUSPICIOUS") return false;
      if (filter === "FULL" && r.devices < limit) return false;
      if (filter === "RESET" && !r.recentlyReset) return false;
      if (filter === "MULTI" && r.activeSessions < 2) return false;
      if (!q) return true;
      return [r.name, r.studentCode, r.email ?? "", r.mobile ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [rows, filter, query, limit]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter students">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-[var(--radius-badge)] border px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
              )}
            >
              {f.key === "FULL" ? `${limit}/${limit} Devices` : f.label}
            </button>
          ))}
        </div>
        <div className="relative w-full lg:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email or phone"
            aria-label="Search students"
            className="pl-9"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
              <th className="py-2 pr-4 font-medium">Student</th>
              <th className="py-2 pr-4 font-medium">Email / Phone</th>
              <th className="py-2 pr-4 font-medium">Devices</th>
              <th className="py-2 pr-4 font-medium">Active Sessions</th>
              <th className="py-2 pr-4 font-medium">Last Login</th>
              <th className="py-2 pr-4 font-medium">Security Status</th>
              <th className="py-2 pr-4 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-[var(--color-muted-foreground)]">
                  No students match.
                </td>
              </tr>
            ) : (
              visible.map((r) => {
                const badge = STATUS_BADGE[r.status];
                return (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 pr-4">
                      <p className="text-[var(--color-foreground)]">{r.name}</p>
                      <p className="font-mono text-xs text-[var(--color-muted-foreground)]">{r.studentCode}</p>
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">
                      <p>{r.emailMasked ?? "—"}</p>
                      <p>{r.mobileMasked ?? ""}</p>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant={r.devices >= limit ? "warning" : "neutral"}>
                        {r.devices}/{limit}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-foreground)]">{r.activeSessions} active</td>
                    <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{r.lastLoginLabel}</td>
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {r.recentlyReset ? <Badge variant="info">Reset</Badge> : null}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <Link href={`/admin/students/${r.id}`} className="text-[var(--color-primary)] hover:underline">
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Showing {visible.length} of {rows.length} students with device activity.
      </p>
    </div>
  );
}
