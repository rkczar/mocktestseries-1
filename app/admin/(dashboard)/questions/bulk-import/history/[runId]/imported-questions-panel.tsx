"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Archive, ShieldAlert, Skull, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ForceDeleteResult, ForcePreview, ResolvePlanRow, ResolveResult, RollbackResult, SelectionPreview } from "@/lib/import-rollback";
import { ROW_FILTERS, ROW_FILTER_LABEL, type Dependency, type ImportSelection, type ImportedQuestionRow, type RowFilter } from "@/lib/import-history-selection";
import {
  executeImportRollbackAction,
  forceDeleteAction,
  planResolveAction,
  previewForceDeleteAction,
  previewImportSelectionAction,
  resolveProtectedAction,
} from "./actions";

const ROLLBACK_LABEL = {
  DELETED: { text: "Deleted", variant: "neutral" as const },
  ARCHIVED: { text: "Archived", variant: "warning" as const },
  PROTECTED: { text: "Protected at last action", variant: "error" as const },
  ALREADY_MISSING: { text: "Already missing", variant: "neutral" as const },
  FAILED: { text: "Last action failed", variant: "error" as const },
};
const ACTION_VARIANT = { CREATED: "success", REPLACED: "primary", SKIPPED: "warning", FAILED: "error", PENDING: "neutral" } as const;

export interface PanelCounts {
  imported: number;
  active: number;
  archived: number;
  deleted: number;
  deletable: number;
  archiveOnly: number;
  protected: number;
}

/** Selection-relevant totals for the whole filtered result (every page), computed on the server. */
export interface FilteredTotals {
  rows: number;
  selectable: number;
  deletable: number;
  archiveOnly: number;
  protected: number;
}

type Selection = { kind: "ids"; ids: Set<string> } | { kind: "all" };

/** A row can be selected when this import created it and the question still exists. */
const selectable = (r: ImportedQuestionRow) => r.action === "CREATED" && r.question !== null && r.classification !== null && r.classification !== "ALREADY_MISSING";

function protectedLabel(deps: Dependency[]): string {
  const protect = deps.filter((d) => d.level === "PROTECT");
  if (protect.length === 1) return `Protected · ${protect[0].label}`;
  return `Protected · ${protect.length} dependencies`;
}

function StatusCell({ r }: { r: ImportedQuestionRow }) {
  return (
    <div className="flex flex-col items-start gap-1 text-xs">
      {r.rollbackAction ? <Badge variant={ROLLBACK_LABEL[r.rollbackAction].variant}>{ROLLBACK_LABEL[r.rollbackAction].text}</Badge> : null}
      {r.classification === "SAFE_TO_DELETE" ? <Badge variant="success">Deletable</Badge> : null}
      {r.classification === "ARCHIVE_ONLY" ? <Badge variant="warning">Archive only · {r.dependencies.length === 1 ? r.dependencies[0].label : `${r.dependencies.length} dependencies`}</Badge> : null}
      {r.classification === "PROTECTED" ? <Badge variant="error">{protectedLabel(r.dependencies)}</Badge> : null}
      {r.classification === "ALREADY_MISSING" ? <Badge variant="neutral">Already deleted / missing</Badge> : null}
      {r.dependencies.length ? <DependencyList deps={r.dependencies} /> : null}
      {!r.classification && r.action !== "CREATED" ? <span className="text-[var(--color-muted-foreground)]">{r.reasons.join("; ")}</span> : null}
      {!r.classification && r.rollbackReason ? <span className="text-[var(--color-muted-foreground)]">{r.rollbackReason}</span> : null}
    </div>
  );
}

