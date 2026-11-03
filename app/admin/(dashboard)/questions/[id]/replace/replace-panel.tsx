"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  applyReplacementAction,
  createCorrectedCopyAction,
  previewReplacementAction,
  type PreviewResult,
} from "../../replacement-actions";

const KIND: Record<string, string> = { MOCK_TEST: "Mock Test", CUSTOM_MODULE: "Custom Module", GRAND_TEST: "Grand Test", LIVE_TEST: "Live Test" };
const ACTION_TEXT: Record<string, string> = {
  SWAP: "Replaced in place",
  SKIP: "Left out (student module)",
  HOLD: "Test taken offline until fixed",
};
const SOURCE: Record<string, string> = {
  MOCK_TEST: "Mock Test",
  PREVIOUS_YEAR_PAPER: "PYQ paper",
  CUSTOM_MODULE: "Custom Module",
  SUBJECT_TEST: "Subject Test",
  GRAND_TEST: "Grand Test",
  LIVE_TEST: "Live Test",
};

/**
 * Retire / Replace: choose the mode, preview exactly what will change, then
 * ONE confirmation (type the question code). Forms use onSubmit +
 * preventDefault, as elsewhere in admin (React 19 form actions reset fields).
 */
export function ReplacePanel({
  oldQuestionId,
  oldCode,
  canPreview,
  canApply,
  isVariant,
  retired,
}: {
  oldQuestionId: string;
  oldCode: string;
  canPreview: boolean;
  canApply: boolean;
  isVariant: boolean;
  /** Already retired (read-only): the panel only shows a confirmation it just made. */
  retired: boolean;
}) {
  const [mode, setMode] = useState<"RETIRE" | "REPLACE">(isVariant ? "RETIRE" : "REPLACE");
  const [replacementRef, setReplacementRef] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; details?: string[] } | null>(null);
  const [copy, setCopy] = useState<{ id: string; code: string } | null>(null);
  const [applied, setApplied] = useState(false);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setPreview(null);
    setConfirm("");
    setMessage(null);
  };

  const runPreview = () =>
    startTransition(async () => {
      setMessage(null);
      const result = await previewReplacementAction(oldQuestionId, mode === "REPLACE" ? replacementRef : null);
      setPreview(result);
      if (!result.ok) setMessage({ kind: "error", text: result.error, details: result.details });
    });

  const makeCopy = () =>
    startTransition(async () => {
      const result = await createCorrectedCopyAction(oldQuestionId);
      if (result.ok) {
        setCopy({ id: result.id, code: result.code });
        setReplacementRef(result.code);
        reset();
      } else setMessage({ kind: "error", text: result.error, details: result.details });
    });

  const apply = () =>
    startTransition(async () => {
      if (!preview?.ok) return;
      const result = await applyReplacementAction({
        oldQuestionId,
        newQuestionId: mode === "REPLACE" ? preview.newQuestionId : null,
        reason,
        expectedHash: preview.summary.hash,
        confirmCode: confirm,
      });
      if (result.ok) {
        // No refresh here: the page re-renders a retired question without this
        // panel, which would hide the confirmation. The links below reload it.
        setMessage({ kind: "ok", text: `Done. ${result.attemptsInvalidated} attempt(s) were reset. Replacement record ${result.replacementId}.` });
        setPreview(null);
        setApplied(true);
      } else setMessage({ kind: "error", text: result.error, details: result.details });
    });

  if (retired && !applied) return null;
  if (!canPreview) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-[var(--color-muted-foreground)]">You can view dependencies; retiring or replacing needs Question Bank manage access.</CardContent>
      </Card>
    );
  }

  const ready = preview?.ok && preview.errors.length === 0;
  const s = preview?.ok ? preview.summary : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retire or replace</CardTitle>
        <CardDescription>
          The question is retired for good: never served again, never re-published. Tests that used it get the replacement at the same
          position. Every attempt of a test or module whose questions change is reset, and open sessions holding it are closed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className={applied ? "hidden" : "flex flex-col gap-4"}
          onSubmit={(e) => {
            e.preventDefault();
            runPreview();
          }}
        >
          <fieldset className="flex flex-wrap gap-4 text-sm">
            {!isVariant ? (
              <label className="flex items-center gap-2">
                <input type="radio" name="mode" checked={mode === "REPLACE"} onChange={() => (setMode("REPLACE"), reset())} />
                Replace with a corrected question
              </label>
            ) : null}
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === "RETIRE"} onChange={() => (setMode("RETIRE"), reset())} />
              Retire only (no replacement)
            </label>
          </fieldset>

          {mode === "REPLACE" ? (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="replacement-ref">
                Corrected question (code or id)
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="replacement-ref"
                  value={replacementRef}
                  onChange={(e) => (setReplacementRef(e.target.value), reset())}
                  placeholder="e.g. RUHSMO 2016 W101"
                  className="max-w-xs"
                />
                <Button type="button" variant="outline" size="sm" onClick={makeCopy} disabled={pending}>
                  Create corrected draft copy
                </Button>
              </div>
              {copy ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Draft {copy.code} created.{" "}
                  <Link className="text-[var(--color-primary)] hover:underline" href={`/admin/questions?tab=add&id=${copy.id}`} target="_blank">
                    Correct it in the editor
                  </Link>{" "}
                  (opens a new tab), save, then preview again.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="replacement-reason">
              Reason (kept in the audit record)
            </label>
            <Textarea id="replacement-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Wrong answer key reported by students" />
          </div>

          <div>
            <Button type="submit" variant="outline" disabled={pending || (mode === "REPLACE" && !replacementRef.trim())}>
              {pending ? "Working…" : "Preview changes"}
            </Button>
          </div>
        </form>

        {applied ? (
          <p className="text-sm">
            <Link className="text-[var(--color-primary)] hover:underline" href="/admin/questions/replacements">
              Replacement history
            </Link>
            {" · "}
            <a className="text-[var(--color-primary)] hover:underline" href={`/admin/questions/${oldQuestionId}/replace`}>
              Reload this question
            </a>
          </p>
        ) : null}

        {message ? (
          <Alert variant={message.kind === "error" ? "destructive" : undefined}>
            <AlertDescription>
              {message.text}
              {message.details?.length ? (
                <ul className="mt-1 list-disc pl-5">
                  {message.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {preview?.ok ? (
          <div className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-4 text-sm" data-testid="replacement-preview">
            {preview.errors.length ? (
              <Alert variant="destructive">
                <AlertDescription>
                  This cannot be applied yet:
                  <ul className="mt-1 list-disc pl-5">
                    {preview.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {s ? (
              <ul className="grid gap-1 sm:grid-cols-2">
                <li>
                  Retire: <b>{oldCode}</b>
                  {preview.variants.length ? ` + ${preview.variants.length} AI variant(s)` : ""}
                </li>
                <li>Replacement: {preview.newQuestionCode ? <b>{preview.newQuestionCode}</b> : "none"}</li>
                <li>
                  Test rows: {s.references.swap} replaced in place · {s.references.hold} held · {s.references.skip} left out
                </li>
                <li>
                  Tests changed: {s.containersChanged.mockTests} mock · {s.containersChanged.adminModules} admin module ·{" "}
                  {s.containersChanged.studentModules} student module
                </li>
                <li>
                  Attempts reset: <b>{s.attemptsInvalidated}</b>
                </li>
                <li>Answers removed from statistics (kept attempts): {s.keptAnswersExcluded}</li>
              </ul>
            ) : null}
            {s && Object.keys(s.attemptsBySource).length ? (
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Attempts reset by type:{" "}
                {Object.entries(s.attemptsBySource)
                  .map(([k, v]) => `${SOURCE[k] ?? k} ${v.submitted} submitted / ${v.inProgress} in progress`)
                  .join(" · ")}
              </p>
            ) : null}
            {s?.holds.length ? (
              <p className="text-xs text-[var(--color-warning)]">
                Taken offline until you fix them in the builder: {s.holds.map((h) => `${KIND[h.kind]} “${h.title}” (${h.from} → ${h.to})`).join(", ")}
              </p>
            ) : null}
            {preview.references.length ? (
              <div className="max-h-72 overflow-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] uppercase text-[var(--color-muted-foreground)]">
                      <th className="py-1 pr-3">Test</th>
                      <th className="py-1 pr-3">Position</th>
                      <th className="py-1 pr-3">Question</th>
                      <th className="py-1 pr-3">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.references.map((r, i) => (
                      <tr key={i} className="border-b border-[var(--color-border)] last:border-0">
                        <td className="py-1 pr-3">
                          {KIND[r.kind]} “{r.title}”{r.studentOwned ? <Badge className="ml-1">student</Badge> : null}
                        </td>
                        <td className="py-1 pr-3 font-mono">Q{r.position}</td>
                        <td className="py-1 pr-3 font-mono">{r.questionCode}</td>
                        <td className="py-1 pr-3">
                          {ACTION_TEXT[r.action]}
                          {r.note ? ` — ${r.note}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-muted-foreground)]">No test or module uses this question.</p>
            )}

            {ready ? (
              canApply ? (
                <form
                  className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    apply();
                  }}
                >
                  <div className="flex flex-col gap-1">
                    <label className="text-xs" htmlFor="confirm-code">
                      Type <span className="font-mono">{oldCode}</span> to confirm
                    </label>
                    <Input id="confirm-code" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="max-w-xs" autoComplete="off" />
                  </div>
                  <Button type="submit" variant="danger" disabled={pending || confirm.trim() !== oldCode || reason.trim().length < 3}>
                    {mode === "REPLACE" ? "Replace question" : "Retire question"}
                  </Button>
                  {reason.trim().length < 3 ? <span className="text-xs text-[var(--color-muted-foreground)]">Add a reason first.</span> : null}
                </form>
              ) : (
                <p className="text-xs text-[var(--color-muted-foreground)]">Only the Master Admin can apply this.</p>
              )
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
