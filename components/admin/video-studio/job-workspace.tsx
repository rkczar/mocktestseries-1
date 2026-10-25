"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Info, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { CapabilityList } from "@/components/admin/video-studio/capability-list";
import { ScenePreview } from "@/components/admin/video-studio/scene-preview";
import { AssetsPanel } from "@/components/admin/video-studio/assets-panel";
import { ProductionPanel, type ProdJob, type ProdScene } from "@/components/admin/video-studio/production-panel";
import type { JobAsset } from "@/lib/video-studio/assets";
import {
  autoConfigureVideoAction,
  cancelVideoJobAction,
  confirmVideoJobAction,
  requestVideoEstimateAction,
  updateVideoConfigAction,
} from "@/app/admin/(dashboard)/video-studio/actions";
import { formatInr } from "@/lib/ai-engine/config";
import { DESIGN_MAP, readyDesigns } from "@/lib/video-studio/designs";
import { selectableSkills, SKILL_MAP } from "@/lib/video-studio/skills";
import { SAMPLE_SCENES } from "@/lib/video-studio/samples";
import type { JobEstimate } from "@/lib/video-studio/jobs";
import type { SceneVisual } from "@/lib/video-studio/template";
import {
  ASPECTS,
  CANCELLABLE,
  DURATION_LIMITS,
  EDITABLE,
  LANGUAGES,
  MEDICAL_VIDEO_TYPES,
  VIDEO_TYPE_MAP,
  VOICE_STYLES,
  type VideoConfig,
  type VideoSource,
} from "@/lib/video-studio/types";

interface JobView {
  id: string;
  title: string;
  status: string;
  source: VideoSource;
  customPrompt: string;
  config: VideoConfig | null;
  estimate: JobEstimate | null;
  actualInr: number;
  unknownCostCalls: number;
  createdAt: string;
  confirmedAt: string | null;
  errorMessage: string | null;
  mediaDeletedAt: string | null;
}

interface SceneView {
  id: string;
  index: number;
  narration: string;
  onScreenText: string;
  durationSec: number;
  needsReview: boolean;
  reviewNote: string | null;
  visual: unknown;
}

