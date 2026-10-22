"use client";

import { useActionState } from "react";
import { PendingSubmitButton } from "@/components/ui/pending-submit-button";
import { runPageSpeedAction, type SeoIntelActionState } from "./actions";

/** MASTER_ADMIN only (rendered for SEO_INTEL_MANAGE; the action re-checks it). */
export function PageSpeedControls({ keyInstalled }: { keyInstalled: boolean }) {
  const [state, action] = useActionState<SeoIntelActionState>(runPageSpeedAction, {});
  return (
    <div className="flex flex-col gap-2" data-testid="seo-intel-psi-controls">
      <form action={action}>
        <PendingSubmitButton size="sm" variant="secondary" disabled={!keyInstalled} pendingLabel="Checking (up to ~45 s)…">
          Run PageSpeed check
        </PendingSubmitButton>
      </form>
      {!keyInstalled ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Install the PageSpeed API key on the server first: <code>sudo ops/seo/set-pagespeed-key.sh</code>
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className={`text-sm ${state.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
