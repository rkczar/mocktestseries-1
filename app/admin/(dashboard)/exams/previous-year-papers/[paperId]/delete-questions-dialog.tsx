"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  DeletePreview,
  DeleteResult,
} from "@/lib/question-permanent-delete";
import {
  deleteQuestionsAction,
  previewDeleteAction,
  type DeleteTarget,
} from "./delete-actions";

export type DeleteRequest = {
  kind: "SINGLE" | "BATCH" | "BULK";
  batchKey?: string;
  ids: DeleteTarget;
  title: string;
};

const LABELS: Record<string, string> = {
  options: "Options",
  assets: "Images / assets",
  attemptQuestions: "Student attempt questions",
  answers: "Student answers",
  mock: "Mock test links",
  custom: "Custom module links",
  grand: "Grand test links",
  live: "Live test links",
  saved: "Saved by students",
  reports: "Reports",
  aiExplanations: "AI explanations",
  aiExplanationVariants: "AI explanation variants",
  revisions: "Revisions",
  importRows: "Import rows (unlinked)",
  aiImportLinks: "AI importer rows (unlinked, rejected)",
  igQueue: "Instagram queue items",
  igPosts: "Instagram posts (kept, reference only)",
};

const NETWORK_ERROR =
  "No response from the server. The deletion may or may not have completed — Retry is safe: a finished deletion is reported, never repeated.";

export function DeleteQuestionsDialog({
  paperId,
  request,
  onClose,
  onDone,
}: {
  paperId: string;
  request: DeleteRequest;
  onClose: () => void;
  onDone: (deletedIds: string[]) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [result, setResult] = useState<DeleteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  // One id per opened dialog: a retry reuses it, so the server replays instead of deleting twice.
  const [opId] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const phrase = request.kind === "BATCH" ? "DELETE BATCH" : "DELETE";
  const scope = { paperId, batchKey: request.batchKey };

  useEffect(() => {
    start(async () => {
      try {
        const r = await previewDeleteAction(
          { paperId, batchKey: request.batchKey },
          request.ids,
        );
        if (r.ok) setPreview(r.data);
        else setError(r.error);
      } catch {
        setError(NETWORK_ERROR);
      }
    });
  }, [request, paperId]);

  function confirm() {
    if (!preview) return;
    setError(null);
    start(async () => {
      // A lost response (network/server crash) must not crash the page: the same opId lets Retry replay safely.
      const r = await deleteQuestionsAction(
        scope,
        request.ids,
        request.kind,
        opId,
        typed,
      ).catch(() => ({ ok: false as const, error: NETWORK_ERROR }));
      if (r.ok) {
        setResult(r.data);
        onDone(preview.questions.map((q) => q.id));
        router.refresh();
      } else setError(r.error);
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        data-testid="delete-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {result ? "Deletion complete" : request.title}
          </DialogTitle>
          <DialogDescription>
            This operation permanently deletes this question and its associated
            data from the entire platform. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {pending && !preview && !error ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Counting dependencies on the server…
          </p>
        ) : null}
        {result ? (
          <p
            className="text-sm text-[var(--color-success)]"
            data-testid="delete-result"
          >
            {result.replayed ? "Already completed earlier: " : ""}Deleted{" "}
            {result.deleted} question{result.deleted === 1 ? "" : "s"}
            {result.alreadyGone
              ? ` (${result.alreadyGone} were already gone)`
              : ""}
            . Operation {result.operationId}.
          </p>
        ) : preview ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="max-h-48 overflow-y-auto rounded-md border border-[var(--color-border)] p-2 text-xs">
              {preview.questions.map((q) => (
                <div
                  key={q.id}
                  className="border-b border-[var(--color-border)] py-1 last:border-0"
                >
                  <span className="font-mono">{q.code}</span> ·{" "}
                  {q.retired ? "RETIRED" : q.status}
                  {q.isVariant ? " · AI variant" : ""} · {q.subject ?? "—"}
                  {q.topic ? ` / ${q.topic}` : ""} · batch{" "}
                  {q.batchId ?? "manual"}
                  <div className="truncate text-[var(--color-muted-foreground)]">
                    {q.preview}
                  </div>
                </div>
              ))}
            </div>
            <ul
              className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs"
              data-testid="delete-counts"
            >
              <li>Questions (incl. AI variants): {preview.counts.questions}</li>
              {Object.entries(preview.counts)
                .filter(([k, v]) => k !== "questions" && v > 0)
                .map(([k, v]) => (
                  <li key={k}>
                    {LABELS[k] ?? k}: {v}
                  </li>
                ))}
              {preview.otherPapers ? (
                <li className="text-[var(--color-warning)]">
                  Other papers affected: {preview.otherPapers}
                </li>
              ) : null}
            </ul>
            {preview.counts.attemptQuestions ? (
              <p className="text-xs text-[var(--color-warning)]">
                Student attempts are kept, but these questions disappear from
                their review pages; stored scores are not recalculated.
              </p>
            ) : null}
            <label className="text-xs" htmlFor="delete-typed">
              Type <b>{phrase}</b> to confirm
            </label>
            <Input
              id="delete-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              data-testid="delete-typed"
            />
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {result ? null : (
            <Button
              variant="danger"
              disabled={pending || !preview || typed !== phrase}
              onClick={confirm}
              data-testid="delete-confirm"
            >
              {pending && preview
                ? "Deleting…"
                : error && preview
                  ? "Retry delete"
                  : "Delete permanently"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
