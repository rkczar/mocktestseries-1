"use client";

import { useTransition } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";

export function MoveButtons({
  onMove,
  disableUp,
  disableDown,
  label,
}: {
  onMove: (direction: "up" | "down") => Promise<void>;
  disableUp: boolean;
  disableDown: boolean;
  label: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={pending || disableUp}
        onClick={() => startTransition(() => onMove("up"))}
        aria-label={`Move ${label} up`}
        className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] disabled:opacity-30"
      >
        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        disabled={pending || disableDown}
        onClick={() => startTransition(() => onMove("down"))}
        aria-label={`Move ${label} down`}
        className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] disabled:opacity-30"
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
