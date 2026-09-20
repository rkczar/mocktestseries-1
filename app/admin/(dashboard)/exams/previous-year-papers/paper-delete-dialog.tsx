"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { getPaperDeleteImpact, deletePaperAction, type PaperDeleteImpact } from "./actions";

export function PaperDeleteDialog({ paperId, paperTitle }: { paperId: string; paperTitle: string }) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<PaperDeleteImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setError(null);
    if (nextOpen) {
      setLoading(true);
      getPaperDeleteImpact(paperId)
        .then(setImpact)
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load impact summary."))
        .finally(() => setLoading(false));
    } else {
      setImpact(null);
    }
  };

  const handleDelete = () => {
    setError(null);
    startTransition(async () => {
      try {
        await deletePaperAction(paperId);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete this paper.");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="ghost" aria-label={`Delete ${paperTitle}`}>
          <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &quot;{paperTitle}&quot;?</DialogTitle>
          <DialogDescription>This permanently removes the paper and cannot be undone.</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Loading impact summary…</p>
        ) : impact ? (
          impact.blocked ? (
            <Alert variant="destructive">
              <AlertDescription>
                This paper has {impact.questions} linked question(s) and {impact.testAttempts} recorded test attempt(s) — unlink the
                questions (Remove From Paper) first, or deactivate the paper instead.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <AlertDescription>No linked questions or test attempts — safe to delete.</AlertDescription>
            </Alert>
          )
        ) : null}
        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="danger" disabled={!impact || impact.blocked || isPending} onClick={handleDelete}>
            {isPending ? "Deleting…" : "Delete Paper"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
