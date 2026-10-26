"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { formatInr } from "@/lib/ai-engine/config";
import type { ImporterSettings } from "@/lib/ai-import/config";
import type { AutoConfigApplied, AutoConfigPreview, AutoTaskRow } from "@/lib/ai-import/autoconfig-types";
import { autoConfigApplyAction, autoConfigPreviewAction } from "../actions";

const ROUTE_TONE = { verified: "success", stale: "warning", not_read: "neutral", unavailable: "error", no_zdr: "error", not_needed: "neutral" } as const;
const ROUTE_LABEL = { verified: "Route verified", stale: "Route unverified", not_read: "Route not read", unavailable: "No route", no_zdr: "No ZDR route", not_needed: "No route needed" } as const;
const inr = (v: number | null) => (v === null ? "Unknown" : formatInr(v, 4));

function TaskRow({ t }: { t: AutoTaskRow }) {
  return (
    <li className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2" data-testid="autoconfig-task" data-task={t.task} data-model={t.model ?? ""} data-price-state={t.price.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t.label}</span>
        {t.model ? <code className="text-xs [overflow-wrap:anywhere]">{t.model}</code> : <Badge variant="warning" data-testid="autoconfig-none">No suitable model</Badge>}
        {t.model && <Badge variant={ROUTE_TONE[t.route.state]}>{ROUTE_LABEL[t.route.state]}</Badge>}
        <Badge variant="neutral" data-testid="autoconfig-quality">Quality: Not tested</Badge>
      </div>
      <p className="text-xs" data-testid="autoconfig-reason">{t.reason}</p>
      {t.model && (
        <dl className="grid gap-x-3 gap-y-0.5 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-[10rem_1fr]">
          <dt className="font-medium text-[var(--color-foreground)]">Image input</dt>
          <dd>{t.imageInput === null ? "Not needed (text only)" : t.imageInput ? "Yes (published input modality)" : "No"}</dd>
          <dt className="font-medium text-[var(--color-foreground)]">Provider route</dt>
          <dd data-testid="autoconfig-route">{t.route.text}</dd>
          <dt className="font-medium text-[var(--color-foreground)]">Price</dt>
          <dd data-testid="autoconfig-price">{t.price.text}</dd>
          <dt className="font-medium text-[var(--color-foreground)]">Privacy</dt>
          <dd>{t.privacy.text}</dd>
          <dt className="font-medium text-[var(--color-foreground)]">Recent requests</dt>
          <dd>{t.rateLimit.text}</dd>
          {t.alternatives.length > 0 && (
            <>
              <dt className="font-medium text-[var(--color-foreground)]">Also suitable</dt>
              <dd>{t.alternatives.join(", ")} (not selected)</dd>
            </>
          )}
        </dl>
      )}
      {t.rateLimit.warning && (
        <p className="text-xs text-[var(--color-warning)]" data-testid="autoconfig-ratelimit">
          {t.rateLimit.warning}
        </p>
      )}
    </li>
  );
}

/**
 * Import Settings → "AI Auto-Configure Everything". Prepares every importer task's model and the related
 * settings from the catalog, provider routes read now, prices, privacy and recent rate limits — without an
 * AI request. Shows the complete preview first; saves only on "Apply Configuration" (re-checked on the
 * server). Paid AI, budgets and privacy are never changed here.
 */
