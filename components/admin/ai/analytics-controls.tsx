"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { reconcileCostsAction } from "@/app/admin/(dashboard)/ai/engine-actions";

const field = "h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-xs";

/** Date / feature / model / provider / status filters (GET form — shareable URLs, no client state). */
export function AiFilters({
  range,
  models,
  features,
  base,
}: {
  range: { from: string; to: string; feature: string | null; model: string | null; provider: string | null; status: string | null };
  models: string[];
  features: { key: string; label: string }[];
  base: string;
}) {
  return (
    <form action={base} className="flex flex-wrap items-end gap-2 text-xs" data-testid="ai-filters">
      <label className="flex flex-col gap-1">
        From (IST)
        <input type="date" name="from" defaultValue={range.from} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        To (IST)
        <input type="date" name="to" defaultValue={range.to} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        Feature
        <select name="feature" defaultValue={range.feature ?? ""} className={field}>
          <option value="">All</option>
          {features.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Model
        <select name="model" defaultValue={range.model ?? ""} className={`${field} max-w-[14rem]`}>
          <option value="">All</option>
          {[...new Set([...(range.model ? [range.model] : []), ...models])].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Provider
        <select name="provider" defaultValue={range.provider ?? ""} className={field}>
          <option value="">All</option>
          <option value="openrouter">OpenRouter</option>
          <option value="gemini">Gemini (legacy)</option>
          <option value="anthropic">Claude (legacy)</option>
          <option value="openai">OpenAI (legacy)</option>
          <option value="default">Legacy default route</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Status
        <select name="status" defaultValue={range.status ?? ""} className={field}>
          <option value="">All</option>
          <option value="ok">Successful</option>
          <option value="failed">Failed</option>
        </select>
      </label>
      <button type="submit" className="h-8 rounded-md border border-[var(--color-border)] px-3">
        Apply
      </button>
    </form>
  );
}

/** Fill in costs OpenRouter had not reported at request time (GET /generation). */
export function ReconcileButton({ pending }: { pending: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || pending === 0}
        data-testid="reconcile"
        onClick={() =>
          start(async () => {
            const r = await reconcileCostsAction();
            setMsg(r.ok ? `Checked ${r.data.checked}, filled in ${r.data.resolved} cost(s).` : r.error);
            router.refresh();
          })
        }
      >
        {`Reconcile pending costs (${pending})`}
      </Button>
      {msg ? <span role="status">{msg}</span> : null}
    </div>
  );
}
