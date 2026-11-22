"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PROVIDER_LABELS, RECOMMENDED_CHAINS, RECOMMENDED_PRIMARIES, chainText, parseChainText } from "@/lib/ai-import/chains";
import { MAX_IMPORTER_MODELS, SELECTION_TASK_LABELS, type ImporterSettings } from "@/lib/ai-import/config";

type Role = keyof ImporterSettings["fallbackChains"];
const ROLES: Role[] = ["extract", "key", "verify", "classify"];

/**
 * Import Settings: the provider fallback chain of each specialist role, the direct providers it may use with their own
 * keys, and the two-step workflow's automatic checks. Saved with the rest of the form (Save settings).
 */
export function FallbackChains({ s, setS, disabled }: { s: ImporterSettings; setS: (next: ImporterSettings) => void; disabled: boolean }) {
  const [text, setText] = useState<Record<Role, string>>(() => Object.fromEntries(ROLES.map((r) => [r, chainText(s.fallbackChains[r])])) as Record<Role, string>);
  const [problems, setProblems] = useState<Record<Role, string[]>>({ extract: [], key: [], verify: [], classify: [] });
  const edit = (role: Role, value: string) => {
    setText({ ...text, [role]: value });
    const p = parseChainText(value);
    setProblems({ ...problems, [role]: p.problems });
    if (!p.problems.length) setS({ ...s, fallbackChains: { ...s.fallbackChains, [role]: p.entries.slice(0, 4) } });
  };
  // Independence: page reading and verification must not start with the same model.
  const sharedPrimary = !!s.models.extract && !!s.models.verify && s.models.extract.split("/")[0] === s.models.verify.split("/")[0];
  return (
    <Card data-testid="fallback-chains">
      <CardHeader>
        <CardTitle>Fallback chains and automatic checks</CardTitle>
        <CardDescription>
          When the job&apos;s model fails (timeout, rate limit, provider error, key limit, moderation, unusable answer, unavailable) the same request goes to the next line — another vendor and, for a direct provider, another API key. Price never decides the order; every request is priced, counted in the budget and logged.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          {ROLES.map((role) => (
            <label key={role} className="flex flex-col gap-1 text-sm">
              {SELECTION_TASK_LABELS[role]}
              <textarea className="min-h-[84px] rounded border p-2 font-mono text-xs" value={text[role]} onChange={(e) => edit(role, e.target.value)} disabled={disabled} data-testid={`chain-${role}`} aria-describedby={`chain-${role}-help`} />
              <span id={`chain-${role}-help`} className="text-xs text-[var(--color-muted-foreground)]">One per line: provider: vendor/model (openrouter, anthropic, gemini, openai).</span>
              {problems[role].map((p) => (
                <span key={p} className="text-xs text-[var(--color-error)]" role="alert">
                  {p}
                </span>
              ))}
            </label>
          ))}
        </div>
        {sharedPrimary && <p className="text-xs text-[var(--color-warning)]" role="alert">Question reading and verification use the same vendor — not saved until verification uses another vendor.</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" className="h-auto whitespace-normal text-left" disabled={disabled} onClick={() => {
            // Strong primaries (manual selection, approved for the importer) + their chains; saved with "Save settings".
            // The importer list is never trimmed (an older job's model must stay approved): over the limit → say so.
            const list = [...new Set([...s.importerModels, ...Object.values(RECOMMENDED_PRIMARIES)])];
            if (list.length > MAX_IMPORTER_MODELS) {
              setProblems({ ...problems, extract: [`The importer model list would have ${list.length} models (limit ${MAX_IMPORTER_MODELS}). Remove ${list.length - MAX_IMPORTER_MODELS} unused model(s) from Importer models first.`] });
              return;
            }
            setText(Object.fromEntries(ROLES.map((r) => [r, chainText(RECOMMENDED_CHAINS[r])])) as Record<Role, string>);
            setProblems({ extract: [], key: [], verify: [], classify: [] });
            setS({
              ...s,
              selection: { mode: "manual" },
              importerModels: list,
              models: { ...s.models, ...RECOMMENDED_PRIMARIES },
              fallbackChains: Object.fromEntries(ROLES.map((r) => [r, RECOMMENDED_CHAINS[r].map((e) => ({ ...e }))])) as ImporterSettings["fallbackChains"],
            });
          }} data-testid="chains-recommended">
            Use recommended strong models (primaries + fallback chains)
          </Button>
          <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="primaries">
            Primaries now: {ROLES.map((r) => `${SELECTION_TASK_LABELS[r]}: ${s.models[r] ?? "automatic"}`).join(" · ")}
          </span>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={s.useOpenRouter} onChange={(e) => setS({ ...s, useOpenRouter: e.target.checked })} disabled={disabled} data-testid="use-openrouter" />
          <span>
            Send importer requests through OpenRouter
            <span className="block text-xs text-[var(--color-muted-foreground)]">Off: every request goes to the model&apos;s own provider (direct keys below) — e.g. while the OpenRouter key limit is used up.</span>
          </span>
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="font-medium">Direct providers (their own keys from AI → Providers; never while Zero-Data-Retention is required)</legend>
          {(["anthropic", "gemini", "openai"] as const).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input type="checkbox" checked={s.directProviders[p]} onChange={(e) => setS({ ...s, directProviders: { ...s.directProviders, [p]: e.target.checked } })} disabled={disabled} data-testid={`direct-${p}`} />
              {PROVIDER_LABELS[p]}
            </label>
          ))}
        </fieldset>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={s.workflow.autoVerify} onChange={(e) => setS({ ...s, workflow: { ...s.workflow, autoVerify: e.target.checked } })} disabled={disabled} data-testid="auto-verify" />
          <span>
            Run every check automatically after Import &amp; Process (Verify 1 → Verify 2 → Verify Answers)
            <span className="block text-xs text-[var(--color-muted-foreground)]">Each check keeps its own model and result. Checks never change official or admin-confirmed answers, and nothing is published without approval.</span>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Automatic checks: job limit (₹) — a check starts by itself only while this import&apos;s total AI cost stays within it; above it, it waits for your confirmation
          <input type="number" min={0} step="0.5" className="w-40 rounded border p-1" value={s.workflow.autoVerifyMaxInr ?? ""} placeholder="no limit" onChange={(e) => setS({ ...s, workflow: { ...s.workflow, autoVerifyMaxInr: e.target.value === "" ? null : Number(e.target.value) } })} disabled={disabled} data-testid="auto-verify-max" />
        </label>
      </CardContent>
    </Card>
  );
}
