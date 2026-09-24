"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { DeletionActions } from "./deletion-actions";

export interface DeletionHistoryRow {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  notes: string | null;
  name: string | null;
  code: string | null;
  email: string | null;
  phone: string | null;
  /** Approved before raw contact was retained — email/phone above are masked. */
  contactMaskedOnly: boolean;
  /** Approved before any identity was retained — nothing to show but the Student ID. */
  identityUnavailable: boolean;
  /** Enrolled exams, then purchased products marked "(purchased)". */
  courses: string[];
  requestedAt: string;
  /** IST calendar date, YYYY-MM-DD — for the date filter. */
  requestedDate: string;
  reviewedAt: string | null;
  reviewer: string | null;
}

const STATUS_VARIANT = { PENDING: "warning", APPROVED: "error", REJECTED: "neutral" } as const;
const STATUS_LABEL = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected" } as const;

export function DeletionHistoryTable({
  rows,
  canReview,
  statuses = ["PENDING", "APPROVED", "REJECTED"],
  emptyText = "No deletion requests.",
}: {
  rows: DeletionHistoryRow[];
  canReview: boolean;
  /** Statuses offered by the filter — hidden when there is only one. */
  statuses?: DeletionHistoryRow["status"][];
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | DeletionHistoryRow["status"]>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    return rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (from && r.requestedDate < from) return false;
      if (to && r.requestedDate > to) return false;
      if (!q) return true;
      if ([r.name, r.code, r.email, ...r.courses].some((v) => v?.toLowerCase().includes(q))) return true;
      return qDigits.length >= 3 && Boolean(r.phone?.replace(/\D/g, "").includes(qDigits));
    });
  }, [rows, query, status, from, to]);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">{emptyText}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
        <Input
          type="search"
          placeholder="Search name, Student ID, email, phone or course"
          aria-label="Search deletion requests"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {statuses.length > 1 ? (
          <SelectNative aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </SelectNative>
        ) : (
          <div className="hidden lg:block" />
        )}
        <Input type="date" aria-label="Requested from" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" aria-label="Requested to" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No requests match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Student</th>
                <th className="py-2 pr-4">Contact</th>
                <th className="py-2 pr-4">Course</th>
                <th className="py-2 pr-4">Request</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Review</th>
                <th className="py-2 pr-4">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                  <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                    {r.name ?? (
                      <span className="italic text-[var(--color-muted-foreground)]">
                        {r.identityUnavailable ? "Historical identity unavailable" : "Name not captured"}
                      </span>
                    )}
                    <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{r.code ?? "—"}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                    <div className="break-all">{r.email ?? "—"}</div>
                    <div className="font-mono">{r.phone ?? "—"}</div>
                    {r.contactMaskedOnly ? <div className="mt-1 italic">Full contact unavailable (deleted before full retention)</div> : null}
                  </td>
                  <td className="max-w-[14rem] py-2.5 pr-4 text-xs text-[var(--color-foreground)]">
                    {r.courses.length ? r.courses.map((c) => <div key={c}>{c}</div>) : <span className="text-[var(--color-muted-foreground)]">—</span>}
                  </td>
                  <td className="max-w-xs py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                    <div className="text-[var(--color-foreground)]">{r.reason || "No reason given"}</div>
                    <div className="whitespace-nowrap text-xs">{r.requestedAt}</div>
                    {r.notes ? <div className="mt-1 text-xs italic">{r.notes}</div> : null}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    {r.status === "APPROVED" ? (
                      <div className="mt-1 whitespace-nowrap text-xs font-medium text-[var(--color-muted-foreground)]">Account Deleted</div>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                    {r.reviewedAt ? (
                      <>
                        <div className="whitespace-nowrap">{r.reviewedAt}</div>
                        <div>by {r.reviewer ?? "unknown admin"}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <div className="flex flex-col items-start gap-2">
                      <Link
                        href={`/admin/students/deletion-requests/${r.id}`}
                        className="text-sm text-[var(--color-primary)] hover:underline"
                      >
                        View Details
                      </Link>
                      {r.status === "PENDING" && canReview ? (
                        <DeletionActions
                          requestId={r.id}
                          name={r.name ?? "Unknown"}
                          code={r.code ?? "—"}
                          contact={[r.email, r.phone].filter(Boolean).join(" · ") || "—"}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
