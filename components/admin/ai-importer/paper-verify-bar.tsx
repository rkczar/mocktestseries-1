"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { importAction, importEligibleAction, verify2PreviewAction, verify2StartAction, verifyPaperAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import type { PaperSummary, Verify2Preview } from "@/lib/ai-import/paper-verify";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);

function Stat({ id, label, value, tone, href }: { id: string; label: string; value: string | number; tone?: "error" | "warning" | "success"; href?: string }) {
  const body = (
    <>
      <span className="text-xs text-[var(--color-muted-foreground)]">{label}</span>
      <span className={`text-base font-semibold ${tone === "error" ? "text-[var(--color-error)]" : tone === "warning" ? "text-[var(--color-warning)]" : tone === "success" ? "text-[var(--color-success)]" : ""}`} data-testid={`ps-${id}`}>
        {value}
      </span>
    </>
  );
  return href ? (
    <Link href={href} className="flex flex-col rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 hover:border-[var(--color-primary)]">
      {body}
    </Link>
  ) : (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-[var(--color-border)] p-2">{body}</div>
  );
}

/**
 * Review Exceptions → full-paper verification: Verify 1 (whole job, no AI), Verify 2 (independent model,
 * priced and confirmed first), the paper-level summary, and the two bulk import actions.
 */
