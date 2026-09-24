"use client";

import { useState, useTransition } from "react";
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
import { approveDeletionRequestAction, rejectDeletionRequestAction } from "../actions";

interface Props {
  requestId: string;
  name: string;
  code: string;
  /** Already masked server-side. */
  contact: string;
}

export function DeletionActions({ requestId, name, code, contact }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: typeof approveDeletionRequestAction, closeOnSuccess: boolean) => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action(requestId);
        if (!result.ok) setError(result.error ?? "Could not update this request.");
        else if (closeOnSuccess) setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not update this request.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            setError(null);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="danger" disabled={pending}>
              Approve
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve account deletion?</DialogTitle>
              <DialogDescription>This cannot be undone.</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-[var(--color-muted-foreground)]">Student</dt>
              <dd className="text-[var(--color-foreground)]">{name}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Student ID</dt>
              <dd className="font-mono text-[var(--color-foreground)]">{code}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Contact</dt>
              <dd className="font-mono text-[var(--color-foreground)]">{contact}</dd>
            </dl>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              This will anonymize the student&apos;s personal account data and revoke all active sessions. Attempt and
              payment records are kept anonymously. The student may create a new account later using the same
              email/phone.
            </p>
            {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="danger" disabled={pending} onClick={() => run(approveDeletionRequestAction, true)}>
                {pending ? "Approving…" : "Approve Deletion"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(rejectDeletionRequestAction, false)}>
          Reject
        </Button>
      </div>
      {error && !open ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
