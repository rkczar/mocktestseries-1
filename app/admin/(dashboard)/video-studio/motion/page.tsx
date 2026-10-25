import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CapabilityList } from "@/components/admin/video-studio/capability-list";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { scriptCapability } from "@/lib/video-studio/autoconfig";
import { speechCapability } from "@/lib/video-studio/voices";
import { renderCapability } from "@/lib/video-studio/worker-status";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { formatInr } from "@/lib/ai-engine/config";
import { VIDEO_SKILLS, SKILL_MAP } from "@/lib/video-studio/skills";
import { MOTION_STYLE_MAP } from "@/lib/video-studio/motion/styles";

export const dynamic = "force-dynamic";

/** What each workflow step uses and whether it works today (no claim without a working path). */
const STEPS: { step: string; how: string; state: "implemented" | "paid" | "free" }[] = [
  { step: "Input or topic", how: "Topic, brief or Question Bank questions (stored answers only).", state: "free" },
  { step: "Script", how: "OpenRouter text model (AI → Features → AI Video Studio Script), or your own script.", state: "paid" },
  { step: "Storyboard", how: "Written with the script (one sentence = one frame), or planned from your script without AI.", state: "free" },
  { step: "Scene-by-scene visual plan", how: "One on-screen idea, one motion, one highlighted word per frame; editable.", state: "free" },
  { step: "Voice-over plan", how: "ONE narration take for the whole script through OpenRouter speech (Voice Studio approvals).", state: "paid" },
  { step: "Animation & motion design", how: "Locked style: layout, motion set, transition and highlight are the same in every frame.", state: "free" },
  { step: "Subtitle synchronisation", how: "Precise: OpenRouter transcription of the take gives every word's time. Estimated: spread over the take (free).", state: "paid" },
  { step: "Rendering", how: "Private render container (Chromium + FFmpeg, no network) — the shared renderer.", state: "free" },
  { step: "Preview", how: "Live frame previews while editing; the MP4 in the browser after rendering.", state: "free" },
  { step: "Quality checks", how: "Automatic checks before anything paid and again on the MP4.", state: "free" },
  { step: "MP4 export", how: "H.264 / AAC download.", state: "free" },
];

export default async function MotionDashboard() {
  const [canUse, jobs, script, voice, render, settings] = await Promise.all([
    hasPermission(PERMISSIONS.VIDEO_STUDIO_USE),
    prisma.videoJob.findMany({ where: { kind: "MOTION" }, orderBy: { createdAt: "desc" }, take: 25, select: { id: true, title: true, status: true, createdAt: true, actualInr: true, errorMessage: true, failedStage: true, config: true, mediaDeletedAt: true } }),
    scriptCapability(true),
    speechCapability("hinglish"),
    renderCapability(),
    getVideoSettings(),
  ]);
  const skills = VIDEO_SKILLS.filter((s) => s.module === "motion");
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Motion Workflow Studio</CardTitle>
          <CardDescription>
            Plan every frame before it is made: pick one style, write the script, storyboard it sentence by sentence, record the voice once, then render word-timed motion frames. Separate from the Generator and the Editor; it shares their OpenRouter key, cost ledger, voices, storage and renderer.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CapabilityList
            items={[
              script,
              voice.check,
              { key: "subtitles", label: "Precise word sync", status: settings.transcriptionModel ? "ready" : "missing", provider: settings.transcriptionModel ? `OpenRouter · ${settings.transcriptionModel}` : null, detail: settings.transcriptionModel ? "Transcribes the narration take once (paid, confirmed). Estimated sync is always free." : "Choose a transcription model in Settings. Until then words follow an estimate of the narration." },
              render,
            ]}
          />
          <div className="flex flex-wrap gap-2">
            {canUse ? <Button asChild><Link href="/admin/video-studio/motion/new" data-testid="motion-new">New motion video</Link></Button> : <p className="text-sm text-[var(--color-muted-foreground)]">Read-only access: only a Master Admin can create videos.</p>}
            <Button asChild variant="outline"><Link href="/admin/video-studio/motion/styles">Style library</Link></Button>
            <Button asChild variant="outline"><Link href="/admin/video-studio/skills">Motion skills in the Skill Library</Link></Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workflow</CardTitle>
          <CardDescription>Input → Script → Storyboard → Visual plan → Voice-over → Motion → Subtitle sync → Render → Preview → Quality checks → MP4. Every paid step shows its price first and starts only after you confirm.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2 md:grid-cols-2" data-testid="motion-workflow">
            {STEPS.map((s, i) => (
              <li key={s.step} className="flex gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-sm">
                <span className="font-semibold text-[var(--color-muted-foreground)]">{i + 1}</span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 font-medium">{s.step}<Badge variant={s.state === "paid" ? "warning" : "success"}>{s.state === "paid" ? "Paid · confirm first" : "Free"}</Badge></span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">{s.how}</span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Motion videos</CardTitle></CardHeader>
        <CardContent>
          {jobs.length ? (
            <ul className="divide-y divide-[var(--color-border)] text-sm" data-testid="motion-jobs">
              {jobs.map((j) => {
                const st = MOTION_STYLE_MAP[(j.config as { styleKey?: string } | null)?.styleKey ?? ""];
                return (
                  <li key={j.id} className="flex flex-wrap items-center gap-3 py-2">
                    <Link className="min-w-0 flex-1 truncate font-medium hover:underline" href={`/admin/video-studio/motion/${j.id}`}>{j.title}</Link>
                    {st ? <Badge>{st.name}</Badge> : null}
                    <JobStatusBadge status={j.status} />
                    <span className="text-xs tabular-nums">{formatInr(j.actualInr, 2)}</span>
                    <span className="text-xs text-[var(--color-muted-foreground)]">{j.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}{j.mediaDeletedAt ? " · media deleted" : ""}</span>
                    {j.status === "FAILED" ? <span className="w-full text-xs text-[var(--color-error)]">{j.failedStage}: {j.errorMessage}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-[var(--color-muted-foreground)]">No motion videos yet.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Motion skills</CardTitle>
          <CardDescription>Stored in the shared Skill Library. Where an equivalent Generator Skill exists, the motion Skill builds on it instead of duplicating it.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 md:grid-cols-2 text-sm" data-testid="motion-skills">
            {skills.map((s) => (
              <li key={s.key} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2">
                <span className="flex flex-wrap items-center gap-1.5 font-medium">{s.name}{s.required ? <Badge variant="warning">Always on</Badge> : null}{s.extends && SKILL_MAP[s.extends] ? <Badge>Builds on {SKILL_MAP[s.extends].name}</Badge> : null}</span>
                <span className="block text-xs text-[var(--color-muted-foreground)]">{s.description}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
