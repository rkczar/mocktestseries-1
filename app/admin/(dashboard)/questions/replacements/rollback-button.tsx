"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { rollbackReplacementAction } from "../replacement-actions";

/** Undo one Retire / Replace after a confirm() — restores questions, tests and attempts from its record. */
export function RollbackButton({ replacementId }: { replacementId: string }) {
  const router = useRouter();
  const [text, setText] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="compact"
        variant="outline"
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Roll back this change? Old questions, tests and the reset attempts are restored exactly as they were.")) return;
          startTransition(async () => {
            const r = await rollbackReplacementAction(replacementId);
            setText(r.ok ? r.message : [r.error, ...r.details].join(" "));
            router.refresh();
          });
        }}
      >
        {pending ? "Rolling back…" : "Roll back"}
      </Button>
      {text ? <p className="max-w-[260px] text-right text-xs text-[var(--color-muted-foreground)]">{text}</p> : null}
    </div>
  );
}
