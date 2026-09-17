"use client";

import { useActionState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publishGrandTestAction, archiveGrandTestAction, type GrandTestFormState } from "./actions";

function PublishButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Publishing…" : "Publish"}
    </Button>
  );
}

export function PublishControl({ grandTestId }: { grandTestId: string }) {
  const [state, formAction] = useActionState<GrandTestFormState, FormData>(publishGrandTestAction.bind(null, grandTestId), {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Publishing resolves the blueprint into a fixed question set. Every student sees the same questions in the
        same order — this cannot be changed afterward except by archiving.
      </p>
      <div className="flex items-center gap-3">
        <PublishButton />
        {state.error ? (
          <p className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

export function ArchiveControl({ grandTestId }: { grandTestId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => startTransition(() => archiveGrandTestAction(grandTestId))}
    >
      {pending ? "Archiving…" : "Archive"}
    </Button>
  );
}
