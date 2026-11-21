"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { saveAdminOtpLoginAction, type DeviceSettingsFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function AdminOtpLoginForm({ enabled, mobileEnabled, canEdit }: { enabled: boolean; mobileEnabled: boolean; canEdit: boolean }) {
  const [state, formAction] = useActionState<DeviceSettingsFormState, FormData>(saveAdminOtpLoginAction, {});
  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin Login with OTP</CardTitle>
        <CardDescription>
          Optional sign-in with a 6-digit code sent to the admin&apos;s verified email or, by SMS, to the verified mobile. Each method is turned on separately and needs your own verified email / mobile first. Password login is never affected.
          Changes apply within 15 seconds. {canEdit ? null : "Only the Master Admin can change this setting."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-3">
          <fieldset disabled={!canEdit}>
            <div className="flex items-center justify-between gap-4 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">Enable Email OTP</p>
                <p className="text-xs text-[var(--color-muted-foreground)]">Code to a verified admin email. Off = no email codes.</p>
              </div>
              <Switch name="enabled" defaultChecked={enabled} aria-label="Enable Email OTP" data-testid="admin-otp-switch" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-4 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-[var(--color-foreground)]">Enable Mobile OTP</p>
                <p className="text-xs text-[var(--color-muted-foreground)]">SMS code (MSG91) to a verified admin mobile; WhatsApp re-send when enabled for the site. Off = no SMS codes.</p>
              </div>
              <Switch name="mobileEnabled" defaultChecked={mobileEnabled} aria-label="Enable Mobile OTP" data-testid="admin-otp-mobile-switch" />
            </div>
          </fieldset>
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
