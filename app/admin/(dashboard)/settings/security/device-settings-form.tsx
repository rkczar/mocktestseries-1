"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { StudentDeviceSettings } from "@/lib/student-device-settings";
import { saveStudentDeviceSettingsAction, type DeviceSettingsFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

const TOGGLES: { name: keyof StudentDeviceSettings; label: string; hint: string }[] = [
  { name: "enabled", label: "Enable Device Limit", hint: "Enforce the maximum number of registered devices at sign-in." },
  {
    name: "blockNewDevice",
    label: "Block New Device When Limit Reached",
    hint: "Off = the new device is allowed and recorded as over the limit (monitoring only).",
  },
  { name: "trackSessions", label: "Track Active Sessions", hint: "Record each sign-in so single sessions can be logged out." },
  { name: "allowAdminReset", label: "Allow Admin Device Reset", hint: "Show Reset Device Limit on student profiles." },
  {
    name: "studentSelfRemove",
    label: "Student Self Device Reset",
    hint: "Let students remove one of their own devices, at most once per cooldown period.",
  },
  {
    name: "oneActiveTestDevice",
    label: "One Active Test Session",
    hint: "A student's test can run on only one device at a time.",
  },
];

export function StudentDeviceSettingsForm({ settings, canEdit }: { settings: StudentDeviceSettings; canEdit: boolean }) {
  const [state, formAction] = useActionState<DeviceSettingsFormState, FormData>(saveStudentDeviceSettingsAction, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Student Device Security</CardTitle>
        <CardDescription>
          Limits how many devices one student account can be used on, to stop account sharing. Admin sessions are never
          affected. Changes apply to new sign-ins within 15 seconds.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-3">
          <fieldset disabled={!canEdit} className="flex flex-col gap-3">
            {TOGGLES.map((row) => (
              <div
                key={row.name}
                className="flex items-center justify-between gap-4 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5"
              >
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{row.label}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{row.hint}</p>
                </div>
                <Switch name={row.name} defaultChecked={settings[row.name] as boolean} aria-label={row.label} />
              </div>
            ))}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="maxDevices">Maximum Registered Devices</Label>
                <Input id="maxDevices" name="maxDevices" type="number" min={1} max={10} step={1} defaultValue={settings.maxDevices} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="selfRemoveCooldownDays">Self-Removal Cooldown (days)</Label>
                <Input
                  id="selfRemoveCooldownDays"
                  name="selfRemoveCooldownDays"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  defaultValue={settings.selfRemoveCooldownDays}
                  required
                />
              </div>
            </div>
          </fieldset>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Lowering the limit never signs anyone out: students already above it keep their registered devices but can&apos;t
            add another until they are under the limit.
          </p>
          {canEdit ? (
            <CardFooter className="items-center gap-3 p-0 pt-1">
              <SubmitButton />
              {state.error ? (
                <span className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
                  <AlertCircle className="h-4 w-4" aria-hidden /> {state.error}
                </span>
              ) : state.success ? (
                <span className="flex items-center gap-1.5 text-sm text-[var(--color-success)]">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Saved
                </span>
              ) : null}
            </CardFooter>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