export function PaperVerifyBar({ jobId, jobStatus, summary, canUse, canPublish, hrefs }: { jobId: string; jobStatus: string; summary: PaperSummary; canUse: boolean; canPublish: boolean; hrefs: { verified: string; v1Problems: string; v2Disagree: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<Verify2Preview | null>(null);
  const [model, setModel] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);
  const finished = ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"].includes(jobStatus);
  const v2 = summary.cost.verify2;
  const running = v2 && (v2.status === "QUEUED" || v2.status === "RUNNING") && !finished;

  const loadPreview = (m: string | null) =>
    start(async () => {
      const r = await callImporter(() => verify2PreviewAction(jobId, m));
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
      setPreview(r.data);
      setModel(r.data.model ?? "");
      setNote(null);
    });

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border-2 border-[var(--color-primary)]/40 p-3" data-testid="paper-verify">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!canUse || !finished || pending} onClick={() => start(async () => {
          setMsg({ ok: true, text: "Verify 1 is checking the whole paper…" });
          const r = await callImporter(() => verifyPaperAction(jobId));
          setMsg(r.ok ? { ok: true, text: `Verify 1 done: ${r.data.questions} checked, ${r.data.passed} passed, ${r.data.withProblems} with findings, ${r.data.corrected} corrected from the source${r.data.missing.length ? `; missing ${r.data.missing.slice(0, 8).join(", ")}` : ""}${r.data.referenceOnly.length ? `; ${r.data.referenceOnly.length} reference question(s) not in the source` : ""}.` } : { ok: false, text: r.error ?? "Failed" });
          if (r.ok) router.refresh();
        })} data-testid="verify1">
          Verify 1 — Full Paper
        </Button>
        <Button variant="outline" className="border-[var(--color-primary)]" disabled={!canUse || !finished || pending} onClick={() => loadPreview(null)} data-testid="verify2">
          Verify 2 — Independent Verification
        </Button>
        <span className="text-xs text-[var(--color-muted-foreground)]">Verify 1 is free (no AI). Verify 2 reads the original paper again with a different model — its cost is shown and confirmed first.</span>
      </div>
      {!finished && <p className="text-xs text-[var(--color-warning)]" data-testid="verify-busy">{running ? `Verify 2 is running with ${v2!.model}…` : "Verification is available once processing has finished."}</p>}
      {v2 && (
        <p className="text-xs" data-testid="verify2-state" data-status={v2.status}>
          Verify 2: <Badge variant={v2.status === "DONE" ? "success" : v2.status === "STOPPED" ? "warning" : "info"}>{v2.status.toLowerCase()}</Badge> {v2.model} · estimated {inr(v2.estimateInr)} · maximum {inr(v2.maxInr)} · actual {inr(v2.actualInr)}
        </p>
      )}
      {preview && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-warning)] p-3 text-sm" role="dialog" aria-label="Confirm Verify 2 cost" data-testid="verify2-preview">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              Model for the independent read
              <SelectNative value={model} onChange={(e) => {
                setModel(e.target.value);
                loadPreview(e.target.value || null);
              }} data-testid="verify2-model">
                {!preview.candidates.some((c) => c.eligible) && <option value="">No suitable model</option>}
                {preview.candidates.filter((c) => c.eligible).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} — up to {inr(c.maxInr)} per request
                  </option>
                ))}
              </SelectNative>
            </label>
            <span className="text-xs text-[var(--color-muted-foreground)]">Not used (extracted this import): {preview.usedModels.join(", ") || "none — read locally"}</span>
          </div>
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            <li>Requests: {preview.pages} page image(s), {preview.textParts} document part(s), {preview.classifyBatches} classification</li>
            <li>Per request: up to {inr(preview.perRequestMaxInr)} (limit ₹1.00)</li>
            <li data-testid="verify2-estimate">Estimated cost: <b>{inr(preview.estimateInr)}</b></li>
            <li data-testid="verify2-max">Maximum cost: <b>{inr(preview.maxInr)}</b></li>
            <li>Spent on this import so far: {inr(preview.spentInr)} · confirmed maximum {inr(preview.confirmedMaxInr)}</li>
          </ul>
          {preview.problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-[var(--color-error)]" data-testid="verify2-problems">
              {preview.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {note && <p className="text-xs text-[var(--color-warning)]" role="alert" data-testid="verify2-note">{note}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending || !model || preview.maxInr === null || !preview.aiEnabled} onClick={() => start(async () => {
              const r = await callImporter(() => verify2StartAction(jobId, model, preview.maxInr));
              if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Failed" });
              if (r.data.started) {
                setPreview(null);
                setMsg({ ok: true, text: `Verify 2 started with ${model} (maximum ${inr(r.data.maxInr)}). This page updates when it finishes.` });
                router.refresh();
              } else {
                // The price changed (or was not confirmed): show the new one; nothing was sent.
                setPreview(r.data.preview);
                setNote(r.data.reason);
              }
            })} data-testid="verify2-confirm">
              Confirm maximum {inr(preview.maxInr)} and start Verify 2
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" data-testid="paper-summary">
        <Stat id="total" label="Questions processed" value={summary.total} />
        <Stat id="verified" label="Verified (1 + 2)" value={summary.verified} tone={summary.verified ? "success" : undefined} href={hrefs.verified} />
        <Stat id="v1" label="Verify 1 passed / findings" value={`${summary.v1.passed} / ${summary.v1.problems}${summary.v1.stale ? ` (+${summary.v1.stale} out of date)` : ""}`} href={hrefs.v1Problems} />
        <Stat id="v2" label="Verify 2 agree / disagree" value={`${summary.v2.verified} / ${summary.v2.disagree}${summary.v2.failed ? ` (+${summary.v2.failed} no result)` : ""}`} href={hrefs.v2Disagree} />
        <Stat id="corrected" label="Corrected" value={summary.corrected} />
        <Stat id="missing" label="Missing / duplicate" value={`${summary.missing.length} / ${summary.duplicates.length}`} tone={summary.missing.length || summary.duplicates.length ? "error" : undefined} />
        <Stat id="answers" label="Answer-key & type issues" value={summary.answerIssues} tone={summary.answerIssues ? "error" : undefined} />
        <Stat id="taxonomy" label="Subject / topic issues" value={summary.classificationIssues} tone={summary.classificationIssues ? "warning" : undefined} />
        <Stat id="formula" label="Formula / OCR issues" value={summary.formulaIssues} tone={summary.formulaIssues ? "warning" : undefined} />
        <Stat id="figures" label="Figure / crop issues" value={summary.figureIssues} tone={summary.figureIssues ? "warning" : undefined} />
        <Stat id="unresolved" label="Unresolved disagreements" value={summary.unresolved} tone={summary.unresolved ? "error" : undefined} />
        <Stat id="cost" label="AI cost: estimate / actual" value={`${inr(summary.cost.estimateInr)} / ${inr(summary.cost.spentInr)}`} />
      </div>
      {(summary.missing.length > 0 || summary.duplicates.length > 0) && (
        <p className="text-xs text-[var(--color-error)]" data-testid="ps-missing-list">
          {summary.missing.length ? `Missing: ${summary.missing.slice(0, 20).join(", ")}${summary.missing.length > 20 ? " …" : ""}. ` : ""}
          {summary.duplicates.length ? `Duplicates: ${summary.duplicates.slice(0, 12).join(", ")}${summary.duplicates.length > 12 ? " …" : ""}.` : ""}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canPublish && (
          <Button disabled={!summary.eligible.length || pending || !finished} onClick={() => confirm(`Approve, import and publish the ${summary.eligible.length} question(s) that passed Verify 1 and Verify 2 and every check? Everything else stays blocked for review.`) && start(async () => {
            const r = await callImporter(() => importEligibleAction(jobId));
            setMsg(r.ok ? { ok: true, text: `${r.data.requested} verified question(s) approved and sent to Import & Publish${r.data.skipped ? `; ${r.data.skipped} could not be approved` : ""}. See the job page.` } : { ok: false, text: r.error ?? "Failed" });
            if (r.ok) router.refresh();
          })} data-testid="import-eligible">
            Import &amp; Publish Eligible Questions ({summary.eligible.length})
          </Button>
        )}
        {canUse && (
          <Button variant="outline" disabled={!summary.approvedNotStored || pending || !finished} onClick={() => confirm(`Import the ${summary.approvedNotStored} approved question(s) into the Question Bank as Draft (not published)?`) && start(async () => {
            const r = await callImporter(() => importAction(jobId, "DRAFT", null));
            setMsg(r.ok ? { ok: true, text: "Import as Draft started — see the job page." } : { ok: false, text: r.error ?? "Failed" });
            if (r.ok) router.refresh();
          })} data-testid="import-approved-draft">
            Import Approved Questions as Draft ({summary.approvedNotStored})
          </Button>
        )}
        <span className="text-xs text-[var(--color-muted-foreground)]">Questions with an unresolved answer, missing content, an uncertain image, invalid options, an unsupported type or a model disagreement stay blocked.</span>
      </div>
      {msg && (
        <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="verify-msg">
          {msg.text}
        </p>
      )}
    </div>
  );
}
