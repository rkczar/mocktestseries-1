"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { approveAllCleanAction, importAction, refreshStatusesAction, runChecksAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import type { TwoStepView } from "@/lib/ai-import/two-step";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);
const STEP_LABEL = { verify1: "Verify 1 (free structure check)", verify2: "Verify 2 (independent read)", answers: "Verify Answers", done: "All checks finished" } as const;

/**
 * The two-step importer: Step 1 Import & Process (reading, key, mapping, classification and every check run in the
 * background), Step 2 Review & Approve (clean questions in bulk; only genuine problems need a person). Provider /
 * model failures are shown apart and never counted as question errors. Every other control stays under Advanced.
 */
export function TwoStepPanel({ v, canUse, canPublish }: { v: TwoStepView; canUse: boolean; canPublish: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const b = v.buckets;
  const exceptions = (status: string) => `/admin/ai-importer/exceptions?job=${v.jobId}&status=${status}`;

  const runChecks = (from: "verify1" | "verify2" | "answers") =>
    start(async () => {
      // A paid step shows its cost first; nothing is sent until it is confirmed.
      const first = from === "verify1" ? null : await callImporter(() => runChecksAction(v.jobId, from, null));
      let confirmed = 0;
      if (first) {
        if (!first.ok) return setMsg({ ok: false, text: first.error ?? "Failed" });
        if (first.data.started) return router.refresh();
        if (first.data.maxInr === null) return setMsg({ ok: false, text: `Cannot run: ${first.data.reason}` });
        if (!confirm(`${first.data.reason}\nEstimated ${inr(first.data.estimateInr)}, maximum ${inr(first.data.maxInr)}.\n\nRun it now? Checks never change official or admin-confirmed answers.`)) return;
        confirmed = first.data.maxInr;
      }
      const r = await callImporter(() => runChecksAction(v.jobId, from, confirmed));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      setMsg(r.data.started ? { ok: !r.data.held, text: r.data.held ? `Waiting: ${r.data.held}` : "Checks started in the background — this page updates when they finish." } : { ok: false, text: r.data.reason });
      router.refresh();
    });

  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border-2 border-[var(--color-primary)]/40 p-3" data-testid="two-step">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-2" data-testid="step1">
          <h2 className="text-sm font-semibold">Step 1 — Import &amp; Process</h2>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Questions, answer key, mapping, subjects and every check run automatically. If a model or provider fails, the next one in the fallback chain takes over.
          </p>
          <p className="text-sm" data-testid="step1-state">
            {v.busy ? <Badge variant="info">Running</Badge> : v.finished ? <Badge variant="success">Processed</Badge> : <Badge variant="warning">{v.status.toLowerCase().replace(/_/g, " ")}</Badge>}{" "}
            {v.auto ? (v.auto.held ? <span className="text-[var(--color-warning)]" data-testid="auto-held">Checks waiting at {STEP_LABEL[v.auto.step]}: {v.auto.held}</span> : <span data-testid="auto-step">{v.auto.step === "done" ? STEP_LABEL.done : `Next: ${STEP_LABEL[v.auto.step]}`}</span>) : <span className="text-[var(--color-muted-foreground)]">Automatic checks are off for this import.</span>}
          </p>
          <p className="text-xs" data-testid="step1-checks">
            Verify 2: {v.verify2 ?? "not run"} · Verify Answers: {v.verifyAnswers ?? "not run"} · Model switches: {v.fallbacks} · Provider failures: {v.providerFailures}
          </p>
          {canUse && v.finished && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={() => runChecks(v.auto?.held && v.auto.step !== "done" ? v.auto.step : "verify1")} data-testid="run-checks">
                {v.auto?.held ? "Continue checks" : b.system ? "Retry failed checks" : "Run checks again"}
              </Button>
              {v.statusesStale && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
                  const r = await callImporter(() => refreshStatusesAction(v.jobId));
                  setMsg(r.ok ? { ok: true, text: `Statuses recomputed for ${r.data.questions} question(s) (no AI; admin-confirmed answers kept).` } : { ok: false, text: r.error ?? "Failed" });
                  if (r.ok) router.refresh();
                })} data-testid="refresh-statuses">
                  Statuses out of date — Refresh (free)
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2" data-testid="step2">
          <h2 className="text-sm font-semibold">Step 2 — Review &amp; Approve</h2>
          <ul className="grid grid-cols-2 gap-2 text-sm">
            <li className="rounded border p-2" data-testid="bucket-clean">
              <b>{b.clean}</b> clean — all checks passed
            </li>
            <li className="rounded border p-2" data-testid="bucket-needs-you">
              <Link className="underline" href={exceptions("needs-you")}>
                <b>{b["needs-you"]}</b> need you
              </Link>{" "}
              <span className="text-xs text-[var(--color-muted-foreground)]">genuine or uncertain</span>
            </li>
            <li className={`rounded border p-2 ${b.system ? "border-[var(--color-warning)]" : ""}`} data-testid="bucket-system">
              <Link className="underline" href={exceptions("system")}>
                <b>{b.system}</b> system issues
              </Link>{" "}
              <span className="text-xs text-[var(--color-muted-foreground)]">a check failed — not the question</span>
            </li>
            <li className="rounded border p-2" data-testid="bucket-done">
              <b>{b.approved}</b> approved · <b>{b.done}</b> imported / rejected
            </li>
          </ul>
          {canUse && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending || !b.clean || !v.finished} onClick={() => confirm(`Approve the ${b.clean} clean question(s)? Questions with any open problem stay blocked.`) && start(async () => {
                const r = await callImporter(() => approveAllCleanAction(v.jobId));
                // Say what the server did: approvals it refused (no subject, answer not confirmed, …) are listed, never hidden.
                setMsg(r.ok ? { ok: !r.data.refused.length, text: `${r.data.approved} question(s) approved${r.data.refused.length ? `; ${r.data.refused.length} not approved: ${r.data.refused.slice(0, 3).map((x) => `Q${x.label} — ${x.reason}`).join("; ")}` : "."}` } : { ok: false, text: r.error ?? "Failed" });
                if (r.ok) router.refresh();
              })} data-testid="approve-clean">
                Approve all clean ({b.clean})
              </Button>
              {canPublish && (
                <Button size="sm" variant="outline" disabled={pending || !b.approved || !v.finished} onClick={() => confirm(`Add the ${b.approved} approved question(s) to the Question Bank as Draft (not published)?`) && start(async () => {
                  const r = await callImporter(() => importAction(v.jobId, "DRAFT", null));
                  setMsg(r.ok ? { ok: true, text: "Import as Draft started." } : { ok: false, text: r.error ?? "Failed" });
                  if (r.ok) router.refresh();
                })} data-testid="import-approved">
                  Add approved to Question Bank ({b.approved})
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {msg && (
        <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="two-step-msg">
          {msg.text}
        </p>
      )}
    </section>
  );
}