export function AutoConfigure({ canManage, dirty, onApplied }: { canManage: boolean; dirty: boolean; onApplied: (next: ImporterSettings) => void }) {
  const [preview, setPreview] = useState<AutoConfigPreview | null>(null);
  const [applied, setApplied] = useState<AutoConfigApplied | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      setError(null);
      setApplied(null);
      const r = await callImporter(() => autoConfigPreviewAction());
      if (r.ok) setPreview(r.data);
      else setError(r.error);
    });
  const apply = () =>
    start(async () => {
      if (!preview) return;
      setError(null);
      const r = await callImporter(() => autoConfigApplyAction(preview.baselineKey, preview.proposalKey));
      if (r.ok) {
        setApplied(r.data);
        onApplied(preview.proposed);
        setPreview(null);
      } else setError(r.error);
    });
  if (!canManage) return null;
  const changed = preview?.changes.filter((c) => c.changed) ?? [];
  return (
    <Card data-testid="autoconfig">
      <CardHeader>
        <CardTitle>AI Auto-Configure Everything</CardTitle>
        <CardDescription>
          Prepares a model for every importer task — scanned pages, digital PDFs, mathematics, chemistry, diagrams, answer keys, independent verification and classification — and the related importer settings, from the synced catalog, provider routes read now, prices, privacy and recent rate limits. No AI request is sent (the recommendations are calculated, not asked of an AI). You see everything first; nothing is saved until you choose Apply Configuration. Paid AI, budgets and privacy are never changed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={run} disabled={pending || dirty} data-testid="autoconfig-run">
            {pending && !preview ? "Preparing…" : "AI Auto-Configure Everything"}
          </Button>
        </div>
        {dirty && <p className="text-xs text-[var(--color-warning)]" data-testid="autoconfig-dirty">Save (or reload to discard) your unsaved changes first — the configuration starts from the saved settings.</p>}
        {error && (
          <p className="text-[var(--color-error)]" role="alert" data-testid="autoconfig-error">
            {error}
          </p>
        )}

        {preview && (
          <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-warning)] p-3" role="dialog" aria-label="AI Auto-Configuration Preview" data-testid="autoconfig-preview" data-ai-requests={preview.aiRequestsSent} data-paid-ai={preview.paidAiOn ? "on" : "off"}>
            <p className="text-base font-semibold">AI Auto-Configuration Preview</p>
            <p className="text-xs" data-testid="autoconfig-method">
              <strong>How this was prepared:</strong> calculated from the synced catalog, provider routes read from OpenRouter {preview.routesFetchedAt ? `at ${preview.routesFetchedAt.slice(0, 16).replace("T", " ")} UTC` : "(not read)"}, the importer&apos;s privacy and budget settings and its own request history. {preview.aiRequestsSent} AI requests were sent. {preview.paidAiText}
            </p>
            {preview.blocking.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-[var(--color-error)]" role="alert" data-testid="autoconfig-blocking">
                {preview.blocking.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <section className="flex flex-col gap-1.5">
              <h3 className="font-semibold">Models per task</h3>
              <ul className="flex flex-col gap-1.5">
                {preview.tasks.map((t) => (
                  <TaskRow key={t.task} t={t} />
                ))}
              </ul>
            </section>
            <section className="flex flex-col gap-1" data-testid="autoconfig-cost">
              <h3 className="font-semibold">Cost</h3>
              <p className="text-xs">
                For a reference job of {preview.jobCost.reference}: estimate <strong data-testid="autoconfig-est">{inr(preview.jobCost.estimateInr)}</strong>, estimated maximum <strong data-testid="autoconfig-max">{inr(preview.jobCost.maxInr)}</strong>.
                {preview.jobCost.maxPerPageInr !== null ? ` About ${inr(preview.jobCost.maxPerPageInr)} per scanned page at the conservative maximum.` : ""}
              </p>
              <ul className="list-disc pl-5 text-xs text-[var(--color-muted-foreground)]">
                {preview.jobCost.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
            <section className="flex flex-col gap-1">
              <h3 className="font-semibold">Current versus proposed settings</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-xs" data-testid="autoconfig-changes">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="py-1 pr-2">Setting</th>
                      <th className="py-1 pr-2">Current</th>
                      <th className="py-1 pr-2">Proposed</th>
                      <th className="py-1">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changes.map((c) => (
                      <tr key={c.key} className="border-b border-[var(--color-border)] align-top" data-testid="autoconfig-change" data-key={c.key} data-changed={c.changed ? "true" : "false"}>
                        <td className="py-1 pr-2 font-medium">{c.label}</td>
                        <td className="py-1 pr-2 [overflow-wrap:anywhere]">{c.current}</td>
                        <td className={`py-1 pr-2 [overflow-wrap:anywhere] ${c.changed ? "font-semibold text-[var(--color-primary)]" : ""}`}>{c.proposed}</td>
                        <td className="py-1">{c.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {changed.length} setting(s) change. Not changed: {preview.untouched.join(", ")}.
              </p>
            </section>
            <p className="text-xs">Before saving, the server reads the provider routes and prices again and re-checks privacy; if anything differs from this preview, nothing is saved.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={apply} disabled={pending || preview.blocking.length > 0} data-testid="autoconfig-apply">
                {pending ? "Checking and saving…" : "Apply Configuration"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setPreview(null)} disabled={pending} data-testid="autoconfig-cancel">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {applied && (
          <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-success)] p-3 text-xs" role="status" data-testid="autoconfig-applied">
            <p className="font-semibold text-[var(--color-success)]">Configuration saved and recorded in the audit log. Paid AI and the cost limits are unchanged.</p>
            <ul className="list-disc pl-5">
              {applied.tasks.map((t) => (
                <li key={t.task} data-task={t.task} data-model={t.model ?? ""}>
                  {t.label}: {t.model ? <code>{t.model}</code> : "no suitable model"}
                </li>
              ))}
            </ul>
            <p>Existing imports keep the models they were confirmed with; use Reconfigure Models for This Job on a paused import to change them.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
