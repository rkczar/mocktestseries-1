"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/ai-import/config";
import type { JobDeletePreview } from "@/lib/ai-import/jobs";
import { cancelJobAction, deleteJobAction, deleteJobPreviewAction, recoverJobAction, retryJobAction } from "@/app/admin/(dashboard)/ai-importer/actions";

export interface JobControlState {
  id: string;
  title: string;
  status: string;
  actions: { cancel: boolean; retry: boolean; delete: boolean; recover: boolean };
}

/** Exactly what Delete import removes (read from the server), with a typed confirmation. */
function DeleteJobDialog({ job, onClose, onDeleted }: { job: JobControlState; onClose: () => void; onDeleted: (message: string) => void }) {
  const [preview, setPreview] = useState<JobDeletePreview | null | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let live = true;
    deleteJobPreviewAction(job.id).then((r) => live && (r.ok ? setPreview(r.data) : setError(r.error)));
    return () => {
      live = false;
    };
  }, [job.id]);
  const remove = () =>
    start(async () => {
      setError(null);
      const r = await deleteJobAction(job.id, typed);
      if (!r.ok) return setError(r.error);
      const d = r.data;
      onDeleted(
        d.alreadyDeleted
          ? "This import was already deleted."
          : `Deleted “${d.title}”: ${d.storedFilesDeleted} stored file(s) and ${d.figuresDeleted} extracted image(s) removed (${formatBytes(d.bytesFreed)})${d.storedFilesKept ? `; ${d.storedFilesKept} file(s) kept because another import uses them` : ""}.${d.warnings.length ? ` ${d.warnings.join(" ")}` : ""}`
      );
    });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent data-testid="delete-job-dialog">
        <DialogHeader>
          <DialogTitle>Delete this import?</DialogTitle>
          <DialogDescription>The import and its importer files are removed. Questions already in the Question Bank are never touched.</DialogDescription>
        </DialogHeader>
        {preview === undefined && !error && <p className="text-sm text-[var(--color-muted-foreground)]">Checking what will be removed…</p>}
        {preview === null && <p className="text-sm">This import no longer exists.</p>}
        {preview && (
          <div className="flex flex-col gap-3 text-sm" data-testid="delete-preview">
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
              <div className="font-medium [overflow-wrap:anywhere]">{preview.title}</div>
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {preview.files.map((f, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-x-3" data-testid="delete-preview-file" data-stored={f.storedCopy}>
                    <span className="[overflow-wrap:anywhere]">
                      {f.name} <span className="text-[var(--color-muted-foreground)]">({f.role === "PAPER" ? "question paper" : "answer key"}, {formatBytes(f.bytes)})</span>
                    </span>
                    <span className="text-[var(--color-muted-foreground)]">{f.storedCopy === "deleted" ? "stored copy deleted" : f.storedCopy === "kept-shared" ? "kept — another import uses it" : "no stored copy"}</span>
                  </li>
                ))}
                {!preview.files.length && <li className="text-[var(--color-muted-foreground)]">No uploaded files.</li>}
              </ul>
            </div>
            <ul className="list-disc pl-5 text-xs">
              <li>Removed: {preview.pages} page record(s) and their renders, {preview.questions} extracted question(s) in the importer, {preview.figures.deleted} extracted image(s){preview.figures.keptShared ? ` (${preview.figures.keptShared} kept, used by another import)` : ""}.</li>
              <li>
                Kept: {preview.importedQuestions ? `${preview.importedQuestions} question(s) already in the Question Bank with their images` : "the Question Bank (nothing from this import is in it)"}
                {preview.bulkImportRuns.length ? `, ${preview.bulkImportRuns.length} Bulk Import history run(s) (rollback stays available there)` : ""}, and the AI cost record (₹{preview.spentInr.toFixed(2)} spent still counts against the pilot budget).
              </li>
              <li>The deletion is recorded in the audit log.</li>
            </ul>
            {preview.blocked && (
              <p className="text-sm text-[var(--color-warning)]" role="alert" data-testid="delete-blocked">
                {preview.blocked}
              </p>
            )}
            {!preview.blocked && (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`delete-confirm-${job.id}`}>Type DELETE to confirm</Label>
                <Input id={`delete-confirm-${job.id}`} className="w-36" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="delete-confirm" />
              </div>
            )}
          </div>
        )}
        {error && (
          <p className="mt-2 text-sm text-[var(--color-error)]" role="alert" data-testid="delete-error">
            {error}
          </p>
        )}
        <DialogFooter className="flex-wrap">
          <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
            Keep import
          </Button>
          <Button variant="danger" size="sm" disabled={pending || !preview || !!preview.blocked || typed !== "DELETE"} onClick={remove} data-testid="delete-job-confirm">
            {pending ? "Deleting…" : "Delete import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cancel / Retry / Start again / Delete for one import. Each button appears only when the server
 * would allow it now, and every action re-checks on the server. A click disables all buttons until
 * the answer arrives, so a double click never sends two requests.
 */
export function JobControls({ job, size = "sm", onDeleted, onMessage }: { job: JobControlState; size?: "sm" | "compact"; onDeleted?: () => void; onMessage?: (m: { text: string; error: boolean }) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [deleting, setDeleting] = useState(false);
  const [local, setLocal] = useState<{ text: string; error: boolean } | null>(null);
  const say = (m: { text: string; error: boolean }) => (onMessage ? onMessage(m) : setLocal(m));
  const act = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, ok: string | ((d: unknown) => string)) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) say({ text: r.error, error: true });
      else {
        say({ text: typeof ok === "string" ? ok : ok(r.data), error: false });
        router.refresh();
      }
    });
  const a = job.actions;
  if (!a.cancel && !a.retry && !a.delete && !a.recover) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2" data-testid="job-controls" data-job-id={job.id}>
        {a.recover && (
          <Button size={size} disabled={pending} onClick={() => act(() => recoverJobAction(job.id), (d) => (d as { message: string }).message)} data-testid="job-recover">
            Start again
          </Button>
        )}
        {a.retry && (
          <Button size={size} disabled={pending} onClick={() => act(() => retryJobAction(job.id), "Retrying — it continues from the last finished step.")} data-testid="job-retry">
            Retry
          </Button>
        )}
        {a.cancel && (
          <Button
            size={size}
            variant="outline"
            disabled={pending}
            onClick={() => window.confirm(`Cancel “${job.title}”? Work stops at the next safe point; no new AI request is sent. Questions already imported stay in the Question Bank.`) && act(() => cancelJobAction(job.id), "Cancelled.")}
            data-testid="job-cancel"
          >
            Cancel
          </Button>
        )}
        {a.delete && (
          <Button size={size} variant="outline" className="border-[color-mix(in_srgb,var(--color-error)_55%,transparent)] text-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)]" disabled={pending} onClick={() => setDeleting(true)} data-testid="job-delete">
            Delete
          </Button>
        )}
      </div>
      {local && (
        <p className={`text-xs ${local.error ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`} role={local.error ? "alert" : "status"} data-testid="job-controls-message">
          {local.text}
        </p>
      )}
      {deleting && (
        <DeleteJobDialog
          job={job}
          onClose={() => setDeleting(false)}
          onDeleted={(m) => {
            setDeleting(false);
            say({ text: m, error: false });
            if (onDeleted) onDeleted();
            else router.refresh();
          }}
        />
      )}
    </div>
  );
}
