"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteSubjectAction } from "./actions";

export function SubjectDeleteButton({ subjectId }: { subjectId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteSubjectAction(subjectId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete this subject.");
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="compact" variant="ghost" onClick={handleClick} disabled={isPending} aria-label="Delete subject">
        <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" aria-hidden />
      </Button>
      {error ? <p className="max-w-[200px] text-right text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
