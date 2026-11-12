"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { chooseExamAction } from "./actions";

export function ChooseExamButton({ examId, label }: { examId: string; label: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const r = await chooseExamAction(examId);
            if (r?.error) setError(r.error);
          })
        }
      >
        {isPending ? "Opening…" : label}
      </Button>
      {error ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
