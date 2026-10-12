"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, PlugZap, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ClaudePublicConfig, ClaudeTestResult } from "@/lib/anthropic-config";
import type { GatewayConfig, ProviderUsage } from "@/lib/ai-gateway";
import { AI_FEATURES, GATEWAY_PROVIDERS, PROVIDER_LABELS, ROUTE_LIMITS, type AiFeature, type FeatureRoute, type GatewayProvider } from "@/lib/ai-gateway-config";
import { removeClaudeKeyAction, saveClaudeKeyAction, saveClaudeSettingsAction, saveGatewayAction, testClaudeConnectionAction } from "@/app/admin/(dashboard)/ai/providers/actions";

export interface ProviderSummary {
  key: "gemini" | "openai";
  name: string;
  configured: boolean;
  enabled: boolean;
  model: string;
  lastTest: { ok: boolean; message: string; at: string } | null;
  lastError: { category: string; message: string; at: string } | null;
  usage: ProviderUsage | null;
  role: string | null;
}

const fmt = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";
const usd = (n: number) => (n < 0.01 && n > 0 ? "< $0.01" : `$${n.toFixed(2)}`);

function StatusPill({ status }: { status: "NOT_CONFIGURED" | "DISABLED" | "CONNECTED" | "ERROR" | "UNTESTED" }) {
  const map = {
    NOT_CONFIGURED: { label: "NOT CONFIGURED", cls: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]", icon: AlertCircle },
    DISABLED: { label: "Disabled", cls: "bg-[var(--color-muted-foreground)]/15 text-[var(--color-muted-foreground)]", icon: null },
    CONNECTED: { label: "Connected", cls: "bg-[var(--color-success)]/15 text-[var(--color-success)]", icon: CheckCircle2 },
    ERROR: { label: "Error", cls: "bg-[var(--color-error)]/15 text-[var(--color-error)]", icon: XCircle },
    UNTESTED: { label: "Enabled · not tested", cls: "bg-[var(--color-info)]/15 text-[var(--color-info)]", icon: AlertCircle },
  }[status];
  const Icon = map.icon;
  return (
    <span data-testid="provider-status" data-status={status} className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", map.cls)}>
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {map.label}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
      <span className="text-xs text-[var(--color-muted-foreground)]">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function UsageRows({ usage }: { usage: ProviderUsage | null }) {
  if (!usage) return <Row label="Usage (30 days)">No calls through the AI Gateway yet</Row>;
  return (
    <>
      <Row label="Usage (30 days)">{`${usage.ok} ok · ${usage.failed} failed`}</Row>
      <Row label="Tokens (30 days)">{`${usage.inputTokens.toLocaleString("en-IN")} in · ${usage.outputTokens.toLocaleString("en-IN")} out`}</Row>
      <Row label="Estimated cost (30 days)">
        {usd(usage.estCostUsd)}
        {usage.unpricedCalls ? <span className="text-xs text-[var(--color-muted-foreground)]">{` (+${usage.unpricedCalls} calls without a price)`}</span> : null}
      </Row>
    </>
  );
}

function LegacyCard({ p }: { p: ProviderSummary }) {
  const status = !p.configured ? "NOT_CONFIGURED" : !p.enabled ? "DISABLED" : p.lastTest && !p.lastTest.ok ? "ERROR" : p.lastTest ? "CONNECTED" : "UNTESTED";
  return (
    <Card data-testid={`provider-card-${p.key}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{p.name}</CardTitle>
          <StatusPill status={status} />
        </div>
        <CardDescription>{p.role ?? "Not used by the default routing"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Row label="Enabled">{p.enabled ? "Yes" : "No"}</Row>
        <Row label="Model">{p.model || "—"}</Row>
        <Row label="Last test">{p.lastTest ? `${p.lastTest.ok ? "Passed" : "Failed"} · ${fmt(p.lastTest.at)}` : "Never"}</Row>
        <Row label="Last error">{p.lastError ? <span className="text-[var(--color-error)]">{`${p.lastError.category} · ${fmt(p.lastError.at)}`}</span> : "None recorded"}</Row>
        <UsageRows usage={p.usage} />
        <Link href="/admin/ai?tab=settings" className="mt-1 text-xs font-medium text-[var(--color-primary)] underline">
          Configure key and model in AI Settings
        </Link>
      </CardContent>
    </Card>
  );
}

function TestResultView({ r }: { r: ClaudeTestResult }) {
  const mark = (s: "pass" | "fail" | "skip") => (s === "pass" ? "✓" : s === "fail" ? "✗" : "–");
  return (
    <div
      role="status"
      data-testid="claude-test-result"
      data-ok={r.ok ? "true" : "false"}
      data-category={r.category}
      className={cn("rounded-md border p-3 text-sm", r.ok ? "border-[var(--color-success)]/40 bg-[var(--color-success)]/10" : "border-[var(--color-error)]/40 bg-[var(--color-error)]/10")}
    >
      <p className="font-medium">{r.message}</p>
      <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{`API key ${mark(r.checks.key)} · Model access ${mark(r.checks.model)} · Test request ${mark(r.checks.generation)} · ${r.model} · ${fmt(r.at)}`}</p>
    </div>
  );
}

function ClaudeCard({ initial, usage }: { initial: ClaudePublicConfig; usage: ProviderUsage | null }) {
  const router = useRouter();
  const [cfg, setCfg] = useState(initial);
  const [key, setKey] = useState("");
  const [showKeyForm, setShowKeyForm] = useState(!initial.apiKeyConfigured);
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState(initial.effort);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [test, setTest] = useState<ClaudeTestResult | null>(initial.lastTest);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const go = <T,>(label: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onOk: (d: T) => void) => {
    setMsg(null);
    setBusy(label);
    start(async () => {
      const r = await fn();
      setBusy(null);
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      onOk(r.data);
      router.refresh();
    });
  };

  const modelIds = cfg.models.map((m) => m.id);

  return (
    <Card data-testid="provider-card-anthropic" className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Anthropic Claude</CardTitle>
          <StatusPill status={cfg.status} />
        </div>
        <CardDescription>
          Paste your Anthropic API key here — no server access, file edits or restart needed. The key is encrypted on the server (AES-256-GCM) and is never shown again; only
          a masked hint is displayed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {msg ? (
          <p role={msg.tone === "error" ? "alert" : "status"} data-testid="claude-message" className={cn("rounded-md px-3 py-2 text-sm", msg.tone === "error" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-success)]/10 text-[var(--color-success)]")}>
            {msg.text}
          </p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Step 1: key */}
          <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="h-4 w-4" aria-hidden /> 1 · API key
            </h3>
            {cfg.apiKeyConfigured ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono" data-testid="claude-key-hint">{cfg.keyHint}</span>
                <span className="text-xs text-[var(--color-muted-foreground)]">{`saved ${fmt(cfg.keySavedAt)}`}</span>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">No key saved. Claude is not used anywhere until you save a key, test it and enable it.</p>
            )}
            {showKeyForm ? (
              <form
                className="flex flex-col gap-2"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  const k = key;
                  go("save-key", () => saveClaudeKeyAction({ apiKey: k }), (c) => {
                    setCfg(c);
                    setKey("");
                    setShowKeyForm(false);
                    setTest(null);
                    setMsg({ tone: "ok", text: "Key saved and encrypted. Now click Test Connection." });
                  });
                }}
              >
                <label htmlFor="claude-api-key" className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  Anthropic API key
                </label>
                <Input
                  id="claude-api-key"
                  name="claude-api-key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-ant-…"
                  data-testid="claude-key-input"
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={pending || !key.trim()} data-testid="claude-save-key">
                    {busy === "save-key" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                    {cfg.apiKeyConfigured ? "Save new key" : "Save"}
                  </Button>
                  {cfg.apiKeyConfigured ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => (setShowKeyForm(false), setKey(""))}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowKeyForm(true)} data-testid="claude-replace-key">
                  Replace API Key
                </Button>
                {confirmRemove ? (
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    Remove the key and disable Claude?
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      data-testid="claude-confirm-remove"
                      onClick={() =>
                        go("remove", () => removeClaudeKeyAction({ confirm: true }), (c) => {
                          setCfg(c);
                          setConfirmRemove(false);
                          setShowKeyForm(true);
                          setTest(null);
                          setMsg({ tone: "ok", text: "Key removed. Claude is disabled; features routed to Claude use their fallback provider." });
                        })
                      }
                    >
                      Remove
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmRemove(false)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} data-testid="claude-remove-key">
                    <Trash2 className="h-4 w-4" aria-hidden /> Remove API Key
                  </Button>
                )}
              </div>
            )}
          </section>

          {/* Step 2: test */}
          <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <PlugZap className="h-4 w-4" aria-hidden /> 2 · Test connection
            </h3>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Checks the key (model list — free), that the selected model is available to it, and sends one tiny test request (a few tokens) to detect billing or model-access
              problems.
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !cfg.apiKeyConfigured}
                data-testid="claude-test"
                onClick={() =>
                  go("test", () => testClaudeConnectionAction(), (d) => {
                    setTest(d.result);
                    setCfg(d.config);
                  })
                }
              >
                {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Test Connection
              </Button>
            </div>
            {test ? <TestResultView r={test} /> : null}
          </section>
        </div>

        {/* Step 3: model + enable */}
        <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
          <h3 className="text-sm font-semibold">3 · Model and enable</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--color-muted-foreground)]">
                {`Model (${cfg.modelsSource === "live" ? `${cfg.models.length} available to this key · updated ${fmt(cfg.availableModelsFetchedAt)}` : "suggested list — Test Connection loads the live list"})`}
              </span>
              <SelectNative value={model} onChange={(e) => setModel(e.target.value)} data-testid="claude-model">
                {!modelIds.includes(model) ? <option value={model}>{`${model} (not in the current list)`}</option> : null}
                {cfg.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName === m.id ? m.id : `${m.displayName} — ${m.id}`}
                  </option>
                ))}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Effort (how much the model thinks — higher is slower and costs more)</span>
              <SelectNative value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)} data-testid="claude-effort">
                <option value="low">Low (recommended for structured content)</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </SelectNative>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={cfg.enabled}
                disabled={pending || !cfg.apiKeyConfigured}
                data-testid="claude-enabled"
                onCheckedChange={(v) =>
                  go("enable", () => saveClaudeSettingsAction({ enabled: v }), (c) => {
                    setCfg(c);
                    setMsg({ tone: "ok", text: v ? "Claude enabled. Select it for features under Feature routing below." : "Claude disabled. The key stays stored; no request goes to Claude." });
                  })
                }
              />
              Enable Claude
            </label>
            <Button
              size="sm"
              disabled={pending}
              data-testid="claude-save-settings"
              onClick={() => go("settings", () => saveClaudeSettingsAction({ model, effort }), (c) => (setCfg(c), setMsg({ tone: "ok", text: "Configuration saved." })))}
            >
              {busy === "settings" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save Configuration
            </Button>
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            On Claude Opus 5.5, Opus 5, Sonnet 5.5 and Fable 5.1 the request also enables Anthropic&apos;s server-side refusal fallback, so a rare safety decline is retried on
            another Claude model inside the same call.
          </p>
        </section>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Row label="Last successful call">{fmt(cfg.lastSuccessAt)}</Row>
            <Row label="Last error">
              {cfg.lastError ? (
                <span className="text-[var(--color-error)]" data-testid="claude-last-error">{`${cfg.lastError.category} · ${fmt(cfg.lastError.at)} — ${cfg.lastError.message}`}</span>
              ) : (
                "None recorded"
              )}
            </Row>
          </div>
          <div className="flex flex-col gap-2">
            <UsageRows usage={usage} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RouteEditor({
  feature,
  route,
  onChange,
  todayCount,
  defaultLabel,
}: {
  feature: { key: AiFeature; label: string; group: string };
  route: FeatureRoute;
  onChange: (r: FeatureRoute) => void;
  todayCount: number;
  defaultLabel: string;
}) {
  const set = (p: Partial<FeatureRoute>) => onChange({ ...route, ...p });
  const chain = [route.primary, route.fallback1, route.fallback2].filter((p) => p !== "none") as GatewayProvider[];
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid={`route-${feature.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{feature.label}</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">{`${feature.group} · ${todayCount} successful call${todayCount === 1 ? "" : "s"} today${route.dailyCap ? ` of ${route.dailyCap}` : ""}`}</p>
        </div>
        <SelectNative className="w-auto" value={route.mode} onChange={(e) => set({ mode: e.target.value as FeatureRoute["mode"] })} data-testid={`route-mode-${feature.key}`}>
          <option value="inherit">{`Default routing (${defaultLabel})`}</option>
          <option value="custom">Custom route</option>
        </SelectNative>
      </div>
      {route.mode === "custom" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {(["primary", "fallback1", "fallback2"] as const).map((slot) => (
            <label key={slot} className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-muted-foreground)]">{slot === "primary" ? "Primary provider" : slot === "fallback1" ? "First fallback" : "Second fallback"}</span>
              <SelectNative value={route[slot]} onChange={(e) => set({ [slot]: e.target.value } as Partial<FeatureRoute>)} data-testid={`route-${slot}-${feature.key}`}>
                {slot !== "primary" ? <option value="none">None</option> : null}
                {GATEWAY_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </SelectNative>
            </label>
          ))}
          {chain.map((p) => (
            <label key={p} className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-muted-foreground)]">{`${PROVIDER_LABELS[p]} model (blank = provider default)`}</span>
              <Input value={route.models[p] ?? ""} onChange={(e) => set({ models: { ...route.models, [p]: e.target.value } })} placeholder="provider default" />
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-muted-foreground)]">Timeout (seconds)</span>
            <Input
              type="number"
              min={ROUTE_LIMITS.timeoutMin / 1000}
              max={ROUTE_LIMITS.timeoutMax / 1000}
              value={Math.round(route.timeoutMs / 1000)}
              onChange={(e) => set({ timeoutMs: Number(e.target.value) * 1000 })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-muted-foreground)]">Retries on temporary errors</span>
            <Input type="number" min={0} max={ROUTE_LIMITS.retriesMax} value={route.maxRetries} onChange={(e) => set({ maxRetries: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--color-muted-foreground)]">Daily cap (blank = none)</span>
            <Input type="number" min={1} value={route.dailyCap ?? ""} onChange={(e) => set({ dailyCap: e.target.value === "" ? null : Number(e.target.value) })} data-testid={`route-cap-${feature.key}`} />
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function ProvidersView(props: {
  legacy: ProviderSummary[];
  claude: ClaudePublicConfig;
  claudeUsage: ProviderUsage | null;
  gateway: GatewayConfig;
  defaultRouting: { active: string; fallback: string };
  todayByFeature: Record<string, number>;
  usage30: { byFeature: { feature: string; calls: number; ok: number; estCostUsd: number }[]; recentErrors: { at: string; feature: string; provider: string; category: string | null; summary: string | null }[] };
}) {
  const router = useRouter();
  const [routes, setRoutes] = useState(props.gateway.routes);
  const [prices, setPrices] = useState(props.gateway.prices);
  const [newPriceModel, setNewPriceModel] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const defaultLabel = `${props.defaultRouting.active}${props.defaultRouting.fallback !== "none" ? ` → ${props.defaultRouting.fallback}` : ""}`;
  const dirty = JSON.stringify(routes) !== JSON.stringify(props.gateway.routes) || JSON.stringify(prices) !== JSON.stringify(props.gateway.prices);

  return (
    <div className="flex flex-col gap-6" data-testid="ai-providers">
      <div>
        <h2 className="text-lg font-semibold">AI Providers</h2>
        <p className="text-sm text-[var(--color-muted-foreground)]">Connect providers and choose which one each AI feature uses. Changes apply immediately — no restart.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {props.legacy.map((p) => (
          <LegacyCard key={p.key} p={p} />
        ))}
        <ClaudeCard initial={props.claude} usage={props.claudeUsage} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Feature routing</CardTitle>
          <CardDescription>
            {`"Default routing" keeps today's behaviour (AI Settings: ${defaultLabel}). A custom route tries the primary provider, then the fallbacks, skipping any provider that is not configured or enabled.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {msg ? (
            <p role={msg.tone === "error" ? "alert" : "status"} data-testid="routes-message" className={cn("rounded-md px-3 py-2 text-sm", msg.tone === "error" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-success)]/10 text-[var(--color-success)]")}>
              {msg.text}
            </p>
          ) : null}
          <div className="grid gap-3 lg:grid-cols-2">
            {AI_FEATURES.filter((f) => f.key !== "ig_image").map((f) => (
              <RouteEditor
                key={f.key}
                feature={f}
                route={routes[f.key]}
                todayCount={props.todayByFeature[f.key] ?? 0}
                defaultLabel={defaultLabel}
                onChange={(r) => setRoutes((x) => ({ ...x, [f.key]: r }))}
              />
            ))}
          </div>

          <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <summary className="cursor-pointer text-sm font-semibold">Model prices for cost estimates (USD per 1M tokens)</summary>
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Estimates only — your provider invoice is the source of truth. Calls to a model without a price show tokens but no cost.</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {Object.entries(prices).map(([m, p]) => (
                <div key={m} className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2 text-sm">
                  <span className="truncate font-mono text-xs">{m}</span>
                  <Input type="number" step="0.01" min={0} value={p.input} onChange={(e) => setPrices((x) => ({ ...x, [m]: { ...p, input: Number(e.target.value) } }))} aria-label={`${m} input price`} />
                  <Input type="number" step="0.01" min={0} value={p.output} onChange={(e) => setPrices((x) => ({ ...x, [m]: { ...p, output: Number(e.target.value) } }))} aria-label={`${m} output price`} />
                </div>
              ))}
              <div className="flex gap-2">
                <Input value={newPriceModel} onChange={(e) => setNewPriceModel(e.target.value.trim())} placeholder="model id, e.g. gemini-2.5-flash" />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!newPriceModel || newPriceModel in prices}
                  onClick={() => (setPrices((x) => ({ ...x, [newPriceModel]: { input: 0, output: 0 } })), setNewPriceModel(""))}
                >
                  Add
                </Button>
              </div>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || !dirty}
              data-testid="routes-save"
              onClick={() => {
                setMsg(null);
                start(async () => {
                  const r = await saveGatewayAction({ routes, prices });
                  if (!r.ok) return setMsg({ tone: "error", text: r.error });
                  setRoutes(r.data.routes);
                  setPrices(r.data.prices);
                  setMsg({ tone: "ok", text: "Routing saved. It applies to the next AI request." });
                  router.refresh();
                });
              }}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Save routing
            </Button>
            {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage by feature (30 days)</CardTitle>
          <CardDescription>Every provider call made through the AI Gateway. Cached explanations and stored variants make no call and are not counted.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {props.usage30.byFeature.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No calls yet.</p> : null}
          <ul className="flex flex-col gap-1 text-sm">
            {props.usage30.byFeature.map((f) => (
              <li key={f.feature} className="flex flex-wrap justify-between gap-2">
                <span>{AI_FEATURES.find((x) => x.key === f.feature)?.label ?? f.feature}</span>
                <span className="tabular-nums text-[var(--color-muted-foreground)]">{`${f.ok}/${f.calls} ok · ${usd(f.estCostUsd)}`}</span>
              </li>
            ))}
          </ul>
          {props.usage30.recentErrors.length ? (
            <div>
              <h3 className="mb-1 text-sm font-semibold">Recent errors</h3>
              <ul className="flex flex-col gap-1 text-xs" data-testid="recent-errors">
                {props.usage30.recentErrors.map((e, i) => (
                  <li key={i} className="flex flex-wrap gap-2">
                    <span className="text-[var(--color-muted-foreground)]">{fmt(e.at)}</span>
                    <span>{`${e.provider} · ${AI_FEATURES.find((x) => x.key === e.feature)?.label ?? e.feature}`}</span>
                    <span className="text-[var(--color-error)]">{e.category}</span>
                    <span className="min-w-0 break-words text-[var(--color-muted-foreground)]">{e.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
