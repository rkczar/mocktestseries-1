"use client";

import { useActionState } from "react";

import { FormSelect } from "@/components/admin/FormSelect";
import { SubmitButton } from "@/components/auth/SubmitButton";

import { confirmImportAction, previewImportAction, type ImportState } from "./actions";

const POLICY_OPTIONS = [
  { value: "skip", label: "Skip duplicates (safest — leaves existing questions untouched)" },
  { value: "replace", label: "Replace matching existing questions (same id/code)" },
  { value: "add_anyway", label: "Add anyway (new row, code suffixed -DUP1, -DUP2…)" },
];

export function ImportClient({ exams }: { exams: { id: string; title: string }[] }) {
  const [previewState, previewAction] = useActionState<ImportState, FormData>(
    previewImportAction,
    undefined,
  );
  const [confirmState, confirmAction] = useActionState<ImportState, FormData>(
    confirmImportAction,
    undefined,
  );

  if (previewState?.step === "preview" && confirmState === undefined) {
    const s = previewState;
    return (
      <div className="max-w-2xl">
        <div className="rounded-[12px] border border-border bg-surface p-5">
          <p className="text-sm font-bold text-text-heading">
            {s.fileName} · {s.examTitle} · {s.totalRows} rows
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-[8px] border border-success-border bg-success-tint px-3 py-2 text-success-text">
              <p className="font-display text-lg font-bold">{s.validCount}</p>
              Valid
            </div>
            <div className="rounded-[8px] border border-brand-accent-border bg-brand-accent-tint px-3 py-2 text-brand-accent-text">
              <p className="font-display text-lg font-bold">{s.duplicateCount}</p>
              Duplicate
            </div>
            <div className="rounded-[8px] border border-error-border bg-error-tint px-3 py-2 text-error">
              <p className="font-display text-lg font-bold">{s.invalidCount}</p>
              Invalid
            </div>
          </div>

          {s.invalidSample.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs font-bold text-text-faint uppercase">
                Invalid rows (first {s.invalidSample.length})
              </p>
              <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs text-text-muted">
                {s.invalidSample.map((row) => (
                  <li key={row.rowNumber}>
                    Row {row.rowNumber}: {row.errors.join(" ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {s.duplicateSample.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs font-bold text-text-faint uppercase">
                Duplicate rows (first {s.duplicateSample.length})
              </p>
              <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto text-xs text-text-muted">
                {s.duplicateSample.map((row) => (
                  <li key={row.rowNumber}>
                    Row {row.rowNumber} ({row.matchType}): {row.stem}…
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <form action={confirmAction} className="mt-5 flex flex-col gap-4">
          <input type="hidden" name="storageKey" value={s.storageKey} />
          <input type="hidden" name="fileName" value={s.fileName} />
          <input type="hidden" name="fileHash" value={s.fileHash} />
          <input type="hidden" name="examId" value={s.examId} />
          <FormSelect
            label={`How to handle the ${s.duplicateCount} duplicate row(s)`}
            name="duplicatePolicy"
            defaultValue="skip"
            options={POLICY_OPTIONS}
          />
          <p className="text-xs text-text-faint">
            {s.invalidCount} invalid row(s) will always be skipped — fix them in the source file
            and re-upload if you need them included.
          </p>
          <SubmitButton className="w-fit px-6">
            Import {s.validCount + (s.duplicateCount > 0 ? s.duplicateCount : 0)} rows
          </SubmitButton>
        </form>
      </div>
    );
  }

  if (confirmState?.step === "error") {
    return (
      <p className="max-w-2xl rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
        {confirmState.error}
      </p>
    );
  }

  return (
    <form action={previewAction} encType="multipart/form-data" className="flex max-w-xl flex-col gap-4">
      <FormSelect label="Exam" name="examId" defaultValue={exams[0]?.id} options={exams.map((e) => ({ value: e.id, label: e.title }))} />
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-bold text-text-muted">CSV or XLSX file</span>
        <input type="file" name="file" accept=".csv,.xls,.xlsx" required className="text-sm" />
      </label>
      {previewState?.step === "error" ? (
        <p className="rounded-[9px] border border-error-border bg-error-tint px-3.5 py-2.5 text-sm text-error">
          {previewState.error}
        </p>
      ) : null}
      <SubmitButton className="w-fit px-6">Preview import</SubmitButton>
    </form>
  );
}
