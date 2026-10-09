"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
import { approveRecoveryRequestAction, rejectRecoveryRequestAction } from "../actions";

export function RecoveryReviewActions({ requestId, mobile }: { requestId: string; mobile: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    setError(null);
    startTransition(async () => {
      const action = mode === "approve" ? approveRecoveryRequestAction : rejectRecoveryRequestAction;
      const result = await action(requestId, notes);
      if (!result.ok) setError(result.error ?? "Could not update this request.");
      else {
        setMode(null);
        router.refresh();
      }
    });
  };

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) setMode(null);
        setError(null);
      }}
    >
      <div className="flex gap-2">
        <DialogTrigger asChild>
          <Button size="sm" onClick={() => setMode("approve")} disabled={pending}>
            Approve — Move Number
          </Button>
        </DialogTrigger>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" onClick={() => setMode("reject")} disabled={pending}>
            Reject
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "approve" ? `Move ${mobile} to the requesting account?` : "Reject this request?"}</DialogTitle>
          <DialogDescription>
            {mode === "approve"
              ? "Only the mobile number moves. Tests, scores, payments and purchases stay on both accounts."
              : "Nothing changes on either account. The student sees that the request was not approved."}
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="recovery-admin-notes" className="text-sm text-[var(--color-muted-foreground)]">
          Notes (kept in the record)
        </label>
        <textarea
          id="recovery-admin-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          rows={3}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm text-[var(--color-foreground)]"
        />
        {error ? (
          <p className="text-sm text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant={mode === "approve" ? "primary" : "danger"} onClick={run} disabled={pending}>
            {pending ? "Saving…" : mode === "approve" ? "Approve" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
