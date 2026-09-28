"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { assignMocksToSeriesAction, removeMocksFromSeriesAction } from "../actions";

export interface ManageTestRow {
  id: string;
  title: string;
  order: number;
  accessType: "FREE" | "PAID";
  status: string;
  availability: string;
  questionCount: number;
  /** PAID mock that no purchasable plan would cover in its current place. */
  uncoveredPaid: boolean;
}

function RowList({
  rows,
  selected,
  toggle,
  readOnly,
  empty,
}: {
  rows: ManageTestRow[];
  selected: Set<string>;
  toggle: (id: string) => void;
  readOnly: boolean;
  empty: string;
}) {
  if (rows.length === 0) return <p className="py-3 text-sm text-[var(--color-muted-foreground)]">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)]">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          {!readOnly ? (
            <input type="checkbox" aria-label={`Select ${r.title}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
          ) : null}
          <Link href={`/admin/tests/mock/${r.id}`} className="min-w-0 flex-1 truncate text-[var(--color-foreground)] hover:underline">
            #{r.order} · {r.title}
          </Link>
          <Badge variant={r.accessType === "FREE" ? "primary" : "neutral"}>{r.accessType}</Badge>
          <Badge variant={r.status === "PUBLISHED" ? "success" : "neutral"}>{r.status === "PUBLISHED" ? "Published" : r.status === "DRAFT" ? "Draft" : "Archived"}</Badge>
          <span className="text-xs text-[var(--color-muted-foreground)]">{r.availability}</span>
          <span className="text-xs text-[var(--color-muted-foreground)]">{r.questionCount} Qs</span>
          {r.uncoveredPaid ? <Badge variant="warning">Not in any purchasable plan</Badge> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Manage Tests: which existing Mock Tests belong to this series. Assigning
 * or removing only changes MockTest.testSeriesId — never duplicates a mock —
 * and access follows through the series' Product automatically.
 */
export function ManageTestsPanel({
  seriesId,
  assigned,
  unassigned,
  seriesHasPlan,
  readOnly,
}: {
  seriesId: string;
  assigned: ManageTestRow[];
  unassigned: ManageTestRow[];
  seriesHasPlan: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  function run(kind: "add" | "remove") {
    const ids = [...(kind === "add" ? toAdd : toRemove)];
    if (ids.length === 0) return;
    if (kind === "remove" && !window.confirm(`Remove ${ids.length} mock test(s) from this series? They become Standalone; students who reach them only through this series' plan lose access to them.`))
      return;
    setMsg(null);
    start(async () => {
      const r = kind === "add" ? await assignMocksToSeriesAction(seriesId, ids) : await removeMocksFromSeriesAction(seriesId, ids);
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.success ?? "Saved." });
      if (!r.error) {
        setToAdd(new Set());
        setToRemove(new Set());
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">In this series ({assigned.length})</h3>
          {!readOnly ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="button" disabled={pending} onClick={() => setToRemove(new Set(assigned.map((r) => r.id)))}>
                Select all
              </Button>
              <Button size="sm" variant="outline" type="button" disabled={pending || toRemove.size === 0} onClick={() => run("remove")}>
                Remove selected ({toRemove.size})
              </Button>
            </div>
          ) : null}
        </div>
        <RowList rows={assigned} selected={toRemove} toggle={(id) => setToRemove((s) => flip(s, id))} readOnly={readOnly} empty="No mock tests assigned yet." />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--color-foreground)]">Compatible unassigned mocks — same exam, Standalone ({unassigned.length})</h3>
          {!readOnly ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="button" disabled={pending} onClick={() => setToAdd(new Set(unassigned.map((r) => r.id)))}>
                Select all
              </Button>
              <Button size="sm" type="button" disabled={pending || toAdd.size === 0} onClick={() => run("add")}>
                Add selected ({toAdd.size})
              </Button>
            </div>
          ) : null}
        </div>
        <RowList rows={unassigned} selected={toAdd} toggle={(id) => setToAdd((s) => flip(s, id))} readOnly={readOnly} empty="No standalone mock tests of this exam." />
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Added mocks are appended as the next Test Numbers.{" "}
          {seriesHasPlan
            ? "Students who already own this series' plan get them immediately — no per-mock access is created."
            : "No purchasable plan covers this series yet, so PAID mocks here stay locked for students."}
        </p>
      </section>

      {readOnly ? <p className="text-xs text-[var(--color-muted-foreground)]">View only — only a Master Admin can add or remove mock tests.</p> : null}
      {msg ? <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>{msg.text}</p> : null}
    </div>
  );
}
