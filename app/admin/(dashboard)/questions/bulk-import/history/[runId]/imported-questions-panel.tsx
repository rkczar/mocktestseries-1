"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ImportedQuestionRow, RollbackResult } from "@/lib/import-rollback";
import { executeImportRollbackAction, previewImportRollbackAction } from "./actions";

const CLASS_LABEL = {
  SAFE_TO_DELETE: { text: "Safe to delete", variant: "success" as const },
  ARCHIVE_ONLY: { text: "Referenced — archive only", variant: "warning" as const },
  PROTECTED: { text: "Protected — cannot delete", variant: "error" as const },
  ALREADY_MISSING: { text: "Already deleted / missing", variant: "neutral" as const },
};
const ROLLBACK_LABEL = {
  DELETED: { text: "Deleted by rollback", variant: "neutral" as const },
  ARCHIVED: { text: "Archived by rollback", variant: "warning" as const },
  PROTECTED: { text: "Protected at rollback", variant: "error" as const },
  ALREADY_MISSING: { text: "Already missing", variant: "neutral" as const },
  FAILED: { text: "Rollback failed", variant: "error" as const },
};
const ACTION_VARIANT = { CREATED: "success", REPLACED: "primary", SKIPPED: "warning", FAILED: "error", PENDING: "neutral" } as const;

type Scope = { total: number; safe: number; archive: number; protected: number; missing: number };

/**
 * Imported Questions for one Bulk Import run: exactly the questions this
 * run's rows point at (CREATED / REPLACED / SKIPPED), with reference status,
 * plus the owner-only "Delete Questions Created By This Import" flow:
 * impact preview → explicit typed confirmation → per-question
 * delete/archive/protect result. REPLACED/SKIPPED questions existed before
 * the import and are never selectable.
 */
