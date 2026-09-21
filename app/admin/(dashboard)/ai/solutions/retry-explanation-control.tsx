"use client";

import { useState, useTransition } from "react";
import { RefreshCw, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryExplanationAction, regenerateExplanationAction, markReviewedAction } from "./actions";

export function RetryExplanationControl({ questionId }: { questionId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const result = await retryExplanationAction(questionId);
            setError(result.error ?? null);
          })
        }
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {isPending ? "Retrying…" : "Retry"}
      </Button>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}

/** Explicit admin regeneration for an already-COMPLETED explanation — never automatic (spec §11). */
export function RegenerateExplanationControl({ questionId }: { questionId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const result = await regenerateExplanationAction(questionId);
            setError(result.error ?? null);
          })
        }
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {isPending ? "Regenerating…" : "Regenerate"}
      </Button>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}

export function MarkReviewedControl({ questionId }: { questionId: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          await markReviewedAction(questionId);
        })
      }
    >
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {isPending ? "Marking…" : "Mark Reviewed"}
    </Button>
  );
}
