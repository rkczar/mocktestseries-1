"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { BudgetCheck } from "@/components/admin/ai-importer/budget-check";
import { verifyAnswersPreviewAction, verifyAnswersStartAction, verifyAnswersStopAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import type { VaPreview } from "@/lib/ai-import/verify-answers-run";

const inr = (v: number | null | undefined) => (typeof v === "number" ? `₹${v.toFixed(2)}` : "—");

/**
 * Verify Answers: paper-wide answer-key mapping check plus an optional independent AI answer per question. The price
 * is shown and confirmed first; it never changes an official answer, never approves and never publishes.
 */
export function VerifyAnswersButton({ jobId, finished, canUse, running }: { jobId: string; finished: boolean; canUse: boolean; running: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<VaPreview | null>(null);
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const report = `/admin/ai-importer/answers?job=${jobId}&va=1`;

  const load = (m: string | null) =>
    start(async () => {
      const r = await callImporter(() => verifyAnswersPreviewAction(jobId, m));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      setPreview(r.data);
      setModel(r.data.model ?? "");
      setMsg(null);
    });

  const begin = (keyOnly: boolean) =>
    start(async () => {
      const r = await callImporter(() => verifyAnswersStartAction(jobId, keyOnly ? null : model || null, keyOnly ? 0 : preview?.maxInr ?? null, keyOnly));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      if (!r.data.started) {
        setPreview(r.data.preview);
        return setMsg({ ok: false, text: r.data.reason ?? "Not started." });
      }
      setPreview(null);
      setMsg({ ok: true, text: "Verify Answers started. This page updates when it finishes." });
      router.refresh();
    });

  return (
    <>
      <Button variant="outline" className="border-[var(--color-primary)]" disabled={!canUse || !finished || pending} onClick={() => load(null)} data-testid="verify-answers">
        Verify Answers
      </Button>
      {running && (
        <Button size="sm" variant="ghost" disabled={!canUse || pending} onClick={() => start(async () => {
          const r = await callImporter(() => verifyAnswersStopAction(jobId));
          setMsg(r.ok ? { ok: true, text: "Verify Answers stopped. Answers so far are kept; run it again to resume." } : { ok: false, text: r.error ?? "Failed" });
          if (r.ok) router.refresh();
        })} data-testid="verify-answers-stop">
          Stop Verify Answers
        </Button>
      )}
      <Link className="text-xs underline" href={report} data-testid="verify-answers-report">Verify Answers report</Link>
      {preview && (
        <div className="flex w-full flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-warning)] p-3 text-sm" role="dialog" aria-label="Confirm Verify Answers cost" data-testid="verify-answers-preview">
          <p className="text-xs">Checks every question&apos;s answer-key mapping (free) and, optionally, asks one model to solve each question on its own. A disagreement only sends the question to manual review: the official answer is never changed.</p>
          {preview.candidates.some((c) => c.eligible) && (
            <label className="flex flex-col gap-1 text-xs">
              Model for the independent answer
              <SelectNative value={model} onChange={(e) => { setModel(e.target.value); load(e.target.value || null); }} data-testid="verify-answers-model">
                {preview.candidates.filter((c) => c.eligible).map((c) => (
                  <option key={c.id} value={c.id}>{c.id} — up to {inr(c.maxInr)} per request</option>
                ))}
              </SelectNative>
            </label>
          )}
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            <li>Questions: {preview.questions} · to ask: <b data-testid="va-to-ask">{preview.toAsk}</b> · reused (same question, same model): {preview.reused}</li>
            <li data-testid="va-estimate">Estimated: <b>{inr(preview.estimateInr)}</b> · Maximum: <b data-testid="va-max">{inr(preview.maxInr)}</b></li>
          </ul>
          {preview.toAsk > 0 && <BudgetCheck maxInr={preview.maxInr} />}
          {preview.problem && <p className="text-xs text-[var(--color-warning)]" data-testid="va-problem">{preview.problem}</p>}
          <div className="flex flex-wrap gap-2">
            {preview.model && preview.aiEnabled && (
              <Button size="sm" disabled={pending} onClick={() => begin(false)} data-testid="verify-answers-confirm">
                {preview.toAsk ? <>Confirm &amp; Continue (max {inr(preview.maxInr)})</> : <>Run (nothing to pay)</>}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={pending} onClick={() => begin(true)} data-testid="verify-answers-key-only">
              Key check only (₹0)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {msg && <p className={`w-full text-xs ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="verify-answers-msg">{msg.text}</p>}
    </>
  );
}
