import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JOB_STATUS_LABELS } from "@/lib/ai-import/config";
import { statusVariant } from "./[jobId]/job-workspace";

export const metadata = { title: "AI Import Jobs — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/** Admin → AI Question Importer → Processing Jobs: open jobs first, then finished ones. */
export default async function AiImportJobsPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Import Jobs" />;
  const jobs = await prisma.aiImportJob.findMany({
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: { _count: { select: { files: true, questions: true } }, pages: { select: { status: true } } },
  });
  const exams = await prisma.exam.findMany({ where: { id: { in: [...new Set(jobs.map((j) => j.examId))] } }, select: { id: true, name: true } });
  const open = ["DRAFT", "ANALYZING", "AWAITING_CONFIRMATION", "QUEUED", "PROCESSING", "NEEDS_REVIEW", "PAUSED", "PAUSED_BUDGET", "IMPORTING", "FAILED"];
  const sorted = [...jobs.filter((j) => open.includes(j.status)), ...jobs.filter((j) => !open.includes(j.status))];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Processing Jobs</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Jobs run in a separate low-priority worker. Pause, resume, retry and cancel from a job&apos;s page.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{jobs.length} job(s)</CardTitle>
          <CardDescription>Open jobs first.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm" data-testid="jobs-table">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Import</th>
                <th className="py-1 pr-2 font-medium">Exam</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 pr-2 font-medium">Files</th>
                <th className="py-1 pr-2 font-medium">Pages done</th>
                <th className="py-1 pr-2 font-medium">Questions</th>
                <th className="py-1 pr-2 font-medium">AI spend / budget</th>
                <th className="py-1 pr-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((j) => (
                <tr key={j.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-2">
                    <Link className="underline" href={`/admin/ai-importer/jobs/${j.id}`}>
                      {j.title}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2">{exams.find((e) => e.id === j.examId)?.name ?? "—"}</td>
                  <td className="py-1.5 pr-2">
                    <Badge variant={statusVariant(j.status)}>{JOB_STATUS_LABELS[j.status] ?? j.status}</Badge>
                  </td>
                  <td className="py-1.5 pr-2">{j._count.files}</td>
                  <td className="py-1.5 pr-2">
                    {j.pages.filter((p) => p.status === "DONE").length}/{j.pages.length}
                  </td>
                  <td className="py-1.5 pr-2">{j._count.questions}</td>
                  <td className="py-1.5 pr-2">
                    ₹{j.spentInr.toFixed(2)} / ₹{j.budgetInr.toFixed(2)}
                  </td>
                  <td className="py-1.5 pr-2 text-xs">{formatIst(j.updatedAt)}</td>
                </tr>
              ))}
              {!jobs.length && (
                <tr>
                  <td colSpan={8} className="py-4 text-[var(--color-muted-foreground)]">
                    No imports yet. Start one under New Import.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
