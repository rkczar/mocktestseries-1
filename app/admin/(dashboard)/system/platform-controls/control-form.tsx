"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { setPlatformControlAction, type PlatformControlFormState } from "./actions";

function Submit({ label, variant, disabled }: { label: string; variant: "primary" | "outline" | "danger"; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending || disabled}>
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {label}
    </Button>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

/**
 * One switch for one control. The form always submits the OPPOSITE of the
 * configured state (Pause ↔ Resume, Turn on ↔ Turn off). `readOnly`
 * (FULL_ADMIN) disables everything; the Server Action refuses it anyway.
 */
export function ControlForm({
  control,
  kind,
  active,
  label,
  readOnly,
  reasonRequired,
  defaults,
}: {
  control: string;
  kind: "pausable" | "maintenance" | "lockdown";
  /** Configured state: pausable → OPEN, maintenance/lockdown → ON. */
  active: boolean;
  label: string;
  readOnly: boolean;
  reasonRequired: boolean;
  defaults: { message?: string; title?: string; eta?: string; messagePlaceholder?: string };
}) {
  const [state, formAction] = useActionState<PlatformControlFormState, FormData>(setPlatformControlAction, {});
  const id = (f: string) => `pc-${control}-${f}`;

  let value: string;
  let submitLabel: string;
  let variant: "primary" | "outline" | "danger";
  if (kind === "pausable") {
    value = active ? "PAUSED" : "OPEN";
    submitLabel = active ? `Pause ${label}` : `Resume ${label}`;
    variant = active ? "outline" : "primary";
  } else if (kind === "maintenance") {
    value = active ? "OFF" : "ON";
    submitLabel = active ? "Turn off Maintenance Mode" : "Turn on Maintenance Mode";
    variant = active ? "primary" : "outline";
  } else {
    value = active ? "OFF" : "ON";
    submitLabel = active ? "End Emergency Lockdown" : "Activate Emergency Lockdown";
    variant = active ? "primary" : "danger";
  }
  const showMessage = kind === "pausable" ? active : kind === "maintenance" && !active;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="control" value={control} />
      <input type="hidden" name="value" value={value} />
      <fieldset disabled={readOnly} className="contents">
        {kind === "maintenance" && !active ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={id("title")} label="Page title (optional)">
              <Input id={id("title")} name="title" maxLength={120} defaultValue={defaults.title} placeholder="We'll be back shortly" />
            </Field>
            <Field id={id("eta")} label="Expected back (optional)" hint="Free text, e.g. “around 4:30 PM IST”.">
              <Input id={id("eta")} name="eta" maxLength={120} defaultValue={defaults.eta} />
            </Field>
          </div>
        ) : null}
        {showMessage ? (
          <Field id={id("message")} label="Public message (optional)" hint="Shown to students. Empty = the default message.">
            <Input id={id("message")} name="message" maxLength={240} defaultValue={defaults.message} placeholder={defaults.messagePlaceholder} />
          </Field>
        ) : null}
        {kind === "lockdown" && !active ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id={id("duration")} label="Duration">
              <SelectNative id={id("duration")} name="duration" defaultValue="MANUAL">
                <option value="MANUAL">Until manually ended</option>
                <option value="30M">30 minutes</option>
                <option value="1H">1 hour</option>
                <option value="2H">2 hours</option>
              </SelectNative>
            </Field>
            <Field id={id("confirm")} label="Confirm" hint="Type LOCKDOWN to confirm.">
              <Input id={id("confirm")} name="confirm" autoComplete="off" required />
            </Field>
          </div>
        ) : null}
        <Field id={id("reason")} label={reasonRequired ? "Reason (required)" : "Reason (optional)"} hint="Kept in the audit log. Never paste keys or secrets.">
          <Input id={id("reason")} name="reason" maxLength={500} required={reasonRequired} autoComplete="off" />
        </Field>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Submit label={submitLabel} variant={variant} disabled={readOnly} />
        {state.error ? (
          <p className="text-xs text-[var(--color-error)]" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.success ? (
          <p className="text-xs text-[var(--color-success)]" aria-live="polite">
            {state.success}
          </p>
        ) : null}
      </div>
    </form>
  );
}
