"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  lockLiveTestAction,
  cancelLiveTestAction,
  endLiveTestAction,
  publishLiveTestResultAction,
  reconcileLiveTestAction,
  type LiveTestFormState,
} from "./actions";

function LockButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Locking…" : "Lock & Schedule"}
    </Button>
  );
}

export function LockControl({ liveTestId }: { liveTestId: string }) {
  const [state, formAction] = useActionState<LiveTestFormState, FormData>(lockLiveTestAction.bind(null, liveTestId), {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Locking resolves the blueprint into a fixed question set and moves this test to Scheduled. Every student sees
        the same questions in the same order — this cannot be changed afterward except by cancelling.
      </p>
      <div className="flex items-center gap-3">
        <LockButton />
        {state.error ? (
          <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function CancelControl({ liveTestId }: { liveTestId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="danger"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm("Cancel this live test? In-progress attempts will be abandoned and cannot be resumed.")) return;
        startTransition(() => cancelLiveTestAction(liveTestId));
      }}
    >
      {pending ? "Cancelling…" : "Cancel Test"}
    </Button>
  );
}

export function EndNowControl({ liveTestId }: { liveTestId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm("End this live test now for everyone? No new answers can be saved after this.")) return;
        startTransition(() => endLiveTestAction(liveTestId));
      }}
    >
      {pending ? "Ending…" : "End Now"}
    </Button>
  );
}

export function PublishResultControl({ liveTestId }: { liveTestId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => publishLiveTestResultAction(liveTestId))}
    >
      {pending ? "Publishing…" : "Publish Result"}
    </Button>
  );
}

export function ReconcileControl({ liveTestId }: { liveTestId: string }) {
  const [pending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<number | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const { finalized } = await reconcileLiveTestAction(liveTestId);
            setLastResult(finalized);
          })
        }
      >
        <RefreshCw className="h-4 w-4" aria-hidden /> {pending ? "Reconciling…" : "Reconcile Now"}
      </Button>
      {lastResult !== null ? (
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {lastResult === 0 ? "Nothing to finalize." : `Finalized ${lastResult} attempt${lastResult === 1 ? "" : "s"}.`}
        </span>
      ) : null}
    </div>
  );
}
