import { notFound } from "next/navigation";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getExamSubjects } from "@/lib/exam-taxonomy";
import { formatIst } from "@/lib/ist-time";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { jobSummary } from "@/lib/ai-import/summary";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import { JobWorkspace, type JobView } from "./job-workspace";
import type { ExamOption } from "../../new-import-form";

export const metadata = { title: "AI Import Job — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

export default async function AiImportJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Import Job" />;
  const { jobId } = await params;
  const job = await prisma.aiImportJob.findUnique({
    where: { id: jobId },
    include: { files: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "desc" }, take: 60 } },
  });
  if (!job) notFound();
  const [canUse, canPublish, settings, summary, exams, papers, exam, keyEntries] = await Promise.all([
    hasPermission(PERMISSIONS.AI_IMPORTER_USE),
    hasPermission(PERMISSIONS.QUESTIONS_MANAGE),
    getImporterSettings(),
    jobSummary(job.id),
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, code: true, year: true, isActive: true } }),
    prisma.previousYearPaper.findMany({ orderBy: [{ year: "desc" }, { title: "asc" }], select: { id: true, examId: true, year: true, title: true, paperCode: true } }),
    prisma.exam.findUnique({ where: { id: job.examId }, select: { name: true } }),
    prisma.aiImportKeyEntry.groupBy({ by: ["keyFileId"], where: { jobId: job.id }, _count: { _all: true } }),
  ]);
  const examOptions: ExamOption[] = await Promise.all(exams.map(async (e) => ({ ...e, subjects: await getExamSubjects(prisma, e.id), papers: papers.filter((p) => p.examId === e.id) })));
  const runs = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id, bulkImportRunId: { not: null } }, distinct: ["bulkImportRunId"], select: { bulkImportRunId: true } });
  const view: JobView = {
    id: job.id,
    title: job.title,
    status: job.status,
    examId: job.examId,
    examName: exam?.name ?? "—",
    paperType: job.paperType,
    subjectId: job.subjectId,
    year: job.year,
    paperCode: job.paperCode,
    previousYearPaperId: job.previousYearPaperId,
    budgetInr: job.budgetInr,
    spentInr: job.spentInr,
    estCostInr: job.estCostInr,
    pauseReason: job.pauseReason,
    errorMessage: job.errorMessage,
    createdAt: formatIst(job.createdAt),
    startedAt: job.startedAt ? formatIst(job.startedAt) : null,
    finishedAt: job.finishedAt ? formatIst(job.finishedAt) : null,
    analysis: (job.analysis as unknown as JobAnalysis | null) ?? null,
    files: job.files.map((f) => ({
      id: f.id,
      name: f.originalName,
      role: f.role,
      status: f.status,
      bytes: f.bytes || f.declaredBytes,
      pages: f.pageCount,
      error: f.errorMessage,
      kind: (f.detected as { kind?: string } | null)?.kind ?? null,
      identicalTo: (f.detected as { identicalTo?: { name: string } } | null)?.identicalTo?.name ?? null,
      paperFileId: f.paperFileId,
      keyEntries: keyEntries.find((k) => k.keyFileId === f.id)?._count._all ?? null,
    })),
    events: job.events.map((e) => ({ id: e.id, at: formatIst(e.createdAt), type: e.type, message: e.message })),
    summary,
    lastImport: (job.config as { lastImport?: { mode: string; result: Record<string, number>; finishedAt: string } } | null)?.lastImport ?? null,
    runIds: runs.map((r) => r.bulkImportRunId!).filter(Boolean),
    aiEnabled: settings.aiEnabled,
    allowUnverified: settings.publish.allowUnverifiedAnswers,
  };
  return <JobWorkspace job={view} exams={examOptions} canUse={canUse} canPublish={canPublish && canUse} />;
}
