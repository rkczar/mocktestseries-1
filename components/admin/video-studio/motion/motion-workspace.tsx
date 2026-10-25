"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, CircleAlert, CircleCheck, Download, Film, Mic, RefreshCw, RotateCcw, Sparkles, Trash2, VolumeX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { AssetsPanel } from "@/components/admin/video-studio/assets-panel";
import { mediaUrl } from "@/components/admin/video-studio/upload";
import { MotionFramePreview } from "@/components/admin/video-studio/motion/frame-preview";
import {
  cancelMotionAction,
  confirmMotionScriptAction,
  confirmMotionVoiceAction,
  estimateMotionVoiceAction,
  moveMotionFrameAction,
  renderMotionSilentAction,
  requestMotionEstimateAction,
  rerenderMotionAction,
  retryMotionAction,
  updateMotionConfigAction,
  updateMotionFrameAction,
  planFromScriptAction,
} from "@/app/admin/(dashboard)/video-studio/motion/actions";
import { formatInr } from "@/lib/ai-engine/config";
import { ASPECTS } from "@/lib/video-studio/types";
import { MOTION_LABELS, MOTION_STYLES, MOTION_STYLE_MAP, type MotionKey } from "@/lib/video-studio/motion/styles";
import { FRAME_TYPES, estimateTiming, type MotionConfig, type MotionTiming, type MotionVisual } from "@/lib/video-studio/motion/storyboard";
import type { QaCheck } from "@/lib/video-studio/motion/quality";
import type { JobAsset } from "@/lib/video-studio/assets";

export interface MotionFrameRow {
  id: string;
  index: number;
  sentence: string;
  onScreen: string;
  visual: MotionVisual;
  durationSec: number;
  needsReview: boolean;
  reviewNote: string | null;
}

export interface MotionJobView {
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
  scriptEstimate: { quoteId: string | null; totalInr: number | null; totalMaxInr: number | null; model: string | null; runnable: boolean; blockReason: string | null; notes: string[]; expiresAt: string | null } | null;
  voicePending: {
    nonce: string;
    model: string;
    voice: string;
    chars: number;
    estSec: number;
    estInr: number;
    maxInr: number;
    sync: "precise" | "estimated";
    stt: { model: string; estInr: number; maxInr: number } | null;
    totalInr: number;
    totalMaxInr: number;
    expiresAt: string;
    notes: string[];
    runnable: boolean;
    blockReason: string | null;
  } | null;
  voice: { mode: "voice" | "silent"; model: string | null; voice: string | null; sync: string } | null;
  take: { key: string; sec: number } | null;
}

const RUNNING = ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING"];
const STAGE_LABEL: Record<string, string> = { script: "Writing the script and storyboard", voice: "Recording the narration and timing every word", render: "Rendering the motion frames" };
const ICON = { pass: CircleCheck, warn: CircleAlert, fail: AlertTriangle } as const;
const TONE = { pass: "text-[var(--color-success)]", warn: "text-[var(--color-warning)]", fail: "text-[var(--color-error)]" } as const;

