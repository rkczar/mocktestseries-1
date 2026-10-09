"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { testInstagramConnectionAction } from "@/app/admin/(dashboard)/instagram/actions";
import type { CheckState, ConnectionConfigView, ConnectionStatus, ConnectionTestResult } from "@/lib/instagram/meta";

type Variant = "success" | "warning" | "error" | "neutral" | "info";

const STATUS: Record<ConnectionStatus, { label: string; variant: Variant }> = {
  CONNECTED: { label: "Connected", variant: "success" },
  CONNECTED_NO_PUBLISH_PERMISSION: { label: "Connected — no publishing permission", variant: "warning" },
  NOT_CONFIGURED: { label: "Not configured", variant: "neutral" },
  TOKEN_EXPIRED: { label: "Token expired", variant: "error" },
  TOKEN_INVALID: { label: "Token invalid", variant: "error" },
  WRONG_ACCOUNT: { label: "Wrong Instagram account", variant: "error" },
  NOT_PROFESSIONAL: { label: "Not a professional account", variant: "error" },
  PERMISSION_MISSING: { label: "Permission missing", variant: "error" },
  RATE_LIMITED: { label: "Rate limited", variant: "warning" },
  TIMEOUT: { label: "Timed out", variant: "warning" },
  NETWORK_ERROR: { label: "Network error", variant: "warning" },
  API_ERROR: { label: "API error", variant: "error" },
};

const CHECK_ICON: Record<CheckState, string> = { pass: "✓", fail: "✗", warn: "!", skip: "–" };
const CHECK_COLOR: Record<CheckState, string> = {
  pass: "text-[var(--color-success)]",
  fail: "text-[var(--color-error)]",
  warn: "text-[var(--color-warning)]",
  skip: "text-[var(--color-muted-foreground)]",
};

const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";

function Field({ label, value, testId }: { label: string; value: React.ReactNode; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</span>
      <span className="text-sm text-[var(--color-foreground)] break-words" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function expiryText(c: ConnectionConfigView): { text: string; variant: Variant } {
  if (!c.tokenConfigured) return { text: "No token installed", variant: "neutral" };
  const e = c.expiry;
  if (e.state === "unknown" || !e.estimatedExpiresAt) return { text: "Unknown — install date not recorded", variant: "warning" };
  const when = new Date(e.estimatedExpiresAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
  if (e.state === "expired") return { text: `Likely expired (around ${when}) — install a new token`, variant: "error" };
  if (e.state === "soon") return { text: `Expires in about ${e.daysLeft} days (around ${when}) — renew soon`, variant: "warning" };
  return { text: `About ${e.daysLeft} days left (around ${when})`, variant: "success" };
}

/**
 * Admin → Instagram → Settings → Instagram connection. Read-only: the test
 * only reads the account identity and publishing permission. The token never
 * reaches the browser — this card only gets yes/no + a short fingerprint.
 */
export function ConnectionCard({ config: initialConfig, last: initialLast }: { config: ConnectionConfigView; last: ConnectionTestResult | null }) {
  const [config, setConfig] = useState(initialConfig);
  const [last, setLast] = useState(initialLast);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function test() {
    setError(null);
    start(async () => {
      const r = await testInstagramConnectionAction();
      if (r.ok) {
        setLast(r.data.result);
        setConfig(r.data.config);
      } else setError(r.error);
    });
  }

  const status = last ? STATUS[last.status] : null;
  const expiry = expiryText(config);
  const perm = last?.publishPermission;
  const stale = last && last.tokenFingerprint !== config.tokenFingerprint;

  return (
    <Card data-testid="ig-connection">
      <CardHeader className="pb-2">
        <CardTitle>Instagram connection</CardTitle>
        <CardDescription>
          Read-only check of the Instagram API token installed on the server. It reads the account identity and publishing permission only — it never posts,
          schedules or deletes anything. Publishing stays turned off.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-foreground)]">Connection status:</span>
          <span data-testid="ig-conn-status" data-status={last?.status ?? "NEVER_TESTED"}>
            {status ? <Badge variant={status.variant}>{status.label}</Badge> : <Badge variant="neutral">Not tested yet</Badge>}
          </span>
          {stale ? <span className="text-xs text-[var(--color-warning)]" data-testid="ig-conn-stale">The installed token changed since this test — test again.</span> : null}
        </div>
        {last ? (
          <p className="text-sm text-[var(--color-foreground)]" data-testid="ig-conn-summary">
            {last.summary}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Instagram username" testId="ig-conn-username" value={last?.account ? `@${last.account.username}` : "—"} />
          <Field label="Instagram User ID" testId="ig-conn-userid" value={last?.account?.userId ?? config.userIdConfigured ?? "—"} />
          <Field label="Account type" testId="ig-conn-type" value={last?.account?.accountType ?? "—"} />
          <Field
            label="Token configured"
            testId="ig-conn-token"
            value={config.tokenConfigured ? `Yes${config.tokenFingerprint ? ` (fingerprint ${config.tokenFingerprint})` : ""}` : "No"}
          />
          <Field label="Token expiration" testId="ig-conn-expiry" value={<Badge variant={expiry.variant}>{expiry.text}</Badge>} />
          <Field
            label="Publishing permission"
            testId="ig-conn-publish"
            value={
              perm === "GRANTED" ? (
                <Badge variant="success">Granted (publishing still OFF in the app)</Badge>
              ) : perm === "MISSING" ? (
                <Badge variant="warning">Missing — instagram_business_content_publish</Badge>
              ) : (
                <Badge variant="neutral">Not verified</Badge>
              )
            }
          />
          <Field label="Expected account" testId="ig-conn-expected" value={`@${config.expectedUsername}`} />
          <Field label="Last connection test" testId="ig-conn-last" value={last ? `${fmt(last.testedAt)} · ${last.durationMs} ms` : "Never"} />
          <Field label="API version" testId="ig-conn-version" value={config.apiVersion} />
        </div>

        {last?.checks.length ? (
          <ul className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm" data-testid="ig-conn-checks">
            {last.checks.map((c) => (
              <li key={c.key} className="flex gap-2" data-check={c.key} data-state={c.state}>
                <span className={`w-4 shrink-0 font-semibold ${CHECK_COLOR[c.state]}`}>{CHECK_ICON[c.state]}</span>
                <span className="font-medium text-[var(--color-foreground)]">{c.label}:</span>
                <span className="text-[var(--color-muted-foreground)] break-words">{c.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {config.warnings.length ? (
          <ul className="text-xs text-[var(--color-warning)]" data-testid="ig-conn-warnings">
            {config.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="ig-conn-error">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={test} disabled={pending} data-testid="ig-conn-test" data-busy={pending ? "1" : "0"}>
            {pending ? "Testing…" : "Test connection"}
          </Button>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            The token is set on the server only (never in this page). To install or replace it, run the install script on the server.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
