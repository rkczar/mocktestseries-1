"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { AUTO_COST_TIERS, ROUTING_MODES, ROUTING_MODE_LABELS, formatInr, type EngineFeatureDef, type FeatureEngineConfig } from "@/lib/ai-engine/config";
import { saveFeatureEngineAction } from "@/app/admin/(dashboard)/ai/engine-actions";

interface Preview {
  model: string | null;
  candidates: string[];
  note: string | null;
  typicalUsd: number | null;
  maxUsd: number | null;
}

const inputCls = "h-8 w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 text-xs";

/** One feature's AI Engine settings (Admin → AI → Features). */
export function FeatureEditor(props: {
  def: EngineFeatureDef;
  cfg: FeatureEngineConfig;
  preview: Preview;
  models: { id: string; medical: boolean }[];
  openRouterEnabled: boolean;
  canManage: boolean;
  fxRate: number | null;
  spentTodayInr: number;
  last30: { requests: number; costInr: number | null };
  promptVersion: string | null;
  globalCapInr: number;
}) {
  const { def, preview, canManage } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cfg, setCfg] = useState<FeatureEngineConfig>(props.cfg);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const set = (p: Partial<FeatureEngineConfig>) => setCfg((c) => ({ ...c, ...p }));
  const dirty = JSON.stringify(cfg) !== JSON.stringify(props.cfg);
  const usable = props.models.filter((m) => !def.medical || m.medical);
  const inr = (usd: number | null) => (usd === null || props.fxRate === null ? null : usd * props.fxRate);

  const save = () =>
    start(async () => {
      setMsg(null);
      const r = await saveFeatureEngineAction(def.key, cfg);
      if (!r.ok) return setMsg({ tone: "error", text: r.error });
      setMsg({ tone: "ok", text: "Saved. It applies to the next request on every server worker." });
      router.refresh();
    });

  return (
    <fieldset
      disabled={!canManage || pending}
      className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3"
      data-testid={`feature-${def.key}`}
      data-provider={props.cfg.provider}
      data-enabled={String(props.cfg.enabled)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{def.label}</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {[def.kind === "image" ? "Image generation" : "Text", def.medical ? "medical — medically approved models only" : null, def.callsPerAction > 1 ? `${def.callsPerAction} calls per action` : null, def.inUse ? null : "reserved (not used yet)"]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant={props.cfg.enabled ? "success" : "error"}>{props.cfg.enabled ? "On" : "Off"}</Badge>
          <Badge variant={props.cfg.provider === "openrouter" ? "primary" : "neutral"}>{props.cfg.provider === "openrouter" ? "OpenRouter" : "Legacy route"}</Badge>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          Status
          <SelectNative className="h-8 text-xs" value={cfg.enabled ? "on" : "off"} onChange={(e) => set({ enabled: e.target.value === "on" })} data-testid="f-enabled">
            <option value="on">Enabled</option>
            <option value="off">Disabled (no new AI requests)</option>
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Provider
          <SelectNative className="h-8 text-xs" value={cfg.provider} onChange={(e) => set({ provider: e.target.value === "openrouter" ? "openrouter" : "legacy" })} data-testid="f-provider">
            <option value="legacy">Legacy route (Gemini / OpenAI / Claude)</option>
            <option value="openrouter" disabled={!props.openRouterEnabled}>
              {`OpenRouter${props.openRouterEnabled ? "" : " (enable it first)"}`}
            </option>
          </SelectNative>
        </label>
      </div>

      {cfg.provider === "openrouter" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            Routing mode
            <SelectNative className="h-8 text-xs" value={cfg.mode} onChange={(e) => set({ mode: e.target.value as FeatureEngineConfig["mode"] })} data-testid="f-mode">
              {ROUTING_MODES.filter((m) => def.kind === "text" || m !== "auto").map((m) => (
                <option key={m} value={m}>
                  {`${ROUTING_MODE_LABELS[m]}${m === "cheapest" ? " (recommended)" : ""}`}
                </option>
              ))}
            </SelectNative>
          </label>
          {cfg.mode === "manual" ? (
            <label className="flex flex-col gap-1 text-xs">
              Model
              <SelectNative className="h-8 text-xs" value={cfg.model ?? ""} onChange={(e) => set({ model: e.target.value || null })} data-testid="f-model">
                <option value="">Choose an approved model</option>
                {usable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </SelectNative>
            </label>
          ) : cfg.mode === "auto" ? (
            <label className="flex flex-col gap-1 text-xs">
              Auto cost tier
              <SelectNative className="h-8 text-xs" value={cfg.autoCostTier} onChange={(e) => set({ autoCostTier: e.target.value as FeatureEngineConfig["autoCostTier"] })}>
                {AUTO_COST_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </SelectNative>
            </label>
          ) : (
            <div className="text-xs">
              <p className="text-[var(--color-muted-foreground)]">Cheapest suitable approved model now</p>
              <p className="break-all font-mono" data-testid="f-current-model">
                {preview.model ?? "—"}
              </p>
            </div>
          )}
          {def.kind === "text" && cfg.mode !== "auto" ? (
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              Fallback models (approved, in order; empty = next cheapest approved)
              <div className="grid gap-1 sm:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <SelectNative
                    key={i}
                    className="h-8 text-xs"
                    value={cfg.fallbacks[i] ?? ""}
                    onChange={(e) => {
                      const f = [...cfg.fallbacks];
                      f[i] = e.target.value;
                      set({ fallbacks: f.filter(Boolean) });
                    }}
                    data-testid={`f-fallback-${i}`}
                  >
                    <option value="">{i === 0 ? "Automatic" : "—"}</option>
                    {usable.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </SelectNative>
                ))}
              </div>
            </label>
          ) : null}
          {def.kind === "text" ? (
            <label className="flex flex-col gap-1 text-xs">
              Max output tokens per call
              <input className={inputCls} type="number" min={64} max={16000} placeholder={`default ${def.defaultMaxOutputTokens}`} value={cfg.maxOutputTokens ?? ""} onChange={(e) => set({ maxOutputTokens: e.target.value ? Number(e.target.value) : null })} />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-xs">
            Timeout (seconds)
            <input className={inputCls} type="number" min={5} max={180} value={Math.round(cfg.timeoutMs / 1000)} onChange={(e) => set({ timeoutMs: Number(e.target.value) * 1000 })} />
          </label>
          {def.kind === "text" ? (
          <label className="flex flex-col gap-1 text-xs">
            Retries after a transient error
            <SelectNative className="h-8 text-xs" value={String(cfg.maxRetries)} onChange={(e) => set({ maxRetries: Number(e.target.value) })}>
              {[0, 1, 2].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </SelectNative>
          </label>
          ) : null}
          <label className="flex flex-col gap-1 text-xs">
            Max cost per request (₹)
            <input className={inputCls} type="number" min={0.01} step={0.01} placeholder={`global ${props.globalCapInr}`} value={cfg.maxCostInr ?? ""} onChange={(e) => set({ maxCostInr: e.target.value ? Number(e.target.value) : null })} data-testid="f-max-cost" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Daily budget for this feature (₹)
            <input className={inputCls} type="number" min={0} step={1} placeholder="only the platform budget" value={cfg.dailyBudgetInr ?? ""} onChange={(e) => set({ dailyBudgetInr: e.target.value ? Number(e.target.value) : null })} />
          </label>
        </div>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {cfg.provider === "openrouter" ? (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Estimated cost</dt>
            <dd data-testid="f-estimate">{preview.typicalUsd === null ? (preview.note ?? "—") : `${formatInr(inr(preview.typicalUsd), 4)} typical · max ${formatInr(inr(preview.maxUsd), 4)} per ${def.trigger === "student" ? "request" : "action"}`}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Suitable approved models</dt>
            <dd>{preview.candidates.length ? `${preview.candidates.length}` : <span className="text-[var(--color-warning)]">{preview.note}</span>}</dd>
          </>
        ) : null}
        <dt className="text-[var(--color-muted-foreground)]">Spent today</dt>
        <dd>{formatInr(props.spentTodayInr)}</dd>
        <dt className="text-[var(--color-muted-foreground)]">Last 30 days</dt>
        <dd>{`${props.last30.requests} request(s) · ${props.last30.costInr === null ? "no reported cost" : formatInr(props.last30.costInr)}`}</dd>
        {props.promptVersion ? (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Prompt</dt>
            <dd>{`${props.promptVersion}${def.key.startsWith("explanation") || def.key.startsWith("variant") ? " · sections set in AI → Settings" : ""}`}</dd>
          </>
        ) : null}
      </dl>

      {msg ? (
        <p role={msg.tone === "error" ? "alert" : "status"} className={`rounded-md px-2 py-1 text-xs ${msg.tone === "error" ? "bg-[var(--color-error)]/10 text-[var(--color-error)]" : "bg-[var(--color-success)]/10"}`} data-testid="f-message">
          {msg.text}
        </p>
      ) : null}
      {canManage ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={!dirty || pending} onClick={save} data-testid="f-save">
            Save
          </Button>
          {dirty ? (
            <Button size="sm" variant="ghost" onClick={() => setCfg(props.cfg)}>
              Reset
            </Button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
