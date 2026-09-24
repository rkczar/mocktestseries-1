"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";

export interface DeletedStudentRow {
  id: string;
  name: string | null;
  code: string | null;
  email: string | null;
  phone: string | null;
  /** Deleted before raw contact was retained — email/phone above are masked. */
  contactMaskedOnly: boolean;
  /** Deleted before any identity was retained. */
  identityUnavailable: boolean;
  reason: string | null;
  requestedAt: string;
  /** IST calendar dates, YYYY-MM-DD — for the date filters. */
  requestedDate: string;
  deletedAt: string | null;
  deletedDate: string;
  deletedTs: number;
  reviewer: string | null;
  authMethods: string[];
  enrolledExams: string[];
  purchasedProducts: string[];
}

const METHOD_LABEL: Record<string, string> = { CREDENTIALS: "Password", GOOGLE: "Google", OTP: "Phone" };

type RecordFilter = "" | "full" | "partial" | "unavailable";
type Sort = "newest" | "oldest" | "name";

function recordKind(r: DeletedStudentRow): Exclude<RecordFilter, ""> {
  if (r.identityUnavailable) return "unavailable";
  if (r.contactMaskedOnly || !r.name) return "partial";
  return "full";
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-[var(--color-muted-foreground)]">—</span>;
  return (
    <>
      {items.map((c) => (
        <div key={c}>{c}</div>
      ))}
    </>
  );
}

export function DeletedStudentsTable({ rows }: { rows: DeletedStudentRow[] }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<RecordFilter>("");
  const [deletedFrom, setDeletedFrom] = useState("");
  const [deletedTo, setDeletedTo] = useState("");
  const [requestedFrom, setRequestedFrom] = useState("");
  const [requestedTo, setRequestedTo] = useState("");
  const [sort, setSort] = useState<Sort>("newest");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const out = rows.filter((r) => {
      if (kind && recordKind(r) !== kind) return false;
      if (deletedFrom && r.deletedDate < deletedFrom) return false;
      if (deletedTo && r.deletedDate > deletedTo) return false;
      if (requestedFrom && r.requestedDate < requestedFrom) return false;
      if (requestedTo && r.requestedDate > requestedTo) return false;
      if (!q) return true;
      if ([r.name, r.code, r.email].some((v) => v?.toLowerCase().includes(q))) return true;
      return qDigits.length >= 3 && Boolean(r.phone?.replace(/\D/g, "").includes(qDigits));
    });
    if (sort === "oldest") out.sort((a, b) => a.deletedTs - b.deletedTs);
    else if (sort === "name") out.sort((a, b) => (a.name ?? "￿").localeCompare(b.name ?? "￿"));
    else out.sort((a, b) => b.deletedTs - a.deletedTs);
    return out;
  }, [rows, query, kind, deletedFrom, deletedTo, requestedFrom, requestedTo, sort]);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No deleted accounts.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          type="search"
          placeholder="Search name, Student ID, email or phone"
          aria-label="Search deleted students"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <SelectNative aria-label="Record" value={kind} onChange={(e) => setKind(e.target.value as RecordFilter)}>
          <option value="">All deleted accounts</option>
          <option value="full">Full identity retained</option>
          <option value="partial">Partial identity (older deletion)</option>
          <option value="unavailable">Historical identity unavailable</option>
        </SelectNative>
        <SelectNative aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="newest">Newest deleted</option>
          <option value="oldest">Oldest deleted</option>
          <option value="name">Name</option>
        </SelectNative>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted-foreground)]">
          Deleted between
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" aria-label="Deleted from" value={deletedFrom} onChange={(e) => setDeletedFrom(e.target.value)} />
            <Input type="date" aria-label="Deleted to" value={deletedTo} onChange={(e) => setDeletedTo(e.target.value)} />
          </div>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted-foreground)]">
          Requested between
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" aria-label="Requested from" value={requestedFrom} onChange={(e) => setRequestedFrom(e.target.value)} />
            <Input type="date" aria-label="Requested to" value={requestedTo} onChange={(e) => setRequestedTo(e.target.value)} />
          </div>
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No deleted accounts match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Student</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Phone</th>
                <th className="py-2 pr-4">Account Status</th>
                <th className="py-2 pr-4">Deletion Reason</th>
                <th className="py-2 pr-4">Requested / Deleted</th>
                <th className="py-2 pr-4">Approved By</th>
                <th className="py-2 pr-4">Login Methods</th>
                <th className="py-2 pr-4">Courses / Enrollments</th>
                <th className="py-2 pr-4">Purchased Products</th>
                <th className="py-2 pr-4" />
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
                  <td className="py-2.5 pr-4 text-xs">
                    <div className="break-all text-[var(--color-foreground)]">{r.email ?? "—"}</div>
                    {r.contactMaskedOnly ? (
                      <div className="mt-1 italic text-[var(--color-muted-foreground)]">Full contact unavailable</div>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-foreground)]">{r.phone ?? "—"}</td>
                  <td className="py-2.5 pr-4">
                    <Badge variant="error">Account Deleted</Badge>
                  </td>
                  <td className="max-w-[14rem] py-2.5 pr-4 text-[var(--color-foreground)]">{r.reason || "No reason given"}</td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                    <div>Requested {r.requestedAt}</div>
                    <div className="text-[var(--color-foreground)]">Deleted {r.deletedAt ?? "—"}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-[var(--color-foreground)]">{r.reviewer ?? "Unknown admin"}</td>
                  <td className="py-2.5 pr-4 text-xs text-[var(--color-foreground)]">
                    <List items={r.authMethods.map((m) => METHOD_LABEL[m] ?? m)} />
                  </td>
                  <td className="max-w-[14rem] py-2.5 pr-4 text-xs text-[var(--color-foreground)]">
                    <List items={r.enrolledExams} />
                  </td>
                  <td className="max-w-[14rem] py-2.5 pr-4 text-xs text-[var(--color-foreground)]">
                    <List items={r.purchasedProducts} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <Link
                      href={`/admin/students/deletion-requests/${r.id}`}
                      className="whitespace-nowrap text-sm text-[var(--color-primary)] hover:underline"
                    >
                      View Details
                    </Link>
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