export function JobWorkspace({
  canUse,
  job,
  scenes,
  events,
  voiceModels,
  examNames,
  brand,
  assets,
  prod,
  prodScenes,
}: {
  canUse: boolean;
  job: JobView;
  scenes: SceneView[];
  assets: JobAsset[];
  prod: ProdJob;
  prodScenes: ProdScene[];
  events: { id: string; type: string; message: string; at: string }[];
  voiceModels: { id: string; name: string; voices: string[] }[];
  examNames: string[];
  brand: { wordmark: string; cta: string; showBranding: boolean };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editable = canUse && (EDITABLE as readonly string[]).includes(job.status);
  const cancellable = canUse && (CANCELLABLE as readonly string[]).includes(job.status);
  const cfg = job.config;
  const [draft, setDraft] = useState<VideoConfig | null>(cfg);
  const [customPrompt, setCustomPrompt] = useState(job.customPrompt);
  const [previewKey, setPreviewKey] = useState(SAMPLE_SCENES[0].key);
  const [approved, setApproved] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg) || customPrompt !== job.customPrompt, [draft, cfg, customPrompt, job.customPrompt]);
  const medical = cfg ? MEDICAL_VIDEO_TYPES.includes(cfg.videoType) : false;

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

  function set<K extends keyof VideoConfig>(k: K, v: VideoConfig[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  }

  function saveChanges() {
    if (!draft || !cfg) return;
    const patch: Record<string, unknown> = { customPrompt };
    for (const k of ["language", "aspect", "durationSec", "designKey", "voiceStyle", "subtitles", "subtitleStyle", "branding", "cta", "examLabel", "skillKeys"] as const) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(cfg[k])) patch[k] = draft[k];
    }
    if (draft.voiceId !== cfg.voiceId || draft.speechModel !== cfg.speechModel) {
      patch.voiceId = draft.voiceId;
      patch.speechModel = draft.speechModel;
    }
    act(() => updateVideoConfigAction(job.id, patch), "Configuration saved. Review the price again before confirming.");
  }

  const design = draft ? DESIGN_MAP[draft.designKey] : null;
  const previewScene = useMemo(() => {
    const real = scenes[0];
    if (real) return { narration: real.narration, onScreenText: real.onScreenText, visual: (real.visual as SceneVisual | null) ?? null, durationSec: real.durationSec };
    return SAMPLE_SCENES.find((s) => s.key === previewKey)!.scene;
  }, [scenes, previewKey]);
  const est = job.estimate;

  return (
    <div className="flex flex-col gap-5" data-testid="job-workspace" data-job-status={job.status}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold" data-testid="job-title">{job.title}</h2>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {VIDEO_TYPE_MAP[job.source.videoType]?.label} · created {new Date(job.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}
            {job.mediaDeletedAt ? " · media deleted by the retention policy" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <JobStatusBadge status={job.status} />
          {cancellable ? (
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => confirm("Cancel this video job? Its temporary media will be deleted.") && act(() => cancelVideoJobAction(job.id), "Job cancelled.")} data-testid="cancel-job">
              Cancel job
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-sm" data-testid="job-error">{error}</p> : null}
      {notice ? <p role="status" className="rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm" data-testid="job-notice">{notice}</p> : null}
      {job.errorMessage ? <p className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 px-3 py-2 text-sm">Last error: {job.errorMessage}</p> : null}

      {job.source.type === "pdf" || job.source.type === "image" || assets.some((a) => a.kind === "music") || (editable && draft) ? (
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>
              {job.source.type === "pdf"
                ? "The PDF the video teaches from (text is extracted locally; choose pages to focus on). Selected pages can also appear on screen."
                : job.source.type === "image"
                  ? "Images / screenshots the video explains (sent to an approved vision model with the script request) and can show on screen."
                  : "Optional background music (MP3 / WAV / M4A) — only tracks you are licensed to use."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AssetsPanel
              jobId={job.id}
              assets={assets}
              canUse={canUse && !job.mediaDeletedAt && ["DRAFT", "CONFIGURING", "AWAITING_CONFIRMATION", "REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status)}
              accept={job.source.type === "pdf" ? "application/pdf,audio/*" : job.source.type === "image" ? "image/png,image/jpeg,image/webp,audio/*" : "audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"}
              hint={job.source.type === "pdf" ? "PDF (and optional music)" : job.source.type === "image" ? "PNG / JPEG / WebP (and optional music)" : "MP3 / WAV / M4A"}
              pagesEditable={editable}
            />
          </CardContent>
        </Card>
      ) : null}

      {!draft ? (
        <Card>
          <CardContent className="py-6 text-sm">
            {job.source.type === "pdf" || job.source.type === "image" ? "Upload the files above, then let Auto Configure propose the video." : "This job has no configuration yet."}{" "}
            {editable ? (
              <Button type="button" size="sm" onClick={() => act(() => autoConfigureVideoAction(job.id, {}))} disabled={pending} data-testid="auto-configure-job">
                <Sparkles className="h-4 w-4" aria-hidden /> Auto Configure AI
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>Proposed by Auto Configure — everything is editable until you confirm the price.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <fieldset disabled={!editable || pending} className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-lang">Language</Label>
                    <SelectNative id="c-lang" value={draft.language} onChange={(e) => set("language", e.target.value as VideoConfig["language"])}>
                      {LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                    </SelectNative>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-dur">Duration (seconds)</Label>
                    <Input id="c-dur" type="number" min={DURATION_LIMITS.minSec} max={DURATION_LIMITS.maxSec} value={draft.durationSec} onChange={(e) => set("durationSec", Number(e.target.value) || draft.durationSec)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-aspect">Aspect ratio</Label>
                    <SelectNative id="c-aspect" value={draft.aspect} onChange={(e) => set("aspect", e.target.value as VideoConfig["aspect"])}>
                      {ASPECTS.filter((a) => DESIGN_MAP[draft.designKey]?.aspects.includes(a.key)).map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                    </SelectNative>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-design">Design</Label>
                    <SelectNative id="c-design" value={draft.designKey} onChange={(e) => set("designKey", e.target.value)} data-testid="design-select">
                      {readyDesigns(draft.aspect).map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
                    </SelectNative>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-vstyle">Voice style</Label>
                    <SelectNative id="c-vstyle" value={draft.voiceStyle} onChange={(e) => set("voiceStyle", e.target.value as VideoConfig["voiceStyle"])}>
                      {VOICE_STYLES.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                    </SelectNative>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-voice">Voice</Label>
                    {voiceModels.length ? (
                      <SelectNative
                        id="c-voice"
                        value={draft.speechModel && draft.voiceId ? `${draft.speechModel}|${draft.voiceId}` : ""}
                        onChange={(e) => {
                          const [m, v] = e.target.value.split("|");
                          setDraft((d) => (d ? { ...d, speechModel: m || null, voiceId: v || null } : d));
                        }}
                      >
                        {voiceModels.map((m) => (
                          <optgroup key={m.id} label={m.name}>
                            {m.voices.map((v) => <option key={v} value={`${m.id}|${v}`}>{v}</option>)}
                          </optgroup>
                        ))}
                      </SelectNative>
                    ) : (
                      <p className="text-xs text-[var(--color-muted-foreground)]">No approved speech model has a voice for this language yet (Voice Studio).</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-exam">Exam label</Label>
                    <SelectNative id="c-exam" value={draft.examLabel ?? ""} onChange={(e) => set("examLabel", e.target.value || null)}>
                      <option value="">None — general format</option>
                      {examNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </SelectNative>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="c-cta">Call to action</Label>
                    <Input id="c-cta" maxLength={80} value={draft.cta} onChange={(e) => set("cta", e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-2 sm:col-span-2">
                    <span className="text-sm font-medium">Output</span>
                    <div className="flex flex-wrap gap-4 text-sm">
                      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.subtitles} onChange={(e) => set("subtitles", e.target.checked)} /> Subtitles</label>
                      <SelectNative aria-label="Subtitle style" className="h-8 w-auto" value={draft.subtitleStyle} onChange={(e) => set("subtitleStyle", e.target.value as VideoConfig["subtitleStyle"])} disabled={!draft.subtitles}>
                        <option value="clean">Clean</option>
                        <option value="highlight">Highlight</option>
                        <option value="boxed">Boxed</option>
                      </SelectNative>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.branding} onChange={(e) => set("branding", e.target.checked)} /> Branding</label>
                      <span className="text-xs text-[var(--color-muted-foreground)]">Background music: upload a licensed track under Files, then choose it before rendering.</span>
                    </div>
                  </div>
                </fieldset>

                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">Skills</span>
                  <ul className="grid gap-2 sm:grid-cols-2" data-testid="skill-checkboxes">
                    {selectableSkills().map((s) => {
                      const locked = Boolean(s.required) && (s.recommendFor === "all" || medical);
                      const on = draft.skillKeys.includes(s.key);
                      return (
                        <li key={s.key}>
                          <label className="flex items-start gap-2 text-sm" title={s.description}>
                            <input
                              type="checkbox"
                              checked={on || locked}
                              disabled={!editable || locked || pending}
                              onChange={(e) => set("skillKeys", e.target.checked ? [...draft.skillKeys, s.key] : draft.skillKeys.filter((k) => k !== s.key))}
                              className="mt-1"
                            />
                            <span>
                              {s.name}
                              {locked ? <span className="ml-1 text-xs text-[var(--color-muted-foreground)]">(always on)</span> : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="c-custom">Custom instructions</Label>
                  <Textarea id="c-custom" rows={4} maxLength={4000} value={customPrompt} disabled={!editable || pending} onChange={(e) => setCustomPrompt(e.target.value)} />
                </div>

                {editable ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={saveChanges} disabled={!dirty || pending} data-testid="save-config">
                      Save changes
                    </Button>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => act(() => autoConfigureVideoAction(job.id, { customPrompt, skillKeys: draft.skillKeys }), "Configuration regenerated.")} data-testid="regenerate-config">
                      <RefreshCw className="h-4 w-4" aria-hidden /> Regenerate Configuration
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Why this configuration</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ul className="flex list-disc flex-col gap-1 pl-4 text-sm" data-testid="config-reasons">
                  {cfg!.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                <CapabilityList items={cfg!.capabilities} />
                {cfg!.blockers.length ? (
                  <div className="flex gap-2 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm" data-testid="blockers">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
                    <div>
                      <p className="font-medium">Cannot generate yet</p>
                      <ul className="list-disc pl-4">{cfg!.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Estimated price</CardTitle>
                <CardDescription>Calculated on the server from current prices. Nothing paid starts until you press Confirm &amp; Generate.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {editable && !dirty ? (
                  <div>
                    <Button type="button" variant={est ? "outline" : "primary"} disabled={pending} onClick={() => act(() => requestVideoEstimateAction(job.id))} data-testid="review-price">
                      {est ? "Refresh estimate" : "Review estimated price"}
                    </Button>
                  </div>
                ) : null}
                {dirty ? <p className="text-xs text-[var(--color-warning)]">Save your changes first — the estimate is for the saved configuration.</p> : null}
                {est ? (
                  <>
                    <table className="w-full text-sm" data-testid="estimate-table">
                      <thead>
                        <tr className="text-left text-xs text-[var(--color-muted-foreground)]">
                          <th className="py-1 font-medium">Step</th>
                          <th className="py-1 font-medium">In this confirmation</th>
                          <th className="py-1 text-right font-medium">Estimate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {est.lines.map((l) => (
                          <tr key={l.key} data-line={l.key} data-state={l.state}>
                            <td className="py-2 pr-2 align-top">
                              <p className="font-medium">{l.label}</p>
                              <p className="text-xs text-[var(--color-muted-foreground)]">{l.detail}</p>
                            </td>
                            <td className="py-2 pr-2 align-top text-xs">
                              {{ included: "Yes", later: "Later stage (own confirmation)", none: "No provider charge", unavailable: "Not available" }[l.state]}
                            </td>
                            <td className="py-2 text-right align-top tabular-nums">
                              {l.inr === null ? "Unknown" : formatInr(l.inr, 2)}
                              {l.maxInr !== null && l.inr !== null && l.maxInr > l.inr ? <span className="block text-xs text-[var(--color-muted-foreground)]">max {formatInr(l.maxInr, 2)}</span> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td className="pt-2 font-semibold" colSpan={2}>Total for this confirmation</td>
                          <td className="pt-2 text-right font-semibold tabular-nums" data-testid="estimate-total">
                            {est.totalInr === null ? "Cannot be estimated" : formatInr(est.totalInr, 2)}
                            {est.totalMaxInr !== null ? <span className="block text-xs font-normal text-[var(--color-muted-foreground)]">max {formatInr(est.totalMaxInr, 2)}</span> : null}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                    {est.notes.length ? (
                      <ul className="flex flex-col gap-1 text-xs text-[var(--color-muted-foreground)]">
                        {est.notes.map((n, i) => (
                          <li key={i} className="flex gap-1.5"><Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{n}</li>
                        ))}
                      </ul>
                    ) : null}
                    {job.status === "AWAITING_CONFIRMATION" && canUse ? (
                      est.runnable && est.quoteId ? (
                        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
                          <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-1" data-testid="approve-cost" />
                            I have reviewed the estimate. Start the paid steps marked “Yes” (the actual provider cost is recorded afterwards).
                          </label>
                          <div className="flex flex-wrap items-center gap-3">
                            <Button type="button" variant="cta" disabled={!approved || pending} onClick={() => act(() => confirmVideoJobAction(job.id, est.quoteId!), "Confirmed — the job is queued.")} data-testid="confirm-generate">
                              <CheckCircle2 className="h-4 w-4" aria-hidden /> Confirm &amp; Generate
                            </Button>
                            {est.expiresAt ? <span className="text-xs text-[var(--color-muted-foreground)]">Estimate valid until {new Date(est.expiresAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" })}</span> : null}
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-[var(--color-warning)]" data-testid="not-runnable">{est.blockReason}</p>
                      )
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-[var(--color-muted-foreground)]">No estimate yet.</p>
                )}
                {job.confirmedAt ? (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Confirmed {new Date(job.confirmedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} · actual recorded cost {formatInr(job.actualInr, 4)}
                    {job.unknownCostCalls ? ` + ${job.unknownCostCalls} request(s) with no reported cost` : ""}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            {scenes.length || !(EDITABLE as readonly string[]).includes(job.status) ? (
              <ProductionPanel
                canUse={canUse}
                job={prod}
                scenes={prodScenes}
                theme={{ ...(DESIGN_MAP[cfg!.designKey] ?? DESIGN_MAP.minimal_professional).theme, subtitleStyle: cfg!.subtitleStyle }}
                brand={{ wordmark: brand.wordmark, examLabel: cfg!.examLabel, showBranding: cfg!.branding, cta: cfg!.cta }}
                subtitles={cfg!.subtitles}
                voiceModels={voiceModels}
                musicAssets={assets.filter((a) => a.kind === "music" && a.state === "ready").map((a) => ({ key: a.key, name: a.name }))}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview Design</CardTitle>
                <CardDescription>{design?.name} · {draft.aspect}. Drawn by your browser from the same template the renderer uses — free.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {!scenes.length ? (
                  <SelectNative aria-label="Sample scene" value={previewKey} onChange={(e) => setPreviewKey(e.target.value)} className="h-8">
                    {SAMPLE_SCENES.map((s) => <option key={s.key} value={s.key}>Sample: {s.label}</option>)}
                  </SelectNative>
                ) : null}
                {design ? (
                  <ScenePreview
                    scene={previewScene}
                    theme={{ ...design.theme, subtitleStyle: draft.subtitleStyle }}
                    aspect={draft.aspect}
                    subtitles={draft.subtitles}
                    brand={{ wordmark: brand.wordmark, examLabel: draft.examLabel, showBranding: draft.branding, cta: draft.cta }}
                    width={draft.aspect === "16:9" ? 268 : 220}
                  />
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Skills in use</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-xs">
                  {draft.skillKeys.map((k) => <li key={k}>{SKILL_MAP[k]?.name} <span className="text-[var(--color-muted-foreground)]">v{SKILL_MAP[k]?.version}</span></li>)}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-1.5 text-xs" data-testid="events">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span className="text-[var(--color-muted-foreground)]">{new Date(e.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" })}</span> {e.message}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
