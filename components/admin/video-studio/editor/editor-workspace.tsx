"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download, Film, Play, RotateCcw, Save, Scissors, Subtitles, Trash2, Type, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { AssetsPanel } from "@/components/admin/video-studio/assets-panel";
import { SfxPanel } from "@/components/admin/video-studio/editor/sfx-panel";
import { mediaUrl } from "@/components/admin/video-studio/upload";
import {
  confirmTranscriptionAction,
  estimateTranscriptionAction,
  exportEditAction,
  processUploadsAction,
  resetEditAction,
  retryVideoJobAction,
  saveEditAction,
  cancelVideoJobAction,
} from "@/app/admin/(dashboard)/video-studio/actions";
import { formatInr } from "@/lib/ai-engine/config";
import { readyDesigns } from "@/lib/video-studio/designs";
import { ASPECTS } from "@/lib/video-studio/types";
import {
  FITS,
  LIMITS,
  POSITIONS,
  SUB_STYLES,
  TEXT_STYLES,
  newId,
  outputCues,
  outputDuration,
  outputToSource,
  segmentOffsets,
  splitAt,
  type EditOverlay,
  type EditProject,
} from "@/lib/video-studio/editor-model";
import type { JobAsset } from "@/lib/video-studio/assets";

/**
 * AI Video Editor — the editing workspace for one EDIT job. Every edit is
 * local until "Save" / "Export": the server re-validates the whole project
 * against the job's own files (lib/video-studio/editor-model.ts). Preview
 * plays the low-resolution proxies in edit order; the export is rendered by
 * the isolated render container (local, no provider charge). The only paid
 * step is transcription, which shows its price and needs a confirmation.
 */

export interface EditorJob {
  id: string;
  title: string;
  status: string;
  stage: string | null;
  progressPct: number;
  failedStage: string | null;
  errorMessage: string | null;
  outputKey: string | null;
  outputBytes: number | null;
  outputSec: number | null;
  renderMs: number | null;
  mediaDeleted: boolean;
  actualInr: number;
  unknownCostCalls: number;
  transcribePending: { nonce: string; model: string; language: string | null; seconds: number; estInr: number; maxInr: number; expiresAt: string; runnable: boolean; blockReason: string | null } | null;
  transcript: string | null;
}

