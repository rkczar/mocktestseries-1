"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { ANSWER_STATUS_LABELS, CHUNK_BYTES, JOB_STATUS_LABELS, formatBytes } from "@/lib/ai-import/config";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import type { JobSummary } from "@/lib/ai-import/summary";
import { JobContextFields, type ExamOption } from "../../new-import-form";
import { analyzeJobAction, cancelJobAction, confirmJobAction, discardUploadAction, importAction, pauseJobAction, resumeJobAction } from "../../actions";

export interface JobView {
  id: string;
  title: string;
  status: string;
  examId: string;
  examName: string;
  paperType: string;
  subjectId: string | null;
  year: number | null;
  paperCode: string | null;
  previousYearPaperId: string | null;
  budgetInr: number;
  spentInr: number;
  estCostInr: number | null;
  pauseReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  analysis: JobAnalysis | null;
  files: { id: string; name: string; role: string; status: string; bytes: number; pages: number | null; error: string | null; kind: string | null; identicalTo: string | null; paperFileId: string | null; keyEntries: number | null }[];
  events: { id: string; at: string; type: string; message: string }[];
  summary: JobSummary;
  lastImport: { mode: string; result: Record<string, number>; finishedAt: string } | null;
  runIds: string[];
  aiEnabled: boolean;
  allowUnverified: boolean;
}

const BUSY = ["ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"];
const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);

export function statusVariant(s: string): "success" | "warning" | "error" | "info" | "neutral" | "primary" {
  if (s === "COMPLETED" || s === "PUBLISHED" || s === "OFFICIAL_MATCHED" || s === "READY") return "success";
  if (s === "FAILED" || s === "CANCELLED" || s === "REJECTED" || s === "IMPORT_FAILED" || s === "KEY_MISMATCH" || s === "NOT_IMPORTABLE") return "error";
  if (s.startsWith("PAUSED") || s === "NEEDS_CORRECTION" || s === "COMPLETED_WITH_ISSUES" || s === "UNVERIFIED" || s === "AMBIGUOUS_MAPPING" || s === "WITHDRAWN" || s === "DUPLICATE" || s === "KEY_MISSING") return "warning";
  if (BUSY.includes(s)) return "info";
  return "neutral";
}

