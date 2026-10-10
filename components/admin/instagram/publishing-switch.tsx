"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { setPublishingSwitchAction } from "@/app/admin/(dashboard)/instagram/actions";
import type { PublishingSwitch } from "@/lib/instagram/publish";

/**
 * Admin → Instagram → Settings → Direct publishing. A kill switch: when OFF no
 * post can be published, whatever the editor shows. Even when ON, every post
 * needs a Master Admin's explicit "Confirm & Publish" — nothing is scheduled
 * or published automatically.
 */
export function PublishingSwitchCard({ initial, tokenConfigured }: { initial: PublishingSwitch; tokenConfigured: boolean }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      setError(null);
      const r = await setPublishingSwitchAction(!state.enabled);
      if (r.ok) setState(r.data);
      else setError(r.error);
    });
  return (
    <Card data-testid="publishing-switch">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          Direct publishing
          <Badge variant={state.enabled ? "success" : "neutral"} data-testid="publishing-switch-state">
            {state.enabled ? "ON" : "OFF"}
          </Badge>
        </CardTitle>
        <CardDescription>
          When ON, a Master Admin can publish an approved (Ready) post straight to Instagram from the editor, after confirming it. Nothing is ever published automatically or on a schedule. Turn it OFF to stop all publishing at once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-5 pb-5">
        {!tokenConfigured ? <p className="text-sm text-[var(--color-warning)]">No access token / Instagram user ID is installed, so publishing can&apos;t work yet.</p> : null}
        {state.updatedAt ? <p className="text-xs text-[var(--color-muted-foreground)]">{`Last changed ${new Date(state.updatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST`}</p> : null}
        <div>
          <Button variant={state.enabled ? "outline" : "success"} onClick={toggle} disabled={pending} data-testid="publishing-switch-toggle">
            {state.enabled ? "Turn publishing OFF" : "Turn publishing ON"}
          </Button>
        </div>
        {error ? (
          <p className="text-sm text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
