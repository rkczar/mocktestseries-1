"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import type { ApplyResult, AssistantCandidate, AssistantResult, ModelTestReport } from "@/lib/ai-import/assistant-types";
import { applyRecommendedModelsAction, findBestModelsAction, testModelsAction } from "../actions";

const ROUTE_TONE = { verified: "success", stale: "warning", not_read: "neutral", unavailable: "error", no_zdr: "error" } as const;
const ROUTE_LABEL = { verified: "Route verified", stale: "Route unverified (old data)", not_read: "Route not read yet", unavailable: "Route unavailable", no_zdr: "No ZDR route" } as const;

function Candidate({ c, recommended }: { c: AssistantCandidate; recommended: boolean }) {
  return (
    <li className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2" data-testid="assistant-candidate" data-model-id={c.id} data-recommended={recommended ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs font-semibold [overflow-wrap:anywhere]">{c.id}</code>
        {recommended && <Badge variant="primary">Recommended</Badge>}
        {c.onList && <Badge variant="neutral">On importer list</Badge>}
        <Badge variant={ROUTE_TONE[c.route.state]} data-testid="assistant-route">{ROUTE_LABEL[c.route.state]}</Badge>
        <Badge variant="neutral" data-testid="assistant-quality">Quality: Not tested</Badge>
      </div>
      <dl className="grid gap-x-3 gap-y-0.5 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-[9rem_1fr]">
        <dt className="font-medium text-[var(--color-foreground)]">Price</dt>
        <dd data-testid="assistant-price" data-price-state={c.price.state}>{c.price.text}</dd>
        <dt className="font-medium text-[var(--color-foreground)]">Image input</dt>
        <dd>{c.imageInput ? "Yes (published input modality)" : "No"}</dd>
        <dt className="font-medium text-[var(--color-foreground)]">Provider route</dt>
        <dd>{c.route.text}</dd>
        <dt className="font-medium text-[var(--color-foreground)]">Recent requests</dt>
        <dd data-testid="assistant-history">{c.history.text}</dd>
        <dt className="font-medium text-[var(--color-foreground)]">Published parameters</dt>
        <dd>{[c.params.structuredOutput ? "structured output (JSON)" : null, c.params.reasoning ? "reasoning" : null].filter(Boolean).join(", ") || "none relevant"} — API facts, not a quality measure</dd>
        <dt className="font-medium text-[var(--color-foreground)]">Test status</dt>
        <dd data-testid="assistant-test" data-config={c.test.config}>
          Configuration: {c.test.config === "passed" ? "passed" : c.test.config === "failed" ? "failed" : "not run"} — {c.test.configText} Quality: Not tested.
        </dd>
      </dl>
      <ul className="list-disc pl-5 text-xs text-[var(--color-warning)]" data-testid="assistant-limitations">
        {c.limitations.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Import Settings → Model Assistant. "Find Best Models with AI" recommends importer models per purpose;
 * the recommendations are deterministic and catalog-based (no AI request — AI reasoning is not approved
 * and is never used while Paid AI is off). "Apply Recommended Models" shows exactly what changes and
 * saves only the importer's own model list after confirmation. "Test Models" runs configuration checks
 * only; real quality tests stay disabled.
 */
export function ModelAssistant({ canManage, dirty, onApplied }: { canManage: boolean; dirty: boolean; onApplied: (list: string[]) => void }) {
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [report, setReport] = useState<ModelTestReport | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const find = () =>
    start(async () => {
      setError(null);
      setPreviewing(false);
      setApplied(null);
      const r = await callImporter(() => findBestModelsAction());
      if (r.ok) setResult(r.data);
      else setError(r.error);
    });
  const test = () =>
    start(async () => {
      setError(null);
      const r = await callImporter(() => testModelsAction());
      if (r.ok) setReport(r.data);
      else setError(r.error);
    });
  const apply = () =>
    start(async () => {
      if (!result) return;
      setError(null);
      const r = await callImporter(() => applyRecommendedModelsAction(result.toAdd, result.currentList));
      if (r.ok) {
        setApplied(r.data);
        setPreviewing(false);
        setResult(null);
        onApplied(r.data.list);
      } else setError(r.error);
    });
  return (
    <Card data-testid="model-assistant">
      <CardHeader>
        <CardTitle>Model Assistant</CardTitle>
        <CardDescription>
          Finds suitable importer models per purpose from the synced catalog (published image input and prices), the stored provider routes, your privacy and budget settings and the importer&apos;s own recent requests. It never judges a model by its name, and every model&apos;s quality is <strong>Not tested</strong> until a real benchmark is run. Nothing changes until you apply and confirm, and only the importer&apos;s own model list changes — never student Ask AI, Instagram or the approvals in AI → Models.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={find} disabled={pending} data-testid="assistant-find">
            {pending && !result && !report ? "Working…" : "Find Best Models with AI"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={test} disabled={pending} data-testid="assistant-test-models">
            Test Models
          </Button>
          {canManage && result && (
            <Button type="button" size="sm" variant="outline" onClick={() => setPreviewing(true)} disabled={pending || dirty || !result.toAdd.length} data-testid="assistant-apply">
              Apply Recommended Models
            </Button>
          )}
        </div>
        {canManage && result && dirty && <p className="text-xs text-[var(--color-warning)]" data-testid="assistant-dirty">Save (or reload to discard) your unsaved changes first — the recommendations are for the saved settings.</p>}
        {error && (
          <p className="text-[var(--color-error)]" role="alert" data-testid="assistant-error">
            {error}
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-3" data-testid="assistant-result" data-method={result.method}>
            <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-xs" data-testid="assistant-method">
              <strong>How these were found:</strong> {result.methodNote} Catalog synced {result.catalogSyncedAt?.slice(0, 10) ?? "never"}; provider routes read {result.routesFetchedAt ? `${result.routesFetchedAt.slice(0, 16).replace("T", " ")} UTC` : "never"}.
            </p>
            {result.purposes.map((p) => (
              <section key={p.purpose} className="flex flex-col gap-1.5" data-testid={`assistant-purpose-${p.purpose}`} data-recommended={p.recommended ?? ""}>
                <h3 className="font-semibold text-[var(--color-foreground)]">{p.label}</h3>
                <p className="text-xs text-[var(--color-muted-foreground)]">Requirements checked: {p.requirements}</p>
                {p.none ? (
                  <p className="text-xs text-[var(--color-warning)]" data-testid="assistant-none">{p.none}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {p.candidates.map((c) => (
                      <Candidate key={c.id} c={c} recommended={c.id === p.recommended} />
                    ))}
                  </ul>
                )}
                {p.excluded.length > 0 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="assistant-excluded">
                    Not recommended: {p.excluded.map((e) => `${e.count} ${e.reason}`).join("; ")}.
                  </p>
                )}
              </section>
            ))}
          </div>
        )}

        {previewing && result && (
          <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-warning)] p-3" role="dialog" aria-label="Apply recommended models" data-testid="assistant-preview">
            <p className="font-semibold">Confirm the change to the importer&apos;s model list</p>
            <ul className="list-disc pl-5 text-xs">
              <li data-testid="assistant-preview-add">Add: {result.toAdd.map((id) => <code key={id} className="mr-2">{id}</code>)}</li>
              <li>Keep: {result.currentList.length ? result.currentList.join(", ") : "nothing (the list is empty)"}</li>
              {result.notRecommended.length > 0 && <li>Already listed but not recommended now (kept — remove by hand if wanted): {result.notRecommended.join(", ")}</li>}
              <li>Not changed: Paid AI, budgets, privacy, selection mode, student Ask AI, Instagram and AI → Models approvals.</li>
              <li>After saving, the provider routes of the list are read again (free metadata requests, no AI request) and route, price, privacy and budget are re-checked per task.</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={apply} disabled={pending} data-testid="assistant-confirm">
                {pending ? "Saving…" : "Confirm and save"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setPreviewing(false)} disabled={pending} data-testid="assistant-cancel">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {applied && (
          <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-success)] p-3 text-xs" role="status" data-testid="assistant-applied">
            <p className="font-semibold text-[var(--color-success)]">Saved: added {applied.added.join(", ")} to the importer&apos;s model list.</p>
            {applied.routesError && <p className="text-[var(--color-warning)]">Provider routes could not be re-read ({applied.routesError}); use Refresh provider routes.</p>}
            <p>Re-validated with the saved settings:</p>
            <ul className="list-disc pl-5" data-testid="assistant-revalidated">
              {applied.tasks.map((t) => (
                <li key={t.task} data-task={t.task} data-model={t.model ?? ""}>
                  {t.label}: {t.model ? <code>{t.model}</code> : "no model"} — {t.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report && (
          <div className="flex flex-col gap-2" data-testid="assistant-report" data-ai-requests={report.aiRequestsSent}>
            <p className="text-xs text-[var(--color-muted-foreground)]">Configuration checks at {report.at.slice(11, 16)} UTC — stored data only; {report.aiRequestsSent} AI requests were sent.</p>
            <ul className="flex flex-col gap-0.5 text-xs" data-testid="assistant-global-checks">
              {report.global.map((c) => (
                <li key={c.label} data-ok={c.ok ? "true" : "false"}>
                  <Badge variant={c.ok ? "success" : "warning"}>{c.ok ? "OK" : "Check"}</Badge> <strong>{c.label}:</strong> {c.detail}
                </li>
              ))}
            </ul>
            {report.models.length === 0 ? (
              <p className="text-xs italic text-[var(--color-muted-foreground)]">No model is on the importer&apos;s list.</p>
            ) : (
              report.models.map((m) => (
                <details key={m.id} className="text-xs" data-testid="assistant-model-test" data-model-id={m.id} data-passed={m.passed ? "true" : "false"}>
                  <summary className="cursor-pointer">
                    <code>{m.id}</code> — configuration {m.passed ? "passed" : "has problems"}; quality Not tested
                  </summary>
                  <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                    {m.checks.map((c) => (
                      <li key={c.label} className={c.ok ? "" : "text-[var(--color-error)]"}>
                        {c.ok ? "✓" : "✗"} {c.label}: {c.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled data-testid="assistant-quality-test">
                Run quality test (disabled)
              </Button>
              <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="assistant-quality-reason">{report.quality.reason}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
