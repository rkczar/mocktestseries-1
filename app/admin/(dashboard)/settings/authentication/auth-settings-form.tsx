"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import type { AuthProviderPublicConfig } from "@/lib/auth-provider-config";
import type { RazorpayPublicConfig } from "@/lib/razorpay-config";
import {
  saveGoogleConfigAction,
  saveMsg91ConfigAction,
  saveLoginMethodTogglesAction,
  testGoogleConnectionAction,
  testMsg91ConnectionAction,
  saveRazorpayConfigAction,
  testRazorpayConnectionAction,
  type SettingsFormState,
  type TestConnectionState,
} from "./actions";

function SubmitButton({ children, pendingLabel }: { children: ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

function TestButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? "Testing…" : "Test Connection"}
    </Button>
  );
}

function StatusBadge({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  if (!configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warning)]/15 px-2.5 py-1 text-xs font-medium text-[var(--color-warning)]">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Not Configured
      </span>
    );
  }
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-muted-foreground)]/15 px-2.5 py-1 text-xs font-medium text-[var(--color-muted-foreground)]">
        Disabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-success)]/15 px-2.5 py-1 text-xs font-medium text-[var(--color-success)]">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Connected
    </span>
  );
}

function TestResult({ state }: { state: TestConnectionState }) {
  if (!state.result) return null;
  const { ok, message, at } = state.result;
  return (
    <p
      className={`flex items-center gap-1.5 text-xs ${ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      {message}
      <span className="text-[var(--color-muted-foreground)]">· {new Date(at).toLocaleString()}</span>
    </p>
  );
}

function SaveFeedback({ state }: { state: SettingsFormState }) {
  if (state.error) return <p className="text-xs text-[var(--color-error)]">{state.error}</p>;
  if (state.success) return <p className="text-xs text-[var(--color-success)]">Saved.</p>;
  return null;
}

export function GoogleOAuthCard({ google }: { google: AuthProviderPublicConfig["google"] }) {
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveGoogleConfigAction, {});
  const [testState, testAction] = useActionState<TestConnectionState, FormData>(testGoogleConnectionAction, {
    result: google.lastTest ?? undefined,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Google OAuth</CardTitle>
          <StatusBadge configured={google.configured} enabled={google.enabled} />
        </div>
        <CardDescription>Used for &ldquo;Continue with Google&rdquo; on the student login page.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Show the Google button on /login.</p>
            </div>
            <Switch name="enabled" defaultChecked={google.enabled} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="google-client-id">Client ID</Label>
            <Input id="google-client-id" name="clientId" defaultValue={google.clientId} placeholder="xxxxxxxx.apps.googleusercontent.com" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="google-client-secret">
              Client Secret {google.secretConfigured ? <span className="text-[var(--color-muted-foreground)]">(configured — leave blank to keep)</span> : null}
            </Label>
            <Input
              id="google-client-secret"
              name="clientSecret"
              type="password"
              autoComplete="off"
              placeholder={google.secretConfigured ? "••••••••••••••••" : "Paste client secret"}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 rounded-[var(--radius-button)] bg-[var(--color-surface)] p-3 text-xs sm:grid-cols-2">
            <div>
              <p className="font-medium text-[var(--color-foreground)]">Authorized redirect URI</p>
              <p className="break-all text-[var(--color-muted-foreground)]">{google.callbackUrl}</p>
            </div>
            <div>
              <p className="font-medium text-[var(--color-foreground)]">Authorized JavaScript origin</p>
              <p className="break-all text-[var(--color-muted-foreground)]">{google.authorizedOrigin}</p>
            </div>
          </div>

          <CardFooter className="flex-wrap items-center gap-3 p-0">
            <SubmitButton pendingLabel="Saving…">Save Configuration</SubmitButton>
            <SaveFeedback state={saveState} />
          </CardFooter>
        </form>

        <form action={testAction} className="mt-3 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center gap-3">
            <TestButton />
            <TestResult state={testState} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function Msg91Card({ msg91 }: { msg91: AuthProviderPublicConfig["msg91"] }) {
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveMsg91ConfigAction, {});
  const [testState, testAction] = useActionState<TestConnectionState, FormData>(testMsg91ConnectionAction, {
    result: msg91.lastTest ?? undefined,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>MSG91 (Mobile OTP)</CardTitle>
          <StatusBadge configured={msg91.configured} enabled={msg91.enabled} />
        </div>
        <CardDescription>
          Delivers the 6-digit verification code for Phone OTP login. Set a Widget ID to use the MSG91 OTP
          Widget (MSG91 generates and checks the code); otherwise Sender ID + Flow ID route through the Flow
          API with our own code generation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Route OTP SMS through MSG91.</p>
            </div>
            <Switch name="enabled" defaultChecked={msg91.enabled} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="msg91-auth-key">
              Auth Key {msg91.authKeyConfigured ? <span className="text-[var(--color-muted-foreground)]">(configured — leave blank to keep)</span> : null}
            </Label>
            <Input
              id="msg91-auth-key"
              name="authKey"
              type="password"
              autoComplete="off"
              placeholder={msg91.authKeyConfigured ? "••••••••••••••••" : "Paste MSG91 auth key"}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="msg91-widget-id">Widget ID (OTP Widget)</Label>
            <Input id="msg91-widget-id" name="widgetId" defaultValue={msg91.widgetId} placeholder="36xxxxxxxxxxxxxxxxxxxxxx" />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="msg91-sender-id">Sender ID (Flow API only)</Label>
              <Input id="msg91-sender-id" name="senderId" defaultValue={msg91.senderId} placeholder="MTSRIN" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="msg91-flow-id">Flow ID (Flow API only)</Label>
              <Input id="msg91-flow-id" name="flowId" defaultValue={msg91.flowId} placeholder="64xxxxxxxxxxxxxxxxxxxxxx" />
            </div>
          </div>

          <CardFooter className="flex-wrap items-center gap-3 p-0">
            <SubmitButton pendingLabel="Saving…">Save Configuration</SubmitButton>
            <SaveFeedback state={saveState} />
          </CardFooter>
        </form>

        <form action={testAction} className="mt-3 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center gap-3">
            <TestButton />
            <TestResult state={testState} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function RazorpayCard({ razorpay }: { razorpay: RazorpayPublicConfig }) {
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveRazorpayConfigAction, {});
  const [testState, testAction] = useActionState<TestConnectionState, FormData>(testRazorpayConnectionAction, {
    result: razorpay.lastTest ?? undefined,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Razorpay Payment Gateway</CardTitle>
          <StatusBadge configured={razorpay.configured} enabled={razorpay.enabled} />
        </div>
        <CardDescription>
          Prototype only — credentials are stored encrypted, but no checkout flow calls Razorpay yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Reserved for when checkout is wired up.</p>
            </div>
            <Switch name="enabled" defaultChecked={razorpay.enabled} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="razorpay-mode">Mode</Label>
            <SelectNative id="razorpay-mode" name="mode" defaultValue={razorpay.mode}>
              <option value="test">Test mode</option>
              <option value="live">Live mode</option>
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="razorpay-key-id">Key ID</Label>
            <Input id="razorpay-key-id" name="keyId" defaultValue={razorpay.keyId} placeholder="rzp_test_xxxxxxxxxxxxxx" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="razorpay-key-secret">
              Key Secret {razorpay.keySecretConfigured ? <span className="text-[var(--color-muted-foreground)]">(configured — leave blank to keep)</span> : null}
            </Label>
            <Input
              id="razorpay-key-secret"
              name="keySecret"
              type="password"
              autoComplete="off"
              placeholder={razorpay.keySecretConfigured ? "••••••••••••••••" : "Paste key secret"}
            />
          </div>

          <CardFooter className="flex-wrap items-center gap-3 p-0">
            <SubmitButton pendingLabel="Saving…">Save Configuration</SubmitButton>
            <SaveFeedback state={saveState} />
          </CardFooter>
        </form>

        <form action={testAction} className="mt-3 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center gap-3">
            <TestButton />
            <TestResult state={testState} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function LoginMethodsCard({ config }: { config: AuthProviderPublicConfig }) {
  const [state, formAction] = useActionState<SettingsFormState, FormData>(saveLoginMethodTogglesAction, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>Login Methods</CardTitle>
        <CardDescription>Controls which sign-in options appear on the public /login page.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-3">
          {[
            { name: "passwordEnabled", label: "User ID / Email + Password", defaultChecked: config.passwordEnabled },
            { name: "otpEnabled", label: "Mobile OTP", defaultChecked: config.otpEnabled },
            { name: "registerEnabled", label: "Create Account (new users)", defaultChecked: config.registerEnabled },
          ].map((row) => (
            <div key={row.name} className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
              <p className="text-sm font-medium text-[var(--color-foreground)]">{row.label}</p>
              <Switch name={row.name} defaultChecked={row.defaultChecked} />
            </div>
          ))}
          <CardFooter className="items-center gap-3 p-0 pt-1">
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            <SaveFeedback state={state} />
          </CardFooter>
        </form>
      </CardContent>
    </Card>
  );
}
