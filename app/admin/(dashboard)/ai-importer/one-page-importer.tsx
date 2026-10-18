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
import { JobControls } from "@/components/admin/ai-importer/job-controls";
import { CHUNK_BYTES } from "@/lib/ai-import/config";
import type { JobCard } from "@/lib/ai-import/job-view";
import type { AnalyzerVerdict } from "@/lib/ai-import/verdict";
import { JobContextFields, type ExamOption } from "./new-import-form";
import { analyzeJobAction, createJobAction, importAction, processAndImportAction, saveModelPreferenceAction } from "./actions";
import { callImporter } from "@/components/admin/ai-importer/call-importer";

export interface CurrentJob {
  card: JobCard;
  examName: string;
  verdict: AnalyzerVerdict | null;
}

const BUSY = ["DRAFT", "ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"];
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv";
const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);

/** Uploads one file in chunks through the importer's upload API; resolves with the server's verdict. */
async function uploadFile(jobId: string, file: File, role: "PAPER" | "ANSWER_KEY", onPct: (pct: number) => void): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const start = await fetch("/api/admin/ai-importer/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, name: file.name, size: file.size, role, paperFileId: null }) });
  const s = await start.json().catch(() => ({}));
  if (!start.ok) return { ok: false, error: s.error ?? "The upload was refused." };
  for (let c = 0; c < s.chunks; c++) {
    const blob = file.slice(c * CHUNK_BYTES, Math.min(file.size, (c + 1) * CHUNK_BYTES));
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const r = await fetch(`/api/admin/ai-importer/files/${s.fileId}/chunks/${c}`, { method: "PUT", body: blob });
      ok = r.ok;
      if (!ok && r.status < 500) return { ok: false, error: (await r.json().catch(() => ({}))).error ?? "The upload was refused." };
    }
    if (!ok) return { ok: false, error: "A part of the file could not be uploaded. Check the connection and try again." };
    onPct(Math.round(((c + 1) / s.chunks) * 95));
  }
  const done = await fetch(`/api/admin/ai-importer/files/${s.fileId}/complete`, { method: "POST" });
  const d = await done.json().catch(() => ({}));
  if (!done.ok || !d.ok) return { ok: false, error: d.reason ?? d.error ?? "The file was refused." };
  onPct(100);
  return { ok: true, note: `${String(d.kind).toUpperCase()}${d.pageCount ? ` · ${d.pageCount} page(s)` : ""}` };
}

function toneVariant(t: JobCard["tone"]): "success" | "warning" | "error" | "info" | "neutral" {
  return t;
}

function Fact({ f }: { f: AnalyzerVerdict["facts"][number] }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2.5" data-testid="analyzer-fact" data-kind={f.kind}>
      <span className="flex items-center justify-between gap-2 text-xs text-[var(--color-muted-foreground)]">
        {f.label}
        <span className="text-[10px] uppercase tracking-wide">{f.kind === "detected" ? "Detected" : f.kind === "estimate" ? "Estimate" : "Unavailable"}</span>
      </span>
      <span className={`text-sm font-medium ${f.tone === "error" ? "text-[var(--color-error)]" : f.tone === "warning" ? "text-[var(--color-warning)]" : ""}`}>{f.value}</span>
    </div>
  );
}

function Result({ label, value, tone, testId }: { label: string; value: number; tone?: "ok" | "warn" | "err"; testId: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid={testId} data-value={value}>
      <div className="text-xs text-[var(--color-muted-foreground)]">{label}</div>
      <div className={`text-2xl font-semibold ${value && tone === "ok" ? "text-[var(--color-success)]" : value && tone === "warn" ? "text-[var(--color-warning)]" : value && tone === "err" ? "text-[var(--color-error)]" : ""}`}>{value}</div>
    </div>
  );
}

