"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import type { GeminiPublicConfig } from "@/lib/gemini-config";
import { refreshGeminiModelsAction, saveGeminiModelPoolAction, type RefreshModelsState, type SettingsFormState } from "./actions";
import { SubmitButton, SaveFeedback } from "./shared-controls";

const FALLBACK_SLOTS = [1, 2, 3, 4] as const;

function RefreshButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      <RefreshCw className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
      {pending ? "Refreshing…" : "Refresh Available Models"}
    </Button>
  );
}

/**
 * Gemini Model Pool — lives inside the existing AI Settings page (never a
 * separate page). MASTER_ADMIN can refresh the real compatible-model list
 * for the configured key (models.list, generateContent-only), enable/
 * disable individual models, and set the primary + up to 4 ordered fallback
 * models a new generation tries. FULL_ADMIN (canManage=false) sees
 * everything read-only, matching the Admin -> SEO view-only pattern.
 */
export function GeminiModelPoolCard({ gemini, canManage }: { gemini: GeminiPublicConfig; canManage: boolean }) {
  const [refreshState, refreshAction] = useActionState<RefreshModelsState, FormData>(refreshGeminiModelsAction, {});
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveGeminiModelPoolAction, {});

  const [enabled, setEnabled] = useState<Set<string>>(new Set(gemini.enabledModels));
  const [primary, setPrimary] = useState(gemini.primaryModel);
  const [fallbacks, setFallbacks] = useState<string[]>(() => {
    const slots = [...gemini.fallbackModels];
    while (slots.length < 4) slots.push("");
    return slots.slice(0, 4);
  });

  const enabledList = gemini.availableModels.filter((m) => enabled.has(m.id));

  const toggleModel = (id: string) => {
    if (!canManage) return;
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const healthFor = (id: string) => gemini.modelHealth[id];

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[var(--color-foreground)]">Gemini Model Pool</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {gemini.availableModelsFetchedAt
              ? `Last refreshed ${new Date(gemini.availableModelsFetchedAt).toLocaleString()}`
              : "Never refreshed — refresh to discover models this API key can use."}
          </p>
        </div>
        {canManage ? (
          <form action={refreshAction}>
            <RefreshButton />
          </form>
        ) : null}
      </div>
      {refreshState.error ? <p className="text-xs text-[var(--color-error)]">{refreshState.error}</p> : null}
      {refreshState.count !== undefined ? (
        <p className="text-xs text-[var(--color-success)]">Found {refreshState.count} compatible model(s).</p>
      ) : null}

      {gemini.availableModels.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No models discovered yet for this key. {canManage ? "Click Refresh Available Models above." : ""}
        </p>
      ) : (
        <form action={saveAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Available Gemini Models</Label>
            <div className="flex flex-col gap-1 rounded-[var(--radius-button)] border border-[var(--color-border)] p-2">
              {gemini.availableModels.map((m) => (
                <label key={m.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-muted)]/40">
                  <input
                    type="checkbox"
                    name="enabledModels"
                    value={m.id}
                    checked={enabled.has(m.id)}
                    onChange={() => toggleModel(m.id)}
                    disabled={!canManage}
                  />
                  <span className="font-medium text-[var(--color-foreground)]">{m.displayName}</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">{m.id}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="primaryModel">Primary Model</Label>
              <SelectNative
                id="primaryModel"
                name="primaryModel"
                value={primary}
                onChange={(e) => setPrimary(e.target.value)}
                disabled={!canManage}
              >
                <option value="">Select a model…</option>
                {enabledList.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </SelectNative>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Fallback Models (tried in order, only if the previous one fails)</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FALLBACK_SLOTS.map((n, i) => (
                <SelectNative
                  key={n}
                  name={`fallbackModel${n}`}
                  value={fallbacks[i] ?? ""}
                  onChange={(e) =>
                    setFallbacks((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                  disabled={!canManage}
                >
                  <option value="">{`Fallback ${n}: none`}</option>
                  {enabledList
                    .filter((m) => m.id !== primary)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                </SelectNative>
              ))}
            </div>
          </div>

          {canManage ? (
            <div className="flex items-center gap-3">
              <SubmitButton pendingLabel="Saving…">Save Model Pool</SubmitButton>
              <SaveFeedback state={saveState} />
            </div>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">View only — the model pool requires MASTER_ADMIN.</p>
          )}
        </form>
      )}

      {gemini.availableModels.length > 0 ? (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Model health</p>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[var(--color-muted-foreground)]">
                <th className="py-1 pr-3">Model</th>
                <th className="py-1 pr-3">Enabled</th>
                <th className="py-1 pr-3">Priority</th>
                <th className="py-1 pr-3">Last Success</th>
                <th className="py-1 pr-3">Last Failure</th>
              </tr>
            </thead>
            <tbody>
              {gemini.availableModels.map((m) => {
                const h = healthFor(m.id);
                const priority = m.id === gemini.primaryModel ? "Primary" : gemini.fallbackModels.includes(m.id) ? `Fallback ${gemini.fallbackModels.indexOf(m.id) + 1}` : "—";
                return (
                  <tr key={m.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-3 text-[var(--color-foreground)]">{m.displayName}</td>
                    <td className="py-1 pr-3">
                      {gemini.enabledModels.includes(m.id) ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
                      )}
                    </td>
                    <td className="py-1 pr-3 text-[var(--color-muted-foreground)]">{priority}</td>
                    <td className="py-1 pr-3 text-[var(--color-muted-foreground)]">
                      {h?.lastSuccessAt ? new Date(h.lastSuccessAt).toLocaleString() : "—"}
                    </td>
                    <td className="py-1 pr-3 text-[var(--color-muted-foreground)]">
                      {h?.lastFailureAt ? `${new Date(h.lastFailureAt).toLocaleString()} (${h.lastErrorCategory})` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
