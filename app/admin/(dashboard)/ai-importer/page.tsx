import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getExamSubjects } from "@/lib/exam-taxonomy";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { computeModelPlan } from "@/lib/ai-import/select";
import { SELECTION_TASKS, SELECTION_TASK_LABELS } from "@/lib/ai-import/config";
import { jobCards, jobMapping } from "@/lib/ai-import/job-view";
import { importerSpendSummary } from "@/lib/ai-import/ledger";
import { jobQuality } from "@/lib/ai-import/summary";
import { analyzerVerdict } from "@/lib/ai-import/verdict";
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import type { CostEstimate } from "@/lib/ai-import/estimate";
import { OnePageImporter, type AiConfigView, type CurrentJob } from "./one-page-importer";
import type { ExamOption } from "./new-import-form";

export const metadata = { title: "AI Question Importer — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer: one page for the whole workflow. Upload a
 * paper → it is analyzed locally for free → the analyzer shows what was
 * detected, the reading strategy, the model chosen automatically and the
 * maximum cost → "Process & Import Questions" processes the file and sends
 * eligible questions through the existing Bulk Import as Draft. The page
 * follows the job (?job=…) until its result is shown.
 */
export default async function AiImporterPage({ searchParams }: { searchParams: Promise<{ job?: string; model?: string }> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Question Importer" />;
  const { job: jobParam, model: modelParam } = await searchParams;
  const [canUse, canManage, settings, exams, papers, lastJob] = await Promise.all([
    hasPermission(PERMISSIONS.AI_IMPORTER_USE),
    hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE),
    getImporterSettings(),
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, code: true, year: true, isActive: true } }),
    prisma.previousYearPaper.findMany({ orderBy: [{ year: "desc" }, { title: "asc" }], select: { id: true, examId: true, year: true, title: true, paperCode: true } }),
    prisma.aiImportJob.findFirst({ orderBy: { createdAt: "desc" }, select: { examId: true } }),
  ]);
  const options: ExamOption[] = await Promise.all(exams.map(async (e) => ({ ...e, subjects: await getExamSubjects(prisma, e.id), papers: papers.filter((p) => p.examId === e.id) })));
  const defaultExamId = (lastJob && exams.some((e) => e.id === lastJob.examId) ? lastJob.examId : null) ?? exams.find((e) => e.isActive)?.id ?? "";

  let current: CurrentJob | null = null;
  const jobId = typeof jobParam === "string" && /^[a-z0-9]{10,40}$/.test(jobParam) ? jobParam : null;
  if (jobId) {
    const [card] = await jobCards({ ids: [jobId] }, canManage);
    const job = card ? await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { analysis: true, estimate: true, examId: true, paperType: true, year: true, previousYearPaperId: true, files: { where: { role: "PAPER", status: { not: "REJECTED" } }, select: { id: true, originalName: true, pageCount: true }, orderBy: { createdAt: "asc" } } } }) : null;
    const [mapping, quality, stage, spend] = job ? await Promise.all([jobMapping(jobId), jobQuality(jobId), prisma.aiImportEvent.findFirst({ where: { jobId, type: "STAGE" }, orderBy: { createdAt: "desc" }, select: { message: true } }), importerSpendSummary(jobId)]) : [null, null, null, null];
    if (card && job && mapping && spend) {
      const analysis = job.analysis as unknown as JobAnalysis | null;
      const yearMissing = !job.year && !job.previousYearPaperId && !exams.find((e) => e.id === job.examId)?.year;
      const estimate = (job.estimate as unknown as CostEstimate | null) ?? analysis?.estimate ?? null;
      current = {
        card,
        examName: mapping.examName,
        mapping,
        quality,
        estimatedQuestions: estimate?.expectedQuestions || null,
        papers: papers.filter((p) => p.examId === job.examId),
        files: job.files.map((f) => ({ id: f.id, name: f.originalName, pageCount: f.pageCount })),
        stage: stage?.message ?? null,
        verifyAvailable: !!estimate?.plan?.tasks.verify.model,
        spend,
        costLines: settings.aiEnabled ? (estimate?.lines ?? []).filter((l) => l.calls > 0 && l.model !== null).map((l) => ({ label: l.label, calls: l.calls, inr: l.inr, maxInr: l.maxInr })) : [],
        verdict: analysis
          ? analyzerVerdict({
              analysis,
              estimate: (job.estimate as unknown as CostEstimate | null) ?? null,
              aiEnabled: settings.aiEnabled,
              limits: settings.limits,
              paperType: job.paperType,
              yearMissing,
            })
          : null,
      };
    }
  }
  // AI Configuration: the same plan Import Settings shows (stored route snapshot, no provider call on page load).
  const plan = settings.aiEnabled && !current ? await computeModelPlan(settings, { refresh: false }).catch((e) => (console.error("ai-importer plan error:", e instanceof Error ? e.message : e), null)) : null;
  const ai: AiConfigView = {
    aiEnabled: settings.aiEnabled,
    mode: settings.selection.mode,
    stages: SELECTION_TASKS.map((task) => ({ task, label: SELECTION_TASK_LABELS[task], model: plan?.tasks[task].model ?? null, reason: plan?.tasks[task].reason ?? (settings.aiEnabled ? "The model plan could not be computed — open Import Settings to check the provider." : "Paid AI is off.") })),
    problems: plan?.problems ?? [],
  };
  const initialOverride = typeof modelParam === "string" && settings.importerModels.includes(modelParam) ? modelParam : "";
  const recent = (await jobCards({ take: 6 }, canManage)).filter((j) => j.id !== current?.card.id).slice(0, 5);

  return (
    <OnePageImporter
      canUse={canUse}
      canManage={canManage}
      exams={options}
      defaultExamId={defaultExamId}
      limits={{ maxFileMb: settings.limits.maxFileMb, maxPagesPerFile: settings.limits.maxPagesPerFile }}
      aiEnabled={settings.aiEnabled}
      selection={{ mode: settings.selection.mode, model: settings.selection.mode === "manual" ? settings.models.extract : null }}
      importerModels={settings.importerModels}
      ai={ai}
      initialOverride={initialOverride}
      current={current}
      missingJob={!!jobParam && !current}
      recent={recent}
    />
  );
}
