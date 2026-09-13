"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { rescanStorageAction } from "./actions";
import { cn } from "@/lib/utils";

export function StorageScanButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => rescanStorageAction())}
      className="inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-60"
    >
      <RefreshCw className={cn("h-3.5 w-3.5", isPending && "animate-spin")} aria-hidden />
      {isPending ? "Scanning…" : "Scan Now"}
    </button>
  );
}
