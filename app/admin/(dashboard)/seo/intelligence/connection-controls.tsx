"use client";

import { useActionState, useState } from "react";
import { PendingSubmitButton } from "@/components/ui/pending-submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { disconnectGoogleAction, startGoogleConnectAction, syncGoogleAction, type SeoIntelActionState } from "./actions";

/** MASTER_ADMIN controls only — the page renders this for SEO_INTEL_MANAGE, and every action re-checks it server-side. */
export function ConnectionControls({ credentialsConfigured, connected }: { credentialsConfigured: boolean; connected: boolean }) {
  const [syncState, syncAction] = useActionState<SeoIntelActionState>(syncGoogleAction, {});
  const [discState, discAction] = useActionState<SeoIntelActionState, FormData>(disconnectGoogleAction, {});
  const [confirming, setConfirming] = useState(false);
  const notice = discState.message ? discState : syncState;

  return (
    <div className="flex flex-col gap-3" data-testid="seo-intel-controls">
      <div className="flex flex-wrap items-center gap-2">
        <form action={startGoogleConnectAction}>
          <PendingSubmitButton size="sm" variant={connected ? "outline" : "primary"} disabled={!credentialsConfigured} pendingLabel="Opening Google…">
            {connected ? "Reconnect Google" : "Connect Google"}
          </PendingSubmitButton>
        </form>
        {connected ? (
          <form action={syncAction}>
            <PendingSubmitButton size="sm" variant="secondary" pendingLabel="Syncing…">
              Sync now
            </PendingSubmitButton>
          </form>
        ) : null}
        {connected && !confirming ? (
          <Button size="sm" variant="ghost" type="button" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        ) : null}
      </div>
      {connected && confirming ? (
        <form action={discAction} className="flex flex-wrap items-center gap-2">
          <Input name="confirm" placeholder="Type DISCONNECT" className="h-8 w-44" autoComplete="off" aria-label="Type DISCONNECT to confirm" />
          <PendingSubmitButton size="sm" variant="danger" pendingLabel="Disconnecting…">
            Disconnect Google
          </PendingSubmitButton>
          <Button size="sm" variant="ghost" type="button" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {!credentialsConfigured ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Install the SEO OAuth client on the server first: <code>sudo ops/seo/set-google-oauth.sh</code>
        </p>
      ) : null}
      {notice.message ? (
        <p role="status" className={`text-sm ${notice.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
          {notice.message}
        </p>
      ) : null}
    </div>
  );
}
