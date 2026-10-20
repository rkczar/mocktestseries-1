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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ANSWER_STATUS_LABELS, CHUNK_BYTES, JOB_STATUS_LABELS, SELECTION_TASKS, SELECTION_TASK_LABELS, fileRemovalBlockedReason, formatBytes, statusVariant } from "@/lib/ai-import/config";
import type { ModelPlan } from "@/lib/ai-import/selection-types";
import type { ResetCheck } from "@/lib/ai-import/jobs";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import type { JobSummary } from "@/lib/ai-import/summary";
import { JobControls, type JobControlState } from "@/components/admin/ai-importer/job-controls";
import { JobContextFields, type ExamOption } from "../../new-import-form";
import { analyzeJobAction, confirmJobAction, discardUploadAction, importAction, pauseJobAction, removeFileAction, resetJobAction, resumeJobAction } from "../../actions";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { confirmBudgetCheck, resumeBudgetCheck, type BudgetCheck, type BudgetLimits } from "@/lib/ai-import/budget-check";

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
  /** Hard limit per job (Import Settings): confirm and resume refuse a larger budget. */
  maxJobInr: number;
  /** Every budget limit that applies at confirm / resume, and what is left of the importer's budgets. */
  budgetLimits: BudgetLimits;
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
  /** The model plan frozen when the job was confirmed (null: not confirmed, or confirmed before automatic selection). */
  plan: ModelPlan | null;
  /** Safe reset to editable: every server-side check (null when the status can never be reset). */
  reset: { allowed: boolean; checks: ResetCheck[] } | null;
  canManage: boolean;
  /** Cancel / Retry / Start again / Delete, as allowed now (shared with the Import and Imports pages). */
  controls: JobControlState;
  plainLabel: string;
  nextAction: string;
}

const BUSY = ["ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"];
const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);


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

type JobFile = JobView["files"][number];

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" className="mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
const roleLabel = (role: string) => (role === "PAPER" ? "Question paper" : "Answer key");

