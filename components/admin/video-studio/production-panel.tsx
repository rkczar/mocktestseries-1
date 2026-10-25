"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, Film, Mic, RefreshCw, RotateCcw, Sparkles, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { ScenePreview } from "@/components/admin/video-studio/scene-preview";
import { mediaUrl } from "@/components/admin/video-studio/upload";
import {
  cancelSceneRegenQuoteAction,
  confirmSceneRegenAction,
  confirmVoiceAction,
  estimateVoiceAction,
  quoteSceneRegenAction,
  renderSilentAction,
  rerenderAction,
  retryVideoJobAction,
  setMusicAction,
  updateSceneAction,
} from "@/app/admin/(dashboard)/video-studio/actions";
import { formatInr } from "@/lib/ai-engine/config";
import type { DesignTheme } from "@/lib/video-studio/designs";
import type { SceneVisual } from "@/lib/video-studio/template";
import type { AspectRatio } from "@/lib/video-studio/types";

export interface ProdScene {
  id: string;
  index: number;
  narration: string;
  onScreenText: string;
  durationSec: number;
  needsReview: boolean;
  reviewNote: string | null;
  visual: SceneVisual | null;
  audioKey: string | null;
  audioSec: number | null;
  regenPending: boolean;
}

export interface VoicePendingView {
  nonce: string;
  model: string;
  voice: string;
  chars: number;
  scenes: number;
  estInr: number;
  maxInr: number;
  expiresAt: string;
  notes: string[];
  runnable: boolean;
  blockReason: string | null;
}

export interface ProdJob {
  id: string;
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
  voice: { mode: "voice" | "silent"; model: string | null; voice: string | null; estInr: number } | null;
  voicePending: VoicePendingView | null;
  music: { on: boolean; key: string | null };
  aspect: AspectRatio;
}

const RUNNING = ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING"];
const STAGE_LABEL: Record<string, string> = { script: "Writing the script", voice: "Generating narration", render: "Rendering the MP4", regen: "Regenerating a scene" };