export function MotionWorkspace({
  canUse,
  job,
  cfg,
  frames,
  checks,
  renderQa,
  voiceModels,
  sttModel,
  events,
  brand,
  assets,
}: {
  canUse: boolean;
  job: MotionJobView;
  cfg: MotionConfig;
  frames: MotionFrameRow[];
  checks: QaCheck[];
  renderQa: QaCheck[] | null;
  voiceModels: { id: string; name: string; voices: string[] }[];
  sttModel: string | null;
  events: { id: string; type: string; message: string; at: string }[];
  brand: { wordmark: string; examLabel: string | null; showBranding: boolean; cta: string };
  assets: JobAsset[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const style = MOTION_STYLE_MAP[cfg.styleKey];
  const running = RUNNING.includes(job.status);
  const draft = ["DRAFT", "CONFIGURING", "AWAITING_CONFIRMATION"].includes(job.status);
  const reviewable = canUse && ["REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status) && !job.mediaDeleted;
  const [script, setScript] = useState(() => frames.map((f) => f.sentence).join("\n"));
  const [choice, setChoice] = useState(() => {
    const m = voiceModels.find((x) => x.id === (job.voicePending?.model ?? job.voice?.model)) ?? voiceModels[0];
    return m ? `${m.id}|${job.voicePending?.voice ?? job.voice?.voice ?? m.voices[0] ?? ""}` : "";
  });
  const [sync, setSync] = useState<"precise" | "estimated">(sttModel ? "precise" : "estimated");
  const [approveScript, setApproveScript] = useState(false);
  const [approveVoice, setApproveVoice] = useState(false);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [running, router]);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) {
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed.");
      else {
        if (done) setNotice(done);
        router.refresh();
      }
    });
  }

  // Word timing for the previews: the saved timing when it matches, else reading-speed timing (free, same as a silent render).
  const timing: MotionTiming = useMemo(
    () => (cfg.timing && cfg.timing.frames.length === frames.length ? cfg.timing : estimateTiming(frames.map((f) => f.sentence), cfg.language, job.take?.sec ?? null, job.take ? "estimated" : "reading")),
    [cfg.timing, cfg.language, frames, job.take]
  );
  const all = useMemo(() => frames.map((f) => ({ onScreen: f.onScreen, tag: f.visual.tag })), [frames]);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const se = job.scriptEstimate && job.scriptEstimate.expiresAt && new Date(job.scriptEstimate.expiresAt) > new Date() ? job.scriptEstimate : null;
  const vp = job.voicePending && new Date(job.voicePending.expiresAt) > new Date() ? job.voicePending : null;
  const steps = [
    { k: "Input", done: true },
    { k: "Script", done: frames.length > 0 },
    { k: "Storyboard", done: frames.length > 0 },
    { k: "Voice-over plan", done: Boolean(job.voice) },
    { k: "Motion design", done: frames.length > 0 },
    { k: "Subtitle sync", done: Boolean(cfg.timing) },
    { k: "Render", done: Boolean(job.outputKey) },
    { k: "Preview", done: Boolean(job.outputKey) },
    { k: "Quality checks", done: Boolean(renderQa) && fails === 0 },
    { k: "MP4 export", done: Boolean(job.outputKey) },
  ];

  return (
    <div className="flex flex-col gap-5" data-testid="motion-workspace">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{job.title}</h2>
        <JobStatusBadge status={job.status} />
        <Badge variant="info">{style?.name ?? cfg.styleKey}</Badge>
        <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="motion-cost">AI cost so far: {formatInr(job.actualInr, 2)}{job.unknownCostCalls ? ` (+${job.unknownCostCalls} unknown)` : ""}</span>
        {canUse && !running && job.status !== "CANCELLED" && job.status !== "COMPLETED" ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(() => cancelMotionAction(job.id), "Cancelled — its files are cleaned up.")} data-testid="motion-cancel">Cancel</Button>
        ) : null}
      </div>

      <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="Workflow" data-testid="motion-steps">
        {steps.map((s, i) => (
          <li key={s.k} className={`rounded-full border px-2.5 py-1 ${s.done ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/10" : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"}`} data-done={s.done ? "1" : "0"}>
            {i + 1}. {s.k}
          </li>
        ))}
      </ol>

      {error ? <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-sm" data-testid="motion-error">{error}</p> : null}
      {notice ? <p role="status" className="rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm" data-testid="motion-notice">{notice}</p> : null}

      {running ? (
        <Card data-testid="motion-progress">
          <CardContent className="flex flex-col gap-2 py-4">
            <p className="text-sm font-medium">{STAGE_LABEL[job.stage ?? ""] ?? (job.status === "QUEUED" ? "Waiting for the worker" : "Working")}…</p>
            <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-muted)]" role="progressbar" aria-valuenow={job.progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-[var(--color-primary)] transition-all" style={{ width: `${Math.max(3, job.progressPct)}%` }} />
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">{job.progressPct}% · updates automatically · pauses while a Live CBT is running.</p>
          </CardContent>
        </Card>
      ) : null}

      {job.status === "FAILED" ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm" data-testid="motion-failed">
            <AlertTriangle className="h-4 w-4 text-[var(--color-error)]" aria-hidden />
            <span className="min-w-0 flex-1">Step “{job.failedStage}” failed{job.errorMessage ? `: ${job.errorMessage}` : "."}</span>
            {canUse ? <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(() => retryMotionAction(job.id), "Retry queued.")} data-testid="motion-retry"><RotateCcw className="h-4 w-4" aria-hidden /> Retry</Button> : null}
          </CardContent>
        </Card>
      ) : null}

      {job.outputKey && !job.mediaDeleted ? (
        <Card data-testid="motion-output">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Film className="h-4 w-4" aria-hidden /> Preview &amp; MP4 export</CardTitle>
            <CardDescription>MP4 (H.264 / AAC) · {job.outputSec?.toFixed(1)} s · {((job.outputBytes ?? 0) / 1024 / 1024).toFixed(1)} MB{job.renderMs ? ` · rendered in ${Math.round(job.renderMs / 1000)} s on this server` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <video controls preload="metadata" className="max-h-[70vh] w-full rounded-[var(--radius-card)] bg-black" src={mediaUrl(job.id, job.outputKey)} data-testid="motion-video" />
            <div className="flex flex-wrap gap-2">
              <a href={mediaUrl(job.id, job.outputKey, true)} className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-foreground)]" data-testid="motion-download"><Download className="h-4 w-4" aria-hidden /> Download MP4</a>
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Before posting: watch it once with the sound off and once with it on. Does every word appear when it is spoken? Does the last frame say exactly what to do?</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {draft || frames.length === 0 ? (
            <Card data-testid="motion-script-step">
              <CardHeader>
                <CardTitle>Script &amp; storyboard</CardTitle>
                <CardDescription>Let AI write the script and storyboard together (one paid request through OpenRouter, price shown first) — or write the script yourself and plan the storyboard for free.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 text-sm">
                {canUse && draft ? (
                  <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" disabled={pending} onClick={() => { setApproveScript(false); act(() => requestMotionEstimateAction(job.id)); }} data-testid="motion-estimate"><Sparkles className="h-4 w-4" aria-hidden /> Review AI script price</Button>
                      <span className="text-xs text-[var(--color-muted-foreground)]">Uses the approved medical model of AI → Features → AI Video Studio Script.</span>
                    </div>
                    {se ? (
                      <div className="flex flex-col gap-2" data-testid="motion-script-estimate">
                        <p>{se.model ?? "—"}: <b data-testid="motion-script-inr">{se.totalInr === null ? "cost unknown" : formatInr(se.totalInr, 2)}</b>{se.totalMaxInr !== null ? <span className="text-xs text-[var(--color-muted-foreground)]"> (max {formatInr(se.totalMaxInr, 2)})</span> : null}</p>
                        {se.notes.length ? <ul className="list-disc pl-4 text-xs text-[var(--color-muted-foreground)]">{se.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
                        {se.runnable && se.quoteId ? (
                          <>
                            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={approveScript} onChange={(e) => setApproveScript(e.target.checked)} data-testid="motion-approve-script" /> I approve this price. Write the script and storyboard.</label>
                            <div><Button type="button" variant="cta" disabled={!approveScript || pending} onClick={() => act(() => confirmMotionScriptAction(job.id, se.quoteId!), "Confirmed — writing the script and storyboard.")} data-testid="motion-confirm-script"><CheckCircle2 className="h-4 w-4" aria-hidden /> Confirm &amp; write (paid)</Button></div>
                          </>
                        ) : <p className="text-[var(--color-warning)]">{se.blockReason}</p>}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {canUse && !running ? (
                  <div className="flex flex-col gap-2">
                    <label className="font-medium" htmlFor="mw-own">Or write it yourself — one sentence per line becomes one frame (free)</label>
                    <Textarea id="mw-own" rows={7} lang="hi" value={script} onChange={(e) => setScript(e.target.value)} placeholder={"क्या आप जानते हैं कि heart attack के बाद सबसे पहले कौन सा marker बढ़ता है?\nTroponin I सबसे specific marker है।\n…\nऐसे और videos के लिए MockTestSeries.in पर practice कीजिए।"} data-testid="motion-own-script" />
                    <div><Button type="button" variant="outline" disabled={pending || !script.trim()} onClick={() => act(() => planFromScriptAction(job.id, script.replace(/\n+/g, " ")), "Storyboard planned (free).")} data-testid="motion-plan-own">Plan storyboard from my script (free)</Button></div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {frames.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Storyboard · scene-by-scene visual plan</CardTitle>
                <CardDescription>{frames.length} frames · {timing.totalSec.toFixed(1)} s ({timing.mode === "precise" ? "word timestamps from the narration" : timing.mode === "estimated" ? "estimated from the narration length" : "reading-speed timing — narration replaces it"}). One sentence, one on-screen idea, one motion and one highlighted word per frame. Editing is free.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ol className="flex flex-col gap-4" data-testid="motion-frames">
                  {frames.map((f, i) => (
                    <FrameRow
                      key={f.id + f.sentence + f.visual.motion + f.visual.type}
                      jobId={job.id}
                      f={f}
                      i={i}
                      n={frames.length}
                      editable={reviewable}
                      cfg={cfg}
                      all={all}
                      timing={timing}
                      brand={brand}
                      pending={pending}
                      onAct={act}
                    />
                  ))}
                </ol>
                {reviewable ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer font-medium">Edit the whole script and re-plan (free)</summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <Textarea rows={6} lang="hi" value={script} onChange={(e) => setScript(e.target.value)} data-testid="motion-replan-script" />
                      <p className="text-xs text-[var(--color-muted-foreground)]">Frames whose sentence is unchanged keep their edits. A changed sentence needs new narration.</p>
                      <div><Button type="button" variant="outline" disabled={pending} onClick={() => act(() => planFromScriptAction(job.id, script.replace(/\n+/g, " ")), "Storyboard re-planned.")} data-testid="motion-replan">Re-plan storyboard</Button></div>
                    </div>
                  </details>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {frames.length && canUse && !job.mediaDeleted ? (
            <Card data-testid="motion-voice">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Mic className="h-4 w-4" aria-hidden /> Voice-over plan &amp; render</CardTitle>
                <CardDescription>One narration take for the whole script (steady tone), through your existing OpenRouter key. Precise sync then transcribes that take once so every word lands exactly when spoken. Rendering is local and free.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {voiceModels.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <SelectNative aria-label="Voice" className="h-9 w-auto max-w-full" value={choice} disabled={!reviewable || pending} onChange={(e) => setChoice(e.target.value)} data-testid="motion-voice-choice">
                      {voiceModels.map((m) => <optgroup key={m.id} label={m.name}>{m.voices.map((v) => <option key={v} value={`${m.id}|${v}`}>{v}</option>)}</optgroup>)}
                    </SelectNative>
                    <SelectNative aria-label="Word sync" className="h-9 w-auto max-w-full" value={sync} disabled={!reviewable || pending} onChange={(e) => setSync(e.target.value as "precise" | "estimated")} data-testid="motion-sync">
                      <option value="precise" disabled={!sttModel}>Precise sync (transcribe the narration{sttModel ? "" : " — set a model in Settings"})</option>
                      <option value="estimated">Estimated sync (free)</option>
                    </SelectNative>
                    <Button type="button" variant="outline" disabled={!reviewable || pending || !choice} onClick={() => { setApproveVoice(false); const [model, voice] = choice.split("|"); act(() => estimateMotionVoiceAction(job.id, { model, voice, sync })); }} data-testid="motion-estimate-voice">Review narration price</Button>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--color-muted-foreground)]">No approved speech model has a voice for this language — approve one in Voice Studio, or render without narration.</p>
                )}
                {vp ? (
                  <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="motion-voice-estimate">
                    <p><b>{vp.model}</b> · {vp.voice} · {vp.chars} characters (~{Math.round(vp.estSec)} s): {formatInr(vp.estInr, 2)}{vp.stt ? <> + sync ({vp.stt.model}) {formatInr(vp.stt.estInr, 2)}</> : null} = <b data-testid="motion-voice-inr">{formatInr(vp.totalInr, 2)}</b> <span className="text-xs text-[var(--color-muted-foreground)]">(max {formatInr(vp.totalMaxInr, 2)})</span></p>
                    <ul className="list-disc pl-4 text-xs text-[var(--color-muted-foreground)]">{vp.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    {vp.runnable ? (
                      <>
                        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={approveVoice} onChange={(e) => setApproveVoice(e.target.checked)} data-testid="motion-approve-voice" /> I have reviewed the storyboard and this price. Record the narration and render the video.</label>
                        <div><Button type="button" variant="cta" disabled={!approveVoice || pending || !reviewable} onClick={() => act(() => confirmMotionVoiceAction(job.id, vp.nonce), "Confirmed — recording and rendering.")} data-testid="motion-confirm-voice"><CheckCircle2 className="h-4 w-4" aria-hidden /> Confirm &amp; render (paid)</Button></div>
                      </>
                    ) : <p className="text-[var(--color-warning)]">{vp.blockReason}</p>}
                  </div>
                ) : null}
                {job.take ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--color-muted-foreground)]">Narration take · {job.take.sec.toFixed(1)} s</span>
                    <audio controls preload="none" className="h-8 w-full" src={mediaUrl(job.id, job.take.key)} />
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
                  <Button type="button" variant="outline" disabled={!reviewable || pending || fails > 0} title={fails ? "Fix the failed quality checks first." : undefined} onClick={() => act(() => renderMotionSilentAction(job.id), "Silent render queued.")} data-testid="motion-render-silent"><VolumeX className="h-4 w-4" aria-hidden /> Render without narration (free)</Button>
                  {job.voice ? <Button type="button" variant="outline" disabled={!reviewable || pending} onClick={() => act(() => rerenderMotionAction(job.id), "Re-render queued.")} data-testid="motion-rerender"><RefreshCw className="h-4 w-4" aria-hidden /> Re-render with the existing {job.voice.mode === "voice" ? "narration" : "settings"} (free)</Button> : null}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Card data-testid="motion-qa">
            <CardHeader>
              <CardTitle className="text-base">Quality checks</CardTitle>
              <CardDescription>{fails ? `${fails} must be fixed` : "Nothing blocking"}{warns ? ` · ${warns} to look at` : ""} · free, re-run on every change{renderQa ? " and on the MP4" : ""}.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-xs">
                {[...checks, ...(renderQa ?? [])].map((c) => {
                  const I = ICON[c.status];
                  return (
                    <li key={c.key} className="flex gap-2" data-check={c.key} data-status={c.status}>
                      <I className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE[c.status]}`} aria-hidden />
                      <span><b className="font-medium">{c.label}</b> — {c.detail}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Style, format &amp; render settings</CardTitle>
              <CardDescription>{style?.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1">Style (locked for every frame)
                <SelectNative value={cfg.styleKey} disabled={!canUse || running || job.status === "CANCELLED"} onChange={(e) => act(() => updateMotionConfigAction(job.id, { styleKey: e.target.value }), "Style changed — every frame now uses it.")} data-testid="motion-style">
                  {MOTION_STYLES.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                </SelectNative>
              </label>
              <label className="flex flex-col gap-1">Aspect ratio
                <SelectNative value={cfg.aspect} disabled={!canUse || running || job.status === "CANCELLED"} onChange={(e) => act(() => updateMotionConfigAction(job.id, { aspect: e.target.value }), "Aspect changed.")} data-testid="motion-aspect">
                  {ASPECTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                </SelectNative>
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.subtitles} disabled={!canUse || running} onChange={(e) => act(() => updateMotionConfigAction(job.id, { subtitles: e.target.checked }))} /> Word-timed captions</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={cfg.branding} disabled={!canUse || running} onChange={(e) => act(() => updateMotionConfigAction(job.id, { branding: e.target.checked }))} /> {brand.wordmark} branding</label>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
                <dt>Transition</dt><dd>{style?.transition.type === "none" ? "Continuous camera (no cut)" : `${style?.transition.type} · ${style?.transition.sec}s`}</dd>
                <dt>Motions</dt><dd>{style?.motions.map((m) => MOTION_LABELS[m].label).join(", ")}</dd>
                <dt>Highlight</dt><dd>{style?.highlight}</dd>
                <dt>Frame rate</dt><dd>25 fps · H.264 / AAC</dd>
                <dt>Length</dt><dd>target {cfg.targetSec} s</dd>
              </dl>
              {style?.layout === "photo" || assets.length ? (
                <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
                  <span className="font-medium">Images {style?.layout === "photo" ? "(required for Photo Story)" : ""}</span>
                  <AssetsPanel jobId={job.id} assets={assets} canUse={canUse && !running} accept="image/png,image/jpeg,image/webp" hint="PNG / JPEG / WebP you are licensed to use" pagesEditable={false} testId="motion-assets" />
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Sound design</CardTitle></CardHeader>
            <CardContent className="text-xs text-[var(--color-muted-foreground)]">
              <ul className="list-disc pl-4">
                <li>Voice first: one clean take with the words landing on time feels more premium than a music bed.</li>
                <li>Background music is off by default. Sound effects are not offered — no licensed effects library is configured.</li>
                <li>Before posting, watch once muted and once with sound.</li>
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Job history &amp; errors</CardTitle></CardHeader>
            <CardContent>
              <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto text-xs" data-testid="motion-events">
                {events.map((e) => (
                  <li key={e.id} className={e.type === "failed" ? "text-[var(--color-error)]" : ""}>
                    <span className="text-[var(--color-muted-foreground)]">{new Date(e.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</span> · {e.message}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FrameRow({
  jobId,
  f,
  i,
  n,
  editable,
  cfg,
  all,
  timing,
  brand,
  pending,
  onAct,
}: {
  jobId: string;
  f: MotionFrameRow;
  i: number;
  n: number;
  editable: boolean;
  cfg: MotionConfig;
  all: { onScreen: string; tag: string | null }[];
  timing: MotionTiming;
  brand: { wordmark: string; examLabel: string | null; showBranding: boolean; cta: string };
  pending: boolean;
  onAct: (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => void;
}) {
  const style = MOTION_STYLE_MAP[cfg.styleKey];
  const [sentence, setSentence] = useState(f.sentence);
  const [onScreen, setOnScreen] = useState(f.onScreen);
  const [highlight, setHighlight] = useState(f.visual.highlight);
  const [motion, setMotion] = useState<MotionKey>(f.visual.motion);
  const [type, setType] = useState(f.visual.type);
  const [list, setList] = useState((f.visual.items ?? f.visual.nodes ?? []).join(", "));
  const [value, setValue] = useState(f.visual.value ?? "");
  const [tag, setTag] = useState(f.visual.tag ?? "");
  const dirty = sentence !== f.sentence || onScreen !== f.onScreen || highlight !== f.visual.highlight || motion !== f.visual.motion || type !== f.visual.type || list !== (f.visual.items ?? f.visual.nodes ?? []).join(", ") || value !== (f.visual.value ?? "") || tag !== (f.visual.tag ?? "");
  const t = timing.frames[i] ?? { start: 0, end: f.durationSec };
  const words = timing.words.filter((w) => w.frame === i).map((w) => ({ text: w.text, start: Math.max(0, w.start - t.start), end: Math.max(0, w.end - t.start) }));
  const items = list.split(",").map((x) => x.trim()).filter(Boolean);
  const visual: MotionVisual = { ...f.visual, motion, highlight, type, tag: tag || null, ...(type === "steps" ? { items } : {}), ...(type === "diagram" ? { nodes: items } : {}), ...(type === "stat" ? { value } : {}) };
  const isQ = f.visual.type === "question";
  return (
    <li className="grid gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm md:grid-cols-[minmax(0,1fr)_auto]" data-frame={i} data-review={f.needsReview ? "1" : "0"}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          <b className="text-[var(--color-foreground)]">Frame {i + 1}</b> · {(t.end - t.start).toFixed(1)} s · {MOTION_LABELS[f.visual.motion].label} · {f.visual.type}
          {editable ? (
            <span className="ml-auto flex gap-1">
              <Button type="button" size="compact" variant="outline" aria-label="Move up" disabled={pending || i === 0} onClick={() => onAct(() => moveMotionFrameAction(jobId, f.id, "up"))}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></Button>
              <Button type="button" size="compact" variant="outline" aria-label="Move down" disabled={pending || i === n - 1} onClick={() => onAct(() => moveMotionFrameAction(jobId, f.id, "down"))}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></Button>
              <Button type="button" size="compact" variant="outline" aria-label={`Delete frame ${i + 1}`} disabled={pending || n <= 2} onClick={() => onAct(() => moveMotionFrameAction(jobId, f.id, "delete"), `Frame ${i + 1} deleted.`)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
            </span>
          ) : null}
        </div>
        {f.needsReview ? <p className="flex gap-1.5 rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2 text-xs" data-testid="motion-review-note"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" aria-hidden /> {f.reviewNote}</p> : null}
        <label className="flex flex-col gap-1 text-xs">Spoken sentence
          <Textarea rows={2} lang="hi" maxLength={320} value={sentence} disabled={!editable || pending} onChange={(e) => setSentence(e.target.value)} aria-label={`Sentence of frame ${i + 1}`} />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">On screen (one idea)
            <Input lang="hi" maxLength={90} value={onScreen} disabled={!editable || pending} onChange={(e) => setOnScreen(e.target.value)} aria-label={`On-screen text of frame ${i + 1}`} />
          </label>
          <label className="flex flex-col gap-1 text-xs">Highlighted word
            <Input lang="hi" maxLength={40} value={highlight} disabled={!editable || pending} onChange={(e) => setHighlight(e.target.value)} aria-label={`Highlight of frame ${i + 1}`} />
          </label>
          <label className="flex flex-col gap-1 text-xs">Motion
            <SelectNative value={motion} disabled={!editable || pending} onChange={(e) => setMotion(e.target.value as MotionKey)} aria-label={`Motion of frame ${i + 1}`}>
              {style?.motions.map((m) => <option key={m} value={m}>{MOTION_LABELS[m].label}</option>)}
            </SelectNative>
          </label>
          <label className="flex flex-col gap-1 text-xs">Visual
            <SelectNative value={type} disabled={!editable || pending || isQ} onChange={(e) => setType(e.target.value as MotionVisual["type"])} aria-label={`Visual of frame ${i + 1}`}>
              {FRAME_TYPES.filter((x) => (isQ ? x === "question" : x !== "question" && x !== "image")).map((x) => <option key={x} value={x}>{x}</option>)}
            </SelectNative>
          </label>
          {type === "steps" || type === "diagram" ? (
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">{type === "steps" ? "Steps" : "Diagram nodes"} (comma separated)
              <Input lang="hi" value={list} disabled={!editable || pending} onChange={(e) => setList(e.target.value)} />
            </label>
          ) : null}
          {type === "stat" ? (
            <label className="flex flex-col gap-1 text-xs">Number
              <Input value={value} maxLength={12} disabled={!editable || pending} onChange={(e) => setValue(e.target.value)} />
            </label>
          ) : null}
          {style?.tagHint ? (
            <label className="flex flex-col gap-1 text-xs">Tag ({style.tagHint})
              <Input maxLength={24} value={tag} disabled={!editable || pending} onChange={(e) => setTag(e.target.value)} />
            </label>
          ) : null}
        </div>
        {isQ ? <p className="text-xs text-[var(--color-muted-foreground)]">Question Bank question — stem, options and answer exactly as stored. {f.visual.correctLabel ? `Stored answer ${f.visual.correctLabel} is revealed at ${f.visual.revealAtSec ?? 0} s.` : "No stored answer — not revealed."}</p> : null}
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!dirty || pending} onClick={() => onAct(() => updateMotionFrameAction(jobId, f.id, { sentence, onScreen, highlight, motion, tag, visual: { type, items, nodes: items, value } }), `Frame ${i + 1} saved.`)} data-testid="motion-save-frame">Save frame</Button>
            {f.needsReview ? <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onAct(() => updateMotionFrameAction(jobId, f.id, { reviewed: true }), "Marked as reviewed.")} data-testid="motion-mark-reviewed"><CheckCircle2 className="h-4 w-4" aria-hidden /> Mark reviewed</Button> : null}
          </div>
        ) : null}
      </div>
      <MotionFramePreview frame={{ sentence, onScreen, visual }} styleKey={cfg.styleKey} aspect={cfg.aspect} index={i} all={all} durationSec={Math.max(1.5, t.end - t.start)} words={words} subtitles={cfg.subtitles} brand={brand} width={cfg.aspect === "16:9" ? 240 : 150} />
    </li>
  );
}