export function ImportedQuestionsPanel({
  runId,
  filename,
  rows,
  canDelete,
}: {
  runId: string;
  filename: string;
  rows: ImportedQuestionRow[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"ALL" | "CREATED" | "OTHER">("ALL");
  const [dialog, setDialog] = useState<{ rowIds?: string[] } | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<RollbackResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const eligible = useMemo(() => rows.filter((r) => r.eligible), [rows]);
  const visible = rows.filter((r) => filter === "ALL" || (filter === "CREATED" ? r.action === "CREATED" : r.action !== "CREATED"));

  const openDialog = (rowIds?: string[]) => {
    setDialog({ rowIds });
    setScope(null);
    setPreviewError(null);
    setConfirmText("");
    setResult(null);
    setRunError(null);
    startTransition(async () => {
      const res = await previewImportRollbackAction(runId, rowIds);
      if (res.error) setPreviewError(res.error);
      else setScope(res.scope!);
    });
  };

  const execute = () => {
    if (!dialog) return;
    setRunError(null);
    startTransition(async () => {
      try {
        const res = await executeImportRollbackAction({ runId, rowIds: dialog.rowIds, confirmation: confirmText.trim() });
        if (res.error) setRunError(res.error);
        else {
          setResult(res.result!);
          setSelected(new Set());
          router.refresh();
        }
      } catch (err) {
        setRunError(err instanceof Error ? err.message : "Rollback failed.");
      }
    });
  };

  const toggle = (rowId: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(rowId);
      else next.delete(rowId);
      return next;
    });

  return (
    <Card>
      <CardHeader className="gap-3">
        <div>
          <CardTitle>Imported Questions</CardTitle>
          <CardDescription>
            The exact questions this run&apos;s rows created or touched ({rows.length}). Only questions <strong>created</strong> by
            this import can be deleted; replaced or skipped questions existed before it and are never deleted here. Shared
            Subjects, Topics, Sub-topics and Exams are never deleted.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="h-8 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
            aria-label="Filter by import action"
          >
            <option value="ALL">All actions</option>
            <option value="CREATED">Created by this import</option>
            <option value="OTHER">Replaced / Skipped</option>
          </select>
          <Button type="button" size="sm" variant="outline" onClick={() => setSelected(new Set(eligible.map((r) => r.rowId)))} disabled={!canDelete || eligible.length === 0}>
            Select All Eligible ({eligible.length})
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => openDialog([...selected])} disabled={!canDelete || selected.size === 0}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete Selected ({selected.size})
          </Button>
          <Button type="button" size="sm" variant="danger" onClick={() => openDialog(undefined)} disabled={!canDelete || eligible.length === 0}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete All Questions Created By This Import
          </Button>
        </div>
        {!canDelete ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">View only — deleting imported questions is restricted to the Master Admin.</p>
        ) : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">This run has no imported questions.</p>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="sticky top-0 bg-[var(--color-card)]">
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-3" />
                  <th className="py-2 pr-3">Row</th>
                  <th className="py-2 pr-3">Question Code</th>
                  <th className="py-2 pr-3">Question</th>
                  <th className="py-2 pr-3">Subject</th>
                  <th className="py-2 pr-3">Topic</th>
                  <th className="py-2 pr-3">Sub-topic</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Import Action</th>
                  <th className="py-2 pr-3">Reference / Usage</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.rowId} className="border-b border-[var(--color-border)] align-top last:border-0">
                    <td className="py-2 pr-3">
                      <Checkbox
                        checked={selected.has(r.rowId)}
                        disabled={!canDelete || !r.eligible}
                        onCheckedChange={(v) => toggle(r.rowId, v === true)}
                        aria-label={`Select ${r.questionCode ?? `row ${r.rowNumber}`}`}
                      />
                    </td>
                    <td className="py-2 pr-3">{r.rowNumber}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.questionCode ?? "—"}</td>
                    <td className="max-w-xs py-2 pr-3">
                      <span className="line-clamp-2">{r.question?.text ?? <em className="text-[var(--color-muted-foreground)]">(no longer exists)</em>}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs">{r.question?.subject ?? "—"}</td>
                    <td className="py-2 pr-3 text-xs">{r.question?.topic ?? "—"}</td>
                    <td className="py-2 pr-3 text-xs">{r.question?.subTopic ?? "—"}</td>
                    <td className="py-2 pr-3 text-xs">{r.question?.status ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={ACTION_VARIANT[r.action]}>{r.action}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <div className="flex flex-col items-start gap-1">
                        {r.rollbackAction ? <Badge variant={ROLLBACK_LABEL[r.rollbackAction].variant}>{ROLLBACK_LABEL[r.rollbackAction].text}</Badge> : null}
                        {r.classification ? <Badge variant={CLASS_LABEL[r.classification].variant}>{CLASS_LABEL[r.classification].text}</Badge> : null}
                        {r.reasons.length ? <span className="text-[var(--color-muted-foreground)]">{r.reasons.join("; ")}</span> : null}
                        {!r.classification && r.rollbackReason ? <span className="text-[var(--color-muted-foreground)]">{r.rollbackReason}</span> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={dialog !== null} onOpenChange={(v) => (!v && !isPending ? setDialog(null) : undefined)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{dialog?.rowIds ? "Delete selected imported questions" : "Delete all questions created by this import"}</DialogTitle>
            <DialogDescription>Impact analysis is re-run on the server right now, and again for every question at execution time.</DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium text-[var(--color-foreground)]">Rollback finished — the import history record is kept.</p>
              <ResultLine label="Deleted" items={result.deleted.map((d) => d.code ?? d.questionId)} />
              <ResultLine label="Archived (referenced)" items={result.archived.map((d) => d.code ?? d.questionId)} />
              <ResultLine label="Protected (untouched)" items={result.protected.map((d) => `${d.code ?? d.questionId} — ${d.reason}`)} />
              <ResultLine label="Already missing" items={result.alreadyMissing.map((d) => d.code ?? d.questionId)} />
              <ResultLine label="Failed" items={result.failed.map((d) => `${d.code ?? d.questionId} — ${d.error}`)} />
              {result.alreadyProcessed ? <p className="text-xs text-[var(--color-muted-foreground)]">{result.alreadyProcessed} already deleted earlier (no-op).</p> : null}
            </div>
          ) : previewError ? (
            <p className="text-sm text-[var(--color-error)]">{previewError}</p>
          ) : !scope ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Analyzing references…</p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-[var(--color-muted-foreground)]">Import</dt>
                <dd className="break-all font-medium">{filename}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Questions created (in scope)</dt>
                <dd className="font-medium">{scope.total}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Safe to delete</dt>
                <dd className="font-medium text-[var(--color-success)]">{scope.safe}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Referenced — will be archived</dt>
                <dd className="font-medium text-[var(--color-warning)]">{scope.archive}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Protected — will not be touched</dt>
                <dd className="font-medium text-[var(--color-error)]">{scope.protected}</dd>
                <dt className="text-[var(--color-muted-foreground)]">Already deleted / missing</dt>
                <dd className="font-medium">{scope.missing}</dd>
              </dl>
              <div className="flex gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
                <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
                <div className="flex flex-col gap-1">
                  <p>
                    <strong>Archived</strong> questions appear in students&apos; past attempts, saved lists, reports or AI variants. Hard
                    deleting them would break historical results, so they are set to ARCHIVED instead (removed from every active
                    question pool, history stays valid).
                  </p>
                  <p>
                    <strong>Protected</strong> questions are part of a Mock Test, Custom Module, Grand or Live Test definition, or were
                    later overwritten by another import. They are left untouched; remove them from the test first if needed.
                  </p>
                  <p>Deleted questions cannot be restored except from a database backup.</p>
                </div>
              </div>
              <label className="flex flex-col gap-1.5 text-xs">
                <span>
                  Type <strong>DELETE</strong> to confirm
                </span>
                <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" aria-label="Type DELETE to confirm" />
              </label>
              {runError ? <p className="text-sm text-[var(--color-error)]">{runError}</p> : null}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={isPending}>
              {result ? "Close" : "Cancel"}
            </Button>
            {!result ? (
              <Button
                type="button"
                variant="danger"
                onClick={execute}
                disabled={isPending || !scope || scope.safe + scope.archive === 0 || confirmText.trim() !== "DELETE"}
              >
                {isPending && scope ? "Working…" : `Delete ${scope?.safe ?? 0} / Archive ${scope?.archive ?? 0}`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
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
