import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { JobStatusBadge } from "@/components/admin/video-studio/status-badge";
import { formatInr } from "@/lib/ai-engine/config";
import { JOB_STATUS_LABELS } from "@/lib/video-studio/types";
import type { VideoJobStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const filter = status && status in JOB_STATUS_LABELS ? (status as VideoJobStatus) : undefined;
  const jobs = await prisma.videoJob.findMany({
    where: filter ? { status: filter } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, title: true, status: true, kind: true, createdAt: true, estTotalInr: true, actualInr: true, unknownCostCalls: true, mediaDeletedAt: true, deliveredAt: true },
  });
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5 text-xs">
        <Link href="/admin/video-studio/history" className={`rounded-full border px-2.5 py-1 ${!filter ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>All</Link>
        {Object.entries(JOB_STATUS_LABELS).map(([k, v]) => (
          <Link key={k} href={`/admin/video-studio/history?status=${k}`} className={`rounded-full border px-2.5 py-1 ${filter === k ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)]"}`}>{v.label}</Link>
        ))}
      </nav>
      {jobs.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="history-empty">No video jobs{filter ? " with this status" : ""}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="history-table">
            <thead>
              <tr className="text-left text-xs text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-2 font-medium">Video</th>
                <th className="py-2 pr-2 font-medium">Status</th>
                <th className="py-2 pr-2 font-medium">Created</th>
                <th className="py-2 pr-2 text-right font-medium">Estimate</th>
                <th className="py-2 pr-2 text-right font-medium">Actual</th>
                <th className="py-2 font-medium">Media</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="py-2 pr-2"><Link className="font-medium hover:underline" href={`/admin/video-studio/jobs/${j.id}`}>{j.title}</Link></td>
                  <td className="py-2 pr-2"><JobStatusBadge status={j.status} /></td>
                  <td className="py-2 pr-2 text-xs">{j.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{j.estTotalInr === null ? "—" : formatInr(j.estTotalInr, 2)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatInr(j.actualInr, 4)}{j.unknownCostCalls ? <span className="block text-xs text-[var(--color-warning)]">+{j.unknownCostCalls} unknown</span> : null}</td>
                  <td className="py-2 text-xs">{j.mediaDeletedAt ? "Deleted (retention)" : j.deliveredAt ? "Delivered" : "Temporary"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
