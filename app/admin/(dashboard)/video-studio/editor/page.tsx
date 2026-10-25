import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CapabilityList } from "@/components/admin/video-studio/capability-list";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { NewEditForm } from "@/components/admin/video-studio/editor/new-edit-form";
import { renderCapability } from "@/lib/video-studio/worker-status";
import { getVideoSettings } from "@/lib/video-studio/settings";

export const dynamic = "force-dynamic";

/**
 * AI Video Editor — start a project and list recent ones. Uploads, previews
 * and export need the private render worker; without a fresh heartbeat the
 * page says so and offers no action that cannot work.
 */
export default async function EditorPage() {
  const [render, canUse, settings, jobs] = await Promise.all([
    renderCapability(),
    hasPermission(PERMISSIONS.VIDEO_STUDIO_USE),
    getVideoSettings(),
    prisma.videoJob.findMany({ where: { kind: "EDIT" }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, title: true, status: true, createdAt: true, mediaDeletedAt: true } }),
  ]);
  const ready = render.status === "ready";
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>AI Video Editor</CardTitle>
          <CardDescription>Upload a video you recorded and turn it into a polished educational or promotional video — trims, subtitles, titles, diagrams, B-roll, music and branding — without changing what you said.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CapabilityList
            items={[
              render,
              { key: "subtitles", label: "Subtitles from your speech", status: settings.transcriptionModel ? "ready" : "missing", provider: settings.transcriptionModel ? `OpenRouter · ${settings.transcriptionModel}` : null, detail: settings.transcriptionModel ? "Paid per second of audio; the price is shown and confirmed for every recording. Hand-typed subtitles are always free." : "Choose a transcription model in Settings (after syncing Voice Studio). Hand-typed subtitles work without it." },
            ]}
          />
          {ready ? (
            canUse ? <NewEditForm disabled={false} /> : <p className="text-sm text-[var(--color-muted-foreground)]">Only a Master Admin can create editor projects.</p>
          ) : (
            <p className="rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm" data-testid="editor-unavailable">
              Not available yet: uploading and editing recorded videos needs the private render worker, which is not running on this server. Nothing can be uploaded until then.
            </p>
          )}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Limits: {settings.maxUploadMb} MB and {settings.maxUploadMinutes} minutes per recording. Background removal is not offered (RVM&apos;s matting model is GPL-3.0); a commercially licensed model will be evaluated separately.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Editor projects</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length ? (
            <ul className="divide-y divide-[var(--color-border)] text-sm" data-testid="edit-jobs">
              {jobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-3 py-2">
                  <Link className="min-w-0 flex-1 truncate font-medium hover:underline" href={`/admin/video-studio/jobs/${j.id}`}>{j.title}</Link>
                  <JobStatusBadge status={j.status} />
                  <span className="text-xs text-[var(--color-muted-foreground)]">{j.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}{j.mediaDeletedAt ? " · media deleted" : ""}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">No editor projects yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
