"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import type { OpenRouterPublicConfig } from "@/lib/ai-engine/settings";
import type { PrivacyConfig } from "@/lib/ai-engine/config";
import { removeOpenRouterKeyAction, saveOpenRouterKeyAction, savePrivacyAction, setOpenRouterEnabledAction, testOpenRouterAction } from "@/app/admin/(dashboard)/ai/engine-actions";

const ist = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST" : "—");
const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${v.toFixed(v < 1 ? 4 : 2)}`);

/**
 * Admin → AI → Providers: OpenRouter. The key is pasted once (or installed by
 * ops/ai/set-openrouter-key.sh), stored encrypted on the server and never sent
 * back — only its hint. Test Connection reads the key's limit/usage (free; no
 * generation). A new key starts disabled until a successful test.
 */
export function OpenRouterCard({ config, privacy, canManage }: { config: OpenRouterPublicConfig; privacy: PrivacyConfig; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [priv, setPriv] = useState<PrivacyConfig>(privacy);
  const c = config;

  const go = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, ok: string | ((d: unknown) => string)) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      setMsg({ tone: "ok", text: typeof ok === "function" ? ok(r.data) : ok });
      router.refresh();
    });

  const variant = c.status === "CONNECTED" ? "success" : c.status === "ERROR" ? "error" : c.status === "NOT_CONFIGURED" ? "warning" : "neutral";
  return (
    <Card data-testid="openrouter-card" data-status={c.status}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>OpenRouter (primary AI provider)</CardTitle>
          <CardDescription>One key for every approved model. Requests run on the server only; the key never reaches the browser.</CardDescription>
        </div>
        <Badge variant={variant} data-testid="openrouter-status">
          {c.status === "NOT_CONFIGURED" ? "Setup required" : c.status.replace("_", " ")}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {msg ? (
          <p role={msg.tone === "error" ? "alert" : "status"} data-testid="openrouter-message" className={`rounded-md px-3 py-2 ${msg.tone === "error" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-success)]/10"}`}>
            {msg.text}
          </p>
        ) : null}
        {c.status === "NOT_CONFIGURED" ? (
          <p className="rounded-md bg-[var(--color-warning)]/10 px-3 py-2" data-testid="openrouter-setup-required">
            No OpenRouter key is installed. Every AI feature keeps using its existing (legacy) provider until a key is installed, tested, enabled, and a feature is switched to OpenRouter in AI → Features.
            Recommended: set a monthly credit limit on the key in the OpenRouter dashboard as a provider-side backstop.
          </p>
        ) : null}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-[var(--color-muted-foreground)]">API key</dt>
          <dd data-testid="openrouter-key-hint">{c.keyHint ? `${c.keyHint} · saved ${ist(c.keySavedAt)} (${c.keySource === "script" ? "setup script" : "admin panel"})` : "Not installed"}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Enabled</dt>
          <dd>{c.enabled ? "Yes" : "No"}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Last test</dt>
          <dd data-testid="openrouter-last-test">{c.lastTest ? `${c.lastTest.ok ? "OK" : "Failed"} · ${c.lastTest.message} (${ist(c.lastTest.at)})` : "Never tested"}</dd>
          {c.keyStatus ? (
            <>
              <dt className="text-[var(--color-muted-foreground)]">Key limit</dt>
              <dd data-testid="openrouter-key-limit">
                {c.keyStatus.limitUsd === null ? "No limit set on this key (set one in the OpenRouter dashboard)" : `${usd(c.keyStatus.limitUsd)} · remaining ${usd(c.keyStatus.limitRemainingUsd)}${c.keyStatus.limitReset ? ` · resets ${c.keyStatus.limitReset}` : ""}`}
              </dd>
              <dt className="text-[var(--color-muted-foreground)]">Key usage</dt>
              <dd>{`today (UTC) ${usd(c.keyStatus.usageDailyUsd)} · month ${usd(c.keyStatus.usageMonthlyUsd)} · total ${usd(c.keyStatus.usageUsd)} · as of ${ist(c.keyStatus.at)}`}</dd>
            </>
          ) : null}
          <dt className="text-[var(--color-muted-foreground)]">Last success</dt>
          <dd>{ist(c.lastSuccessAt)}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Last error</dt>
          <dd data-testid="openrouter-last-error">{c.lastError ? `${c.lastError.category}: ${c.lastError.message} (${ist(c.lastError.at)})` : "—"}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Model catalog</dt>
          <dd>{c.lastSyncAt ? `${c.lastSyncSummary ?? ""} · synced ${ist(c.lastSyncAt)}` : "Not synced yet (AI → Models)"}</dd>
        </dl>

        {canManage ? (
          <>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium" htmlFor="or-key">
                {c.keyHint ? "Replace API key" : "Install API key"}
              </label>
              <div className="flex flex-wrap gap-2">
                <Input id="or-key" type="password" autoComplete="off" spellCheck={false} className="min-w-0 flex-1" placeholder="sk-or-…" value={key} onChange={(e) => setKey(e.target.value)} data-testid="openrouter-key-input" />
                <Button
                  disabled={pending || !key.trim()}
                  onClick={() => {
                    const k = key;
                    setKey("");
                    go(() => saveOpenRouterKeyAction(k), "Key saved (encrypted). Run Test Connection, then enable OpenRouter.");
                  }}
                  data-testid="openrouter-save-key"
                >
                  Save key
                </Button>
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Or install it on the server without the browser: <code>sudo /var/www/mocktestseries-current/ops/ai/set-openrouter-key.sh</code> (reads the key from a hidden prompt; never stored in .env).</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={pending || !c.apiKeyConfigured} onClick={() => go(testOpenRouterAction, (d) => (d as { test: { message: string } }).test.message)} data-testid="openrouter-test">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Test Connection
              </Button>
              {c.enabled ? (
                <Button variant="outline" disabled={pending} onClick={() => go(() => setOpenRouterEnabledAction(false), "OpenRouter disabled. Features set to OpenRouter now refuse new AI requests until it is enabled again.")} data-testid="openrouter-disable">
                  Disable
                </Button>
              ) : (
                <Button disabled={pending || !c.apiKeyConfigured || !c.lastTest?.ok} onClick={() => go(() => setOpenRouterEnabledAction(true), "OpenRouter enabled. Switch features to it in AI → Features.")} data-testid="openrouter-enable">
                  Enable OpenRouter
                </Button>
              )}
              {c.apiKeyConfigured ? (
                <Button variant="ghost" disabled={pending} onClick={() => confirm("Remove the OpenRouter key? Features set to OpenRouter will stop generating until a new key is installed.") && go(removeOpenRouterKeyAction, "Key removed.")}>
                  Remove key
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="privacy-settings">
          <p className="text-sm font-semibold">Privacy routing</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Sent with every OpenRouter request. “Deny” uses only providers that do not store or train on prompts; OpenRouter never falls back to a provider outside this policy (the request fails instead).
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              Data collection
              <SelectNative className="h-8 w-auto text-xs" disabled={!canManage} value={priv.dataCollection} onChange={(e) => setPriv({ ...priv, dataCollection: e.target.value === "allow" ? "allow" : "deny" })} data-testid="privacy-data-collection">
                <option value="deny">Deny (recommended)</option>
                <option value="allow">Allow</option>
              </SelectNative>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" disabled={!canManage} checked={priv.zdr} onChange={(e) => setPriv({ ...priv, zdr: e.target.checked })} data-testid="privacy-zdr" /> Zero Data Retention endpoints only
            </label>
            {canManage ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => go(() => savePrivacyAction(priv), "Privacy routing saved.")} data-testid="privacy-save">
                Save
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
