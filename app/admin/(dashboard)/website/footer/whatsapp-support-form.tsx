"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { WhatsAppSupportConfig } from "@/lib/whatsapp-support";
import { saveWhatsAppSupportAction, type WhatsAppSupportFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

function ToggleRow({
  name,
  title,
  description,
  defaultChecked,
  disabled,
}: {
  name: string;
  title: string;
  description: string;
  defaultChecked: boolean;
  disabled: boolean;
}) {
  const id = `whatsapp-support-${name}`;
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

export function WhatsAppSupportForm({
  config,
  canManage,
  defaults,
}: {
  config: WhatsAppSupportConfig;
  canManage: boolean;
  defaults: { message: string; label: string; messageMax: number; labelMax: number };
}) {
  const [state, formAction] = useActionState<WhatsAppSupportFormState, FormData>(saveWhatsAppSupportAction, {});
  const [number, setNumber] = useState(config.number ? `+${config.number}` : "");

  // After a successful save, show the normalized value the server actually
  // stored (adjusting state during render when the action result changes).
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.success) setNumber(state.savedNumber ? `+${state.savedNumber}` : "");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp Support</CardTitle>
        <CardDescription>
          The floating WhatsApp button on the homepage and the Student Dashboard. Changes apply on the next page load —
          no deployment needed. The button stays hidden while disabled or without a valid number.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4" data-testid="whatsapp-support-form">
          <ToggleRow
            name="enabled"
            title="Enable WhatsApp Support"
            description="Master switch for the floating button."
            defaultChecked={config.enabled}
            disabled={!canManage}
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="whatsapp-support-number" className="text-sm font-medium text-[var(--color-foreground)]">
              WhatsApp Number
            </label>
            <Input
              id="whatsapp-support-number"
              name="number"
              inputMode="tel"
              autoComplete="off"
              placeholder="+<country code> <number>"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              disabled={!canManage}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              International format with country code. Spaces, +, - and brackets are removed automatically.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="whatsapp-support-message" className="text-sm font-medium text-[var(--color-foreground)]">
              Pre-filled Message
            </label>
            <Textarea
              id="whatsapp-support-message"
              name="message"
              rows={3}
              maxLength={defaults.messageMax}
              defaultValue={config.message}
              placeholder={defaults.message}
              disabled={!canManage}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="whatsapp-support-label" className="text-sm font-medium text-[var(--color-foreground)]">
              Tooltip / Label
            </label>
            <Input
              id="whatsapp-support-label"
              name="label"
              maxLength={defaults.labelMax}
              defaultValue={config.label}
              placeholder={defaults.label}
              disabled={!canManage}
            />
          </div>

          <ToggleRow
            name="showOnHomepage"
            title="Show on Homepage"
            description="Floating button on the public homepage."
            defaultChecked={config.showOnHomepage}
            disabled={!canManage}
          />
          <ToggleRow
            name="showInStudentArea"
            title="Show on Student Dashboard"
            description="Floating button on the Student Dashboard."
            defaultChecked={config.showInStudentArea}
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