/** Confirmation for removing one uploaded file; stays open with the server's reason when the removal is refused. */
function RemoveFileDialog({ jobId, file, analyzed, onClose, onRemoved }: { jobId: string; file: JobFile; analyzed: boolean; onClose: () => void; onRemoved: (message: string) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const remove = () =>
    start(async () => {
      setError(null);
      const r = await callImporter(() => removeFileAction(jobId, file.id));
      if (!r.ok) return setError(r.error);
      const d = r.data;
      onRemoved(
        `Removed “${d.name}” (${roleLabel(d.role).toLowerCase()}).${d.analysisCleared ? " The analysis was cleared — analyze the files again before confirming." : ""} Upload the correct ${d.role === "PAPER" ? "question paper" : "answer key"} below if needed.${d.warning ? ` ${d.warning}` : ""}`
      );
    });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent data-testid="remove-file-dialog">
        <DialogHeader>
          <DialogTitle>Remove this file?</DialogTitle>
          <DialogDescription>It is removed from this import only. Files of other imports and questions already in the Question Bank are never touched.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
          <dt className="text-[var(--color-muted-foreground)]">File</dt>
          <dd className="break-all font-medium" data-testid="remove-file-name">{file.name}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Type</dt>
          <dd data-testid="remove-file-type">{roleLabel(file.role)}{file.kind ? ` · ${file.kind.toUpperCase()}` : ""}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Size</dt>
          <dd>{formatBytes(file.bytes)}{file.pages ? ` · ${file.pages} page${file.pages === 1 ? "" : "s"}` : ""}</dd>
        </dl>
        <ul className="mt-3 list-disc pl-5 text-xs text-[var(--color-muted-foreground)]">
          {analyzed && <li>The analysis report and cost estimate are cleared; analyze the files again before confirming.</li>}
          <li>The stored copy is deleted unless another upload uses the identical file.</li>
          <li>The removal is recorded in the activity log.</li>
        </ul>
        {error && <p className="mt-3 text-sm text-[var(--color-error)]" role="alert" data-testid="remove-file-error">{error}</p>}
        <DialogFooter className="flex-wrap">
          <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
            Keep file
          </Button>
          <Button variant="danger" size="sm" disabled={pending} onClick={remove} data-testid="remove-file-confirm">
            {pending ? "Removing…" : "Remove file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The models a confirmed job uses (frozen at confirmation), with the reason for each. */
function PlanCard({ plan }: { plan: ModelPlan }) {
  return (
    <Card data-testid="plan-card">
      <CardHeader>
        <CardTitle>Models for this job</CardTitle>
        <CardDescription>
          {plan.mode === "auto" ? "Chosen automatically" : "Manual override"} at confirmation ({plan.computedAt.slice(0, 16).replace("T", " ")} UTC) from OpenRouter prices and routes read {plan.routesFetchedAt ? plan.routesFetchedAt.slice(0, 16).replace("T", " ") : "—"} UTC; fixed for this job. {plan.privacy.zdr ? "Zero-Data-Retention routes only." : "ZDR not required."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-sm">
          {SELECTION_TASKS.map((t) => {
            const c = plan.tasks[t];
            return (
              <li key={t} data-testid={`plan-${t}`} data-model={c.model ?? ""}>
                <span className="font-medium">{SELECTION_TASK_LABELS[t]}:</span> {c.model ? <code className="text-xs">{c.model}</code> : <span className="italic text-[var(--color-muted-foreground)]">none</span>}
                {c.model && <span className="text-xs text-[var(--color-muted-foreground)]"> · up to {inr(c.maxInr)} per request</span>}
                <span className="block text-xs text-[var(--color-muted-foreground)]">{c.reason}</span>
                {c.replaced && <span className="block text-xs text-[var(--color-warning)]" data-testid={`plan-${t}-replaced`}>Replaced {c.replaced.from} at {c.replaced.at.slice(0, 16).replace("T", " ")} UTC: {c.replaced.why}</span>}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Safe reset of a processed job that produced nothing: every check is shown; the button appears only when all pass. */
function ResetCard({ jobId, reset, canManage, onDone }: { jobId: string; reset: { allowed: boolean; checks: ResetCheck[] }; canManage: boolean; onDone: (message: string) => void }) {
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card data-testid="reset-card" data-allowed={reset.allowed ? "true" : "false"}>
      <CardHeader>
        <CardTitle>Reset to editable</CardTitle>
        <CardDescription>
          A processed import that produced nothing — zero questions, ₹0 AI spend, nothing imported — can return to Uploading so its files can be removed or replaced and analyzed again. The server re-checks every condition inside one locked transaction; the reset is audited.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <ul className="flex flex-col gap-1" data-testid="reset-checks">
          {reset.checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2" data-testid="reset-check" data-ok={c.ok ? "true" : "false"}>
              <Badge variant={c.ok ? "success" : "error"}>{c.ok ? "OK" : "No"}</Badge>
              <span>
                <span className="font-medium">{c.label}</span> <span className="text-xs text-[var(--color-muted-foreground)]">— {c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        {!reset.allowed && (
          <p className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]" data-testid="reset-refused">
            This import cannot be reset, and it is kept unchanged as a record. To use different files: create a <Link className="underline" href="/admin/ai-importer">New Import</Link> with the same exam context, upload the correct question paper (and answer key), analyze it, check the models and maximum cost, then confirm. Cancel this import only if you no longer need it as a record.
          </p>
        )}
        {reset.allowed && canManage && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="reset-confirm">Type RESET to confirm</Label>
              <Input id="reset-confirm" className="w-32" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="reset-confirm" />
            </div>
            <Button
              variant="outline"
              disabled={pending || typed !== "RESET"}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await callImporter(() => resetJobAction(jobId, typed));
                  if (!r.ok) setError(r.error);
                  else onDone("The import is editable again: remove or replace files, then analyze them again before confirming.");
                })
              }
              data-testid="reset-submit"
            >
              {pending ? "Resetting…" : "Reset to editable"}
            </Button>
          </div>
        )}
        {reset.allowed && !canManage && <p className="text-xs text-[var(--color-muted-foreground)]">Only a Master Admin can reset an import.</p>}
        {error && <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="reset-error">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** Every figure the job budget is checked against, each named separately. */
function BudgetLimitsPanel({ limits: l, estimate }: { limits: BudgetLimits; estimate: JobAnalysis["estimate"] | null }) {
  const rows: [string, string, string][] = [
    ["Current estimated cost", estimate ? inr(estimate.totalInr) : "₹0.00 (no paid AI)", "limit-estimate"],
    ["Conservative maximum cost", estimate ? inr(estimate.maxInr) : "₹0.00 (no paid AI)", "limit-max"],
    ["Hard limit per job", `${inr(l.maxJobInr)} (Import Settings)`, "limit-job"],
    ["Limit per AI request", `${inr(l.maxRequestInr)} (models above it are never chosen)`, "limit-request"],
    ["All-time importer budget left", `${inr(Math.max(0, l.allTimeLeftInr))} of ${inr(l.totalCapInr)}`, "limit-alltime"],
    ["This month's importer budget left", `${inr(Math.max(0, l.monthLeftInr))} of ${inr(l.monthCapInr)}`, "limit-month"],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="confirm-limits">
      {rows.map(([k, v, id]) => (
        <div key={id} data-testid={id}>
          <dt className="inline text-[var(--color-muted-foreground)]">{k}: </dt>
          <dd className="inline font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Why the entered budget would be refused (every reason), or the range that would be accepted. */
function BudgetFeedback({ check, id, testId }: { check: BudgetCheck; id: string; testId: string }) {
  if (check.problems.length === 0)
    return (
      <p id={id} className="text-xs text-[var(--color-success)]" data-testid={`${testId}-budget-ok`}>
        This budget is within every limit. The server checks it again, with fresh prices, when you click.
      </p>
    );
  return (
    <div id={id} className="flex flex-col gap-1 text-xs text-[var(--color-error)]" data-testid={`${testId}-budget-problems`}>
      <p className="font-medium">Cannot start with this budget:</p>
      <ul className="list-disc pl-4">
        {check.problems.map((p) => (
          <li key={p} data-testid={`${testId}-budget-problem`}>
            {p}
          </li>
        ))}
      </ul>
      {check.impossible ? (
        <p className="text-[var(--color-foreground)]" data-testid={`${testId}-budget-impossible`}>
          Changing the budget cannot fix this. Process fewer pages (for example a 2-page sample file), or ask a Master Admin to review the limits in Import Settings.
        </p>
      ) : check.range ? (
        <p className="text-[var(--color-foreground)]" data-testid={`${testId}-budget-range`}>
          Accepted: {check.range.minInr > 0 ? `at least ${inr(check.range.minInr)} and ` : ""}at most {inr(check.range.maxInr)}.
        </p>
      ) : null}
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
  // A refusal of Confirm / Resume is shown next to that button (the page-level message is far above it).
  const [inlineError, setInlineError] = useState<{ at: "confirm" | "resume"; text: string } | null>(null);
  const [ctx, setCtx] = useState({ examId: job.examId, paperType: job.paperType, subjectId: job.subjectId ?? "", year: job.year ? String(job.year) : "", paperCode: job.paperCode ?? "", previousYearPaperId: job.previousYearPaperId ?? "" });
  const [removing, setRemoving] = useState<JobFile | null>(null);
  const busy = BUSY.includes(job.status);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [busy, router]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string, at?: "confirm" | "resume") =>
    start(async () => {
      setError(null);
      setNotice(null);
      setInlineError(null);
      const r = await callImporter(fn);
      if (!r.ok) {
        if (at) setInlineError({ at, text: r.error ?? "Failed" });
        else setError(r.error ?? "Failed");
      } else {
        if (ok) setNotice(ok);
        router.refresh();
      }
    });

  const s = job.summary;
  const a = job.analysis;
  // Recomputed on every keystroke: the same rules the server applies at confirm / resume.
  const confirmCheck = confirmBudgetCheck({ raw: budget, aiEnabled: job.aiEnabled, estimate: a?.estimate ?? null, limits: job.budgetLimits });
  const resumeCheck = resumeBudgetCheck({ raw: budget, currentInr: job.budgetInr, spentInr: job.spentInr, maxJobInr: job.maxJobInr, budgetPaused: job.status === "PAUSED_BUDGET" });
  const editable = job.status === "DRAFT" || job.status === "AWAITING_CONFIRMATION";
  const canImport = ["NEEDS_REVIEW", "COMPLETED_WITH_ISSUES", "COMPLETED"].includes(job.status);
  const removalBlocked = fileRemovalBlockedReason(job.status);
  const stored = job.files.filter((f) => f.status !== "UPLOADING" && f.status !== "REJECTED");
  const totals = { papers: stored.filter((f) => f.role === "PAPER").length, keys: stored.filter((f) => f.role === "ANSWER_KEY").length, pages: stored.filter((f) => f.role === "PAPER").reduce((n, f) => n + (f.pages ?? 0), 0) };
  const linkedKeys = (f: JobFile) => (f.role === "PAPER" ? job.files.filter((k) => k.role === "ANSWER_KEY" && k.paperFileId === f.id) : []);

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
      <p className="text-sm" data-testid="job-next-action">
        <span className="font-medium" data-testid="job-plain-status">{job.plainLabel}.</span> <span className="font-medium">Next: </span>
        {job.nextAction}
      </p>
      {canUse && (
        <JobControls
          job={job.controls}
          onDeleted={() => router.replace("/admin/ai-importer/jobs")}
          onMessage={(m) => {
            setError(m.error ? m.text : null);
            setNotice(m.error ? null : m.text);
          }}
        />
      )}
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="files-table">
              <thead className="text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th className="py-1 pr-2 font-medium">File</th>
                  <th className="py-1 pr-2 font-medium">Type</th>
                  <th className="hidden py-1 pr-2 font-medium sm:table-cell">Size</th>
                  <th className="hidden py-1 pr-2 font-medium sm:table-cell">Pages</th>
                  <th className="hidden py-1 pr-2 font-medium sm:table-cell">Status</th>
                  {canUse && <th className="py-1 text-right font-medium">Action</th>}
                </tr>
              </thead>
              <tbody>
                {job.files.map((f) => {
                  const unfinished = f.status === "UPLOADING" || f.status === "REJECTED";
                  const keys = linkedKeys(f);
                  const blocked = unfinished ? null : removalBlocked ?? (keys.length ? `Remove its answer key${keys.length === 1 ? "" : "s"} first.` : null);
                  return (
                    <tr key={f.id} className="border-t border-[var(--color-border)] align-top" data-testid="file-row" data-file-id={f.id}>
                      <td className="py-1.5 pr-2 sm:max-w-[16rem]">
                        <span className="font-medium [overflow-wrap:anywhere]" data-testid="file-name">{f.name}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-muted-foreground)] sm:hidden">
                          <span>
                            {formatBytes(f.bytes)}
                            {f.pages ? ` · ${f.pages} page${f.pages === 1 ? "" : "s"}` : ""}
                          </span>
                          <Badge variant={f.status === "REJECTED" ? "error" : f.status === "UPLOADING" ? "warning" : "neutral"}>{f.status.toLowerCase()}</Badge>
                        </span>
                        {f.error && <span className="block text-xs text-[var(--color-error)] sm:hidden">{f.error}</span>}
                        {f.identicalTo && <span className="block text-xs text-[var(--color-muted-foreground)]">Identical to “{f.identicalTo}” — stored once</span>}
                      </td>
                      <td className="py-1.5 pr-2" data-testid="file-type">
                        {roleLabel(f.role)}
                        {f.kind && <span className="text-xs text-[var(--color-muted-foreground)]"> · {f.kind.toUpperCase()}</span>}
                        {f.role === "ANSWER_KEY" && f.keyEntries !== null && <span className="block text-xs text-[var(--color-muted-foreground)]">{f.keyEntries} entries</span>}
                      </td>
                      <td className="hidden py-1.5 pr-2 sm:table-cell">{formatBytes(f.bytes)}</td>
                      <td className="hidden py-1.5 pr-2 sm:table-cell">{f.pages ?? "—"}</td>
                      <td className="hidden py-1.5 pr-2 sm:table-cell">
                        <Badge variant={f.status === "REJECTED" ? "error" : f.status === "UPLOADING" ? "warning" : "neutral"}>{f.status.toLowerCase()}</Badge>
                        {f.error && <span className="block text-xs text-[var(--color-error)]">{f.error}</span>}
                      </td>
                      {canUse && (
                        <td className="py-1.5 text-right">
                          {unfinished ? (
                            <Button variant="outline" size="compact" disabled={pending} onClick={() => act(() => discardUploadAction(f.id), `Removed the unfinished upload “${f.name}”.`)} data-testid="file-remove">
                              Remove upload
                            </Button>
                          ) : blocked ? (
                            // Locked: a neutral, natively disabled button (no click, no keyboard activation) with its reason
                            // visible next to it — never the red destructive style, which made it look usable but broken.
                            <span className="inline-flex cursor-not-allowed flex-col items-end" title={blocked}>
                              <Button
                                variant="outline"
                                size="compact"
                                className="border-dashed text-[var(--color-muted-foreground)] disabled:opacity-70"
                                disabled
                                aria-disabled="true"
                                aria-label={`Remove ${f.name} (unavailable)`}
                                aria-describedby={`remove-why-${f.id}`}
                                data-testid="file-remove"
                                data-locked="true"
                              >
                                <LockIcon />
                                Locked
                              </Button>
                              <span id={`remove-why-${f.id}`} className="mt-1 block max-w-[14rem] text-left text-xs text-[var(--color-muted-foreground)] sm:text-right" data-testid="file-remove-why">
                                {removalBlocked ? (job.controls.actions.delete ? "Use Delete above to remove the import with its files" : "Cancel the import first, then delete it") : blocked}
                              </span>
                            </span>
                          ) : (
                            <Button
                              variant="outline"
                              size="compact"
                              className="border-[color-mix(in_srgb,var(--color-error)_55%,transparent)] text-[var(--color-error)] hover:bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)]"
                              disabled={pending}
                              aria-label={`Remove ${f.name}`}
                              onClick={() => setRemoving(f)}
                              data-testid="file-remove"
                            >
                              Remove
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!job.files.length && (
                  <tr>
                    <td colSpan={canUse ? 6 : 5} className="py-3 text-[var(--color-muted-foreground)]">
                      No files yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {stored.length > 0 && (
            <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="files-totals">
              {totals.papers} question paper{totals.papers === 1 ? "" : "s"} · {totals.keys} answer key{totals.keys === 1 ? "" : "s"} · {totals.pages} paper page{totals.pages === 1 ? "" : "s"}
            </p>
          )}
          {canUse && removalBlocked && stored.length > 0 && (
            <p className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-foreground)_4%,transparent)] p-3 text-sm text-[var(--color-foreground)]" role="note" data-testid="files-remove-blocked">
              <LockIcon />
              <span>
                <strong>A single file cannot be removed now.</strong> {job.reset?.allowed ? "Processing has started. This import produced nothing, so it can be reset to editable below; then the files can be removed or replaced." : removalBlocked}
              </span>
            </p>
          )}
          {removing && (
            <RemoveFileDialog
              jobId={job.id}
              file={removing}
              analyzed={!!a || job.status === "AWAITING_CONFIRMATION"}
              onClose={() => setRemoving(null)}
              onRemoved={(m) => {
                setRemoving(null);
                setError(null);
                setNotice(m);
                router.refresh();
              }}
            />
          )}
          {/* Keyed by editability: after a reset the file-type choice starts at "question paper" again. */}
          {canUse && job.status !== "CANCELLED" && !["PROCESSING", "IMPORTING", "ANALYZING"].includes(job.status) && <Uploader key={editable ? "editable" : "keys-only"} jobId={job.id} files={job.files} canAddPapers={editable} />}
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
                    <th className="py-1 pr-2 font-medium">Maximum</th>
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
                      <td className="py-1 pr-2" data-testid="estimate-line-cost">{!l.calls ? "—" : l.inr === null ? <span className="text-[var(--color-warning)]">Unknown — not priced</span> : l.inr === 0 && l.pricePerM && l.pricePerM.prompt === 0 && l.pricePerM.completion === 0 ? <>₹0.00<span className="block text-xs text-[var(--color-warning)]">published free price — may be rate-limited</span></> : inr(l.inr)}</td>
                      <td className="py-1 pr-2">{l.maxCalls ? (l.maxInr === undefined ? "—" : `${inr(l.maxInr)} (${l.maxCalls} call${l.maxCalls === 1 ? "" : "s"})`) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Estimated total: <strong data-testid="estimate-total">{inr(a.estimate.totalInr)}</strong> (includes a {a.estimate.reservePct}% reserve) · conservative maximum <strong data-testid="estimate-max">{inr(a.estimate.maxInr)}</strong> (every request at its reserved worst case) · per AI page {inr(a.estimate.perPageInr)} · per question {inr(a.estimate.perQuestionInr)} · {a.estimate.pagesNeedingAi} page(s) need AI · about {a.estimate.estimatedMinutes} min.
              </p>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {a.estimate.plan ? `Models: ${a.estimate.plan.mode === "auto" ? "automatic" : "manual override"} — ${SELECTION_TASKS.map((t) => `${SELECTION_TASK_LABELS[t].toLowerCase()} ${a.estimate.plan!.tasks[t].model ?? "none"}`).join(", ")} (chosen again with fresh prices when you confirm) · ` : ""}Provider routes read {a.estimate.pricesSyncedAt ? a.estimate.pricesSyncedAt.slice(0, 16).replace("T", " ") : "—"} · USD→INR {a.estimate.fxRate ?? "—"} ({a.estimate.fxDate ?? "—"}) · computed {a.estimate.computedAt.slice(0, 16).replace("T", " ")} UTC
              </p>
              {a.estimate.notes.length > 0 && (
                <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="estimate-notes-asof">
                  Notes as of this estimate ({a.estimate.computedAt.slice(0, 16).replace("T", " ")} UTC). Later changes in Import Settings (importer models, provider routes) are not shown here; they apply when a job is analyzed or confirmed again.
                </p>
              )}
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
              <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="confirm-budget-limit">Hard limit per job: ₹{job.maxJobInr} (Import Settings).</p>
            </div>
            <BudgetLimitsPanel limits={job.budgetLimits} estimate={job.aiEnabled ? (a?.estimate ?? null) : null} />
            <BudgetFeedback check={confirmCheck} id="confirm-budget-problems" testId="confirm" />
            <div className="flex flex-col gap-2">
              <Button
                className="w-fit"
                disabled={pending || confirmCheck.problems.length > 0}
                aria-describedby="confirm-budget-problems"
                onClick={() => act(() => confirmJobAction(job.id, { title: job.title, ...ctx, year: ctx.year || null, subjectId: ctx.subjectId || null, previousYearPaperId: ctx.previousYearPaperId || null, paperCode: ctx.paperCode || null, budgetInr: confirmCheck.value! }), "Processing queued.", "confirm")}
                data-testid="confirm-start"
              >
                {job.aiEnabled ? "Confirm and start processing" : "Confirm and start (local reading only)"}
              </Button>
              {inlineError?.at === "confirm" && (
                <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="confirm-error">
                  {inlineError.text}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {job.plan && job.status !== "DRAFT" && job.status !== "AWAITING_CONFIRMATION" && <PlanCard plan={job.plan} />}

      {job.reset && canUse && (
        <ResetCard
          jobId={job.id}
          reset={job.reset}
          canManage={job.canManage}
          onDone={(m) => {
            setError(null);
            setNotice(m);
            router.refresh();
          }}
        />
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
                  <div className="flex w-full flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input className="w-32" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} aria-label={`Job budget (hard limit ₹${job.maxJobInr})`} aria-describedby="resume-budget-problems" title={`Hard limit per job: ₹${job.maxJobInr}`} data-testid="resume-budget" />
                      <Button disabled={pending || resumeCheck.problems.length > 0} onClick={() => act(() => resumeJobAction(job.id, resumeCheck.value), "Resumed.", "resume")} data-testid="resume">
                        Resume{job.status === "PAUSED_BUDGET" ? " with this budget" : ""}
                      </Button>
                    </div>
                    <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="resume-budget-limit">
                      Spent so far {inr(job.spentInr)} · hard limit per job {inr(job.maxJobInr)} · all-time budget left {inr(Math.max(0, job.budgetLimits.allTimeLeftInr))} · this month {inr(Math.max(0, job.budgetLimits.monthLeftInr))}. Every AI request is still checked against these limits before it is sent.
                    </p>
                    <BudgetFeedback check={resumeCheck} id="resume-budget-problems" testId="resume" />
                    {inlineError?.at === "resume" && (
                      <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="resume-error">
                        {inlineError.text}
                      </p>
                    )}
                  </div>
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
              Only questions an administrator approved are added. They go through the existing Bulk Import (validation, duplicate check, Import History, rollback); questions that fail a mandatory check stay in Review Exceptions. {s.pendingDecision - s.approvedReady > 0 ? `${s.pendingDecision - s.approvedReady} checked question(s) still await approval.` : ""}
              {job.allowUnverified ? " Policy: questions without an official key may be published with their answer marked UNVERIFIED." : " Policy: answers without an official key or independent verification are imported as drafts only."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button disabled={pending || !s.approvedReady} onClick={() => act(() => importAction(job.id, "DRAFT", null), "Import started.")} data-testid="import-draft">
              Add approved as Draft ({s.approvedReady})
            </Button>
            {canPublish && (
              <Button
                variant="outline"
                disabled={pending || (!s.approvedReady && !s.eligiblePublish)}
                onClick={() => confirm("Add the approved questions and publish those that pass every automated check? Students will see published questions.") && act(() => importAction(job.id, "PUBLISH_ALL", null), "Import & publish started.")}
                data-testid="import-publish-all"
              >
                Add approved &amp; Publish Eligible
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