function DependencyList({ deps, open }: { deps: Dependency[]; open?: boolean }) {
  return (
    <details open={open} className="text-xs">
      <summary className="cursor-pointer text-[var(--color-primary)]">View dependencies ({deps.length})</summary>
      <ul className="mt-1 flex flex-col gap-0.5 text-[var(--color-muted-foreground)]">
        {deps.map((d, i) => (
          <li key={`${d.kind}-${i}`}>
            <span className={d.level === "PROTECT" ? "text-[var(--color-error)]" : "text-[var(--color-warning)]"}>{d.level === "PROTECT" ? "●" : "○"}</span> {d.label}
            {d.items?.length ? (
              <span>
                {" "}
                — {d.items.map((it) => (it.attempts !== undefined ? `${it.title} (${it.attempts} attempt${it.attempts === 1 ? "" : "s"})` : it.title)).join(", ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Imported Questions for one Bulk Import run, paginated on the server. MASTER_ADMIN
 * can select rows (this page, or every row matching the current filter via a
 * server-resolved "all" selection — ids are never bulk-loaded into the browser)
 * and Archive / Delete permanently / Resolve & Remove. Every action re-checks
 * permissions, ids and dependencies on the server. FULL_ADMIN sees everything read-only.
 */
export function ImportedQuestionsPanel({
  runId,
  filename,
  rows,
  page,
  totalPages,
  filter,
  search,
  counts,
  totals,
  canManage,
}: {
  runId: string;
  filename: string;
  rows: ImportedQuestionRow[];
  page: number;
  totalPages: number;
  filter: RowFilter;
  search: string;
  counts: PanelCounts;
  totals: FilteredTotals;
  canManage: boolean;
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection>({ kind: "ids", ids: new Set() });
  const [dialog, setDialog] = useState<null | "archive" | "delete" | "resolve" | "force">(null);
  const [forceScope, setForceScope] = useState<ImportSelection | null>(null);
  const [forcePreview, setForcePreview] = useState<ForcePreview | null>(null);
  const [forceResult, setForceResult] = useState<ForceDeleteResult | null>(null);
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [plan, setPlan] = useState<ResolvePlanRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [archiveHistory, setArchiveHistory] = useState(true);
  const [detach, setDetach] = useState({ mockTests: false, pyqPaper: false, adminCustomModules: false });
  const [then, setThen] = useState<"NONE" | "ARCHIVE" | "DELETE">("ARCHIVE");
  const [result, setResult] = useState<RollbackResult | null>(null);
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const pageSelectable = useMemo(() => rows.filter(selectable), [rows]);
  const selectedRows = selection.kind === "all" ? pageSelectable : pageSelectable.filter((r) => selection.ids.has(r.rowId));
  const stats =
    selection.kind === "all"
      ? { selected: totals.selectable, deletable: totals.deletable, archiveOnly: totals.archiveOnly, protected: totals.protected }
      : {
          selected: selectedRows.length,
          deletable: selectedRows.filter((r) => r.classification === "SAFE_TO_DELETE").length,
          archiveOnly: selectedRows.filter((r) => r.classification === "ARCHIVE_ONLY").length,
          protected: selectedRows.filter((r) => r.classification === "PROTECTED").length,
        };
  const pageAllSelected = pageSelectable.length > 0 && (selection.kind === "all" || pageSelectable.every((r) => selection.ids.has(r.rowId)));
  const pageSomeSelected = selection.kind === "ids" && pageSelectable.some((r) => selection.ids.has(r.rowId));

  const toServer = (): ImportSelection => (selection.kind === "all" ? { kind: "all", filter, search } : { kind: "ids", rowIds: [...selection.ids] });

  const href = (next: { page?: number; filter?: RowFilter; search?: string }) => {
    const p = new URLSearchParams();
    const f = next.filter ?? filter;
    const s = next.search ?? search;
    const pg = next.page ?? 1;
    if (f !== "ALL") p.set("qf", f);
    if (s) p.set("qs", s);
    if (pg > 1) p.set("qp", String(pg));
    const qs = p.toString();
    return `/admin/questions/bulk-import/history/${runId}${qs ? `?${qs}` : ""}#imported-questions`;
  };

  const toggle = (rowId: string, on: boolean) =>
    setSelection((prev) => {
      // Leaving "all matching" mode: keep this page's rows explicitly, minus the toggled one.
      const ids = prev.kind === "all" ? new Set(pageSelectable.map((r) => r.rowId)) : new Set(prev.ids);
      if (on) ids.add(rowId);
      else ids.delete(rowId);
      return { kind: "ids", ids };
    });
  const togglePage = (on: boolean) => setSelection({ kind: "ids", ids: on ? new Set(pageSelectable.map((r) => r.rowId)) : new Set() });

  const openForce = (sel: ImportSelection) => {
    setDialog("force");
    setForceScope(sel);
    setForcePreview(null);
    setForceResult(null);
    setLoadError(null);
    setConfirmText("");
    setRunError(null);
    startTransition(async () => {
      const res = await previewForceDeleteAction(runId, sel);
      if (res.error) setLoadError(res.error);
      else setForcePreview(res.preview!);
    });
  };

  const runForce = () => {
    if (!forceScope) return;
    setRunError(null);
    startTransition(async () => {
      try {
        const res = await forceDeleteAction({ runId, selection: forceScope, confirmation: confirmText });
        if (res.error) setRunError(res.error);
        else {
          setForceResult(res.result!);
          finish();
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Force delete failed.");
      }
    });
  };

  const open = (kind: "archive" | "delete" | "resolve") => {
    setDialog(kind);
    setPreview(null);
    setPlan(null);
    setLoadError(null);
    setConfirmText("");
    setResult(null);
    setResolveResult(null);
    setRunError(null);
    setArchiveHistory(true);
    setDetach({ mockTests: false, pyqPaper: false, adminCustomModules: false });
    setThen("ARCHIVE");
    const sel = toServer();
    startTransition(async () => {
      if (kind === "resolve") {
        const res = await planResolveAction(runId, sel);
        if (res.error) setLoadError(res.error);
        else setPlan(res.rows ?? []);
      } else {
        const res = await previewImportSelectionAction(runId, sel);
        if (res.error) setLoadError(res.error);
        else setPreview(res.preview!);
      }
    });
  };

  const finish = () => {
    setSelection({ kind: "ids", ids: new Set() });
    router.refresh();
  };

  const runRollback = (mode: "ARCHIVE" | "DELETE" | "AUTO") => {
    setRunError(null);
    startTransition(async () => {
      try {
        const res = await executeImportRollbackAction({ runId, selection: toServer(), mode, confirmation: mode === "ARCHIVE" ? "ARCHIVE" : confirmText });
        if (res.error) setRunError(res.error);
        else {
          setResult(res.result!);
          finish();
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Action failed.");
      }
    });
  };

  const runResolve = () => {
    setRunError(null);
    startTransition(async () => {
      try {
        const res = await resolveProtectedAction({ runId, selection: toServer(), detach, then, confirmation: confirmText });
        if (res.error) setRunError(res.error);
        else {
          setResolveResult(res.result!);
          finish();
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Action failed.");
      }
    });
  };

  const planCount = (kind: Dependency["kind"]) => plan?.filter((p) => p.dependencies.some((d) => d.kind === kind)).length ?? 0;
  const nothingSelected = stats.selected === 0;

  return (
    <Card id="imported-questions">
      <CardHeader className="gap-3">
        <div>
          <CardTitle>Imported Questions</CardTitle>
          <CardDescription>
            The questions this run created or touched. Only questions <strong>created</strong> by this import can be archived or
            deleted here; replaced or skipped questions existed before it. The import record itself is always kept.
          </CardDescription>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <MiniStat label="Imported" value={counts.imported} />
          <MiniStat label="Active" value={counts.active} />
          <MiniStat label="Archived" value={counts.archived} cls="text-[var(--color-warning)]" />
          <MiniStat label="Deleted" value={counts.deleted} />
          <MiniStat label="Deletable" value={counts.deletable} cls="text-[var(--color-success)]" />
          <MiniStat label="Archive only" value={counts.archiveOnly} cls="text-[var(--color-warning)]" />
          <MiniStat label="Protected" value={counts.protected} cls="text-[var(--color-error)]" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter imported questions">
            {ROW_FILTERS.map((f) => (
              <Button key={f} asChild size="compact" variant={f === filter ? "secondary" : "ghost"}>
                <Link href={href({ filter: f })} scroll={false} aria-current={f === filter ? "page" : undefined}>
                  {ROW_FILTER_LABEL[f]}
                </Link>
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const q = String(new FormData(e.currentTarget).get("qs") ?? "");
              router.push(href({ search: q }), { scroll: false });
            }}
          >
            <Input name="qs" defaultValue={search} placeholder="Search code or text…" className="h-8 w-56 text-xs" aria-label="Search question code or text" />
            <Button type="submit" size="sm" variant="outline">
              Search
            </Button>
          </form>
        </div>

        {canManage ? (
          <div className="flex flex-col gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] p-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span>
                Selected: <strong>{stats.selected}</strong>
              </span>
              <span className="text-[var(--color-success)]">
                Deletable: <strong>{stats.deletable}</strong>
              </span>
              <span className="text-[var(--color-warning)]">
                Archive only: <strong>{stats.archiveOnly}</strong>
              </span>
              <span className="text-[var(--color-error)]">
                Protected: <strong>{stats.protected}</strong>
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => open("archive")} disabled={nothingSelected || stats.deletable + stats.archiveOnly === 0}>
                  <Archive className="h-3.5 w-3.5" aria-hidden /> Archive Selected
                </Button>
                <Button type="button" size="sm" variant="danger" onClick={() => open("delete")} disabled={nothingSelected || stats.deletable + stats.archiveOnly === 0}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete Selected
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => open("resolve")} disabled={stats.protected === 0}>
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Resolve &amp; Remove ({stats.protected})
                </Button>
                <Button type="button" size="sm" variant="danger" onClick={() => openForce(toServer())} disabled={nothingSelected}>
                  <Skull className="h-3.5 w-3.5" aria-hidden /> Force Delete Selected ({stats.selected})
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-muted-foreground)]">
              <span>Force Delete removes questions no matter where they are used (Mock Tests, PYQ papers, Custom Modules, archived or not).</span>
              <Button type="button" size="sm" variant="danger" onClick={() => openForce({ kind: "all", filter: "ALL", search: "" })} disabled={counts.imported - counts.deleted <= 0}>
                <Skull className="h-3.5 w-3.5" aria-hidden /> Force Delete ALL From This Import ({Math.max(0, counts.imported - counts.deleted)})
              </Button>
            </div>
            {pageAllSelected && selection.kind === "ids" && totals.selectable > pageSelectable.length ? (
              <p className="text-xs">
                All {pageSelectable.length} selectable on this page are selected.{" "}
                <button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={() => setSelection({ kind: "all" })}>
                  Select all {totals.selectable} questions from this import{filter !== "ALL" || search ? " matching this filter" : ""}
                </button>
              </p>
            ) : null}
            {selection.kind === "all" ? (
              <p className="text-xs">
                All {totals.selectable} questions from this import{filter !== "ALL" || search ? " matching this filter" : ""} are selected (resolved on the server).{" "}
                <button type="button" className="font-medium text-[var(--color-primary)] hover:underline" onClick={() => togglePage(false)}>
                  Clear selection
                </button>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">View only — archiving or deleting imported questions is restricted to the Master Admin.</p>
        )}
      </CardHeader>

      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No imported questions {filter !== "ALL" || search ? "match this filter" : "in this run"}.</p>
        ) : (
          <>
            {/* Desktop: compact table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="py-2 pr-3">
                      {canManage ? (
                        <Checkbox
                          checked={pageAllSelected ? true : pageSomeSelected ? "indeterminate" : false}
                          onCheckedChange={(v) => togglePage(v === true)}
                          disabled={pageSelectable.length === 0}
                          aria-label={`Select all ${pageSelectable.length} on this page`}
                        />
                      ) : null}
                    </th>
                    <th className="py-2 pr-3">Row</th>
                    <th className="py-2 pr-3">Question Code</th>
                    <th className="py-2 pr-3">Question</th>
                    <th className="py-2 pr-3">Subject / Topic</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Import</th>
                    <th className="py-2 pr-3">Dependencies</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rowId} className="border-b border-[var(--color-border)] align-top last:border-0">
                      <td className="py-2 pr-3">
                        {canManage ? (
                          <Checkbox
                            checked={selection.kind === "all" ? selectable(r) : selection.ids.has(r.rowId)}
                            disabled={!selectable(r)}
                            onCheckedChange={(v) => toggle(r.rowId, v === true)}
                            aria-label={`Select ${r.questionCode ?? `row ${r.rowNumber}`}`}
                          />
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{r.rowNumber}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{r.questionCode ?? "—"}</td>
                      <td className="max-w-xs py-2 pr-3">
                        <span className="line-clamp-2">{r.question?.text ?? <em className="text-[var(--color-muted-foreground)]">(no longer exists)</em>}</span>
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {r.question?.subject ?? "—"}
                        {r.question?.topic ? <span className="block text-[var(--color-muted-foreground)]">{r.question.topic}</span> : null}
                      </td>
                      <td className="py-2 pr-3 text-xs">{r.question?.status ?? "DELETED"}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={ACTION_VARIANT[r.action]}>{r.action}</Badge>
                      </td>
                      <td className="max-w-sm py-2 pr-3">
                        <StatusCell r={r} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards */}
            <div className="flex flex-col gap-2 md:hidden">
              {canManage && pageSelectable.length ? (
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={pageAllSelected ? true : pageSomeSelected ? "indeterminate" : false} onCheckedChange={(v) => togglePage(v === true)} />
                  Select all {pageSelectable.length} on this page
                </label>
              ) : null}
              {rows.map((r) => (
                <div key={r.rowId} className="flex gap-3 rounded-[var(--radius-button)] border border-[var(--color-border)] p-3">
                  {canManage ? (
                    <Checkbox
                      className="mt-0.5"
                      checked={selection.kind === "all" ? selectable(r) : selection.ids.has(r.rowId)}
                      disabled={!selectable(r)}
                      onCheckedChange={(v) => toggle(r.rowId, v === true)}
                      aria-label={`Select ${r.questionCode ?? `row ${r.rowNumber}`}`}
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono">{r.questionCode ?? `Row ${r.rowNumber}`}</span>
                      <Badge variant={ACTION_VARIANT[r.action]}>{r.action}</Badge>
                      <span className="text-[var(--color-muted-foreground)]">{r.question?.status ?? "DELETED"}</span>
                    </div>
                    <p className="line-clamp-3 text-sm">{r.question?.text ?? <em className="text-[var(--color-muted-foreground)]">(no longer exists)</em>}</p>
                    <StatusCell r={r} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border)] pt-4">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Page {page} of {totalPages} · {totals.rows} rows
            </p>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ page: page - 1 })} scroll={false}>
                    Previous
                  </Link>
                </Button>
              ) : null}
              {page < totalPages ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={href({ page: page + 1 })} scroll={false}>
                    Next
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={dialog !== null} onOpenChange={(v) => (!v && !isPending ? setDialog(null) : undefined)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {dialog === "archive" || dialog === "delete" ? (
            <>
              <DialogHeader>
                <DialogTitle>{dialog === "archive" ? "Archive selected imported questions?" : "Delete selected imported questions?"}</DialogTitle>
                <DialogDescription>Dependencies are re-checked on the server now, and again for every question when it runs.</DialogDescription>
              </DialogHeader>
              {result ? (
                <RollbackResultView result={result} />
              ) : loadError ? (
                <p className="text-sm text-[var(--color-error)]">{loadError}</p>
              ) : !preview ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">Analyzing dependencies…</p>
              ) : (
                <div className="flex flex-col gap-3 text-sm">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-[var(--color-muted-foreground)]">Import</dt>
                    <dd className="break-all font-medium">{filename}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Selected</dt>
                    <dd className="font-medium">{preview.total}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Safe to permanently delete</dt>
                    <dd className="font-medium text-[var(--color-success)]">{preview.safe}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Has student history — archive only</dt>
                    <dd className="font-medium text-[var(--color-warning)]">{preview.archive}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Protected — untouched</dt>
                    <dd className="font-medium text-[var(--color-error)]">{preview.protected}</dd>
                    {preview.alreadyArchived ? (
                      <>
                        <dt className="text-[var(--color-muted-foreground)]">Already archived</dt>
                        <dd className="font-medium">{preview.alreadyArchived}</dd>
                      </>
                    ) : null}
                  </dl>
                  <div className="flex gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
                    <div className="flex flex-col gap-1">
                      {dialog === "archive" ? (
                        <p>
                          <strong>{preview.safeNotArchived + preview.archive}</strong> question(s) will be set to ARCHIVED: removed from every active question
                          pool, still visible in students&apos; past results. Nothing is deleted and this can be reversed by changing the status back.
                        </p>
                      ) : (
                        <>
                          <p>
                            <strong>{preview.safe}</strong> question(s) have no tests, papers, attempts, saved lists or reports and will be{" "}
                            <strong>permanently deleted</strong> (with their options and AI explanation cache). This cannot be undone except from a database
                            backup.
                          </p>
                          <p>
                            <strong>{preview.archive}</strong> question(s) appear in students&apos; attempts, saved lists, reports or personal modules. They are
                            never hard deleted — historical results stay exactly as they are.
                          </p>
                        </>
                      )}
                      <p>
                        <strong>{preview.protected}</strong> protected question(s) are part of a Mock Test, Previous Year Paper, Custom Module, Grand or Live
                        Test and are left untouched. Use <em>Resolve &amp; Remove</em> for those.
                      </p>
                      <p>The import history record is kept either way.</p>
                    </div>
                  </div>
                  {dialog === "delete" ? (
                    <>
                      {preview.archive ? (
                        <label className="flex items-center gap-2 text-xs">
                          <Checkbox checked={archiveHistory} onCheckedChange={(v) => setArchiveHistory(v === true)} />
                          Also archive the {preview.archive} question(s) with student history
                        </label>
                      ) : null}
                      <label className="flex flex-col gap-1.5 text-xs">
                        <span>
                          Type <strong>DELETE {preview.safe}</strong> to confirm
                        </span>
                        <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" aria-label={`Type DELETE ${preview.safe} to confirm`} />
                      </label>
                    </>
                  ) : null}
                  {runError ? <p className="text-sm text-[var(--color-error)]">{runError}</p> : null}
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={isPending}>
                  {result ? "Close" : "Cancel"}
                </Button>
                {!result && preview && dialog === "archive" ? (
                  <Button type="button" variant="primary" onClick={() => runRollback("ARCHIVE")} disabled={isPending || preview.safeNotArchived + preview.archive === 0}>
                    {isPending ? "Working…" : `Archive ${preview.safeNotArchived + preview.archive}`}
                  </Button>
                ) : null}
                {!result && preview && dialog === "delete" ? (
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => runRollback(archiveHistory ? "AUTO" : "DELETE")}
                    disabled={
                      isPending ||
                      preview.safe + (archiveHistory ? preview.archive : 0) === 0 ||
                      confirmText.trim().replace(/\s+/g, " ") !== `DELETE ${preview.safe}`
                    }
                  >
                    {isPending ? "Working…" : `Delete ${preview.safe}${archiveHistory && preview.archive ? ` · Archive ${preview.archive}` : ""}`}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          ) : null}

          {dialog === "force" ? (
            <>
              <DialogHeader>
                <DialogTitle>Force delete questions?</DialogTitle>
                <DialogDescription>Permanently deletes the questions no matter where they are used. This cannot be undone except from a database backup.</DialogDescription>
              </DialogHeader>
              {forceResult ? (
                <div className="flex flex-col gap-2 text-sm">
                  <p className="font-medium text-[var(--color-foreground)]">Finished — the import history record is kept.</p>
                  <ResultLine label="Permanently deleted" items={forceResult.deleted.map((d) => `${d.code ?? d.questionId}${d.removedFrom.length ? ` — removed from: ${d.removedFrom.join("; ")}` : ""}`)} />
                  <ResultLine label="Already missing" items={forceResult.alreadyMissing.map((d) => d.code ?? d.questionId)} />
                  <ResultLine label="Failed" items={forceResult.failed.map((d) => `${d.code ?? d.questionId} — ${d.error}`)} />
                </div>
              ) : loadError ? (
                <p className="text-sm text-[var(--color-error)]">{loadError}</p>
              ) : !forcePreview ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">Counting…</p>
              ) : (
                <div className="flex flex-col gap-3 text-sm">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-[var(--color-muted-foreground)]">Import</dt>
                    <dd className="break-all font-medium">{filename}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Questions to delete</dt>
                    <dd className="font-medium text-[var(--color-error)]">{forcePreview.total}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">In Mock Tests</dt>
                    <dd className="font-medium">{forcePreview.inMockTests}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">In a Previous Year Paper</dt>
                    <dd className="font-medium">{forcePreview.inPyqPaper}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">In Custom Modules</dt>
                    <dd className="font-medium">{forcePreview.inCustomModules}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">In Grand / Live Tests</dt>
                    <dd className="font-medium">{forcePreview.inGrandOrLive}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Used in student attempts</dt>
                    <dd className="font-medium">{forcePreview.withAttempts}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Saved / reported by students</dt>
                    <dd className="font-medium">{forcePreview.savedOrReported}</dd>
                    <dt className="text-[var(--color-muted-foreground)]">Already archived</dt>
                    <dd className="font-medium">{forcePreview.archived}</dd>
                  </dl>
                  <div className="flex gap-2 rounded-[var(--radius-button)] border border-[var(--color-error)] p-3 text-xs text-[var(--color-muted-foreground)]">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-error)]" aria-hidden />
                    <div className="flex flex-col gap-1">
                      <p>
                        Each question is removed from every Mock Test, Previous Year Paper, Custom Module and Grand / Live Test, then permanently deleted
                        together with its options, AI explanation, saved and report entries.
                      </p>
                      <p>The tests and papers themselves are kept (with fewer questions). Past attempt scores are kept from their frozen copies.</p>
                      <p>The import history record is kept.</p>
                    </div>
                  </div>
                  <label className="flex flex-col gap-1.5 text-xs">
                    <span>
                      Type <strong>FORCE DELETE {forcePreview.total}</strong> to confirm
                    </span>
                    <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" aria-label={`Type FORCE DELETE ${forcePreview.total} to confirm`} />
                  </label>
                  {runError ? <p className="text-sm text-[var(--color-error)]">{runError}</p> : null}
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={isPending}>
                  {forceResult ? "Close" : "Cancel"}
                </Button>
                {!forceResult && forcePreview ? (
                  <Button
                    type="button"
                    variant="danger"
                    onClick={runForce}
                    disabled={isPending || forcePreview.total === 0 || confirmText.trim().replace(/\s+/g, " ") !== `FORCE DELETE ${forcePreview.total}`}
                  >
                    {isPending ? "Deleting…" : `Force Delete ${forcePreview.total}`}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          ) : null}

          {dialog === "resolve" ? (
            <>
              <DialogHeader>
                <DialogTitle>Resolve &amp; Remove protected questions</DialogTitle>
                <DialogDescription>
                  Review every dependency first. Only the links you tick are removed; tests, papers, attempts and results are never deleted.
                </DialogDescription>
              </DialogHeader>
              {resolveResult ? (
                <ResolveResultView result={resolveResult} />
              ) : loadError ? (
                <p className="text-sm text-[var(--color-error)]">{loadError}</p>
              ) : !plan ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">Loading dependencies…</p>
              ) : plan.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No protected questions in this selection.</p>
              ) : (
                <div className="flex flex-col gap-3 text-sm">
                  <div className="max-h-72 overflow-y-auto rounded-[var(--radius-button)] border border-[var(--color-border)]">
                    {plan.map((p) => (
                      <div key={p.rowId} className="border-b border-[var(--color-border)] p-2 text-xs last:border-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-medium">{p.questionCode ?? p.rowId}</span>
                          <span className="text-[var(--color-muted-foreground)]">Import: {filename}</span>
                          <span className="text-[var(--color-muted-foreground)]">Exam: {p.exam ?? "—"}</span>
                          <Badge variant={p.bestOutcome === "DELETE" ? "success" : p.bestOutcome === "ARCHIVE" ? "warning" : "error"}>
                            {p.bestOutcome === "DELETE"
                              ? "Can be deleted after detach"
                              : p.bestOutcome === "ARCHIVE"
                                ? "History — archive only"
                                : "Cannot be resolved here"}
                          </Badge>
                        </div>
                        {p.text ? <p className="mt-1 line-clamp-1 text-[var(--color-muted-foreground)]">{p.text}</p> : null}
                        <DependencyList deps={p.dependencies} open />
                      </div>
                    ))}
                  </div>

                  <fieldset className="flex flex-col gap-1.5 text-xs">
                    <legend className="mb-1 font-medium">1. Remove these links (only what you tick)</legend>
                    <label className="flex items-center gap-2">
                      <Checkbox checked={detach.mockTests} disabled={planCount("MOCK_TEST") === 0} onCheckedChange={(v) => setDetach((d) => ({ ...d, mockTests: v === true }))} />
                      Detach from Mock Tests ({planCount("MOCK_TEST")} question(s)) — future attempts of those mocks will no longer include them
                    </label>
                    <label className="flex items-center gap-2">
                      <Checkbox checked={detach.pyqPaper} disabled={planCount("PYQ_PAPER") === 0} onCheckedChange={(v) => setDetach((d) => ({ ...d, pyqPaper: v === true }))} />
                      Detach from Previous Year Paper ({planCount("PYQ_PAPER")} question(s)) — the question itself is kept
                    </label>
                    <label className="flex items-center gap-2">
                      <Checkbox
                        checked={detach.adminCustomModules}
                        disabled={planCount("ADMIN_CUSTOM_MODULE") === 0}
                        onCheckedChange={(v) => setDetach((d) => ({ ...d, adminCustomModules: v === true }))}
                      />
                      Detach from admin Custom Modules ({planCount("ADMIN_CUSTOM_MODULE")} question(s))
                    </label>
                    <p className="text-[var(--color-muted-foreground)]">
                      Grand / Live Tests, students&apos; own modules and questions later overwritten by another import are never changed here.
                    </p>
                  </fieldset>

                  <fieldset className="flex flex-col gap-1.5 text-xs">
                    <legend className="mb-1 font-medium">2. Then</legend>
                    {(
                      [
                        ["NONE", "Keep the question (only remove the links above — e.g. a wrong PYQ link)"],
                        ["ARCHIVE", "Archive it (recommended when unsure)"],
                        ["DELETE", "Delete permanently if nothing else depends on it — questions with student history are archived instead"],
                      ] as const
                    ).map(([value, text]) => (
                      <label key={value} className="flex items-center gap-2">
                        <input type="radio" name="resolve-then" value={value} checked={then === value} onChange={() => setThen(value)} />
                        {text}
                      </label>
                    ))}
                  </fieldset>

                  <label className="flex flex-col gap-1.5 text-xs">
                    <span>
                      Type <strong>RESOLVE {plan.length}</strong> to confirm
                    </span>
                    <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" aria-label={`Type RESOLVE ${plan.length} to confirm`} />
                  </label>
                  {runError ? <p className="text-sm text-[var(--color-error)]">{runError}</p> : null}
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={isPending}>
                  {resolveResult ? "Close" : "Cancel"}
                </Button>
                {!resolveResult && plan && plan.length ? (
                  <Button
                    type="button"
                    variant={then === "DELETE" ? "danger" : "primary"}
                    onClick={runResolve}
                    disabled={
                      isPending ||
                      (!detach.mockTests && !detach.pyqPaper && !detach.adminCustomModules && then === "NONE") ||
                      confirmText.trim().replace(/\s+/g, " ") !== `RESOLVE ${plan.length}`
                    }
                  >
                    {isPending ? "Working…" : `Resolve ${plan.length}`}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function MiniStat({ label, value, cls }: { label: string; value: number; cls?: string }) {
  return (
    <div className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-2 py-1.5">
      <div className={`text-base font-bold text-[var(--color-foreground)] ${cls ?? ""}`}>{value}</div>
      <div className="text-[11px] text-[var(--color-muted-foreground)]">{label}</div>
    </div>
  );
}

function RollbackResultView({ result }: { result: RollbackResult }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-[var(--color-foreground)]">Finished — the import history record is kept.</p>
      <ResultLine label="Permanently deleted" items={result.deleted.map((d) => d.code ?? d.questionId)} />
      <ResultLine label="Archived" items={result.archived.map((d) => d.code ?? d.questionId)} />
      <ResultLine label="Kept (student history — archive instead)" items={result.keptForHistory.map((d) => `${d.code ?? d.questionId} — ${d.reason}`)} />
      <ResultLine label="Protected (untouched)" items={result.protected.map((d) => `${d.code ?? d.questionId} — ${d.reason}`)} />
      <ResultLine label="Already missing" items={result.alreadyMissing.map((d) => d.code ?? d.questionId)} />
      <ResultLine label="Failed" items={result.failed.map((d) => `${d.code ?? d.questionId} — ${d.error}`)} />
      {result.alreadyProcessed ? <p className="text-xs text-[var(--color-muted-foreground)]">{result.alreadyProcessed} already processed earlier (no-op).</p> : null}
    </div>
  );
}

function ResolveResultView({ result }: { result: ResolveResult }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-[var(--color-foreground)]">Finished — the import history record is kept.</p>
      <ResultLine
        label="Links removed"
        items={result.detached.map(
          (d) =>
            `${d.code ?? d.questionId} — ${[...d.mockTests.map((m) => `Mock: ${m}`), ...(d.pyqPaper ? [`PYQ: ${d.pyqPaper}`] : []), ...d.adminCustomModules.map((m) => `Module: ${m}`)].join(", ")}`
        )}
      />
      <ResultLine label="Permanently deleted" items={result.deleted.map((d) => d.code ?? d.questionId)} />
      <ResultLine label="Archived" items={result.archived.map((d) => d.code ?? d.questionId)} />
      <ResultLine label="Still protected (untouched)" items={result.stillProtected.map((d) => `${d.code ?? d.questionId} — ${d.reason}`)} />
      <ResultLine label="Already missing" items={result.alreadyMissing.map((d) => d.code ?? d.questionId)} />
      <ResultLine label="Failed" items={result.failed.map((d) => `${d.code ?? d.questionId} — ${d.error}`)} />
    </div>
  );
}

function ResultLine({ label, items }: { label: string; items: string[] }) {
  return (
    <details className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5">
      <summary className="cursor-pointer text-sm">
        {label}: <strong>{items.length}</strong>
      </summary>
      {items.length ? <p className="mt-1 max-h-32 overflow-y-auto break-all font-mono text-xs text-[var(--color-muted-foreground)]">{items.join(", ")}</p> : null}
    </details>
  );
}
