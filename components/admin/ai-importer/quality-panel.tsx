"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { QUALITY_STATE_LABELS, type QualityReport } from "@/lib/ai-import/quality";
import { acknowledgeSequenceAction, addMissingQuestionAction, approveAllCleanAction, importAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import { callImporter } from "@/components/admin/ai-importer/call-importer";

const TONE: Record<QualityReport["state"], "success" | "warning" | "error" | "info"> = {
  PROCESSING: "info",
  NEEDS_CORRECTION: "error",
  READY_FOR_REVIEW: "warning",
  READY_FOR_APPROVAL: "info",
  APPROVED: "info",
  COMPLETED: "success",
  COMPLETED_WITH_WARNINGS: "warning",
};

function Stat({ label, value, tone, testId, hint }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" | "err"; testId: string; hint?: string }) {
  const color = tone === "ok" ? "text-[var(--color-success)]" : tone === "warn" ? "text-[var(--color-warning)]" : tone === "err" ? "text-[var(--color-error)]" : "";
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2.5" data-testid={testId} data-value={typeof value === "number" ? value : undefined}>
      <div className="text-xs text-[var(--color-muted-foreground)]">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      {hint ? <div className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</div> : null}
    </div>
  );
}

/**
 * The quality summary of an import (stored facts only) with the approval workflow:
 * review → approve → add the approved questions to the Question Bank as Draft.
 */