/** Upload area: exam (remembered from the last import), the paper, an optional answer key, and rarely needed details. */
function UploadCard({ exams, defaultExamId, defaultBudget, limits, aiEnabled }: { exams: ExamOption[]; defaultExamId: string; defaultBudget: number; limits: { maxFileMb: number; maxPagesPerFile: number }; aiEnabled: boolean }) {
  const router = useRouter();
  const [ctx, setCtx] = useState({ examId: defaultExamId, paperType: "FULL_PAPER", subjectId: "", year: "", paperCode: "", previousYearPaperId: "" });
  const [paper, setPaper] = useState<File | null>(null);
  const [key, setKey] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paperInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const exam = exams.find((e) => e.id === ctx.examId);
  // The Bulk Import needs a year for every question: the exam's own year, or the paper's year entered here.
  const needsYear = !!exam && !exam.year;
  const contextMissing = !ctx.examId
    ? "Select the exam first."
    : needsYear && !/^\d{4}$/.test(ctx.year)
      ? "Enter the paper's year — this exam has no year set, and the Question Bank needs one."
      : ctx.paperType === "SINGLE_SUBJECT" && !ctx.subjectId
        ? "Select the subject (Advanced options)."
        : null;

  async function go(file: File) {
    if (busy) return;
    if (contextMissing) return setError(contextMissing);
    if (file.size > limits.maxFileMb * 1024 * 1024) return setError(`The file is larger than ${limits.maxFileMb} MB.`);
    setBusy(true);
    setError(null);
    try {
      // One key per chosen file: a double click or a retried request returns the same job.
      const clientKey = `up_${file.size}_${file.lastModified}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      setProgress("Creating the import…");
      const created = await callImporter(() => createJobAction({ title: file.name.replace(/\.[^.]+$/, "").slice(0, 160) || "Untitled import", ...ctx, year: ctx.year || null, subjectId: ctx.subjectId || null, previousYearPaperId: ctx.previousYearPaperId || null, paperCode: ctx.paperCode || null, budgetInr: defaultBudget, clientKey }));
      if (!created.ok) throw new Error(created.error);
      const jobId = created.data.jobId;
      const up = await uploadFile(jobId, file, "PAPER", (p) => setProgress(`Uploading ${file.name}… ${p}%`));
      if (!up.ok) throw new Error(`${file.name}: ${up.error}`);
      if (key) {
        const k = await uploadFile(jobId, key, "ANSWER_KEY", (p) => setProgress(`Uploading the answer key… ${p}%`));
        if (!k.ok) throw new Error(`Answer key ${key.name}: ${k.error}`);
      }
      setProgress("Analyzing…");
      const an = await callImporter(() => analyzeJobAction(jobId));
      if (!an.ok) throw new Error(an.error);
      router.replace(`/admin/ai-importer?job=${jobId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload failed.");
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Card data-testid="upload-card">
      <CardHeader>
        <CardTitle>Upload PDF or Document</CardTitle>
        <CardDescription>
          PDF, Word (DOCX), JPG, PNG, XLSX or CSV · up to {limits.maxFileMb} MB and {limits.maxPagesPerFile} pages per file. The file is analyzed automatically on this server (free); nothing is charged before you click Process.
          {!aiEnabled && " Paid AI is off: digital PDFs and Word files work fully; scanned pages cannot be read."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="op-exam">Exam</Label>
          <SelectNative id="op-exam" value={ctx.examId} disabled={busy} onChange={(e) => setCtx((c) => ({ ...c, examId: e.target.value, subjectId: "", previousYearPaperId: "" }))} data-testid="op-exam">
            <option value="">Select an exam…</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </SelectNative>
        </div>
        {needsYear && (
          <div className="flex max-w-[12rem] flex-col gap-1.5">
            <Label htmlFor="op-year">Paper year</Label>
            <Input id="op-year" inputMode="numeric" maxLength={4} placeholder="e.g. 2024" value={ctx.year} disabled={busy} onChange={(e) => setCtx((c) => ({ ...c, year: e.target.value.replace(/\D/g, "") }))} data-testid="op-year" />
            <span className="text-xs text-[var(--color-muted-foreground)]">Required: this exam has no year set.</span>
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          aria-disabled={busy}
          onClick={() => !busy && paperInput.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && (e.preventDefault(), paperInput.current?.click())}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !busy) {
              setPaper(f);
              go(f);
            }
          }}
          className={`flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed p-6 text-center transition-colors ${drag ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5" : "border-[var(--color-border)] hover:border-[var(--color-primary)]"} ${busy ? "cursor-wait opacity-80" : ""}`}
          data-testid="drop-zone"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-[var(--color-muted-foreground)]">
            <path d="M12 16V4m0 0-4 4m4-4 4 4" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
          <span className="text-base font-medium">{busy ? progress ?? "Working…" : paper ? paper.name : "Drop the question paper here, or click to choose"}</span>
          <span className="text-xs text-[var(--color-muted-foreground)]">{busy ? "Keep this page open until the analysis appears." : "Upload starts as soon as a file is chosen."}</span>
          <input
            ref={paperInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) {
                setPaper(f);
                go(f);
              }
            }}
            data-testid="op-upload-input"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--color-muted-foreground)]">Separate answer key (optional, choose before the paper):</span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => keyInput.current?.click()} data-testid="op-key-button">
            {key ? key.name : "Choose answer key"}
          </Button>
          {key && !busy && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setKey(null)}>
              Remove
            </Button>
          )}
          <input
            ref={keyInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setKey(f);
            }}
            data-testid="op-key-input"
          />
        </div>
        <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="op-advanced">
          <summary className="cursor-pointer text-sm font-medium">Advanced options</summary>
          <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Rarely needed. The defaults import a full paper of the selected exam into the Question Bank as Draft.</p>
          <div className="mt-3">
            <JobContextFields exams={exams} value={ctx} onChange={(v) => setCtx((c) => ({ ...c, ...v }))} />
          </div>
        </details>
        {error && (
          <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="op-upload-error">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ModelOverride({ jobId, importerModels, canManage, selection, value, onChange }: { jobId: string; importerModels: string[]; canManage: boolean; selection: { mode: "auto" | "manual"; model: string | null }; value: string; onChange: (v: string) => void }) {
  const router = useRouter();
  const [remember, setRemember] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm" data-testid="op-change-model">
      <summary className="cursor-pointer font-medium">Change model</summary>
      {importerModels.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">The importer has no models on its own list yet, so only the free local reader is available. Models are added under Import Settings (Master Admin).</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <Label htmlFor={`op-model-${jobId}`}>Model for reading scanned pages and the answer key (this import)</Label>
          <SelectNative id={`op-model-${jobId}`} value={value} onChange={(e) => onChange(e.target.value)} data-testid="op-model-select">
            <option value="">Automatic — Cheapest Suitable Model</option>
            {importerModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </SelectNative>
          <p className="text-xs text-[var(--color-muted-foreground)]">A chosen model passes the same suitability, privacy and price checks. It applies to this import only unless you save it.</p>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid="op-model-remember" />
                Remember as the importer default
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !remember}
                onClick={() =>
                  start(async () => {
                    const r = await callImporter(() => saveModelPreferenceAction(value || null));
                    setMsg(r.ok ? { text: r.data.mode === "auto" ? "Saved: Automatic is the default." : `Saved: ${r.data.model} is the default.`, error: false } : { text: r.error, error: true });
                    if (r.ok) router.refresh();
                  })
                }
                data-testid="op-model-save"
              >
                Save preference
              </Button>
            </div>
          )}
          {selection.mode === "manual" && <p className="text-xs text-[var(--color-warning)]">Saved default: {selection.model ?? "—"} (manual). Choose Automatic and save to go back.</p>}
          {msg && <p className={`text-xs ${msg.error ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>{msg.text}</p>}
        </div>
      )}
    </details>
  );
}

function CurrentJobPanel({ current, canUse, canManage, aiEnabled, importerModels, selection, pilot }: { current: CurrentJob; canUse: boolean; canManage: boolean; aiEnabled: boolean; importerModels: string[]; selection: { mode: "auto" | "manual"; model: string | null }; pilot: { remainingInr: number; totalCapInr: number } }) {
  const router = useRouter();
  const { card: j, verdict: v } = current;
  const [pending, start] = useTransition();
  const [clicked, setClicked] = useState(false);
  const [override, setOverride] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const busy = BUSY.includes(j.status) && !j.stalled;

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [busy, router]);

  const processNow = () => {
    if (clicked) return;
    setClicked(true);
    start(async () => {
      setMsg(null);
      const r = await callImporter(() => processAndImportAction(j.id, { modelOverride: override || null }));
      if (!r.ok) {
        setMsg({ text: r.error, error: true });
        setClicked(false);
      } else router.refresh();
    });
  };
  const finished = ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"].includes(j.status);
  // An analyzed file that cannot be processed says so in one place (the blocker), never "Ready to process".
  const blocked = j.status === "AWAITING_CONFIRMATION" && !!v?.blocker;
  const c = j.counts;

  return (
    <Card data-testid="current-job" data-status={j.status}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="[overflow-wrap:anywhere]">{j.title}</CardTitle>
            <CardDescription>
              {current.examName} · {j.files.map((f) => `${f.name}${f.role === "ANSWER_KEY" ? " (answer key)" : ""}`).join(", ") || "no files"} · uploaded {j.createdAt}
            </CardDescription>
          </div>
          <Badge variant={blocked ? "warning" : toneVariant(j.tone)} data-testid="current-status">
            {blocked ? "Action needed" : j.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(j.status === "DRAFT" || j.status === "ANALYZING") && !j.stalled && (
          <p className="text-sm" data-testid="op-analyzing">
            Analyzing the file on this server (free)… this usually takes a few seconds.
          </p>
        )}

        {j.status === "AWAITING_CONFIRMATION" && v && (
          <div className="flex flex-col gap-4" data-testid="analyzer" data-strategy={v.strategy}>
            <div>
              <h3 className="text-sm font-semibold">AI File Analyzer</h3>
              <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="analyzer-mode">
                {v.analysisMode} {!aiEnabled && "Deeper AI analysis is unavailable because paid AI is switched off."}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {v.facts.map((f) => (
                <Fact key={f.label} f={f} />
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="selected-model" data-model={v.model.name} data-local={v.model.local ? "true" : "false"}>
                <div className="text-xs text-[var(--color-muted-foreground)]">Selected model {override ? "(override for this import)" : selection.mode === "manual" ? "(saved manual choice)" : "· Automatic — Cheapest Suitable Model"}</div>
                <div className="text-base font-semibold [overflow-wrap:anywhere]">{override || v.model.name}</div>
                {(override ? null : v.model.route) && <div className="text-xs text-[var(--color-muted-foreground)]">Route: {v.model.route}</div>}
                <div className="mt-1 text-xs">
                  <span className="font-medium">Why this model? </span>
                  {override ? "Chosen by you for this import; it is checked for suitability, privacy and price when you click Process." : v.model.reason}
                </div>
                {v.otherModels.length > 0 && (
                  <ul className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                    {v.otherModels.map((m) => (
                      <li key={m.task}>
                        {m.task}: {m.model ?? "none"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="op-cost">
                <div className="text-xs text-[var(--color-muted-foreground)]">Estimated cost</div>
                <div className="text-base font-semibold" data-testid="op-cost-estimate">
                  {inr(v.estimatedCostInr)}
                </div>
                <div className="text-xs">
                  Maximum possible: <strong data-testid="op-cost-max">{inr(v.maxCostInr)}</strong> · remaining pilot budget <strong data-testid="op-pilot-remaining">{inr(pilot.remainingInr)}</strong> of {inr(pilot.totalCapInr)}
                </div>
                <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">{v.strategyLabel}.</div>
              </div>
            </div>
            {v.warnings.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-[var(--color-warning)]" data-testid="analyzer-warnings">
                {v.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {v.blocker ? (
              <div className="rounded-[var(--radius-card)] border border-[color-mix(in_srgb,var(--color-warning)_50%,transparent)] p-3 text-sm" role="alert" data-testid="analyzer-blocker">
                <p className="font-medium">{v.blocker.reason}</p>
                <p className="mt-1">
                  <span className="font-medium">Next: </span>
                  {v.blocker.nextAction}
                </p>
              </div>
            ) : null}
            {canUse && v.strategy === "AI" && <ModelOverride jobId={j.id} importerModels={importerModels} canManage={canManage} selection={selection} value={override} onChange={setOverride} />}
            {canUse && (
              <div className="flex flex-col gap-1">
                <Button size="lg" className="w-full sm:w-auto sm:self-start" disabled={!v.canProcess || pending || clicked} onClick={processNow} data-testid="process-import">
                  {pending || clicked ? "Starting…" : "Process & Import Questions"}
                </Button>
                <p className="text-xs text-[var(--color-muted-foreground)]">Eligible questions are added to the Question Bank as Draft through the existing Bulk Import. Questions with unverified answers or unsupported formats are kept for review — nothing is published automatically.</p>
              </div>
            )}
          </div>
        )}

        {(j.status === "QUEUED" || j.status === "PROCESSING" || j.status === "IMPORTING") && (
          <div className="flex flex-col gap-2" data-testid="op-progress">
            <p className="text-sm font-medium">{j.label}…</p>
            {j.pages.total > 0 && (
              <>
                <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-border)]">
                  <span className="block h-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${Math.round(((j.pages.done + j.pages.skipped + j.pages.failed) / j.pages.total) * 100)}%` }} />
                </div>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Pages {j.pages.done + j.pages.skipped + j.pages.failed} of {j.pages.total} · {c.extracted} question(s) so far · AI spend {inr(j.spentInr)}
                </p>
              </>
            )}
          </div>
        )}

        {finished && (
          <div className="flex flex-col gap-3" data-testid="op-result">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Result label="Imported (Draft)" value={c.imported} tone="ok" testId="result-imported" />
              <Result label="Needs review" value={c.needsReview + c.ready} tone="warn" testId="result-review" />
              <Result label="Unsupported (not importable)" value={c.notImportable} tone="err" testId="result-unsupported" />
              <Result label="Failed" value={c.importFailed + j.pages.failed} tone="err" testId="result-failed" />
              <Result label="Duplicates skipped" value={c.duplicates} tone="warn" testId="result-duplicates" />
              <Result label="Answer unverified" value={c.unverifiedAnswers} tone="warn" testId="result-unverified" />
            </div>
            {j.status === "NEEDS_REVIEW" && c.ready > 0 && canUse && (
              <div>
                <Button
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await callImporter(() => importAction(j.id, "DRAFT", null));
                      if (!r.ok) setMsg({ text: r.error, error: true });
                      else router.refresh();
                    })
                  }
                  data-testid="op-import-ready"
                >
                  Import ready questions ({c.ready})
                </Button>
              </div>
            )}
          </div>
        )}

        {j.message && !(j.status === "AWAITING_CONFIRMATION" && v?.blocker) && (
          <p className="text-sm text-[var(--color-warning)]" data-testid="op-job-message">
            {j.message}
          </p>
        )}
        {!blocked && (
          <p className="text-sm" data-testid="op-next-action">
            <span className="font-medium">Next: </span>
            {j.nextAction}
          </p>
        )}
        {msg && (
          <p className={`text-sm ${msg.error ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`} role={msg.error ? "alert" : "status"} data-testid="op-message">
            {msg.text}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {c.extracted > 0 && (
            <Link className="underline" href={`/admin/ai-importer/exceptions?job=${j.id}`} data-testid="op-review-link">
              Review questions
            </Link>
          )}
          {j.runIds.map((r) => (
            <Link key={r} className="underline" href={`/admin/questions/bulk-import/history/${r}`}>
              Bulk Import run {r.slice(-6)}
            </Link>
          ))}
          <Link className="underline" href={`/admin/ai-importer/jobs/${j.id}`} data-testid="op-details-link">
            Full details
          </Link>
          <Link className="underline" href="/admin/ai-importer" data-testid="op-new-upload">
            Upload another file
          </Link>
        </div>
        {canUse && <JobControls job={j} onDeleted={() => router.replace("/admin/ai-importer")} />}
      </CardContent>
    </Card>
  );
}

