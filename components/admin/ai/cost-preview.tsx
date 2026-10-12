"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { cancelAiQuoteAction, cancelBulkQuotesAction, requestAiQuoteAction, requestBulkQuoteAction } from "@/app/admin/(dashboard)/ai/quote-actions";
import { formatInr } from "@/lib/ai-engine/config";
import type { BulkQuoteView, QuoteView } from "@/lib/ai-engine/quote";

/**
 * "AI Cost Preview" — shown before every admin-triggered paid AI action.
 * The quote is computed on the server; "Generate Now" hands its one-time id to
 * the action, which consumes it atomically (a double click cannot start a
 * second paid request). Usage:
 *
 *   const preview = useCostPreview();
 *   preview.ask({ feature: "ig_diagram", context: { postId } }, (quoteId) => runAction(quoteId));
 *   …
 *   {preview.dialog}
 */

export interface CostPreviewRequest {
  feature: string;
  context?: Record<string, string | number | null>;
  units?: number;
  legacyProvider?: boolean;
  evaluation?: boolean;
  /** Pre-selected model (evaluation: the model under test). */
  model?: string | null;
}

type Run = (quoteId: string) => void;

export function useCostPreview(): { ask: (req: CostPreviewRequest, run: Run) => void; dialog: ReactNode; busy: boolean } {
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const req = useRef<CostPreviewRequest | null>(null);
  const run = useRef<Run | null>(null);
  const launched = useRef(false);

  const load = useCallback(async (opts: { model?: string | null; pick?: "cheapest" | null } = {}) => {
    if (!req.current) return;
    setLoading(true);
    setError(null);
    const prev = quote;
    const r = await requestAiQuoteAction({ ...req.current, model: opts.model ?? (opts.pick ? null : (req.current.model ?? null)), pick: opts.pick ?? null });
    setLoading(false);
    if (!r.ok) return setError(r.error);
    if (prev && prev.id !== r.data.id) void cancelAiQuoteAction(prev.id);
    setQuote(r.data);
  }, [quote]);

  const ask = useCallback((r: CostPreviewRequest, fn: Run) => {
    req.current = r;
    run.current = fn;
    launched.current = false;
    setQuote(null);
    setError(null);
    setOpen(true);
    setLoading(true);
    requestAiQuoteAction({ ...r }).then((res) => {
      setLoading(false);
      if (!res.ok) setError(res.error);
      else setQuote(res.data);
    });
  }, []);

  const close = (cancel: boolean) => {
    if (cancel && quote && !launched.current) void cancelAiQuoteAction(quote.id);
    setOpen(false);
  };

  const generate = () => {
    if (!quote || !quote.runnable || launched.current) return;
    launched.current = true; // one click = one request
    setOpen(false);
    run.current?.(quote.id);
  };

  const q = quote;
  const dialog = (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close(true))}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" data-testid="cost-preview">
        <DialogHeader>
          <DialogTitle>AI Cost Preview</DialogTitle>
          <DialogDescription>{q ? q.featureLabel : "Estimating the cost of this AI request…"}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="rounded-md bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]" data-testid="cost-preview-error">
            {error}
          </p>
        ) : null}
        {!q && !error ? (
          <p className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Calculating…
          </p>
        ) : null}
        {q ? (
          <div className="flex flex-col gap-3 text-sm" data-testid="cost-preview-body" data-provider={q.provider} data-runnable={String(q.runnable)} data-quote-id={q.id}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <Row label="Selected task" value={q.featureLabel} />
              <Row label="Selected model" value={<span className="break-all font-mono text-xs" data-testid="cost-preview-model">{q.model}</span>} />
              <Row label="Routing" value={q.provider === "legacy" ? "Existing provider route" : q.routingMode === "auto" ? "OpenRouter Auto" : q.routingMode === "manual" ? "Manual" : "Cheapest Approved"} />
              {q.provider === "openrouter" && q.calls > 0 && q.estInputTokens > 0 ? (
                <>
                  <Row label="Estimated input tokens" value={q.estInputTokens.toLocaleString("en-IN")} />
                  <Row label="Estimated output tokens" value={`${q.estOutputTokens.toLocaleString("en-IN")} (max ${q.maxOutputTokens.toLocaleString("en-IN")})`} />
                </>
              ) : null}
              {q.provider === "openrouter" ? (
                <>
                  <Row label="Estimated text cost" value={q.textInr === null ? (q.imageInr !== null ? "—" : "Not available") : `${formatInr(q.textInr, 4)} (max ${formatInr(q.textMaxInr, 4)})`} />
                  <Row label="Estimated image cost" value={q.imageInr === null ? "—" : formatInr(q.imageInr, 4)} />
                  <Row label="Estimated total cost" value={<strong data-testid="cost-preview-total">{q.totalInr === null ? "Not available" : formatInr(q.totalInr, 4)}</strong>} />
                  <Row label="Maximum possible cost" value={<span data-testid="cost-preview-max">{formatInr(q.totalMaxInr, 4)}</span>} />
                  <Row label="Maximum permitted cost" value={`${formatInr(q.capInr)} per request`} />
                  <Row label="Budget left today" value={formatInr(q.budgetDayLeftInr)} />
                  <Row label="USD→INR rate" value={q.fxRate ? `${q.fxRate} · ${q.fxSource ?? ""}${q.fxAt ? ` · ${new Date(q.fxAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST` : ""}${q.fxStale ? " · STALE" : ""}` : "unavailable"} />
                </>
              ) : (
                <Row label="Estimated cost" value={<span data-testid="cost-preview-total">Not available (legacy provider)</span>} />
              )}
            </dl>
            {q.blockReason ? (
              <p role="alert" className="rounded-md bg-[var(--color-warning)]/10 px-3 py-2 text-[var(--color-foreground)]" data-testid="cost-preview-block">
                {q.blockReason}
              </p>
            ) : null}
            {q.provider === "openrouter" && q.alternatives.length > 0 ? (
              <label className="flex flex-col gap-1 text-xs">
                Change model (approved models, typical / maximum cost)
                <SelectNative
                  value={q.alternatives.find((a) => a.current)?.model ?? ""}
                  disabled={loading}
                  onChange={(e) => void load({ model: e.target.value })}
                  data-testid="cost-preview-change-model"
                >
                  {q.alternatives.find((a) => a.current) ? null : <option value="">{q.model}</option>}
                  {q.alternatives.map((a) => (
                    <option key={a.model} value={a.model}>
                      {`${a.model} — ${formatInr(a.typicalInr, 4)} / max ${formatInr(a.maxInr, 4)}`}
                    </option>
                  ))}
                </SelectNative>
              </label>
            ) : null}
            <ul className="list-disc pl-5 text-xs text-[var(--color-muted-foreground)]">
              {q.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={() => close(true)} data-testid="cost-preview-cancel">
            Cancel
          </Button>
          {q?.provider === "openrouter" ? (
            <Button type="button" variant="outline" disabled={loading} onClick={() => void load({ pick: "cheapest" })} data-testid="cost-preview-cheapest">
              Choose Cheapest
            </Button>
          ) : null}
          <Button type="button" disabled={!q || !q.runnable || loading} onClick={generate} data-testid="cost-preview-generate">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Generate Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog, busy: open };
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="min-w-0 text-[var(--color-foreground)]">{value}</dd>
    </>
  );
}

/**
 * Bulk AI Cost Preview (Instagram Bulk Studio): the combined estimate for every
 * selected post × AI step, approved once. `run` receives the per-post, per-step
 * one-time quote ids.
 */
export function useBulkCostPreview(): {
  ask: (req: { postIds: string[]; features: string[]; legacyProvider?: boolean }, run: (quotes: BulkQuoteView["quotes"]) => void) => void;
  dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<BulkQuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef<((q: BulkQuoteView["quotes"]) => void) | null>(null);
  const launched = useRef(false);
  const allIds = (v: BulkQuoteView | null) => (v ? Object.values(v.quotes).flatMap((m) => Object.values(m) as string[]) : []);

  const ask = useCallback((req: { postIds: string[]; features: string[]; legacyProvider?: boolean }, fn: (q: BulkQuoteView["quotes"]) => void) => {
    run.current = fn;
    launched.current = false;
    setView(null);
    setError(null);
    setOpen(true);
    requestBulkQuoteAction(req).then((r) => (r.ok ? setView(r.data) : setError(r.error)));
  }, []);
  const close = () => {
    if (!launched.current && view) void cancelBulkQuotesAction(allIds(view));
    setOpen(false);
  };
  const go = () => {
    if (!view || !view.runnable || launched.current) return;
    launched.current = true;
    setOpen(false);
    run.current?.(view.quotes);
  };
  const v = view;
  const dialog = (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl" data-testid="bulk-cost-preview">
        <DialogHeader>
          <DialogTitle>AI Cost Preview — bulk</DialogTitle>
          <DialogDescription>{v ? `${v.posts} post(s) × ${v.lines.length} AI step(s)` : "Estimating the cost of this run…"}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="rounded-md bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
            {error}
          </p>
        ) : null}
        {!v && !error ? (
          <p className="flex items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Calculating…
          </p>
        ) : null}
        {v ? (
          <div className="flex flex-col gap-3 text-sm" data-testid="bulk-cost-body" data-runnable={String(v.runnable)}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[var(--color-muted-foreground)]">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Step</th>
                    <th className="py-1 pr-2 font-medium">Model</th>
                    <th className="py-1 pr-2 font-medium">Per post</th>
                    <th className="py-1 font-medium">All posts (max)</th>
                  </tr>
                </thead>
                <tbody>
                  {v.lines.map((l) => (
                    <tr key={l.feature} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-2">{l.label}</td>
                      <td className="py-1 pr-2 break-all font-mono">{l.provider === "legacy" ? "legacy route" : l.model}</td>
                      <td className="py-1 pr-2">{l.perPostInr === null ? "not available" : formatInr(l.perPostInr, 4)}</td>
                      <td className="py-1">{l.totalInr === null ? "—" : `${formatInr(l.totalInr, 2)} (max ${formatInr(l.totalMaxInr, 2)})`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
              <dt className="text-[var(--color-muted-foreground)]">Estimated total</dt>
              <dd data-testid="bulk-cost-total">
                <strong>{v.totalInr === null ? "Not available" : formatInr(v.totalInr, 2)}</strong>
                {v.totalMaxInr !== null ? ` (maximum ${formatInr(v.totalMaxInr, 2)})` : ""}
              </dd>
              <dt className="text-[var(--color-muted-foreground)]">Budget left today</dt>
              <dd>{formatInr(v.budgetDayLeftInr)}</dd>
              <dt className="text-[var(--color-muted-foreground)]">USD→INR rate</dt>
              <dd>{v.fxRate ? `${v.fxRate} · ${v.fxSource ?? ""}` : "unavailable"}</dd>
            </dl>
            {v.blockReason ? (
              <p role="alert" className="rounded-md bg-[var(--color-warning)]/10 px-3 py-2" data-testid="bulk-cost-block">
                {v.blockReason}
              </p>
            ) : null}
            <ul className="list-disc pl-5 text-xs text-[var(--color-muted-foreground)]">
              {v.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={close} data-testid="bulk-cost-cancel">
            Cancel
          </Button>
          <Button type="button" disabled={!v || !v.runnable} onClick={go} data-testid="bulk-cost-generate">
            Generate Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}
