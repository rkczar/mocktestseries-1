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
import type { JobCard } from "@/lib/ai-import/job-view";
import type { AnalyzerVerdict } from "@/lib/ai-import/verdict";
import { JobContextFields, type ExamOption } from "./new-import-form";
import { analyzeJobAction, changeJobPaperAction, createJobAction, processAndImportAction, saveModelPreferenceAction } from "./actions";
import { PaperMapping } from "@/components/admin/ai-importer/paper-mapping";
import { QualityPanel } from "@/components/admin/ai-importer/quality-panel";
import type { JobMapping } from "@/lib/ai-import/job-view";
import type { QualityReport } from "@/lib/ai-import/quality";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { ACCEPT, STAGE_LABEL, SUPPORTED_LABEL, checkLocalFile, uploadJobFile, uploadReferenceFile, type UploadStage } from "@/components/admin/ai-importer/upload-client";
import { CostSummary, type CostBreakdownLine } from "@/components/admin/ai-importer/cost-summary";
import type { SpendSummary } from "@/lib/ai-import/ledger";

export interface CurrentJob {
  card: JobCard;
  examName: string;
  verdict: AnalyzerVerdict | null;
  mapping: JobMapping;
  quality: QualityReport | null;
  /** The analyzer's estimate of the question count (a starting value for the confirmation, never trusted). */
  estimatedQuestions: number | null;
  /** Papers of the job's exam, for an explicit change of the Previous Year Paper. */
  papers: ExamOption["papers"];
  files: { id: string; name: string; pageCount: number | null }[];
  stage: string | null;
  verifyAvailable: boolean;
  /** Actual spend of this job and of the importer this IST month (AI Question Importer only). */
  spend: SpendSummary;
  /** The estimate per priced step (paid AI on), shown under the cost at confirmation. */
  costLines: CostBreakdownLine[];
}

const BUSY = ["DRAFT", "ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"];

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

const paperLabel = (p: ExamOption["papers"][number]) => `${p.year} — ${p.title}${p.paperCode ? ` (${p.paperCode})` : ""}`;

/** The models the importer would use now, per stage — the same plan Import Settings shows (computeModelPlan). */
export interface AiConfigView {
  aiEnabled: boolean;
  mode: "auto" | "manual";
  stages: { task: string; label: string; model: string | null; reason: string }[];
  problems: string[];
}

type Slot = "paper" | "key" | "reference";
type SlotState = { file: File | null; invalid: string | null; pct: number; done: string | null; error: string | null };
const EMPTY: SlotState = { file: null, invalid: null, pct: 0, done: null, error: null };
const SLOT_LABEL: Record<Slot, string> = { paper: "Question paper", key: "Answer key", reference: "Reference paper" };

/** One file picker: chosen name, check result, progress, Remove / Replace. Choosing a file never uploads it. */
function FileSlot(props: { slot: Slot; step: string; hint: string; state: SlotState; locked: boolean; onPick: (f: File) => void; onRemove: () => void; required?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { state: s, slot } = props;
  const status = s.error ? "failed" : s.done ? "uploaded" : s.pct > 0 ? "uploading" : s.invalid ? "invalid" : s.file ? "ready" : "empty";
  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid={`op-slot-${slot}`} data-status={status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {props.step} {SLOT_LABEL[slot]} {props.required ? "" : <span className="font-normal text-[var(--color-muted-foreground)]">(optional)</span>}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={props.locked} onClick={() => input.current?.click()} data-testid={`op-${slot}-button`}>
            {s.file ? "Replace" : "Choose file"}
          </Button>
          {s.file && !props.locked && (
            <Button type="button" variant="ghost" size="sm" onClick={props.onRemove} data-testid={`op-${slot}-remove`}>
              Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          disabled={props.locked}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) props.onPick(f);
          }}
          data-testid={slot === "paper" ? "op-upload-input" : `op-${slot}-input`}
        />
      </div>
      {s.file ? (
        <div className="flex flex-col gap-1 text-xs">
          <span className="[overflow-wrap:anywhere]" data-testid={`op-${slot}-name`}>
            {s.file.name} · {(s.file.size / 1024 / 1024).toFixed(1)} MB
          </span>
          {s.invalid && (
            <span className="text-[var(--color-error)]" role="alert" data-testid={`op-${slot}-invalid`}>
              Not accepted: {s.invalid}
            </span>
          )}
          {!s.invalid && !s.done && !s.error && s.pct === 0 && <span className="text-[var(--color-success)]">Ready — uploaded when you click Submit &amp; Analyze.</span>}
          {s.pct > 0 && !s.done && !s.error && (
            <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--color-border)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.pct} data-testid={`op-${slot}-progress`}>
              <span className="block h-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${s.pct}%` }} />
            </div>
          )}
          {s.done && (
            <span className="text-[var(--color-success)]" data-testid={`op-${slot}-done`}>
              Uploaded ✓ {s.done}
            </span>
          )}
          {s.error && (
            <span className="text-[var(--color-error)]" role="alert" data-testid={`op-${slot}-error`}>
              {s.error}
            </span>
          )}
        </div>
      ) : (
        <span className="text-xs text-[var(--color-muted-foreground)]">{props.hint}</span>
      )}
    </div>
  );
}

