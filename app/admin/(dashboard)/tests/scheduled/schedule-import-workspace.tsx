"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  previewScheduleImportAction,
  confirmScheduleImportAction,
  type SchedulePreviewResult,
  type SchedulePreviewRow,
  type ScheduleImportConfirmResult,
} from "./actions";

function PreviewButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Parsing…" : "Upload & Preview"}
    </Button>
  );
}

export function ScheduleImportWorkspace({ testSeriesId, examId }: { testSeriesId: string; examId: string }) {
  const previewAction = previewScheduleImportAction.bind(null, testSeriesId);
  const [previewState, formAction] = useActionState<SchedulePreviewResult, FormData>(previewAction, {});
  const [confirming, startConfirm] = useTransition();
  const [confirmResult, setConfirmResult] = useState<ScheduleImportConfirmResult | null>(null);

  const rows: SchedulePreviewRow[] = previewState.rows ?? [];
  const validRows = rows.filter((r) => r.errors.length === 0);
  const invalidRows = rows.filter((r) => r.errors.length > 0);
  const newCount = validRows.filter((r) => r.isNew).length;
  const updateCount = validRows.length - newCount;

  function handleConfirm() {
    startConfirm(async () => {
      const result = await confirmScheduleImportAction(testSeriesId, examId, validRows);
      setConfirmResult(result);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/api/admin/test-schedule/template"
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          Download Schedule Template
        </a>
      </div>

      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          name="file"
          accept=".csv,.xlsx,.xls"
          required
          className="text-sm text-[var(--color-foreground)]"
        />
        <PreviewButton />
        {previewState.error ? <p className="text-sm text-[var(--color-error)]">{previewState.error}</p> : null}
      </form>

      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="success">{updateCount} matched (will update)</Badge>
            <Badge variant="info">{newCount} new (will create as Draft)</Badge>
            <Badge variant={invalidRows.length > 0 ? "error" : "neutral"}>{invalidRows.length} invalid (skipped)</Badge>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Row</th>
                  <th className="py-2 pr-4">Test #</th>
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Match</th>
                  <th className="py-2 pr-4">Available From</th>
                  <th className="py-2 pr-4">Duration</th>
                  <th className="py-2 pr-4">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.rowNumber} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{row.rowNumber}</td>
                    <td className="py-2 pr-4">{row.testNumber ?? "—"}</td>
                    <td className="py-2 pr-4">{row.title || "—"}</td>
                    <td className="py-2 pr-4">
                      {row.errors.length > 0 ? (
                        <Badge variant="error">Invalid</Badge>
                      ) : row.isNew ? (
                        <Badge variant="info">New</Badge>
                      ) : (
                        <Badge variant="success">Matched</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {row.availableFromIso ? new Date(row.availableFromIso).toLocaleString("en-IN") : "Immediate"}
                    </td>
                    <td className="py-2 pr-4">{row.durationMinutes ?? "—"}</td>
                    <td className="py-2 pr-4 text-xs">
                      {[...row.errors, ...row.warnings].map((msg, i) => (
                        <p key={i} className={row.errors.includes(msg) ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]"}>
                          {msg}
                        </p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleConfirm} disabled={confirming || validRows.length === 0}>
              {confirming ? "Importing…" : `Confirm Import (${validRows.length} rows)`}
            </Button>
            {confirmResult?.error ? <p className="text-sm text-[var(--color-error)]">{confirmResult.error}</p> : null}
            {confirmResult?.applied != null ? (
              <p className="text-sm text-[var(--color-success)]">
                Imported — {confirmResult.created} created, {confirmResult.updated} updated.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