const RUNNING = ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING"];
const STAGE_LABEL: Record<string, string> = { ingest: "Checking uploads and making previews", transcribe: "Transcribing the recording", export: "Exporting the MP4" };
const EDITABLE = ["REVIEW_REQUIRED", "COMPLETED", "FAILED"];

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export function EditorWorkspace({
  canUse,
  job,
  project: saved,
  assets,
  events,
  sttModels,
  defaultSttModel,
  wordmark,
}: {
  canUse: boolean;
  job: EditorJob;
  project: EditProject | null;
  assets: JobAsset[];
  events: { id: string; type: string; message: string; at: string }[];
  sttModels: { id: string; name: string; perSecondUsd: number }[];
  defaultSttModel: string | null;
  wordmark: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [p, setP] = useState<EditProject | null>(saved);
  const [dirty, setDirty] = useState(false);
  const running = RUNNING.includes(job.status);
  const editable = canUse && EDITABLE.includes(job.status) && !job.mediaDeleted;
  const processing = assets.filter((a) => a.state === "processing");
  const byKey = useMemo(() => new Map(assets.map((a) => [a.key, a])), [assets]);

  // A new save from the server (or the worker's subtitles) replaces the local copy unless the admin has unsaved changes.
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    if (!dirty) setP(saved);
  }

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [running, router]);

  function change(next: EditProject) {
    setP(next);
    setDirty(true);
  }

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string, after?: () => void) {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed.");
      else {
        if (done) setNotice(done);
        after?.();
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-5" data-testid="editor-workspace">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{job.title}</h2>
        <JobStatusBadge status={job.status} />
        <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="editor-cost">
          AI cost so far: {formatInr(job.actualInr, 2)}
          {job.unknownCostCalls ? ` (+${job.unknownCostCalls} call(s) with unknown cost)` : ""}
        </span>
        {canUse && (EDITABLE.includes(job.status) || job.status === "DRAFT") ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(() => cancelVideoJobAction(job.id), "Project cancelled — its files are cleaned up.")} data-testid="cancel-edit">
            Cancel project
          </Button>
        ) : null}
      </div>

      {error ? <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-sm" data-testid="editor-error">{error}</p> : null}
      {notice ? <p role="status" className="rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm" data-testid="editor-notice">{notice}</p> : null}

      {running ? (
        <Card data-testid="progress-card">
          <CardContent className="flex flex-col gap-2 py-4">
            <p className="text-sm font-medium">{STAGE_LABEL[job.stage ?? ""] ?? (job.status === "QUEUED" ? "Waiting for the worker" : "Working")}…</p>
            <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-muted)]" role="progressbar" aria-valuenow={job.progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-[var(--color-primary)] transition-all" style={{ width: `${Math.max(3, job.progressPct)}%` }} />
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">{job.progressPct}% · the page updates automatically. Processing pauses while a Live CBT is running.</p>
          </CardContent>
        </Card>
      ) : null}

      {job.status === "FAILED" ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm" data-testid="failed-card">
            <AlertTriangle className="h-4 w-4 text-[var(--color-error)]" aria-hidden />
            <span className="min-w-0 flex-1">Step “{job.failedStage}” failed{job.errorMessage ? `: ${job.errorMessage}` : "."}</span>
            {canUse ? (
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => act(() => retryVideoJobAction(job.id), "Retry queued.")} data-testid="retry-job">
                <RotateCcw className="h-4 w-4" aria-hidden /> Retry
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {job.outputKey && !job.mediaDeleted ? (
        <Card data-testid="output-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Film className="h-4 w-4" aria-hidden /> Exported video</CardTitle>
            <CardDescription>
              MP4 (H.264 / AAC) · {job.outputSec?.toFixed(1)} s · {((job.outputBytes ?? 0) / 1024 / 1024).toFixed(1)} MB{job.renderMs ? ` · exported in ${Math.round(job.renderMs / 1000)} s on this server` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <video controls preload="metadata" className="max-h-[70vh] w-full rounded-[var(--radius-card)] bg-black" src={mediaUrl(job.id, job.outputKey)} data-testid="output-video" />
            <div>
              <a href={mediaUrl(job.id, job.outputKey, true)} className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-foreground)]" data-testid="download-mp4">
                <Download className="h-4 w-4" aria-hidden /> Download MP4
              </a>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Upload className="h-4 w-4" aria-hidden /> Files</CardTitle>
          <CardDescription>Your recording, plus optional images, B-roll clips and licensed music. Files are checked by their content, kept only for the retention period, and never published by themselves.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <AssetsPanel
            jobId={job.id}
            assets={assets}
            canUse={canUse && !running && !job.mediaDeleted}
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,image/png,image/jpeg,image/webp,audio/mpeg,audio/mp4,audio/wav,audio/x-wav"
            hint="MP4, MOV, WebM or MKV video · PNG / JPEG / WebP images · MP3 / M4A / WAV music"
            pagesEditable={false}
            testId="editor-assets"
          />
          {processing.length && canUse && !running ? (
            <div>
              <Button type="button" disabled={pending} onClick={() => act(() => processUploadsAction(job.id), "Uploads queued for checking.")} data-testid="process-uploads">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Check {processing.length} upload(s) and make previews (free)
              </Button>
            </div>
          ) : null}
          {!p && editable && assets.some((a) => a.kind === "video" && a.state === "ready") ? (
            <div>
              <Button type="button" disabled={pending} onClick={() => act(() => resetEditAction(job.id), "Edit started from the full recording.")} data-testid="start-edit">
                Start editing
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {p ? (
        <EditorBody
          job={job}
          p={p}
          change={change}
          byKey={byKey}
          assets={assets}
          editable={editable}
          pending={pending}
          wordmark={wordmark}
          dirty={dirty}
          sttModels={sttModels}
          defaultSttModel={defaultSttModel}
          onSave={() => act(() => saveEditAction(job.id, p), "Edit saved.", () => setDirty(false))}
          onExport={() => act(() => exportEditAction(job.id, p), "Export queued — rendered locally, no provider charge.", () => setDirty(false))}
          onReset={() => act(() => resetEditAction(job.id), "Edit reset to the full recording.", () => setDirty(false))}
          onEstimate={(model, language) => act(() => estimateTranscriptionAction(job.id, { model, language }))}
          onConfirmTranscribe={(nonce) => act(() => confirmTranscriptionAction(job.id, nonce), "Transcription confirmed — subtitles will appear when it finishes.", () => setDirty(false))}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-xs" data-testid="editor-events">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="shrink-0 text-[var(--color-muted-foreground)]">{new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</span>
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function EditorBody({
  job,
  p,
  change,
  byKey,
  assets,
  editable,
  pending,
  wordmark,
  dirty,
  sttModels,
  defaultSttModel,
  onSave,
  onExport,
  onReset,
  onEstimate,
  onConfirmTranscribe,
}: {
  job: EditorJob;
  p: EditProject;
  change: (p: EditProject) => void;
  byKey: Map<string, JobAsset>;
  assets: JobAsset[];
  editable: boolean;
  pending: boolean;
  wordmark: string;
  dirty: boolean;
  sttModels: { id: string; name: string; perSecondUsd: number }[];
  defaultSttModel: string | null;
  onSave: () => void;
  onExport: () => void;
  onReset: () => void;
  onEstimate: (model: string, language: string) => void;
  onConfirmTranscribe: (nonce: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [outT, setOutT] = useState(0);
  const [seq, setSeq] = useState<{ index: number } | null>(null);
  const [stt, setStt] = useState({ model: defaultSttModel && sttModels.some((m) => m.id === defaultSttModel) ? defaultSttModel : (sttModels[0]?.id ?? ""), language: "auto" });
  const [approveStt, setApproveStt] = useState(false);
  const total = outputDuration(p);
  const offs = segmentOffsets(p);
  const cues = outputCues(p);
  const videos = assets.filter((a) => a.kind === "video" && a.state === "ready");
  const images = assets.filter((a) => a.kind === "image" && a.state === "ready");
  const music = assets.filter((a) => a.kind === "music" && a.state === "ready");
  const tp = job.transcribePending && new Date(job.transcribePending.expiresAt) > new Date() ? job.transcribePending : null;
  const at = outputToSource(p, outT);
  const srcOf = (key: string) => {
    const a = byKey.get(key);
    return mediaUrl(job.id, a?.proxyKey ?? key);
  };

  /** Shows the frame at an output time (loads the right proxy, seeks inside it). */
  function seek(t: number) {
    const hit = outputToSource(p, Math.max(0, Math.min(total, t)));
    setOutT(Math.max(0, Math.min(total, t)));
    const v = video.current;
    if (!hit || !v) return;
    const url = srcOf(hit.src);
    if (!v.src.endsWith(url)) {
      v.src = url;
      v.addEventListener("loadedmetadata", () => (v.currentTime = hit.time), { once: true });
    } else v.currentTime = hit.time;
  }

  function playSequence() {
    setSeq({ index: 0 });
    const v = video.current;
    const s = p.segments[0];
    if (!v || !s) return;
    const url = srcOf(s.src);
    const go = () => {
      v.currentTime = s.in;
      void v.play();
    };
    if (!v.src.endsWith(url)) {
      v.src = url;
      v.addEventListener("loadedmetadata", go, { once: true });
    } else go();
  }

  function onTime() {
    const v = video.current;
    if (!v) return;
    if (seq) {
      const s = p.segments[seq.index];
      if (!s) return;
      setOutT(offs[seq.index] + Math.max(0, v.currentTime - s.in));
      if (v.currentTime >= s.out - 0.04) {
        const next = seq.index + 1;
        const n = p.segments[next];
        if (!n) {
          v.pause();
          setSeq(null);
          return;
        }
        setSeq({ index: next });
        const url = srcOf(n.src);
        if (!v.src.endsWith(url)) {
          v.src = url;
          v.addEventListener("loadedmetadata", () => { v.currentTime = n.in; void v.play(); }, { once: true });
        } else v.currentTime = n.in;
      }
    } else if (at) {
      const seg = p.segments[at.index];
      if (seg && v.src.endsWith(srcOf(seg.src))) setOutT(offs[at.index] + Math.max(0, Math.min(seg.out, v.currentTime) - seg.in));
    }
  }

  const visibleOverlays = p.overlays.filter((o) => outT >= o.start && outT < o.end && (o.kind === "text" || o.kind === "diagram"));
  const cue = cues.find((c) => outT >= c.start && outT < c.end);
  const setSeg = (i: number, patch: Partial<EditProject["segments"][number]>) => change({ ...p, segments: p.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveSeg = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= p.segments.length) return;
    const segments = [...p.segments];
    [segments[i], segments[j]] = [segments[j], segments[i]];
    change({ ...p, segments });
  };
  const setOv = (id: string, patch: Partial<EditOverlay>) => change({ ...p, overlays: p.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
  const addOv = (ov: Omit<EditOverlay, "id" | "start" | "end">) => {
    if (p.overlays.length >= LIMITS.overlays) return;
    const start = Math.min(outT, Math.max(0, total - 1));
    change({ ...p, overlays: [...p.overlays, { id: newId(), start: Math.round(start * 10) / 10, end: Math.round(Math.min(total, start + 4) * 10) / 10, ...ov }] });
  };
  const portrait = p.aspect === "9:16" || p.aspect === "4:5";

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Scissors className="h-4 w-4" aria-hidden /> Timeline</CardTitle>
          <CardDescription>
            {p.segments.length} segment(s) · output {fmt(total)} · preview uses low-resolution copies; the export uses the original files. Your recording is never modified.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            <div className={`relative mx-auto w-full overflow-hidden rounded-[var(--radius-card)] bg-black ${portrait ? "max-w-[300px]" : ""}`} style={{ aspectRatio: p.aspect.replace(":", " / ") }}>
              <video ref={video} className={`absolute inset-0 h-full w-full ${p.fit === "crop" ? "object-cover" : "object-contain"}`} playsInline preload="metadata" onTimeUpdate={onTime} onPause={() => setSeq(null)} src={p.segments[0] ? srcOf(p.segments[0].src) : undefined} data-testid="editor-preview" />
              {visibleOverlays.map((o) => (
                <div key={o.id} className={`pointer-events-none absolute inset-x-3 text-center ${o.position === "bottom" ? "bottom-16" : o.position === "center" ? "top-1/2 -translate-y-1/2" : "top-6"}`} data-testid="preview-overlay">
                  <span className="rounded bg-[var(--color-warning)] px-2 py-0.5 text-xs font-bold text-black">{o.kind === "diagram" ? (o.nodes ?? []).join(" → ") : o.text}</span>
                </div>
              ))}
              {cue ? (
                <div className="pointer-events-none absolute inset-x-3 bottom-6 text-center" data-testid="preview-cue">
                  <span className={`px-1.5 py-0.5 text-xs font-semibold text-white ${p.subtitles.style === "boxed" ? "rounded bg-black/70" : ""}`} lang="hi">{cue.text}</span>
                </div>
              ) : null}
              {p.branding ? <span className="pointer-events-none absolute right-2 top-2 text-[10px] font-semibold text-white/80">{wordmark}</span> : null}
            </div>
            <input type="range" aria-label="Playhead" min={0} max={Math.max(0.1, total)} step={0.1} value={Math.min(outT, total)} onChange={(e) => seek(Number(e.target.value))} data-testid="playhead" />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono" data-testid="playhead-time">{fmt(outT)} / {fmt(total)}</span>
              <Button type="button" size="sm" variant="outline" onClick={playSequence} data-testid="play-sequence">
                <Play className="h-4 w-4" aria-hidden /> Play edit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!editable}
                onClick={() => {
                  const n = splitAt(p, outT);
                  if (n) change(n);
                }}
                data-testid="split"
              >
                <Scissors className="h-4 w-4" aria-hidden /> Split at playhead
              </Button>
            </div>
          </div>
          <ol className="flex flex-col gap-2" data-testid="segments">
            {p.segments.map((s, i) => {
              const a = byKey.get(s.src);
              const dur = a?.durationSec ?? s.out;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-xs" data-segment={i}>
                  <button type="button" className="font-mono text-[var(--color-primary)] underline-offset-2 hover:underline" onClick={() => seek(offs[i] + 0.01)}>
                    #{i + 1} @ {fmt(offs[i])}
                  </button>
                  <span className="min-w-0 max-w-40 truncate text-[var(--color-muted-foreground)]">{a?.name ?? s.src}</span>
                  <label className="flex items-center gap-1">
                    In
                    <Input type="number" step={0.1} min={0} max={s.out - 0.2} className="h-7 w-20 text-xs" disabled={!editable} value={s.in} onChange={(e) => setSeg(i, { in: Math.max(0, Math.min(s.out - 0.2, Number(e.target.value))) })} aria-label={`Segment ${i + 1} in`} />
                  </label>
                  <label className="flex items-center gap-1">
                    Out
                    <Input type="number" step={0.1} min={s.in + 0.2} max={dur} className="h-7 w-20 text-xs" disabled={!editable} value={s.out} onChange={(e) => setSeg(i, { out: Math.min(dur, Math.max(s.in + 0.2, Number(e.target.value))) })} aria-label={`Segment ${i + 1} out`} />
                  </label>
                  <label className="flex items-center gap-1">
                    Vol
                    <Input type="number" step={0.1} min={0} max={2} className="h-7 w-16 text-xs" disabled={!editable} value={s.volume} onChange={(e) => setSeg(i, { volume: Math.max(0, Math.min(2, Number(e.target.value))) })} aria-label={`Segment ${i + 1} volume`} />
                  </label>
                  <span className="ml-auto flex gap-1">
                    <Button type="button" size="sm" variant="outline" aria-label="Move up" disabled={!editable || i === 0} onClick={() => moveSeg(i, -1)}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></Button>
                    <Button type="button" size="sm" variant="outline" aria-label="Move down" disabled={!editable || i === p.segments.length - 1} onClick={() => moveSeg(i, 1)}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></Button>
                    <Button type="button" size="sm" variant="outline" aria-label={`Delete segment ${i + 1}`} disabled={!editable || p.segments.length < 2} onClick={() => change({ ...p, segments: p.segments.filter((_, j) => j !== i) })} data-testid="delete-segment"><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
                  </span>
                </li>
              );
            })}
            {videos.length > 1 && editable ? (
              <li className="flex flex-wrap items-center gap-2 text-xs">
                <span>Append clip:</span>
                {videos.map((v) => (
                  <Button key={v.key} type="button" size="sm" variant="outline" disabled={p.segments.length >= LIMITS.segments} onClick={() => change({ ...p, segments: [...p.segments, { id: newId(), src: v.key, in: 0, out: v.durationSec ?? 1, volume: 1 }] })}>
                    {v.name}
                  </Button>
                ))}
              </li>
            ) : null}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Subtitles className="h-4 w-4" aria-hidden /> Subtitles</CardTitle>
          <CardDescription>
            Generate them from your recording&apos;s speech (OpenRouter speech-to-text — the price is shown before you confirm), or type them by hand. Times are in the original recording, so trimming never puts them out of sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2"><input type="checkbox" disabled={!editable} checked={p.subtitles.on} onChange={(e) => change({ ...p, subtitles: { ...p.subtitles, on: e.target.checked } })} data-testid="subs-on" /> Show subtitles</label>
            <SelectNative aria-label="Subtitle style" className="h-8 w-auto" disabled={!editable} value={p.subtitles.style} onChange={(e) => change({ ...p, subtitles: { ...p.subtitles, style: e.target.value as EditProject["subtitles"]["style"] } })}>
              {SUB_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
            </SelectNative>
            <span className="text-xs text-[var(--color-muted-foreground)]">{p.subtitles.cues.length} cue(s)</span>
          </div>
          {editable ? (
            sttModels.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <SelectNative aria-label="Transcription model" className="h-8 w-auto max-w-full" value={stt.model} onChange={(e) => setStt({ ...stt, model: e.target.value })} data-testid="stt-choice">
                  {sttModels.map((m) => <option key={m.id} value={m.id}>{m.name} · ${(m.perSecondUsd * 60).toFixed(4)}/min</option>)}
                </SelectNative>
                <SelectNative aria-label="Spoken language" className="h-8 w-auto" value={stt.language} onChange={(e) => setStt({ ...stt, language: e.target.value })}>
                  <option value="auto">Detect language</option>
                  <option value="hi">Hindi / Hinglish</option>
                  <option value="en">English</option>
                </SelectNative>
                <Button type="button" size="sm" variant="outline" disabled={pending || !stt.model} onClick={() => { setApproveStt(false); onEstimate(stt.model, stt.language); }} data-testid="estimate-transcribe">
                  Review subtitle price
                </Button>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-muted-foreground)]">No per-second transcription model is available — sync the catalog in Voice Studio, or type subtitles by hand.</p>
            )
          ) : null}
          {tp && editable ? (
            <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="transcribe-estimate">
              <p>
                <b>{tp.model}</b> · {Math.round(tp.seconds)} s of audio: <b data-testid="transcribe-inr">{formatInr(tp.estInr, 2)}</b> <span className="text-xs text-[var(--color-muted-foreground)]">(max {formatInr(tp.maxInr, 2)})</span>
              </p>
              {tp.runnable ? (
                <>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={approveStt} onChange={(e) => setApproveStt(e.target.checked)} data-testid="approve-transcribe" />
                    Send this recording&apos;s audio to {tp.model} through OpenRouter and generate subtitles. Existing subtitle cues are replaced.
                  </label>
                  <div>
                    <Button type="button" variant="cta" disabled={!approveStt || pending || dirty} title={dirty ? "Save your edit first." : undefined} onClick={() => onConfirmTranscribe(tp.nonce)} data-testid="confirm-transcribe">
                      <CheckCircle2 className="h-4 w-4" aria-hidden /> Confirm &amp; transcribe (paid)
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-[var(--color-warning)]">{tp.blockReason}</p>
              )}
            </div>
          ) : null}
          <ol className="flex max-h-80 flex-col gap-1 overflow-y-auto" data-testid="cues">
            {p.subtitles.cues.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Input type="number" step={0.1} className="h-7 w-20 text-xs" aria-label="Cue start" disabled={!editable} value={c.start} onChange={(e) => change({ ...p, subtitles: { ...p.subtitles, cues: p.subtitles.cues.map((x) => (x.id === c.id ? { ...x, start: Number(e.target.value) } : x)) } })} />
                <Input type="number" step={0.1} className="h-7 w-20 text-xs" aria-label="Cue end" disabled={!editable} value={c.end} onChange={(e) => change({ ...p, subtitles: { ...p.subtitles, cues: p.subtitles.cues.map((x) => (x.id === c.id ? { ...x, end: Number(e.target.value) } : x)) } })} />
                <Input className="h-7 min-w-0 flex-1 text-xs" aria-label="Cue text" lang="hi" maxLength={LIMITS.text} disabled={!editable} value={c.text} onChange={(e) => change({ ...p, subtitles: { ...p.subtitles, cues: p.subtitles.cues.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)) } })} />
                <Button type="button" size="sm" variant="outline" aria-label="Delete cue" disabled={!editable} onClick={() => change({ ...p, subtitles: { ...p.subtitles, cues: p.subtitles.cues.filter((x) => x.id !== c.id) } })}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
              </li>
            ))}
          </ol>
          {editable ? (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={p.subtitles.cues.length >= LIMITS.cues || !at || at.src !== p.primary}
                title={at && at.src !== p.primary ? "Cues belong to the main recording — move the playhead onto it." : undefined}
                onClick={() => {
                  if (!at) return;
                  const cuesNext = [...p.subtitles.cues, { id: newId(), start: at.time, end: at.time + 2, text: "Subtitle" }].sort((a, b) => a.start - b.start);
                  change({ ...p, subtitles: { ...p.subtitles, cues: cuesNext } });
                }}
                data-testid="add-cue"
              >
                Add cue at playhead
              </Button>
            </div>
          ) : null}
          {job.transcript ? (
            <details className="text-xs">
              <summary className="cursor-pointer">Full transcript</summary>
              <p className="mt-1 whitespace-pre-wrap" lang="hi">{job.transcript}</p>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Type className="h-4 w-4" aria-hidden /> Overlays</CardTitle>
          <CardDescription>Titles, lower thirds, simple flow diagrams, images, picture-in-picture and full-frame B-roll. Times are on the output timeline; new overlays start at the playhead.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {editable ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => addOv({ kind: "text", text: "Title", style: "title", position: "top" })} data-testid="add-text">+ Text</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => addOv({ kind: "diagram", text: "", nodes: ["Step 1", "Step 2", "Step 3"], position: "center" })} data-testid="add-diagram">+ Diagram</Button>
              {images.length ? <Button type="button" size="sm" variant="outline" onClick={() => addOv({ kind: "image", assetKey: images[0].key })} data-testid="add-image">+ Image</Button> : null}
              {videos.length > 1 || images.length ? <Button type="button" size="sm" variant="outline" onClick={() => addOv({ kind: "pip", assetKey: (videos.find((v) => v.key !== p.primary) ?? images[0] ?? videos[0]).key })}>+ Picture-in-picture</Button> : null}
              {videos.length > 1 || images.length ? <Button type="button" size="sm" variant="outline" onClick={() => addOv({ kind: "broll", assetKey: (videos.find((v) => v.key !== p.primary) ?? images[0] ?? videos[0]).key })}>+ B-roll</Button> : null}
            </div>
          ) : null}
          <ol className="flex flex-col gap-2" data-testid="overlays">
            {p.overlays.map((o) => (
              <li key={o.id} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-xs" data-overlay={o.kind}>
                <div className="flex flex-wrap items-center gap-2">
                  <b className="uppercase">{o.kind}</b>
                  <label className="flex items-center gap-1">From<Input type="number" step={0.1} className="h-7 w-20 text-xs" disabled={!editable} value={o.start} onChange={(e) => setOv(o.id, { start: Number(e.target.value) })} /></label>
                  <label className="flex items-center gap-1">To<Input type="number" step={0.1} className="h-7 w-20 text-xs" disabled={!editable} value={o.end} onChange={(e) => setOv(o.id, { end: Number(e.target.value) })} /></label>
                  {o.kind === "text" || o.kind === "diagram" ? (
                    <SelectNative aria-label="Position" className="h-7 w-auto text-xs" disabled={!editable} value={o.position ?? "top"} onChange={(e) => setOv(o.id, { position: e.target.value as EditOverlay["position"] })}>
                      {POSITIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </SelectNative>
                  ) : null}
                  {o.kind === "text" ? (
                    <SelectNative aria-label="Text style" className="h-7 w-auto text-xs" disabled={!editable} value={o.style ?? "title"} onChange={(e) => setOv(o.id, { style: e.target.value as EditOverlay["style"] })}>
                      {TEXT_STYLES.map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}
                    </SelectNative>
                  ) : null}
                  {o.kind === "image" || o.kind === "pip" || o.kind === "broll" ? (
                    <SelectNative aria-label="File" className="h-7 w-auto max-w-48 text-xs" disabled={!editable} value={o.assetKey ?? ""} onChange={(e) => setOv(o.id, { assetKey: e.target.value })}>
                      {(o.kind === "image" ? images : [...videos.filter((v) => v.key !== p.primary), ...images]).map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
                    </SelectNative>
                  ) : null}
                  <Button type="button" size="sm" variant="outline" className="ml-auto" aria-label="Delete overlay" disabled={!editable} onClick={() => change({ ...p, overlays: p.overlays.filter((x) => x.id !== o.id) })}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
                </div>
                {o.kind === "text" ? (
                  <div className="flex flex-wrap gap-2">
                    <Input className="h-7 min-w-0 flex-1 text-xs" aria-label="Text" lang="hi" maxLength={LIMITS.text} disabled={!editable} value={o.text ?? ""} onChange={(e) => setOv(o.id, { text: e.target.value })} />
                    <Input className="h-7 min-w-0 flex-1 text-xs" aria-label="Second line" placeholder="Second line (optional)" lang="hi" maxLength={LIMITS.text} disabled={!editable} value={o.subtext ?? ""} onChange={(e) => setOv(o.id, { subtext: e.target.value })} />
                  </div>
                ) : o.kind === "diagram" ? (
                  <div className="flex flex-wrap gap-2">
                    <Input className="h-7 w-48 text-xs" aria-label="Diagram title" placeholder="Title (optional)" maxLength={90} disabled={!editable} value={o.text ?? ""} onChange={(e) => setOv(o.id, { text: e.target.value })} />
                    <Input className="h-7 min-w-0 flex-1 text-xs" aria-label="Diagram steps" placeholder="Steps separated by →  or commas (2–6)" disabled={!editable} value={(o.nodes ?? []).join(", ")} onChange={(e) => setOv(o.id, { nodes: e.target.value.split(/,|→/).map((x) => x.trim()).filter(Boolean).slice(0, 6) })} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <SfxPanel p={p} change={change} editable={editable} playhead={outT} seek={seek} sequencePlaying={seq !== null} />

      <Card>
        <CardHeader>
          <CardTitle>Output, audio and branding</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <fieldset disabled={!editable} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1">Aspect ratio
              <SelectNative value={p.aspect} onChange={(e) => change({ ...p, aspect: e.target.value as EditProject["aspect"] })} data-testid="edit-aspect">
                {ASPECTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1">Fit
              <SelectNative value={p.fit} onChange={(e) => change({ ...p, fit: e.target.value as EditProject["fit"] })}>
                {FITS.map((f) => <option key={f} value={f}>{f === "blur" ? "Blurred background fill" : f === "crop" ? "Crop to fill" : "Pad with colour"}</option>)}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1">Transition between segments
              <SelectNative value={p.transition} onChange={(e) => change({ ...p, transition: e.target.value as EditProject["transition"] })}>
                <option value="none">Cut</option>
                <option value="fade">Cross-fade (0.5 s)</option>
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1">Look (overlay colours)
              <SelectNative value={p.designKey} onChange={(e) => change({ ...p, designKey: e.target.value })}>
                {readyDesigns(p.aspect).map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1">Voice volume
              <Input type="number" step={0.1} min={0} max={2} value={p.audio.volume} onChange={(e) => change({ ...p, audio: { ...p.audio, volume: Number(e.target.value) } })} />
            </label>
            <label className="flex flex-col gap-1">Fade in / out (s)
              <span className="flex gap-2">
                <Input type="number" step={0.5} min={0} max={5} aria-label="Fade in" value={p.audio.fadeInSec} onChange={(e) => change({ ...p, audio: { ...p.audio, fadeInSec: Number(e.target.value) } })} />
                <Input type="number" step={0.5} min={0} max={5} aria-label="Fade out" value={p.audio.fadeOutSec} onChange={(e) => change({ ...p, audio: { ...p.audio, fadeOutSec: Number(e.target.value) } })} />
              </span>
            </label>
            <label className="flex flex-col gap-1">Background music
              <SelectNative value={p.audio.musicKey ?? ""} onChange={(e) => change({ ...p, audio: { ...p.audio, musicKey: e.target.value || null } })} data-testid="edit-music">
                <option value="">None</option>
                {music.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
              </SelectNative>
            </label>
            <label className="flex flex-col gap-1">Music level (%)
              <Input type="number" min={0} max={60} value={p.audio.musicVolumePct} onChange={(e) => change({ ...p, audio: { ...p.audio, musicVolumePct: Number(e.target.value) } })} />
            </label>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.audio.clean} onChange={(e) => change({ ...p, audio: { ...p.audio, clean: e.target.checked } })} /> Clean up voice (noise &amp; hum filter)</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={p.branding} onChange={(e) => change({ ...p, branding: e.target.checked })} /> Show {wordmark} branding</label>
            </div>
          </fieldset>
          {editable ? (
            <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
              <Button type="button" variant="outline" disabled={!editable || pending || !dirty} onClick={onSave} data-testid="save-edit">
                <Save className="h-4 w-4" aria-hidden /> Save edit
              </Button>
              <Button type="button" variant="cta" disabled={!editable || pending} onClick={onExport} data-testid="export-edit">
                <Film className="h-4 w-4" aria-hidden /> Export MP4 (local, free)
              </Button>
              <Button type="button" variant="outline" disabled={!editable || pending} onClick={onReset} data-testid="reset-edit">
                <RotateCcw className="h-4 w-4" aria-hidden /> Reset to full recording
              </Button>
              {dirty ? <span className="self-center text-xs text-[var(--color-warning)]">Unsaved changes</span> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
