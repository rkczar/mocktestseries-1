"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runVideoCleanupAction, saveVideoSettingsAction } from "@/app/admin/(dashboard)/video-studio/actions";
import { SelectNative } from "@/components/ui/select-native";
import type { VideoStudioSettings } from "@/lib/video-studio/settings";

type NumKey = { [K in keyof VideoStudioSettings]: VideoStudioSettings[K] extends number ? K : never }[keyof VideoStudioSettings];

const FIELDS: { k: NumKey; label: string; hint: string }[] = [
  { k: "deliveredRetentionHours", label: "Keep delivered videos (hours)", hint: "After the first download or publish." },
  { k: "undeliveredRetentionHours", label: "Keep undelivered videos (hours)", hint: "Finished but never downloaded." },
  { k: "abandonedAfterHours", label: "Abandon unconfirmed drafts after (hours)", hint: "Drafts with no activity are cancelled and cleaned." },
  { k: "failedRetentionHours", label: "Keep failed jobs for Retry (hours)", hint: "Then the failed job's files are deleted." },
  { k: "maxRetentionDays", label: "Maximum retention (days)", hint: "Hard cap for every job, whatever its state (1–30)." },
  { k: "maxUploadMb", label: "Largest upload (MB)", hint: "AI Video Editor uploads." },
  { k: "jobQuotaMb", label: "Media per job (MB)", hint: "A job stops before exceeding it." },
  { k: "minFreeDiskGb", label: "Minimum free disk (GB)", hint: "New jobs are refused below this." },
  { k: "maxConcurrentRenders", label: "Renders at the same time", hint: "1–2 on this server (Live CBT shares the CPU)." },
  { k: "renderTimeoutMin", label: "Render time limit (minutes)", hint: "A render that takes longer is stopped and marked failed." },
  { k: "renderCpus", label: "CPU cores per render", hint: "The web app always wins CPU contention." },
  { k: "renderMemoryMb", label: "Memory per render (MB)", hint: "The render container is stopped above this." },
  { k: "maxUploadMinutes", label: "Longest recording (minutes)", hint: "AI Video Editor uploads." },
  { k: "musicVolumePct", label: "Music level under narration (%)", hint: "Lowered further while someone speaks." },
];

export function VideoSettingsForm({
  settings,
  canManage,
  sttModels,
  storage,
}: {
  settings: VideoStudioSettings;
  canManage: boolean;
  sttModels: { id: string; name: string; perSecondUsd: number | null }[];
  storage: { root: string; freeGb: number | null; folders: number; strayEntries: number; mediaMb: number };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [s, setS] = useState(settings);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveVideoSettingsAction(s);
      setMsg(r.ok ? { ok: true, text: "Settings saved." } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  }
  function cleanup() {
    setMsg(null);
    start(async () => {
      const r = await runVideoCleanupAction();
      setMsg(r.ok ? { ok: true, text: `Cleanup done: ${r.data.deletedJobs} job(s) cleaned, ${r.data.abandoned} abandoned, ${r.data.orphanFolders} orphan folder(s), ${(r.data.bytesFreed / 1024 ** 2).toFixed(1)} MB freed.` } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Branding</CardTitle>
          <CardDescription>Shown on every video when Branding is on. The exam label comes from the video&apos;s questions or chosen exam, never from free text.</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!canManage || pending} className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="b-word">Wordmark</Label>
              <Input id="b-word" maxLength={40} value={s.brand.wordmark} onChange={(e) => setS({ ...s, brand: { ...s.brand, wordmark: e.target.value } })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="b-cta">Default call to action</Label>
              <Input id="b-cta" maxLength={80} value={s.brand.cta} onChange={(e) => setS({ ...s, brand: { ...s.brand, cta: e.target.value } })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.brand.showBranding} onChange={(e) => setS({ ...s, brand: { ...s.brand, showBranding: e.target.checked } })} /> Branding on by default
            </label>
          </fieldset>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Storage, retention and limits</CardTitle>
          <CardDescription>Generated media are temporary: they are deleted after delivery, cancellation, abandonment, inactivity or expiry. A failed job keeps them only for the &ldquo;failed&rdquo; period so Retry can resume it, and no job keeps them longer than the maximum retention. Only the job record and its costs are kept.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <fieldset disabled={!canManage || pending} className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.k} className="flex flex-col gap-1.5">
                <Label htmlFor={`s-${f.k}`}>{f.label}</Label>
                <Input id={`s-${f.k}`} type="number" value={s[f.k]} onChange={(e) => setS({ ...s, [f.k]: Number(e.target.value) })} />
                <span className="text-xs text-[var(--color-muted-foreground)]">{f.hint}</span>
              </div>
            ))}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="s-stt">Transcription model (editor subtitles)</Label>
              <SelectNative id="s-stt" value={s.transcriptionModel ?? ""} onChange={(e) => setS({ ...s, transcriptionModel: e.target.value || null })} data-testid="stt-model">
                <option value="">Not chosen</option>
                {sttModels.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.perSecondUsd === null}>
                    {m.name}{m.perSecondUsd === null ? " (priced per token — cannot be estimated)" : ` · $${(m.perSecondUsd * 60).toFixed(4)}/min`}
                  </option>
                ))}
              </SelectNative>
              <span className="text-xs text-[var(--color-muted-foreground)]">{sttModels.length ? "OpenRouter speech-to-text. Each transcription shows its price and needs your confirmation." : "Sync the catalog in Voice Studio first."}</span>
            </div>
          </fieldset>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm" data-testid="storage-report">
            <dt className="text-[var(--color-muted-foreground)]">Media folder</dt>
            <dd className="break-all">{storage.root}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Free disk</dt>
            <dd>{storage.freeGb === null ? "—" : `${storage.freeGb.toFixed(1)} GB`}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Job folders</dt>
            <dd>{storage.folders}{storage.strayEntries ? ` (${storage.strayEntries} unexpected entr${storage.strayEntries === 1 ? "y" : "ies"} — not touched by cleanup)` : ""}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Media held by jobs</dt>
            <dd>{storage.mediaMb.toFixed(1)} MB</dd>
          </dl>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={save} disabled={pending} data-testid="save-settings">Save settings</Button>
              <Button type="button" variant="outline" onClick={cleanup} disabled={pending} data-testid="run-cleanup">Run cleanup now</Button>
            </div>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">Read-only access.</p>
          )}
          {msg ? <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="settings-msg">{msg.text}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
