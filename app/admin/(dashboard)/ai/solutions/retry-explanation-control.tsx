"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryExplanationAction } from "./actions";

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
