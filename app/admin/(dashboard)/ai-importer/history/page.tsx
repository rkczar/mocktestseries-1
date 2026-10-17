import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JOB_STATUS_LABELS } from "@/lib/ai-import/config";
import { jobSummary } from "@/lib/ai-import/summary";
import { statusVariant } from "../jobs/[jobId]/job-workspace";

export const metadata = { title: "AI Import History — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Import History: every job with its
 * reconciled counts (each detected question in exactly one bucket), cost,
 * duration, models, the Bulk Import runs it created and storage actions.
 */
export default async function AiImportHistoryPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Import History" />;
  const jobs = await prisma.aiImportJob.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { files: { select: { originalName: true, role: true, pageCount: true } } } });
  const [exams, admins, models, runs, cleanups] = await Promise.all([
    prisma.exam.findMany({ where: { id: { in: [...new Set(jobs.map((j) => j.examId))] } }, select: { id: true, name: true } }),
    prisma.adminUser.findMany({ where: { id: { in: [...new Set(jobs.map((j) => j.createdById))] } }, select: { id: true, name: true, username: true } }),
    prisma.aiImportAiCall.groupBy({ by: ["jobId", "model"], where: { jobId: { in: jobs.map((j) => j.id) } }, _count: { _all: true } }),
    prisma.aiImportQuestion.findMany({ where: { jobId: { in: jobs.map((j) => j.id) }, bulkImportRunId: { not: null } }, distinct: ["jobId", "bulkImportRunId"], select: { jobId: true, bulkImportRunId: true } }),
    prisma.aiImportEvent.groupBy({ by: ["jobId"], where: { type: "STORAGE_CLEANUP", jobId: { in: jobs.map((j) => j.id) } }, _count: { _all: true } }),
  ]);
  const summaries = await Promise.all(jobs.map((j) => jobSummary(j.id)));
  const subjects = await prisma.subject.findMany({ where: { id: { in: jobs.map((j) => j.subjectId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Import History</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Per-question rollback stays in the existing Bulk Import history (each job links its runs). A job is &ldquo;Completed&rdquo; only when every detected question is accounted for.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{jobs.length} import(s)</CardTitle>
          <CardDescription>Newest first.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1300px] text-left text-xs" data-testid="history-table">
            <thead className="text-[var(--color-muted-foreground)]">
              <tr>
                {["Import", "Uploaded", "By", "Exam / subject", "Files · pages", "Status", "Detected", "Imported", "Published", "Duplicates", "Correction", "Not importable", "Failed", "Unaccounted", "Answers", "Images", "Cost est. / actual", "Duration", "Models", "Runs", "Cleanups"].map((h) => (
                  <th key={h} className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j, i) => {
                const s = summaries[i];
                const admin = admins.find((a) => a.id === j.createdById);
                const dur = j.startedAt && j.finishedAt ? Math.max(1, Math.round((j.finishedAt.getTime() - j.startedAt.getTime()) / 60000)) : null;
                return (
                  <tr key={j.id} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1.5 pr-2">
                      <Link className="underline" href={`/admin/ai-importer/jobs/${j.id}`}>
                        {j.title}
                      </Link>
                      <div className="text-[var(--color-muted-foreground)]">{j.files.map((f) => f.originalName).join(", ").slice(0, 80)}</div>
                    </td>
                    <td className="py-1.5 pr-2">{formatIst(j.createdAt)}</td>
                    <td className="py-1.5 pr-2">{admin?.name ?? admin?.username ?? "—"}</td>
                    <td className="py-1.5 pr-2">
                      {exams.find((e) => e.id === j.examId)?.name ?? "—"}
                      {j.subjectId ? ` · ${subjects.find((x) => x.id === j.subjectId)?.name ?? ""}` : ""}
                    </td>
                    <td className="py-1.5 pr-2">
                      {j.files.length} · {j.files.reduce((a, f) => a + (f.pageCount ?? 0), 0)}
                    </td>
                    <td className="py-1.5 pr-2">
                      <Badge variant={statusVariant(j.status)}>{JOB_STATUS_LABELS[j.status]}</Badge>
                    </td>
                    <td className="py-1.5 pr-2">{s.detected}</td>
                    <td className="py-1.5 pr-2">{s.imported}</td>
                    <td className="py-1.5 pr-2">{s.published}</td>
                    <td className="py-1.5 pr-2">{s.duplicates}</td>
                    <td className="py-1.5 pr-2">{s.needsCorrection}</td>
                    <td className="py-1.5 pr-2">{s.notImportable}</td>
                    <td className="py-1.5 pr-2">{s.importFailed}</td>
                    <td className={`py-1.5 pr-2 ${s.unaccounted ? "text-[var(--color-error)]" : ""}`}>{s.unaccounted}</td>
                    <td className="py-1.5 pr-2">{Object.entries(s.answerStatus).map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")} ${v}`).join(", ")}</td>
                    <td className="py-1.5 pr-2">{s.imageIssues ? `${s.imageIssues} issue(s)` : "ok"}</td>
                    <td className="py-1.5 pr-2">
                      {j.estCostInr !== null ? `₹${j.estCostInr.toFixed(2)}` : "—"} / ₹{j.spentInr.toFixed(2)}
                    </td>
                    <td className="py-1.5 pr-2">{dur ? `${dur} min` : "—"}</td>
                    <td className="py-1.5 pr-2">{models.filter((m) => m.jobId === j.id).map((m) => `${m.model} ×${m._count._all}`).join(", ") || "local only"}</td>
                    <td className="py-1.5 pr-2">
                      {runs.filter((r) => r.jobId === j.id).map((r) => (
                        <Link key={r.bulkImportRunId} className="mr-1 underline" href={`/admin/questions/bulk-import/history/${r.bulkImportRunId}`}>
                          {r.bulkImportRunId!.slice(-6)}
                        </Link>
                      ))}
                    </td>
                    <td className="py-1.5 pr-2">{cleanups.find((c) => c.jobId === j.id)?._count._all ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
