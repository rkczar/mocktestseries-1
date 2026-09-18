"use client";

import { useState, useTransition } from "react";
import { RefreshCw, DownloadCloud } from "lucide-react";
import { refreshRepoStatusAction, fetchRemoteStatusAction } from "./actions";
import { cn } from "@/lib/utils";

export function RefreshRepoStatusButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => refreshRepoStatusAction())}
      className="inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-60"
    >
      <RefreshCw className={cn("h-3.5 w-3.5", isPending && "animate-spin")} aria-hidden />
      {isPending ? "Refreshing…" : "Refresh Repository Status"}
    </button>
  );
}

export function FetchRemoteStatusButton({ remoteConfigured }: { remoteConfigured: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (!remoteConfigured) return null;

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const result = await fetchRemoteStatusAction();
            setMessage(result.message);
          })
        }
        className="inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)] disabled:opacity-60"
      >
        <DownloadCloud className={cn("h-3.5 w-3.5", isPending && "animate-pulse")} aria-hidden />
        {isPending ? "Fetching…" : "Fetch Remote Status"}
      </button>
      {message ? <p className="text-xs text-[var(--color-muted-foreground)]">{message}</p> : null}
    </div>
  );
}