export function ProductionPanel({
  canUse,
  job,
  scenes,
  theme,
  brand,
  subtitles,
  voiceModels,
  musicAssets,
}: {
  canUse: boolean;
  job: ProdJob;
  scenes: ProdScene[];
  theme: DesignTheme;
  brand: { wordmark: string; examLabel: string | null; showBranding: boolean; cta: string };
  subtitles: boolean;
  voiceModels: { id: string; name: string; voices: string[] }[];
  musicAssets: { key: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const running = RUNNING.includes(job.status) || scenes.some((s) => s.regenPending);
  const reviewable = canUse && ["REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status) && !job.mediaDeleted && !scenes.some((s) => s.regenPending);
  const [choice, setChoice] = useState(() => {
    const m = voiceModels.find((x) => x.id === (job.voicePending?.model ?? job.voice?.model)) ?? voiceModels[0];
    const v = job.voicePending?.voice ?? job.voice?.voice ?? m?.voices[0] ?? "";
    return m ? `${m.id}|${v}` : "";
  });
  const [approved, setApproved] = useState(false);

  // While the worker is busy, refresh every 3 s (progress, then the result).
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

  const vp = job.voicePending && new Date(job.voicePending.expiresAt) > new Date() ? job.voicePending : null;
  const flagged = scenes.filter((s) => s.needsReview).length;
  const changedAudio = job.voice?.mode === "voice" ? scenes.filter((s) => s.narration.trim() && !s.audioKey).length : 0;

  return (
    <div className="flex flex-col gap-5" data-testid="production">
      {error ? <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-sm" data-testid="prod-error">{error}</p> : null}
      {notice ? <p role="status" className="rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm" data-testid="prod-notice">{notice}</p> : null}

      {running ? (
        <Card data-testid="progress-card">
          <CardContent className="flex flex-col gap-2 py-4">
            <p className="text-sm font-medium">{STAGE_LABEL[job.stage ?? ""] ?? (job.status === "QUEUED" ? "Waiting for the worker" : "Working")}…</p>
            <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-muted)]" role="progressbar" aria-valuenow={job.progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-[var(--color-primary)] transition-all" style={{ width: `${Math.max(3, job.progressPct)}%` }} />
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">{job.progressPct}% · the page updates automatically. Rendering pauses while a Live CBT is running.</p>
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
            <CardTitle className="flex items-center gap-2"><Film className="h-4 w-4" aria-hidden /> Video</CardTitle>
            <CardDescription>
              MP4 (H.264 / AAC) · {job.outputSec?.toFixed(1)} s · {((job.outputBytes ?? 0) / 1024 / 1024).toFixed(1)} MB{job.renderMs ? ` · rendered in ${Math.round(job.renderMs / 1000)} s on this server` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <video controls preload="metadata" className="max-h-[70vh] w-full rounded-[var(--radius-card)] bg-black" src={mediaUrl(job.id, job.outputKey)} data-testid="output-video" />
            <div className="flex flex-wrap gap-2">
              <a href={mediaUrl(job.id, job.outputKey, true)} className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-primary)] px-3 text-sm font-medium text-[var(--color-primary-foreground)]" data-testid="download-mp4">
                <Download className="h-4 w-4" aria-hidden /> Download MP4
              </a>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {scenes.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Script review</CardTitle>
            <CardDescription>
              {scenes.length} scenes · {scenes.reduce((a, s) => a + s.durationSec, 0).toFixed(0)} s planned
              {flagged ? ` · ${flagged} flagged by the fact checker — check them before the narration` : " · nothing flagged"}. Editing text is free; changed narration needs new audio.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-4" data-testid="scene-editor">
              {scenes.map((s) => (
                <SceneRow key={s.id} jobId={job.id} scene={s} editable={reviewable} theme={theme} aspect={job.aspect} brand={brand} subtitles={subtitles} onAct={act} pending={pending} />
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      {scenes.length && canUse && !job.mediaDeleted ? (
        <Card data-testid="narration-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Mic className="h-4 w-4" aria-hidden /> Narration &amp; render</CardTitle>
            <CardDescription>
              Narration is a paid OpenRouter speech request per scene (shown before you confirm). Rendering is done locally on this server in the isolated render container — no provider charge.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {musicAssets.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Background music</span>
                <SelectNative aria-label="Background music" className="h-8 w-auto" disabled={!reviewable || pending} value={job.music.on && job.music.key ? job.music.key : ""} onChange={(e) => act(() => setMusicAction(job.id, e.target.value || null), "Music updated.")} data-testid="music-select">
                  <option value="">None</option>
                  {musicAssets.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </SelectNative>
                <span className="text-xs text-[var(--color-muted-foreground)]">Only music you are licensed to use. Lowered automatically under the narration.</span>
              </div>
            ) : null}
            {voiceModels.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <SelectNative aria-label="Voice" className="h-9 w-auto max-w-full" value={choice} disabled={!reviewable || pending} onChange={(e) => setChoice(e.target.value)} data-testid="voice-choice">
                  {voiceModels.map((m) => (
                    <optgroup key={m.id} label={m.name}>
                      {m.voices.map((v) => <option key={v} value={`${m.id}|${v}`}>{v}</option>)}
                    </optgroup>
                  ))}
                </SelectNative>
                <Button type="button" variant="outline" disabled={!reviewable || pending || !choice} onClick={() => { setApproved(false); const [model, voice] = choice.split("|"); act(() => estimateVoiceAction(job.id, { model, voice })); }} data-testid="estimate-voice">
                  Review narration price
                </Button>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-muted-foreground)]">No approved speech model has a voice for this language — approve one in Voice Studio, or render without narration.</p>
            )}
            {vp ? (
              <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="voice-estimate">
                <p>
                  <b>{vp.model}</b> · {vp.voice} · {vp.chars} characters in {vp.scenes} scene(s): <b data-testid="voice-estimate-inr">{formatInr(vp.estInr, 2)}</b> <span className="text-xs text-[var(--color-muted-foreground)]">(max {formatInr(vp.maxInr, 2)})</span>
                </p>
                <ul className="list-disc pl-4 text-xs text-[var(--color-muted-foreground)]">{vp.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                {vp.runnable ? (
                  <>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={approved} onChange={(e) => setApproved(e.target.checked)} data-testid="approve-voice" />
                      I have reviewed the script and the narration price. Generate the narration and render the video.
                    </label>
                    <div>
                      <Button type="button" variant="cta" disabled={!approved || pending || !reviewable} onClick={() => act(() => confirmVoiceAction(job.id, vp.nonce), "Narration confirmed — generating and rendering.")} data-testid="confirm-voice">
                        <CheckCircle2 className="h-4 w-4" aria-hidden /> Confirm &amp; Generate video
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-[var(--color-warning)]">{vp.blockReason}</p>
                )}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
              <Button type="button" variant="outline" disabled={!reviewable || pending} onClick={() => act(() => renderSilentAction(job.id), "Render queued.")} data-testid="render-silent">
                <VolumeX className="h-4 w-4" aria-hidden /> Render without narration (free)
              </Button>
              {job.voice ? (
                <Button type="button" variant="outline" disabled={!reviewable || pending || changedAudio > 0} title={changedAudio ? "Some scenes changed narration — review the narration price first." : undefined} onClick={() => act(() => rerenderAction(job.id), "Re-render queued.")} data-testid="rerender">
                  <RefreshCw className="h-4 w-4" aria-hidden /> Re-render with existing {job.voice.mode === "voice" ? "narration" : "settings"} (free)
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function SceneRow({
  jobId,
  scene,
  editable,
  theme,
  aspect,
  brand,
  subtitles,
  onAct,
  pending,
}: {
  jobId: string;
  scene: ProdScene;
  editable: boolean;
  theme: DesignTheme;
  aspect: AspectRatio;
  brand: { wordmark: string; examLabel: string | null; showBranding: boolean; cta: string };
  subtitles: boolean;
  onAct: (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => void;
  pending: boolean;
}) {
  const [narration, setNarration] = useState(scene.narration);
  const [onScreen, setOnScreen] = useState(scene.onScreenText);
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<{ id: string; totalInr: number | null; totalMaxInr: number | null; model: string; runnable: boolean; blockReason: string | null } | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const dirty = narration !== scene.narration || onScreen !== scene.onScreenText;
  const v = scene.visual;
  return (
    <li className="grid gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm md:grid-cols-[minmax(0,1fr)_170px]" data-scene={scene.index} data-review={scene.needsReview ? "1" : "0"}>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Scene {scene.index + 1} · {scene.durationSec.toFixed(1)} s{scene.audioSec ? ` (narration ${scene.audioSec.toFixed(1)} s)` : ""} · {v ? v.kind : "text"}
          {scene.regenPending ? " · regeneration queued…" : ""}
        </p>
        {scene.needsReview ? (
          <p className="flex gap-1.5 rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2 text-xs" data-testid="review-note">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" aria-hidden /> {scene.reviewNote}
          </p>
        ) : null}
        <Textarea aria-label={`Narration of scene ${scene.index + 1}`} rows={3} value={narration} disabled={!editable || pending} onChange={(e) => setNarration(e.target.value)} maxLength={700} lang="hi" />
        <Input aria-label={`On-screen text of scene ${scene.index + 1}`} value={onScreen} disabled={!editable || pending} onChange={(e) => setOnScreen(e.target.value)} maxLength={140} />
        {v?.kind === "question" ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Question from the Question Bank — stem, options and answer are shown exactly as stored. {v.correctLabel ? `Correct: ${v.correctLabel}${v.revealAtSec ? ` (revealed at ${v.revealAtSec} s)` : " (not revealed)"}` : "No stored answer — not revealed."}
          </p>
        ) : null}
        {scene.audioKey ? <audio controls preload="none" className="h-8 w-full" src={mediaUrl(jobId, scene.audioKey)} /> : null}
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={!dirty || pending} onClick={() => onAct(() => updateSceneAction(jobId, scene.id, { narration, onScreenText: onScreen }), `Scene ${scene.index + 1} saved.`)} data-testid="save-scene">
              Save scene
            </Button>
            {scene.needsReview ? (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onAct(() => updateSceneAction(jobId, scene.id, { reviewed: true, ...(v?.kind === "question" ? { visual: { confirmAnswer: true } } : {}) }), "Marked as reviewed.")} data-testid="mark-reviewed">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Mark reviewed
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={async () => {
                setQErr(null);
                const r = await quoteSceneRegenAction(jobId, scene.id);
                if (r.ok) setQuote({ id: r.data.id, totalInr: r.data.totalInr, totalMaxInr: r.data.totalMaxInr, model: r.data.model, runnable: r.data.runnable, blockReason: r.data.blockReason });
                else setQErr(r.error);
              }}
              data-testid="regen-scene"
            >
              <Sparkles className="h-4 w-4" aria-hidden /> Regenerate with AI
            </Button>
          </div>
        ) : null}
        {qErr ? <p className="text-xs text-[var(--color-error)]">{qErr}</p> : null}
        {quote ? (
          <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] p-2 text-xs" data-testid="regen-quote">
            <p>
              Regenerate scene {scene.index + 1} with {quote.model}: {quote.totalInr === null ? "price unknown" : formatInr(quote.totalInr, 2)}
              {quote.totalMaxInr !== null ? ` (max ${formatInr(quote.totalMaxInr, 2)})` : ""}
            </p>
            <Input aria-label="What should change" placeholder="What should change? (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="cta" disabled={!quote.runnable || pending} onClick={() => { const q = quote; setQuote(null); onAct(() => confirmSceneRegenAction(jobId, scene.id, q.id, note), "Regeneration queued."); }} data-testid="confirm-regen">
                Confirm (paid)
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { void cancelSceneRegenQuoteAction(quote.id); setQuote(null); }}>
                Cancel
              </Button>
            </div>
            {!quote.runnable ? <p className="text-[var(--color-warning)]">{quote.blockReason}</p> : null}
          </div>
        ) : null}
      </div>
      <ScenePreview scene={{ narration, onScreenText: onScreen, visual: v, durationSec: scene.durationSec }} theme={theme} aspect={aspect} subtitles={subtitles} brand={brand} width={aspect === "16:9" ? 170 : 150} />
    </li>
  );
}
