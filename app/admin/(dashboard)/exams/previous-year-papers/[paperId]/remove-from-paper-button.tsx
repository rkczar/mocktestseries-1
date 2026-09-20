"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { unlinkQuestionFromPaperAction } from "../actions";

export function RemoveFromPaperButton({ paperId, questionId }: { paperId: string; questionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        await unlinkQuestionFromPaperAction(paperId, questionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not remove this question from the paper.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="compact" variant="ghost" onClick={handleClick} disabled={isPending}>
        {isPending ? "Removing…" : "Remove From Paper"}
      </Button>
      {error ? <p className="max-w-[200px] text-right text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
