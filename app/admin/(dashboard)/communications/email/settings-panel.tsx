"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EmailTemplateKey } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { checkProviderAction, saveEmailSettingsAction, sendTestEmailAction } from "./actions";

export interface SettingsView {
  provider: string;
  from: string;
  replyTo: string;
  senderAddress: string;
  providerConfigured: boolean;
  providerProblem: string | null;
  webhookConfigured: boolean;
  webhookUrl: string;
  sendingEnabled: boolean;
  ratePerSecond: number;
  testEmailSucceeded: boolean;
  settingsUpdatedAt: string | null;
  settingsUpdatedBy: string | null;
  workerLastRunAt: string | null;
  workerAlive: boolean;
  queued: number;
  sending: number;
  sent24: number;
  failed24: number;
  skipped24: number;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-[var(--color-border)] py-2.5 last:border-0 sm:flex-row sm:items-center sm:gap-4">
      <dt className="w-44 shrink-0 text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Absolute IST time (deterministic, so server and client render the same text). */
function at(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Kolkata" });
}

export function SettingsPanel({ view, templates, canManage }: { view: SettingsView; templates: { key: EmailTemplateKey; label: string }[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rate, setRate] = useState(String(view.ratePerSecond));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testTemplate, setTestTemplate] = useState<EmailTemplateKey>("WELCOME");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  function saveSettings(sendingEnabled: boolean) {
    setMessage(null);
    startTransition(async () => {
      const r = await saveEmailSettingsAction({ sendingEnabled, ratePerSecond: Number(rate) });
      setMessage(r.ok ? { ok: true, text: "Settings saved." } : { ok: false, text: r.error });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Email provider</CardTitle>
          <CardDescription>The API key lives only in the server environment (RESEND_API_KEY) and is never shown here.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl>
            <Row label="Provider">Resend</Row>
            <Row label="Sender">{view.from}</Row>
            <Row label="Reply-To">{view.replyTo}</Row>
            <Row label="Provider status">
              {view.providerConfigured ? (
                <Badge variant="success">CONFIGURED</Badge>
              ) : (
                <span className="flex flex-col items-start gap-1">
                  <Badge variant="error">NOT CONFIGURED</Badge>
                  <span className="text-xs text-[var(--color-muted-foreground)]">Email provider not configured. {view.providerProblem}</span>
                </span>
              )}
            </Row>
            <Row label="Delivery webhook">
              {view.webhookConfigured ? (
                <span>
                  <Badge variant="success">CONFIGURED</Badge> <span className="ml-1 font-mono text-xs">{view.webhookUrl}</span>
                </span>
              ) : (
                <span className="flex flex-col items-start gap-1">
                  <Badge variant="warning">DISABLED</Badge>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    Optional. Set RESEND_WEBHOOK_SECRET to receive delivered / bounced / complained status at {view.webhookUrl}. Until then
                    the endpoint rejects every event.
                  </span>
                </span>
              )}
            </Row>
            <Row label="Queue worker">
              {view.workerAlive ? <Badge variant="success">RUNNING</Badge> : <Badge variant="warning">NOT RUNNING</Badge>}
              <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">last run: {at(view.workerLastRunAt)}</span>
            </Row>
            <Row label="Queue">
              {view.queued} queued · {view.sending} sending · last 24 h: {view.sent24} sent, {view.failed24} failed, {view.skipped24} skipped
            </Row>
          </dl>
          {canManage ? (
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              disabled={pending || !view.providerConfigured}
              onClick={() =>
                startTransition(async () => {
                  const r = await checkProviderAction();
                  setMessage(r.ok ? { ok: r.check.ok, text: r.check.message } : { ok: false, text: r.error });
                })
              }
            >
              Check connection
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Send test email</CardTitle>
          <CardDescription>
            Sends one email right now through the full pipeline (template → queue → provider). Use it to verify the setup before turning on
            production sending.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!view.providerConfigured ? (
            <p className="text-sm text-[var(--color-warning)]">Email provider not configured: add RESEND_API_KEY to the production environment and reload the app.</p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-to">Email address</Label>
              <Input id="test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" disabled={!canManage || !view.providerConfigured} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-template">Template</Label>
              <SelectNative id="test-template" value={testTemplate} onChange={(e) => setTestTemplate(e.target.value as EmailTemplateKey)} disabled={!canManage || !view.providerConfigured}>
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </SelectNative>
            </div>
            <Button
              disabled={!canManage || !view.providerConfigured || pending || !testTo.trim()}
              onClick={() =>
                startTransition(async () => {
                  setTestResult(null);
                  const r = await sendTestEmailAction(testTo, testTemplate);
                  if (!r.ok) setTestResult({ ok: false, text: r.error });
                  else if (r.status === "SENT" || r.status === "DELIVERED") setTestResult({ ok: true, text: `Sent. Provider message ID: ${r.providerMessageId}. Check the inbox (and spam folder).` });
                  else if (r.status === "QUEUED") setTestResult({ ok: false, text: `Provider is busy; will retry. ${r.failureReason ?? ""}` });
                  else setTestResult({ ok: false, text: `Not sent (${r.status}): ${r.failureReason ?? "unknown reason"}` });
                  router.refresh();
                })
              }
            >
              {pending ? "Sending…" : "Send test email"}
            </Button>
          </div>
          {testResult ? (
            <p className={`text-sm ${testResult.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role="status">
              {testResult.text}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Production sending</CardTitle>
          <CardDescription>
            While off, automatic emails (welcome, first login, payment, password) are logged as skipped and campaigns can&apos;t be sent.
            Turning it on needs a configured provider and one successful test email.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-center gap-3 text-sm">
            <Switch
              checked={view.sendingEnabled}
              disabled={!canManage || pending || (!view.sendingEnabled && (!view.providerConfigured || !view.testEmailSucceeded))}
              onCheckedChange={(v) => {
                if (v && !window.confirm("Turn on production sending? Automatic emails and campaigns will be delivered to students.")) return;
                saveSettings(v);
              }}
            />
            {view.sendingEnabled ? <Badge variant="success">ON</Badge> : <Badge>OFF</Badge>}
            <span className="text-xs text-[var(--color-muted-foreground)]">
              {!view.providerConfigured
                ? view.sendingEnabled
                  ? "Switched on, but nothing is sent until the provider key is added."
                  : "Needs the provider key."
                : !view.testEmailSucceeded
                  ? "Send a successful test email first."
                  : view.settingsUpdatedBy
                    ? `Last changed by ${view.settingsUpdatedBy}, ${at(view.settingsUpdatedAt)}.`
                    : ""}
            </span>
          </label>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rate">Send rate (emails per second)</Label>
              <Input id="rate" type="number" min={1} max={10} value={rate} onChange={(e) => setRate(e.target.value)} className="w-32" disabled={!canManage} />
            </div>
            {canManage ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => saveSettings(view.sendingEnabled)}>
                Save rate
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">Resend&apos;s default limit is 2 requests per second. Raise it only if your Resend plan allows more.</p>
          {message ? (
            <p className={`text-sm ${message.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role="status">
              {message.text}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
