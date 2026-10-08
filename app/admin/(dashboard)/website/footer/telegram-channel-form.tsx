"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { TelegramChannelConfig } from "@/lib/telegram-channel";
import { TELEGRAM_URL_MAX } from "@/lib/telegram-url";
import { saveTelegramChannelAction, type TelegramChannelFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} data-testid="telegram-save">
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

function ToggleRow({ name, title, description, defaultChecked, disabled }: { name: string; title: string; description: string; defaultChecked: boolean; disabled: boolean }) {
  const id = `telegram-channel-${name}`;
  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-[var(--color-foreground)]">
          {title}
        </label>
        <p className="text-xs text-[var(--color-muted-foreground)]">{description}</p>
      </div>
      <Switch id={id} name={name} defaultChecked={defaultChecked} disabled={disabled} />
    </div>
  );
}

export function TelegramChannelForm({ config, canManage }: { config: TelegramChannelConfig; canManage: boolean }) {
  const [state, formAction] = useActionState<TelegramChannelFormState, FormData>(saveTelegramChannelAction, {});
  const [url, setUrl] = useState(config.url);
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.success) setUrl(state.savedUrl ?? "");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram Channel</CardTitle>
        <CardDescription>
          &quot;Join Our Telegram Channel&quot; card above the homepage footer and near the bottom of the Student Dashboard. Changes
          apply on the next page load — no deployment needed. Hidden while switched off or without a valid link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" data-testid="telegram-channel-form">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="telegram-channel-url" className="text-sm font-medium text-[var(--color-foreground)]">
              Telegram Channel URL
            </label>
            <Input
              id="telegram-channel-url"
              name="url"
              type="url"
              inputMode="url"
              autoComplete="off"
              maxLength={TELEGRAM_URL_MAX}
              placeholder="https://t.me/yourchannel"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={!canManage}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">Only https links on t.me or telegram.me are accepted.</p>
          </div>
          <ToggleRow name="showOnHomepage" title="Show on Homepage" description="Card directly above the public homepage footer." defaultChecked={config.showOnHomepage} disabled={!canManage} />
          <ToggleRow
            name="showOnDashboard"
            title="Show on Student Dashboard"
            description="Card near the bottom of the Student Dashboard."
            defaultChecked={config.showOnDashboard}
            disabled={!canManage}
          />
          {canManage ? (
            <CardFooter className="flex-wrap items-center gap-3 p-0">
              <SubmitButton />
              {state.error ? <p role="status" className="text-xs text-[var(--color-error)]">{state.error}</p> : null}
              {state.success ? <p role="status" className="text-xs text-[var(--color-success)]">Saved.</p> : null}
            </CardFooter>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">View only — MASTER_ADMIN can change this setting.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