export function OnePageImporter(props: {
  canUse: boolean;
  canManage: boolean;
  exams: ExamOption[];
  defaultExamId: string;
  defaultBudget: number;
  limits: { maxFileMb: number; maxPagesPerFile: number };
  aiEnabled: boolean;
  selection: { mode: "auto" | "manual"; model: string | null };
  importerModels: string[];
  pilot: { remainingInr: number; totalCapInr: number };
  current: CurrentJob | null;
  missingJob: boolean;
  recent: JobCard[];
}) {
  const { current } = props;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Question Importer</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">Upload a question paper, check the analysis, then click Process &amp; Import Questions. Questions enter the Question Bank as Draft through the existing Bulk Import.</p>
      </div>
      {props.missingJob && (
        <p className="text-sm text-[var(--color-warning)]" data-testid="op-missing-job">
          That import no longer exists (it may have been deleted). Upload a file to start a new one.
        </p>
      )}
      {current ? (
        <CurrentJobPanel current={current} canUse={props.canUse} canManage={props.canManage} aiEnabled={props.aiEnabled} importerModels={props.importerModels} selection={props.selection} pilot={props.pilot} />
      ) : props.canUse ? (
        <UploadCard exams={props.exams} defaultExamId={props.defaultExamId} defaultBudget={props.defaultBudget} limits={props.limits} aiEnabled={props.aiEnabled} />
      ) : (
        <Card>
          <CardContent className="py-4 text-sm text-[var(--color-muted-foreground)]">You can view imports but not start one (Master Admin only).</CardContent>
        </Card>
      )}
      {props.recent.length > 0 && (
        <Card data-testid="op-recent">
          <CardHeader>
            <CardTitle>Recent imports</CardTitle>
            <CardDescription>
              <Link className="underline" href="/admin/ai-importer/jobs">
                All imports
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {props.recent.map((j) => (
                <li key={j.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="op-recent-row" data-job-id={j.id}>
                  <div className="min-w-0">
                    <Link className="font-medium underline [overflow-wrap:anywhere]" href={`/admin/ai-importer?job=${j.id}`}>
                      {j.title}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                      <Badge variant={toneVariant(j.tone)}>{j.label}</Badge>
                      <span>{j.updatedAt}</span>
                      {j.counts.extracted > 0 && <span>{j.counts.imported}/{j.counts.extracted} imported</span>}
                    </div>
                  </div>
                  {props.canUse && <JobControls job={j} size="compact" />}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