/** AI Configuration: the model chosen for each stage (read-only plan) and an optional override for this import. */
function AiConfiguration({ ai, importerModels, canManage, override, setOverride, locked }: { ai: AiConfigView; importerModels: string[]; canManage: boolean; override: string; setOverride: (v: string) => void; locked: boolean }) {
  const router = useRouter();
  const [remember, setRemember] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="op-ai-config" data-ai={ai.aiEnabled ? "on" : "off"}>
      <h3 className="text-sm font-semibold">7. AI Configuration</h3>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        {ai.aiEnabled
          ? `${ai.mode === "auto" ? "Automatic — the cheapest suitable model on the importer's list" : "Manual — the saved importer choice"}, checked for availability, image support, privacy and price. The same plan is shown under Import Settings and is checked again (with fresh prices) before anything is charged.`
          : "Paid AI is switched off: digital PDFs and Word files are read locally for free; scanned pages and image answer keys cannot be read. Nothing is charged."}
      </p>
      <ul className="grid gap-1.5 sm:grid-cols-2" data-testid="op-ai-stages">
        {ai.stages.map((s) => (
          <li key={s.task} className="flex flex-col rounded border border-[var(--color-border)] p-2 text-xs" data-testid="op-ai-stage" data-task={s.task} data-model={s.model ?? ""}>
            <span className="text-[var(--color-muted-foreground)]">{s.label}</span>
            <span className={`font-medium [overflow-wrap:anywhere] ${s.model ? "" : "text-[var(--color-warning)]"}`}>{s.model ?? (ai.aiEnabled ? "Not available" : "Local reader only (free)")}</span>
            {!s.model && <span className="text-[var(--color-muted-foreground)]">{s.reason}</span>}
          </li>
        ))}
      </ul>
      {ai.problems.length > 0 && (
        <ul className="text-xs text-[var(--color-warning)]" data-testid="op-ai-problems">
          {ai.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {ai.aiEnabled && importerModels.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="op-ai-override">Page-reading model for this import (optional override)</Label>
          <SelectNative id="op-ai-override" value={override} disabled={locked} onChange={(e) => setOverride(e.target.value)} data-testid="op-ai-override">
            <option value="">Automatic (recommended)</option>
            {importerModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </SelectNative>
          <span className="text-xs text-[var(--color-muted-foreground)]">An override passes the same suitability, privacy and price checks at the cost confirmation; if it fails them you are told why and nothing is charged.</span>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid="op-ai-remember" />
                Save as the importer default (Import Settings)
              </label>
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={pending || !remember || locked}
                onClick={() =>
                  start(async () => {
                    const r = await callImporter(() => saveModelPreferenceAction(override || null));
                    setMsg(r.ok ? { text: r.data.mode === "auto" ? "Saved: Automatic is the default." : `Saved: ${r.data.model} is the default.`, error: false } : { text: r.error, error: true });
                    if (r.ok) router.refresh();
                  })
                }
                data-testid="op-ai-save"
              >
                Save default
              </Button>
            </div>
          )}
          {msg && <p className={`text-xs ${msg.error ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>{msg.text}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * New import: 1 exam → 2 Previous Year Paper → 3 expected count → 4 question paper → 5 answer key (optional)
 * → 6 reference paper (optional) → 7 AI configuration → Submit & Analyze. Choosing a file only selects it; the
 * import is created, uploaded and analyzed when Submit & Analyze is clicked. A failed step can be retried on the
 * same import (the job is created with a stable key, finished uploads are not repeated), so nothing is duplicated.
 * The free local analysis runs here; paid AI still needs the cost confirmation on the next screen.
 */
function UploadCard({ exams, defaultExamId, limits, ai, importerModels, canManage }: { exams: ExamOption[]; defaultExamId: string; limits: { maxFileMb: number; maxPagesPerFile: number }; ai: AiConfigView; importerModels: string[]; canManage: boolean }) {
  const router = useRouter();
  const [ctx, setCtx] = useState({ examId: defaultExamId, paperType: "FULL_PAPER", subjectId: "", year: "", paperCode: "", previousYearPaperId: "" });
  const [expected, setExpected] = useState("");
  const [slots, setSlots] = useState<Record<Slot, SlotState>>({ paper: EMPTY, key: EMPTY, reference: EMPTY });
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<{ stage: UploadStage; text: string } | null>(null);
  // The import this form is filling: kept across a retry so the job and finished uploads are never repeated.
  const [jobId, setJobId] = useState<string | null>(null);
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const clientKey = useRef<string | null>(null);
  const [drag, setDrag] = useState(false);
  const exam = exams.find((e) => e.id === ctx.examId);
  const pyq = exam?.papers.find((p) => p.id === ctx.previousYearPaperId) ?? null;
  // The Bulk Import needs a year for every question: the selected paper's year, the exam's own year, or one entered here.
  const needsYear = !!exam && !exam.year && !pyq;
  const locked = busy || jobId !== null;
  const missing = !ctx.examId
    ? "Select the exam."
    : needsYear && !/^\d{4}$/.test(ctx.year)
      ? "Select the Previous Year Paper, or enter the paper's year — this exam has no year set, and the Question Bank needs one."
      : ctx.paperType === "SINGLE_SUBJECT" && !ctx.subjectId
        ? "Select the subject (Advanced options)."
        : !/^[1-9]\d{0,3}$/.test(expected)
          ? "Enter the expected number of questions."
          : !slots.paper.file
            ? "Choose the question paper."
            : (["paper", "key", "reference"] as const).map((k) => slots[k].invalid && `${SLOT_LABEL[k]}: ${slots[k].invalid}`).find(Boolean) || null;

  const patch = (k: Slot, v: Partial<SlotState>) => setSlots((s) => ({ ...s, [k]: { ...s[k], ...v } }));
  const pick = (k: Slot, f: File) => {
    setError(null);
    setSlots((s) => ({ ...s, [k]: { ...EMPTY, file: f, invalid: checkLocalFile(f, limits.maxFileMb) } }));
  };

  async function submit() {
    if (running.current || missing) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const ctl = new AbortController();
    abort.current = ctl;
    let stage: UploadStage = "validation";
    try {
      let id = jobId;
      if (!id) {
        // One key per form: a double click or a retried request returns the same job.
        clientKey.current ??= `up_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
        setProgress("Creating the import…");
        const paper = slots.paper.file!;
        const created = await callImporter(() => createJobAction({ title: paper.name.replace(/\.[^.]+$/, "").slice(0, 160) || "Untitled import", ...ctx, year: pyq ? null : ctx.year || null, paperCode: pyq ? null : ctx.paperCode || null, subjectId: ctx.subjectId || null, previousYearPaperId: ctx.previousYearPaperId || null, clientKey: clientKey.current, expectedQuestions: expected }));
        if (!created.ok) throw Object.assign(new Error(created.error), { stage: "validation" as UploadStage });
        id = created.data.jobId;
        setJobId(id);
      }
      stage = "upload";
      for (const k of ["paper", "key", "reference"] as const) {
        const s = slots[k];
        if (!s.file || s.done) continue;
        patch(k, { error: null, pct: 1 });
        setProgress(`Uploading the ${SLOT_LABEL[k].toLowerCase()}…`);
        const onPct = (p: number) => patch(k, { pct: Math.max(1, p) });
        const r = k === "reference" ? await uploadReferenceFile(id, s.file, onPct, ctl.signal) : await uploadJobFile(id, s.file, k === "paper" ? "PAPER" : "ANSWER_KEY", onPct, ctl.signal);
        if (!r.ok) {
          patch(k, { pct: 0, error: `${STAGE_LABEL[r.stage]} failed: ${r.error}` });
          throw Object.assign(new Error(`${SLOT_LABEL[k]} “${s.file.name}”: ${r.error}`), { stage: r.stage });
        }
        patch(k, { done: r.note, pct: 100 });
      }
      stage = "analysis";
      setProgress("Analyzing on this server (free)…");
      const an = await callImporter(() => analyzeJobAction(id!));
      if (!an.ok) throw Object.assign(new Error(an.error), { stage: "analysis" as UploadStage });
      router.replace(`/admin/ai-importer?job=${id}${override ? `&model=${encodeURIComponent(override)}` : ""}`);
    } catch (e) {
      const st = (e as { stage?: UploadStage }).stage ?? stage;
      setError({ stage: st, text: ctl.signal.aborted ? "Cancelled. Finished uploads are kept on this import — click Submit & Analyze to continue, or Start over." : e instanceof Error ? e.message : "The step failed." });
      setBusy(false);
      setProgress(null);
      running.current = false;
    }
  }

  function startOver() {
    abort.current?.abort();
    clientKey.current = null;
    running.current = false;
    setJobId(null);
    setSlots({ paper: EMPTY, key: EMPTY, reference: EMPTY });
    setError(null);
    setBusy(false);
    setProgress(null);
  }

  return (
    <Card data-testid="upload-card">
      <CardHeader>
        <CardTitle>New import</CardTitle>
        <CardDescription>
          {SUPPORTED_LABEL} · up to {limits.maxFileMb} MB and {limits.maxPagesPerFile} pages per file. Fill in the steps, then click Submit &amp; Analyze. The analysis runs on this server (free); nothing is charged before you confirm the estimated cost.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="op-exam">1. Exam</Label>
            <SelectNative id="op-exam" value={ctx.examId} disabled={locked} onChange={(e) => setCtx((c) => ({ ...c, examId: e.target.value, subjectId: "", previousYearPaperId: "" }))} data-testid="op-exam">
              <option value="">Select an exam…</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="op-pyq">2. Previous Year Paper</Label>
            <SelectNative id="op-pyq" value={ctx.previousYearPaperId} disabled={locked || !exam} onChange={(e) => setCtx((c) => ({ ...c, previousYearPaperId: e.target.value, year: "", paperCode: "" }))} data-testid="op-pyq">
              <option value="">{exam ? "None — add to the Question Bank only" : "Select the exam first"}</option>
              {exam?.papers.map((p) => (
                <option key={p.id} value={p.id}>
                  {paperLabel(p)}
                </option>
              ))}
            </SelectNative>
            <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="op-pyq-hint">
              {pyq ? `Questions are linked to "${pyq.title}" with its year ${pyq.year}${pyq.paperCode ? ` and code ${pyq.paperCode}` : ""}.` : exam && !exam.papers.length ? "This exam has no Previous Year Paper yet. " : "The paper record must already exist; it is never created or guessed from the file name. "}
              {!pyq && (
                <Link className="underline" href="/admin/exams/previous-year-papers">
                  Manage Previous Year Papers
                </Link>
              )}
            </span>
          </div>
          {needsYear && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="op-year">Paper year</Label>
              <Input id="op-year" inputMode="numeric" maxLength={4} placeholder="e.g. 2024" value={ctx.year} disabled={locked} onChange={(e) => setCtx((c) => ({ ...c, year: e.target.value.replace(/\D/g, "") }))} data-testid="op-year" />
              <span className="text-xs text-[var(--color-muted-foreground)]">Required: no paper is selected and this exam has no year set.</span>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="op-expected">3. Expected number of questions</Label>
            <Input id="op-expected" inputMode="numeric" maxLength={4} placeholder="e.g. 100" value={expected} disabled={locked} onChange={(e) => setExpected(e.target.value.replace(/\D/g, ""))} data-testid="op-expected" />
            <span className="text-xs text-[var(--color-muted-foreground)]">As printed on the paper. You confirm it again before processing; missing questions are detected against it.</span>
          </div>
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!locked) setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !locked) pick("paper", f);
          }}
          className={`rounded-[var(--radius-card)] ${drag ? "ring-2 ring-[var(--color-primary)]" : ""}`}
          data-testid="drop-zone"
        >
          <FileSlot slot="paper" step="4." required hint="Choose the question paper or drop it here. It is uploaded only when you click Submit & Analyze." state={slots.paper} locked={locked} onPick={(f) => pick("paper", f)} onRemove={() => patch("paper", EMPTY)} />
        </div>
        <FileSlot slot="key" step="5." hint="The official answer key, if you have it (a digital key is read for free)." state={slots.key} locked={busy || !!slots.key.done} onPick={(f) => pick("key", f)} onRemove={() => patch("key", EMPTY)} />
        <FileSlot slot="reference" step="6." hint={`A related paper, a clean copy or an answer-key document (${SUPPORTED_LABEL}, up to ${limits.maxFileMb} MB). Read on this server only and used by Verify 1 as evidence — conflicts are shown, the question paper is never replaced. Old .doc files: save as .docx or PDF first.`} state={slots.reference} locked={busy || !!slots.reference.done} onPick={(f) => pick("reference", f)} onRemove={() => patch("reference", EMPTY)} />
        <AiConfiguration ai={ai} importerModels={importerModels} canManage={canManage} override={override} setOverride={setOverride} locked={busy} />
        <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="op-advanced">
          <summary className="cursor-pointer text-sm font-medium">Advanced options</summary>
          <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Rarely needed: paper type (single-subject papers) and a paper code when no Previous Year Paper is selected.</p>
          <div className="mt-3">
            <JobContextFields exams={exams} value={ctx} onChange={(v) => !locked && setCtx((c) => ({ ...c, ...v }))} hidePaper />
          </div>
        </details>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" className="w-full sm:w-auto" disabled={busy || !!missing} onClick={submit} data-testid="op-submit">
              {busy ? "Working…" : jobId ? "Retry — Submit & Analyze" : "Submit & Analyze"}
            </Button>
            {busy && (
              <Button type="button" variant="outline" onClick={() => abort.current?.abort()} data-testid="op-cancel">
                Cancel upload
              </Button>
            )}
            {jobId && !busy && (
              <Button type="button" variant="ghost" onClick={startOver} data-testid="op-start-over">
                Start over
              </Button>
            )}
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="op-submit-hint">
            {busy ? progress ?? "Working…" : missing ? `To continue: ${missing}` : "Ready. The import is created, the files are uploaded and analyzed (free); the cost is shown for confirmation before any paid AI."}
          </p>
          {jobId && !busy && (
            <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="op-draft-note">
              This import is already created; a retry continues it (finished uploads are not repeated). Start over begins a new import — the unfinished one stays under Recent imports, where it can be deleted.
            </p>
          )}
        </div>
        {error && (
          <p className="text-sm text-[var(--color-error)]" role="alert" data-testid="op-upload-error" data-stage={error.stage}>
            <span className="font-medium">{STAGE_LABEL[error.stage]} failed: </span>
            {error.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Explicit change of the import's Previous Year Paper (before any question is stored). */
function ChangePaper({ jobId, papers, current }: { jobId: string; papers: ExamOption["papers"]; current: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm" data-testid="op-change-paper">
      <summary className="cursor-pointer font-medium">Change Previous Year Paper</summary>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <SelectNative aria-label="Previous Year Paper" value={value} onChange={(e) => setValue(e.target.value)} data-testid="op-change-paper-select">
          <option value="">None — Question Bank only</option>
          {papers.map((p) => (
            <option key={p.id} value={p.id}>
              {paperLabel(p)}
            </option>
          ))}
        </SelectNative>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || value === (current ?? "")}
          onClick={() =>
            start(async () => {
              const r = await callImporter(() => changeJobPaperAction(jobId, value || null));
              setMsg(r.ok ? { ok: true, text: "Paper changed (recorded in the import log)." } : { ok: false, text: r.error });
              if (r.ok) router.refresh();
            })
          }
          data-testid="op-change-paper-save"
        >
          Change paper
        </Button>
      </div>
      <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">The year and code come from the selected paper. Not possible once questions of this import are in the Question Bank.</p>
      {msg && <p className={`mt-1 text-xs ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>{msg.text}</p>}
    </details>
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

function CurrentJobPanel({ current, canUse, canManage, aiEnabled, importerModels, selection, initialOverride }: { current: CurrentJob; canUse: boolean; canManage: boolean; aiEnabled: boolean; importerModels: string[]; selection: { mode: "auto" | "manual"; model: string | null }; initialOverride: string }) {
  const router = useRouter();
  const { card: j, verdict: v } = current;
  const [pending, start] = useTransition();
  const [clicked, setClicked] = useState(false);
  // A page-reading override chosen on the import form (AI Configuration) carries over to the confirmation.
  const [override, setOverride] = useState(initialOverride);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [expected, setExpected] = useState(String(current.mapping.expectedQuestions ?? current.estimatedQuestions ?? ""));
  const [verifyMode, setVerifyMode] = useState<"risk" | "all">("risk");
  const [confirmed, setConfirmed] = useState(false);
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
      // The cost the administrator is looking at: the server refreshes prices and refuses if the maximum went up.
      const r = await callImporter(() => processAndImportAction(j.id, { modelOverride: override || null, expectedQuestions: expected, verifyMode, confirmedMaxInr: v?.maxCostInr ?? null }));
      if (!r.ok) {
        setMsg({ text: r.error, error: true });
        setClicked(false);
        // A refused confirmation (for example a new price) stored the fresh estimate: show it and ask again.
        setConfirmed(false);
        router.refresh();
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
              {j.files.map((f) => `${f.name}${f.role === "ANSWER_KEY" ? " (answer key)" : ""}`).join(", ") || "no files"} · uploaded {j.createdAt}
            </CardDescription>
          </div>
          <Badge variant={blocked ? "warning" : toneVariant(j.tone)} data-testid="current-status">
            {blocked ? "Action needed" : j.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <PaperMapping m={current.mapping} />
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
            <div>
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
            </div>
            <div className="flex flex-col gap-2" data-testid="op-cost" data-cost-basis={v.costBasis}>
              <CostSummary estimateInr={v.estimatedCostInr} maxInr={v.maxCostInr} priced={v.costBasis !== "unknown"} breakdown={current.costLines} job={current.spend.job} month={current.spend.month} istMonth={current.spend.istMonth} />
              {v.costBasis === "zero_published" && (
                <div className="text-xs text-[var(--color-warning)]" data-testid="op-cost-zero">
                  Published free price (₹0) — a known zero, but free-price routes are often rate-limited.
                </div>
              )}
              <div className="text-xs text-[var(--color-muted-foreground)]">{v.strategyLabel}.</div>
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
            {canUse && !v.blocker && (
              <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-primary)]/40 p-3" data-testid="op-confirm">
                <h3 className="text-sm font-semibold">Confirm before starting</h3>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2" data-testid="op-confirm-summary">
                  <div>
                    <dt className="inline text-[var(--color-muted-foreground)]">Exam: </dt>
                    <dd className="inline font-medium">{current.mapping.examName}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[var(--color-muted-foreground)]">Previous Year Paper: </dt>
                    <dd className="inline font-medium" data-testid="op-confirm-paper">{current.mapping.paper ? current.mapping.paper.title : current.mapping.paperMissing ? "missing record — select a paper" : "None (Question Bank only)"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[var(--color-muted-foreground)]">Year: </dt>
                    <dd className="inline font-medium" data-testid="op-confirm-year">{current.mapping.year ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[var(--color-muted-foreground)]">Paper set / code: </dt>
                    <dd className="inline font-medium">{current.mapping.paperCode ?? "—"}</dd>
                  </div>
                </dl>
                <ChangePaper jobId={j.id} papers={current.papers} current={current.mapping.paper?.id ?? null} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="op-confirm-expected">Expected number of questions</Label>
                    <Input id="op-confirm-expected" inputMode="numeric" maxLength={4} value={expected} onChange={(e) => setExpected(e.target.value.replace(/\D/g, ""))} data-testid="op-confirm-expected" />
                    <span className="text-xs text-[var(--color-muted-foreground)]">{current.estimatedQuestions ? `The analyzer counted about ${current.estimatedQuestions} — check it against the paper.` : "Check it against the paper."}</span>
                  </div>
                  {aiEnabled && current.verifyAvailable && (
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="op-verify-mode">Independent verification</Label>
                      <SelectNative id="op-verify-mode" value={verifyMode} onChange={(e) => setVerifyMode(e.target.value === "all" ? "all" : "risk")} data-testid="op-verify-mode">
                        <option value="risk">Scanned and low-confidence pages (default)</option>
                        <option value="all">Every page (higher cost — included in the price you confirm)</option>
                      </SelectNative>
                      <span className="text-xs text-[var(--color-muted-foreground)]">A second, different model reads the original page without seeing the first result. Agreement is evidence, not proof.</span>
                    </div>
                  )}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="op-confirm-check" />
                  <span>The exam, Previous Year Paper and expected question count above are correct, and I accept the estimated cost shown.</span>
                </label>
                <div className="flex flex-col gap-1">
                  <Button size="lg" className="w-full sm:w-auto sm:self-start" disabled={!v.canProcess || pending || clicked || !confirmed || !/^\d{1,4}$/.test(expected) || current.mapping.paperMissing} onClick={processNow} data-testid="process-import">
                    {pending || clicked ? "Starting…" : "Confirm Cost & Start Processing"}
                  </Button>
                  <p className="text-xs text-[var(--color-muted-foreground)]">Questions are extracted and checked. Nothing enters the Question Bank until you review and approve it; approved questions are added as Draft and are never published automatically.</p>
                </div>
              </div>
            )}
          </div>
        )}

        {(j.status === "QUEUED" || j.status === "PROCESSING" || j.status === "IMPORTING" || j.status === "PAUSED" || j.status === "PAUSED_BUDGET") && (
          <div className="flex flex-col gap-2" data-testid="op-progress">
            <p className="text-sm font-medium" data-testid="op-stage">
              {j.label}
              {j.status === "PROCESSING" && current.stage ? "" : j.status === "QUEUED" ? " — waiting for the worker" : ""}
              …
            </p>
            {j.pages.total > 0 && (
              <>
                <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-border)]" role="progressbar" aria-valuemin={0} aria-valuemax={j.pages.total} aria-valuenow={j.pages.done + j.pages.skipped + j.pages.failed}>
                  <span className="block h-full bg-[var(--color-primary)] transition-[width]" style={{ width: `${Math.round(((j.pages.done + j.pages.skipped + j.pages.failed) / j.pages.total) * 100)}%` }} />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4" data-testid="op-live">
                  <div>Pages: <strong>{j.pages.done}</strong> of {j.pages.total} done</div>
                  <div>Failed: <strong className={j.pages.failed ? "text-[var(--color-error)]" : ""}>{j.pages.failed}</strong></div>
                  <div>Retrying / waiting: <strong>{current.quality?.pages.retrying ?? 0}</strong> / {current.quality?.pages.pending ?? j.pages.pending}</div>
                  <div>Skipped: <strong>{j.pages.skipped}</strong></div>
                  <div>Expected: <strong>{current.mapping.expectedQuestions ?? "—"}</strong></div>
                  <div>Extracted: <strong>{c.extracted}</strong></div>
                  <div>Verified: <strong>{current.quality?.verified ?? 0}</strong></div>
                </dl>
              </>
            )}
            <div data-testid="op-live-cost">
              <CostSummary estimateInr={v?.estimatedCostInr ?? null} maxInr={j.maxCostInr} priced={j.maxCostInr !== null} job={current.spend.job} month={current.spend.month} istMonth={current.spend.istMonth} />
            </div>
          </div>
        )}

        {finished && (
          <div data-testid="op-final-cost">
            <CostSummary estimateInr={v?.estimatedCostInr ?? null} maxInr={j.maxCostInr} priced={j.maxCostInr !== null} job={current.spend.job} month={current.spend.month} istMonth={current.spend.istMonth} />
          </div>
        )}
        {finished && current.quality && <QualityPanel jobId={j.id} report={current.quality} canUse={canUse} jobStatus={j.status} files={current.files} runIds={j.runIds} />}
        {finished && canUse && !j.counts.imported && <ChangePaper jobId={j.id} papers={current.papers} current={current.mapping.paper?.id ?? null} />}

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
  limits: { maxFileMb: number; maxPagesPerFile: number };
  aiEnabled: boolean;
  selection: { mode: "auto" | "manual"; model: string | null };
  importerModels: string[];
  ai: AiConfigView;
  initialOverride: string;
  current: CurrentJob | null;
  missingJob: boolean;
  recent: JobCard[];
}) {
  const { current } = props;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Question Importer</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">Fill in the import, click Submit &amp; Analyze, check the analysis and cost, then confirm processing. Questions enter the Question Bank as Draft through the existing Bulk Import.</p>
      </div>
      {props.missingJob && (
        <p className="text-sm text-[var(--color-warning)]" data-testid="op-missing-job">
          That import no longer exists (it may have been deleted). Upload a file to start a new one.
        </p>
      )}
      {current ? (
        <CurrentJobPanel current={current} canUse={props.canUse} canManage={props.canManage} aiEnabled={props.aiEnabled} importerModels={props.importerModels} selection={props.selection} initialOverride={props.initialOverride} />
      ) : props.canUse ? (
        <UploadCard exams={props.exams} defaultExamId={props.defaultExamId} limits={props.limits} ai={props.ai} importerModels={props.importerModels} canManage={props.canManage} />
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
