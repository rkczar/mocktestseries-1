import Link from "next/link";
import { Clapperboard, Film, Wand2 } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { CapabilityList } from "@/components/admin/video-studio/capability-list";
import { scriptCapability } from "@/lib/video-studio/autoconfig";
import { speechCapability } from "@/lib/video-studio/voices";
import { renderCapability } from "@/lib/video-studio/worker-status";
import { freeDiskBytes } from "@/lib/video-studio/storage";
import { formatInr } from "@/lib/ai-engine/config";

export const dynamic = "force-dynamic";

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const mb = (b: number) => `${(b / 1024 ** 2).toFixed(1)} MB`;

/** Kept outside the component: computing "now" is an impure call components must not make during render. */
function monthStartIst(): Date {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60_000);
}

export default async function VideoStudioDashboard() {
  const monthStart = monthStartIst();
  const [canUse, recent, holding, monthCost, script, voice, render, free] = await Promise.all([
    hasPermission(PERMISSIONS.VIDEO_STUDIO_USE),
    prisma.videoJob.findMany({ orderBy: { createdAt: "desc" }, take: 6, select: { id: true, title: true, status: true, createdAt: true, estTotalInr: true, actualInr: true } }),
    prisma.videoJob.aggregate({ where: { mediaDeletedAt: null, storageBytes: { gt: 0 } }, _sum: { storageBytes: true }, _count: { _all: true } }),
    prisma.aiGatewayCall.aggregate({ where: { feature: "video_script", createdAt: { gte: monthStart } }, _sum: { actualCostInr: true }, _count: { _all: true } }),
    scriptCapability(true),
    speechCapability("hinglish"),
    renderCapability(),
    freeDiskBytes().catch(() => null),
  ]);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Wand2 className="h-4 w-4" aria-hidden /> AI Video Generator</CardTitle>
            <CardDescription>New video from a topic, a prompt or Question Bank MCQs.</CardDescription>
          </CardHeader>
          <CardContent>
            {canUse ? (
              <Button asChild>
                <Link href="/admin/video-studio/new">Create Video</Link>
              </Button>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">Read-only access: only a Master Admin can create videos.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Film className="h-4 w-4" aria-hidden /> AI Video Editor</CardTitle>
            <CardDescription>Polish a video you recorded: captions, branding, trims, layouts.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/admin/video-studio/editor">Open AI Video Editor</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>What the studio can do right now</CardTitle>
          <CardDescription>Checked live from the AI Engine, Voice Studio and the render worker. Nothing here is assumed.</CardDescription>
        </CardHeader>
        <CardContent>
          <CapabilityList items={[script, voice.check, render]} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Script AI cost this month</CardDescription>
            <CardTitle data-testid="month-cost">{formatInr(monthCost._sum.actualCostInr ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[var(--color-muted-foreground)]">{monthCost._count._all} request(s) · details in Cost Center</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Temporary media on disk</CardDescription>
            <CardTitle>{mb(Number(holding._sum.storageBytes ?? 0))}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[var(--color-muted-foreground)]">{holding._count._all} job(s) hold media · removed by the retention policy</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Free disk space</CardDescription>
            <CardTitle>{free === null ? "—" : gb(free)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-[var(--color-muted-foreground)]">New jobs are refused below the minimum in Settings.</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Clapperboard className="h-4 w-4" aria-hidden /> Recent videos</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="no-jobs">No videos yet.{canUse ? " Start with Create Video." : ""}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {recent.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <Link href={`/admin/video-studio/jobs/${j.id}`} className="min-w-0 truncate text-sm font-medium hover:underline">
                    {j.title}
                  </Link>
                  <div className="flex items-center gap-3 text-xs text-[var(--color-muted-foreground)]">
                    <span>{j.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</span>
                    <JobStatusBadge status={j.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
