"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { sendTestSecurityCodeAction, setSecurityCodeEmailsAction } from "./actions";

export interface SecurityCodesView {
  enabled: boolean;
  providerConfigured: boolean;
  lastTest: { at: string; ok: boolean; message: string } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

function at(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" });
}

/** Admin switch for Email OTP (security codes), independent of production sending. */
export function SecurityCodesCard({ view, canManage }: { view: SecurityCodesView; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, okText: string) => {
    setMessage(null);
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? { ok: true, text: r.message ?? okText } : { ok: false, text: r.error });
      router.refresh();
    });
  };

  return (
    <Card data-testid="security-codes-card">
      <CardHeader>
        <CardTitle>Security code emails (Email OTP)</CardTitle>
        <CardDescription>
          6-digit codes for email verification and account recovery. They are sent straight to Resend, never through the queue, and do
          not depend on Production sending. Turning this on needs one test code that you confirm has arrived.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={view.enabled}
            aria-label="Security code emails"
            disabled={!canManage || pending || (!view.enabled && (!view.providerConfigured || !view.lastTest?.ok))}
            onCheckedChange={(v) => run(() => setSecurityCodeEmailsAction(v), "Saved.")}
          />
          {view.enabled ? <Badge variant="success">ON</Badge> : <Badge>OFF</Badge>}
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {!view.providerConfigured
              ? "Needs the provider key."
              : !view.lastTest?.ok
                ? "Send a test code first."
                : view.updatedBy
                  ? `Last changed by ${view.updatedBy}, ${at(view.updatedAt)}.`
                  : ""}
          </span>
        </label>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Last test: {view.lastTest ? `${at(view.lastTest.at)} (${view.lastTest.ok ? "sent" : `failed: ${view.lastTest.message}`})` : "never"}
        </p>
        {canManage ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="otp-test-to">Send a test code to</Label>
              <Input id="otp-test-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
            </div>
            <Button size="sm" variant="outline" disabled={pending || !to} onClick={() => run(() => sendTestSecurityCodeAction(to), "Test code sent.")}>
              Send Test Code
            </Button>
          </div>
        ) : null}
        {message ? (
          <p className={`text-sm ${message.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role="status">
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