export function QualityPanel({
  jobId,
  report,
  canUse,
  jobStatus,
  files,
  runIds,
}: {
  jobId: string;
  report: QualityReport;
  canUse: boolean;
  jobStatus: string;
  files: { id: string; name: string; pageCount: number | null }[];
  runIds: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [missing, setMissing] = useState({ fileId: files[0]?.id ?? "", number: "", section: "", page: "1" });
  const r = report;
  const reviewable = ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"].includes(jobStatus);
  const act = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok: (d: T) => string) =>
    start(async () => {
      setMsg(null);
      const res = await callImporter(fn);
      setMsg(res.ok ? { ok: true, text: ok(res.data) } : { ok: false, text: res.error });
      if (res.ok) router.refresh();
    });
  const sequenceIssue = r.missing.length > 0 || (r.countDifference !== null && r.countDifference !== 0);

  return (
    <div className="flex flex-col gap-3" data-testid="quality-panel" data-state={r.state}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Quality summary</h3>
        <Badge variant={TONE[r.state]} data-testid="quality-state">
          {QUALITY_STATE_LABELS[r.state]}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Expected" value={r.expected ?? "—"} testId="q-expected" tone={r.expected === null ? "warn" : undefined} />
        <Stat label="Extracted" value={r.extracted} testId="q-extracted" hint={r.rejected ? `${r.rejected} rejected` : undefined} />
        <Stat label="Independently verified" value={r.verified} testId="q-verified" tone={r.verifyDisagreed ? "warn" : undefined} hint={r.verifyDisagreed ? `${r.verifyDisagreed} disagree` : r.unverified ? `${r.unverified} not verified` : undefined} />
        <Stat label="Approved" value={r.approved} testId="q-approved" hint={r.awaitingApproval ? `${r.awaitingApproval} awaiting approval` : undefined} />
        <Stat label="In Question Bank" value={r.stored} tone="ok" testId="q-stored" />
        <Stat label="Missing numbers" value={r.missing.length} tone={r.missing.length && !r.ackValid ? "err" : r.missing.length ? "warn" : undefined} testId="q-missing" />
        <Stat label="Duplicate candidates" value={r.duplicateCandidates} tone={r.duplicateCandidates ? "warn" : undefined} testId="q-duplicates" />
        <Stat label="Failed pages" value={r.pages.failed} tone={r.pages.failed ? "err" : undefined} testId="q-failed-pages" hint={`${r.pages.completed} of ${r.pages.total} pages done${r.pages.retrying ? ` · ${r.pages.retrying} retrying` : ""}`} />
        <Stat label="Needs correction" value={r.needsCorrection + r.importFailed} tone={r.needsCorrection + r.importFailed ? "err" : undefined} testId="q-needs-correction" />
        <Stat label="Image problems" value={r.imageIssues} tone={r.imageIssues ? "warn" : undefined} testId="q-images" />
        <Stat label="Answer key" value={`${r.answerKey.official} official`} testId="q-key" hint={`${r.answerKey.independentlyVerified} verified · ${r.answerKey.unverified} unverified · ${r.answerKey.missing} missing${r.answerKey.mismatch ? ` · ${r.answerKey.mismatch} mismatch` : ""}`} />
        <Stat label="Subject / topic uncertain" value={r.topicUncertain} tone={r.topicUncertain ? "warn" : undefined} testId="q-topics" />
      </div>
      {r.blockers.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--color-error)_45%,transparent)] p-3" role="alert" data-testid="quality-blockers">
          <p className="text-sm font-medium">Unresolved — the import cannot be completed until these are fixed or explained:</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {r.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      {r.warnings.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-[var(--color-warning)]" data-testid="quality-warnings">
          {r.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {canUse && reviewable && (
        <div className="flex flex-wrap items-center gap-2">
          <Link className="text-sm underline" href={`/admin/ai-importer/exceptions?job=${jobId}&status=all`} data-testid="qp-review-all">
            Review all questions
          </Link>
          <Link className="text-sm underline" href={`/admin/ai-importer/exceptions?job=${jobId}`} data-testid="qp-review-exceptions">
            Questions needing a decision
          </Link>
          {r.awaitingCleanApproval > 0 && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => approveAllCleanAction(jobId), (d) => `${d.approved} question(s) approved${d.refused.length ? `; ${d.refused.length} refused: ${d.refused.slice(0, 3).map((x) => `Q${x.label} (${x.reason})`).join(", ")}` : ""}.`)} data-testid="qp-approve-clean">
              Approve all questions without flags
            </Button>
          )}
          {r.approvedNotStored > 0 && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() => confirm(`Add the ${r.approvedNotStored} approved question(s) to the Question Bank as Draft? They stay unpublished until you publish them in the Question Bank.`) && act(() => importAction(jobId, "DRAFT", null), () => "Adding the approved questions to the Question Bank — this page updates by itself.")}
              data-testid="qp-store-approved"
            >
              Add {r.approvedNotStored} approved question(s) to the Question Bank
            </Button>
          )}
        </div>
      )}
      {r.stored > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="qp-open-bank">
          {runIds.map((id) => (
            <Link key={id} className="underline" href={`/admin/questions?qb=${encodeURIComponent(`importBatchId=${id}&page=1`)}`}>
              Open these questions in the Question Bank{runIds.length > 1 ? ` (batch ${id.slice(-6)})` : ""}
            </Link>
          ))}
        </div>
      )}

      {canUse && reviewable && sequenceIssue && (
        <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm" data-testid="qp-sequence">
          <summary className="cursor-pointer font-medium">Fix or explain the count difference</summary>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--color-muted-foreground)]">Add a question the extraction missed (empty, at its printed number and page) — then fill it in, re-scan it or reject it. Numbers are never changed to hide a gap.</p>
              <div className="flex flex-wrap items-end gap-2">
                {files.length > 1 && (
                  <SelectNative aria-label="Question paper" value={missing.fileId} onChange={(e) => setMissing((m) => ({ ...m, fileId: e.target.value }))}>
                    {files.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </SelectNative>
                )}
                <div className="flex flex-col gap-1">
                  <Label htmlFor="qp-mq-number">Number</Label>
                  <Input id="qp-mq-number" className="w-20" inputMode="numeric" value={missing.number} onChange={(e) => setMissing((m) => ({ ...m, number: e.target.value.replace(/\D/g, "") }))} data-testid="qp-mq-number" />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="qp-mq-section">Section</Label>
                  <Input id="qp-mq-section" className="w-20" placeholder="(none)" value={missing.section} onChange={(e) => setMissing((m) => ({ ...m, section: e.target.value.toUpperCase().slice(0, 3) }))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="qp-mq-page">Page</Label>
                  <Input id="qp-mq-page" className="w-20" inputMode="numeric" value={missing.page} onChange={(e) => setMissing((m) => ({ ...m, page: e.target.value.replace(/\D/g, "") }))} data-testid="qp-mq-page" />
                </div>
                <Button size="sm" variant="outline" disabled={pending || !missing.number || !missing.fileId} onClick={() => act(() => addMissingQuestionAction({ jobId, fileId: missing.fileId, number: Number(missing.number), section: missing.section, page: Number(missing.page) }), () => "Added. Open it to fill in the text, or re-scan its page.")} data-testid="qp-mq-add">
                  Add missing question
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--color-muted-foreground)]">Or explain the difference (e.g. a question withdrawn by the board). It is recorded and shown as a warning; it lapses if the counts change.</p>
              <Textarea rows={2} value={ackNote} onChange={(e) => setAckNote(e.target.value)} aria-label="Explanation" data-testid="qp-ack-note" />
              <div>
                <Button size="sm" variant="outline" disabled={pending || ackNote.trim().length < 5} onClick={() => act(() => acknowledgeSequenceAction(jobId, ackNote), () => "Explanation recorded.")} data-testid="qp-ack">
                  Record explanation
                </Button>
              </div>
            </div>
          </div>
        </details>
      )}
      {msg && (
        <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="qp-msg">
          {msg.text}
        </p>
      )}
    </div>
  );
}
