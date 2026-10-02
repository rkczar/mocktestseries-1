"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cancelCampaignAction, deleteDraftCampaignAction, retryFailedEmailAction } from "./actions";

export function CampaignRowActions({ id, status }: { id: string; status: "DRAFT" | "SENDING" | "COMPLETED" | "CANCELLED" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(confirmText: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    if (!window.confirm(confirmText)) return;
    setError(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) setError(r.error ?? "Failed.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {status === "DRAFT" ? (
        <Button asChild size="compact" variant="outline">
          <Link href={`/admin/communications?tab=email&etab=compose&campaign=${id}`}>Edit / send</Link>
        </Button>
      ) : null}
      <Button asChild size="compact" variant="ghost">
        <Link href={`/admin/communications?tab=email&etab=logs&campaign=${id}`}>Logs</Link>
      </Button>
      {status === "DRAFT" ? (
        <Button size="compact" variant="ghost" disabled={pending} onClick={() => run("Delete this draft?", () => deleteDraftCampaignAction(id))}>
          Delete
        </Button>
      ) : null}
      {status === "SENDING" ? (
        <Button size="compact" variant="danger" disabled={pending} onClick={() => run("Cancel this campaign? Emails not yet sent will not be sent.", () => cancelCampaignAction(id))}>
          Cancel
        </Button>
      ) : null}
      {error ? <span className="text-xs text-[var(--color-error)]">{error}</span> : null}
    </div>
  );
}

export function RetryEmailButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="compact"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await retryFailedEmailAction(id);
            if (!r.ok) setError(r.error);
            router.refresh();
          })
        }
      >
        Retry
      </Button>
      {error ? <span className="ml-1 text-xs text-[var(--color-error)]">{error}</span> : null}
    </>
  );
}
