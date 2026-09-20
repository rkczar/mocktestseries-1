"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getExamDeleteImpact, deleteExamAction, type ExamDeleteImpact } from "./actions";

export function DeleteExamDialog({ examId, examName }: { examId: string; examName: string }) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<ExamDeleteImpact | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setError(null);
    setConfirmText("");
    if (nextOpen) {
      setLoadingImpact(true);
      getExamDeleteImpact(examId)
        .then(setImpact)
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load impact summary."))
        .finally(() => setLoadingImpact(false));
    } else {
      setImpact(null);
    }
  };

  const handleDelete = () => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteExamAction(examId);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete this exam.");
      }
    });
  };

  const canDelete = impact && !impact.blocked && confirmText.trim() === examName.trim();

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="ghost" aria-label={`Delete ${examName}`}>
          <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &quot;{examName}&quot;?</DialogTitle>
          <DialogDescription>This permanently removes the Exam and cannot be undone.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {loadingImpact ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Loading impact summary…</p>
          ) : impact ? (
            <>
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                {[
                  ["Subjects", impact.subjects],
                  ["Topics", impact.topics],
                  ["Questions", impact.questions],
                  ["PYQ Papers", impact.papers],
                  ["Mock Tests", impact.mockTests],
                  ["Custom Modules", impact.customModules],
                  ["Grand Tests", impact.grandTests],
                  ["Live Tests", impact.liveTests],
                  ["Test Attempts", impact.testAttempts],
                  ["Enrollments", impact.enrollments],
                ].map(([label, count]) => (
                  <div key={label as string} className="rounded-md border border-[var(--color-border)] px-2 py-1.5">
                    <div className="text-base font-semibold text-[var(--color-foreground)]">{count as number}</div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">{label as string}</div>
                  </div>
                ))}
              </div>

              {impact.blocked ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    This exam has recorded student test attempts or enrollments — it cannot be deleted. Deactivate it instead (All Exams
                    &gt; Active toggle) to preserve history.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <Alert>
                    <AlertDescription>
                      Deleting will also remove all Subjects, Topics, Questions, PYQ Papers, Mock/Custom/Grand/Live Tests linked to this
                      exam. Type the exam name to confirm.
                    </AlertDescription>
                  </Alert>
                  <Input
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={examName}
                    aria-label="Type the exam name to confirm deletion"
                  />
                </>
              )}
            </>
          ) : null}
          {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="danger" disabled={!canDelete || isPending} onClick={handleDelete}>
            {isPending ? "Deleting…" : `Delete "${examName}"`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