function Uploader({ jobId, files, canAddPapers }: { jobId: string; files: JobView["files"]; canAddPapers: boolean }) {
  const router = useRouter();
  const [role, setRole] = useState<"PAPER" | "ANSWER_KEY">(canAddPapers ? "PAPER" : "ANSWER_KEY");
  const [paperFileId, setPaperFileId] = useState("");
  const [progress, setProgress] = useState<{ name: string; pct: number; msg?: string; error?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const papers = files.filter((f) => f.role === "PAPER" && f.status !== "REJECTED");

  async function upload(list: FileList) {
    setBusy(true);
    const items = Array.from(list);
    setProgress(items.map((f) => ({ name: f.name, pct: 0 })));
    for (const [i, file] of items.entries()) {
      const set = (p: Partial<{ pct: number; msg: string; error: boolean }>) => setProgress((cur) => cur.map((x, k) => (k === i ? { ...x, ...p } : x)));
      try {
        const start = await fetch("/api/admin/ai-importer/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, name: file.name, size: file.size, role, paperFileId: role === "ANSWER_KEY" ? paperFileId || null : null }) });
        const s = await start.json();
        if (!start.ok) {
          set({ error: true, msg: s.error ?? "Refused" });
          continue;
        }
        for (let c = 0; c < s.chunks; c++) {
          const blob = file.slice(c * CHUNK_BYTES, Math.min(file.size, (c + 1) * CHUNK_BYTES));
          let ok = false;
          for (let attempt = 0; attempt < 3 && !ok; attempt++) {
            const r = await fetch(`/api/admin/ai-importer/files/${s.fileId}/chunks/${c}`, { method: "PUT", body: blob });
            ok = r.ok;
            if (!ok && r.status < 500) {
              set({ error: true, msg: (await r.json().catch(() => ({}))).error ?? "Upload refused" });
              break;
            }
          }
          if (!ok) throw new Error("A part of the file could not be uploaded.");
          set({ pct: Math.round(((c + 1) / s.chunks) * 95) });
        }
        const done = await fetch(`/api/admin/ai-importer/files/${s.fileId}/complete`, { method: "POST" });
        const d = await done.json();
        if (!done.ok || !d.ok) set({ error: true, pct: 100, msg: d.reason ?? d.error ?? "Refused" });
        else set({ pct: 100, msg: `${String(d.kind).toUpperCase()}${d.pageCount ? ` · ${d.pageCount} page(s)` : ""}${d.duplicateOf ? " · identical to an earlier upload (stored once)" : ""}` });
      } catch (e) {
        set({ error: true, msg: e instanceof Error ? e.message : "Upload failed" });
      }
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3" data-testid="uploader">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-role">File type</Label>
          <SelectNative id="ai-role" value={role} onChange={(e) => setRole(e.target.value as "PAPER" | "ANSWER_KEY")} data-testid="upload-role">
            {canAddPapers && <option value="PAPER">Question paper</option>}
            <option value="ANSWER_KEY">Answer key</option>
          </SelectNative>
        </div>
        {role === "ANSWER_KEY" && papers.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-key-paper">Answer key belongs to</Label>
            <SelectNative id="ai-key-paper" value={paperFileId} onChange={(e) => setPaperFileId(e.target.value)}>
              <option value="">Select the paper…</option>
              {papers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectNative>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-files">Files (PDF, JPG, PNG, DOCX, XLSX, CSV)</Label>
          <input
            ref={input}
            id="ai-files"
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv"
            disabled={busy || (role === "ANSWER_KEY" && papers.length > 1 && !paperFileId)}
            onChange={(e) => e.target.files?.length && upload(e.target.files)}
            className="text-sm"
            data-testid="upload-input"
          />
        </div>
      </div>
      {progress.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="upload-progress">
          {progress.map((p, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="h-1.5 w-32 overflow-hidden rounded bg-[var(--color-border)]">
                <span className="block h-full bg-[var(--color-primary)]" style={{ width: `${p.pct}%` }} />
              </span>
              <span className={p.error ? "text-[var(--color-error)]" : "text-[var(--color-muted-foreground)]"}>{p.msg ?? `${p.pct}%`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "warn" | "ok" | "err" }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
      <div className="text-xs text-[var(--color-muted-foreground)]">{label}</div>
      <div className={`text-lg font-semibold ${tone === "warn" ? "text-[var(--color-warning)]" : tone === "err" ? "text-[var(--color-error)]" : tone === "ok" ? "text-[var(--color-success)]" : ""}`}>{value}</div>
    </div>
  );
}

export function JobWorkspace({ job, exams, canUse, canPublish }: { job: JobView; exams: ExamOption[]; canUse: boolean; canPublish: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [budget, setBudget] = useState(String(job.budgetInr));
  const [ctx, setCtx] = useState({ examId: job.examId, paperType: job.paperType, subjectId: job.subjectId ?? "", year: job.year ? String(job.year) : "", paperCode: job.paperCode ?? "", previousYearPaperId: job.previousYearPaperId ?? "" });
  const busy = BUSY.includes(job.status);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [busy, router]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed");
      else {
        if (ok) setNotice(ok);
        router.refresh();
      }
    });

  const s = job.summary;
  const a = job.analysis;
  const editable = job.status === "DRAFT" || job.status === "AWAITING_CONFIRMATION";
  const canImport = ["NEEDS_REVIEW", "COMPLETED_WITH_ISSUES", "COMPLETED"].includes(job.status);

  return (
    <div className="flex flex-col gap-4" data-testid="job-workspace">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{job.title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {job.examName} · {job.paperType.replace(/_/g, " ").toLowerCase()} · created {job.createdAt}
          </p>
        </div>
        <Badge variant={statusVariant(job.status)} data-testid="job-status">
          {JOB_STATUS_LABELS[job.status] ?? job.status}
        </Badge>
      </div>
      {(job.pauseReason || job.errorMessage) && (
        <Card>
          <CardContent className="py-3 text-sm text-[var(--color-warning)]" data-testid="job-alert">
            {job.pauseReason ?? job.errorMessage}
          </CardContent>
        </Card>
      )}
      {error && <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="job-error">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-success)]" data-testid="job-notice">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
          <CardDescription>Question papers and their answer keys. Each file is checked by its content (not its name) and kept privately in the Original Paper Vault.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <table className="w-full text-left text-sm" data-testid="files-table">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">File</th>
                <th className="py-1 pr-2 font-medium">Type</th>
                <th className="py-1 pr-2 font-medium">Size</th>
                <th className="py-1 pr-2 font-medium">Pages</th>
                <th className="py-1 pr-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {job.files.map((f) => (
                <tr key={f.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-2">
                    {f.name}
                    {f.identicalTo && <span className="block text-xs text-[var(--color-muted-foreground)]">Identical to “{f.identicalTo}” — stored once</span>}
                  </td>
                  <td className="py-1.5 pr-2">{f.role === "PAPER" ? "Question paper" : `Answer key${f.keyEntries !== null ? ` · ${f.keyEntries} entries` : ""}`}</td>
                  <td className="py-1.5 pr-2">{formatBytes(f.bytes)}</td>
                  <td className="py-1.5 pr-2">{f.pages ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    <Badge variant={f.status === "REJECTED" ? "error" : f.status === "UPLOADING" ? "warning" : "neutral"}>{f.status.toLowerCase()}</Badge>
                    {f.error && <span className="block text-xs text-[var(--color-error)]">{f.error}</span>}
                    {canUse && (f.status === "UPLOADING" || f.status === "REJECTED") && (
                      <button type="button" className="ml-2 text-xs underline" onClick={() => act(() => discardUploadAction(f.id))}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!job.files.length && (
                <tr>
                  <td colSpan={5} className="py-3 text-[var(--color-muted-foreground)]">
                    No files yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {canUse && job.status !== "CANCELLED" && !["PROCESSING", "IMPORTING", "ANALYZING"].includes(job.status) && <Uploader jobId={job.id} files={job.files} canAddPapers={editable} />}
          {canUse && editable && (
            <div>
              <Button onClick={() => act(() => analyzeJobAction(job.id), "Analysis started — this takes a few seconds per file.")} disabled={pending || !job.files.some((f) => f.role === "PAPER" && f.status !== "REJECTED" && f.status !== "UPLOADING")} data-testid="analyze">
                {job.status === "AWAITING_CONFIRMATION" ? "Analyze again" : "Analyze files (free)"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {a && (
        <Card data-testid="analysis-report">
          <CardHeader>
            <CardTitle>Analysis report</CardTitle>
            <CardDescription>
              <strong>Detected</strong> values were measured locally from the files. <strong>Estimated</strong> values (cost, time) come from current model prices and are not charges.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Detected · pages" value={a.totals.pages} />
              <Stat label="Detected · text pages" value={a.totals.textPages} />
              <Stat label="Detected · scanned pages" value={a.totals.scannedPages} tone={a.totals.scannedPages ? "warn" : undefined} />
              <Stat label="Detected · questions (local)" value={a.totals.localQuestions} />
              <Stat label="Detected · embedded images" value={a.totals.embeddedImages} />
              <Stat label="Estimated · questions" value={a.estimate.expectedQuestions} />
            </div>
            {a.files.map((f) => (
              <div key={f.fileId} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="analysis-file">
                <div className="font-medium">
                  {f.name} <span className="text-xs text-[var(--color-muted-foreground)]">({f.role === "PAPER" ? "question paper" : "answer key"})</span>
                </div>
                {f.error && <p className="text-[var(--color-error)]">{f.error}</p>}
                {f.facts && (
                  <ul className="mt-1 grid gap-x-6 gap-y-0.5 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-2">
                    <li>Format: {f.facts.kind} · document type: {f.facts.documentType.replace(/_/g, " ").toLowerCase()}</li>
                    <li>Pages: {f.facts.pages} ({f.facts.textPages} text, {f.facts.scannedPages} scanned, {f.facts.blankPages} blank)</li>
                    <li>Questions recognized locally: {f.facts.localQuestionCount}</li>
                    <li>Answer key present: {f.facts.answerKeyDetected ? "yes (detected)" : "not detected"}</li>
                    <li>Formulas / scientific notation: {f.facts.formulasLikely ? "likely" : "not detected"} · tables: {f.facts.tablesLikely ? "likely" : "not detected"}</li>
                    <li>Question types noticed: {Object.entries(f.facts.questionTypes).map(([k, v]) => `${k} ×${v}`).join(", ") || "standard MCQ"}</li>
                    {f.facts.notes.map((n, i) => (
                      <li key={i} className="text-[var(--color-warning)] sm:col-span-2">
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <div className="flex flex-col gap-2" data-testid="estimate">
              <div className="font-medium">Estimated AI cost</div>
              <table className="w-full text-left text-xs">
                <thead className="text-[var(--color-muted-foreground)]">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Step</th>
                    <th className="py-1 pr-2 font-medium">Model</th>
                    <th className="py-1 pr-2 font-medium">Calls</th>
                    <th className="py-1 pr-2 font-medium">Tokens in / out</th>
                    <th className="py-1 pr-2 font-medium">Price ($/M in · out)</th>
                    <th className="py-1 pr-2 font-medium">Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {a.estimate.lines.map((l, i) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-2">{l.label}</td>
                      <td className="py-1 pr-2">{l.model ?? "—"}</td>
                      <td className="py-1 pr-2">{l.calls}</td>
                      <td className="py-1 pr-2">
                        {l.inputTokens.toLocaleString("en-IN")} / {l.outputTokens.toLocaleString("en-IN")}
                      </td>
                      <td className="py-1 pr-2">{l.pricePerM ? `${l.pricePerM.prompt.toFixed(3)} · ${l.pricePerM.completion.toFixed(3)}` : l.calls ? <span className="text-[var(--color-warning)]">{l.problem}</span> : "—"}</td>
                      <td className="py-1 pr-2">{l.calls ? inr(l.inr) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Estimated total: <strong data-testid="estimate-total">{inr(a.estimate.totalInr)}</strong> (includes a {a.estimate.reservePct}% reserve for retries) · per AI page {inr(a.estimate.perPageInr)} · per question {inr(a.estimate.perQuestionInr)} · {a.estimate.pagesNeedingAi} page(s) need AI · about {a.estimate.estimatedMinutes} min.
              </p>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Prices synced {a.estimate.pricesSyncedAt ? a.estimate.pricesSyncedAt.slice(0, 10) : "—"} · USD→INR {a.estimate.fxRate ?? "—"} ({a.estimate.fxDate ?? "—"}) · computed {a.estimate.computedAt.slice(0, 16).replace("T", " ")} UTC
              </p>
              {a.estimate.notes.map((n, i) => (
                <p key={i} className="text-xs text-[var(--color-warning)]">
                  {n}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {job.status === "AWAITING_CONFIRMATION" && canUse && (
        <Card data-testid="confirm-card">
          <CardHeader>
            <CardTitle>Confirm and start processing</CardTitle>
            <CardDescription>Correct the exam context if needed. Paid AI calls stay within the job budget; the job pauses before exceeding it.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <JobContextFields exams={exams} value={ctx} onChange={(v) => setCtx((c) => ({ ...c, ...v }))} />
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="ai-confirm-budget">Job budget (₹)</Label>
              <Input id="ai-confirm-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} data-testid="confirm-budget" />
              {a?.estimate.totalInr !== null && a?.estimate.totalInr !== undefined && Number(budget) < a.estimate.totalInr && <p className="text-xs text-[var(--color-warning)]">The budget is below the estimate; the job will pause when it is reached.</p>}
            </div>
            <div className="flex gap-2">
              <Button disabled={pending} onClick={() => act(() => confirmJobAction(job.id, { title: job.title, ...ctx, year: ctx.year || null, subjectId: ctx.subjectId || null, previousYearPaperId: ctx.previousYearPaperId || null, paperCode: ctx.paperCode || null, budgetInr: Number(budget) }), "Processing queued.")} data-testid="confirm-start">
                {job.aiEnabled ? "Confirm and start processing" : "Confirm and start (local reading only)"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {job.status !== "DRAFT" && job.status !== "AWAITING_CONFIRMATION" && job.status !== "ANALYZING" && (
        <Card data-testid="progress-card">
          <CardHeader>
            <CardTitle>Progress and batch summary</CardTitle>
            <CardDescription>
              Pages {s.pages.done}/{s.pages.total} done{s.pages.pending ? ` · ${s.pages.pending} pending` : ""}
              {s.pages.failed ? ` · ${s.pages.failed} failed` : ""}
              {s.pages.skipped ? ` · ${s.pages.skipped} need AI (switched off)` : ""} · AI spend {inr(job.spentInr)} of {inr(job.budgetInr)} budget
              {job.estCostInr !== null ? ` (estimate ${inr(job.estCostInr)})` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" data-testid="batch-summary">
              <Stat label="Questions extracted" value={s.extracted} />
              <Stat label="Eligible for import" value={s.eligibleImport} />
              <Stat label="Imported" value={s.imported} tone={s.imported ? "ok" : undefined} />
              <Stat label="Eligible for publishing" value={s.eligiblePublish} />
              <Stat label="Published" value={s.published} tone={s.published ? "ok" : undefined} />
              <Stat label="Need correction" value={s.needsCorrection} tone={s.needsCorrection ? "warn" : undefined} />
              <Stat label="Duplicates (skipped)" value={s.duplicates} tone={s.duplicates ? "warn" : undefined} />
              <Stat label="Not importable (schema)" value={s.notImportable} tone={s.notImportable ? "err" : undefined} />
              <Stat label="Unverified answers" value={s.unverifiedAnswers} tone={s.unverifiedAnswers ? "warn" : undefined} />
              <Stat label="Image issues" value={s.imageIssues} tone={s.imageIssues ? "warn" : undefined} />
              <Stat label="Rejected" value={s.rejected} />
              <Stat label="Import failed" value={s.importFailed} tone={s.importFailed ? "err" : undefined} />
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-[var(--color-muted-foreground)]">
              {Object.entries(s.answerStatus).map(([k, v]) => (
                <Badge key={k} variant={statusVariant(k)}>
                  {ANSWER_STATUS_LABELS[k] ?? k}: {v}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className="text-sm underline" href={`/admin/ai-importer/exceptions?job=${job.id}`} data-testid="exceptions-link">
                Review exceptions ({s.needsCorrection + s.notImportable + s.duplicates + s.importFailed})
              </Link>
              <Link className="text-sm underline" href={`/admin/ai-importer/exceptions?job=${job.id}&status=all`}>
                All questions
              </Link>
              <Link className="text-sm underline" href={`/admin/ai-importer/answers?job=${job.id}`}>
                Answer keys & verification
              </Link>
              {job.runIds.map((r) => (
                <Link key={r} className="text-sm underline" href={`/admin/questions/bulk-import/history/${r}`}>
                  Bulk Import run {r.slice(-6)}
                </Link>
              ))}
            </div>
            {canUse && (
              <div className="flex flex-wrap gap-2">
                {(job.status === "QUEUED" || job.status === "PROCESSING") && (
                  <Button variant="outline" disabled={pending} onClick={() => act(() => pauseJobAction(job.id), "Paused.")} data-testid="pause">
                    Pause
                  </Button>
                )}
                {(job.status === "PAUSED" || job.status === "PAUSED_BUDGET" || job.status === "FAILED") && (
                  <>
                    <Input className="w-32" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Job budget" data-testid="resume-budget" />
                    <Button disabled={pending} onClick={() => act(() => resumeJobAction(job.id, Number(budget)), "Resumed.")} data-testid="resume">
                      Resume{job.status === "PAUSED_BUDGET" ? " with this budget" : ""}
                    </Button>
                  </>
                )}
                {job.status !== "CANCELLED" && job.status !== "IMPORTING" && job.status !== "COMPLETED" && (
                  <Button variant="outline" disabled={pending} onClick={() => confirm("Cancel this import? Questions already imported stay in the Question Bank.") && act(() => cancelJobAction(job.id), "Cancelled.")} data-testid="cancel">
                    Cancel import
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canImport && canUse && (
        <Card data-testid="import-card">
          <CardHeader>
            <CardTitle>Import into the Question Bank</CardTitle>
            <CardDescription>
              Questions go through the existing Bulk Import (validation, duplicate check, Import History, rollback). Questions that fail a mandatory check are isolated in Review Exceptions; the rest proceed.
              {job.allowUnverified ? " Policy: questions without an official key may be published with their answer marked UNVERIFIED." : " Policy: answers without an official key or independent verification are imported as drafts only."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button disabled={pending || !s.eligibleImport} onClick={() => act(() => importAction(job.id, "DRAFT", null), "Import started.")} data-testid="import-draft">
              Import as Draft ({s.eligibleImport})
            </Button>
            {canPublish && (
              <Button
                variant="outline"
                disabled={pending || (!s.eligibleImport && !s.eligiblePublish)}
                onClick={() => confirm("Import and publish every question that passes all automated checks? Students will see published questions.") && act(() => importAction(job.id, "PUBLISH_ALL", null), "Import & publish started.")}
                data-testid="import-publish-all"
              >
                Import &amp; Publish All Eligible
              </Button>
            )}
            {canPublish && (
              <Link className="self-center text-sm underline" href={`/admin/ai-importer/exceptions?job=${job.id}&status=all`} data-testid="publish-selected-link">
                Import &amp; Publish Selected…
              </Link>
            )}
            {job.lastImport && (
              <p className="w-full text-xs text-[var(--color-muted-foreground)]" data-testid="last-import">
                Last import ({job.lastImport.mode.replace(/_/g, " ").toLowerCase()}, {job.lastImport.finishedAt.slice(0, 16).replace("T", " ")} UTC): {Object.entries(job.lastImport.result).map(([k, v]) => `${k} ${v}`).join(" · ")}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Every step, pause, retry, import and cleanup of this job (newest first).</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-xs" data-testid="job-events">
            {job.events.map((e) => (
              <li key={e.id}>
                <span className="text-[var(--color-muted-foreground)]">{e.at}</span> · <span className="font-medium">{e.type.replace(/_/g, " ").toLowerCase()}</span> — {e.message}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
