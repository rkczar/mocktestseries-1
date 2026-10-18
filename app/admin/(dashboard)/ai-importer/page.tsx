import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getExamSubjects } from "@/lib/exam-taxonomy";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewImportForm, type ExamOption } from "./new-import-form";

export const metadata = { title: "AI Question Importer — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → New Import. The administrator gives the
 * exam context (existing exams, subjects and papers only) and a job budget;
 * files are uploaded on the next screen, analyzed locally for free, and paid
 * processing starts only after an explicit confirmation of the estimate.
 */
export default async function AiImporterNewPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="AI Question Importer" />;
  const canUse = await hasPermission(PERMISSIONS.AI_IMPORTER_USE);
  const [exams, papers, settings] = await Promise.all([
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true, code: true, year: true, isActive: true } }),
    prisma.previousYearPaper.findMany({ orderBy: [{ year: "desc" }, { title: "asc" }], select: { id: true, examId: true, year: true, title: true, paperCode: true } }),
    getImporterSettings(),
  ]);
  const options: ExamOption[] = await Promise.all(
    exams.map(async (e) => ({ ...e, subjects: await getExamSubjects(prisma, e.id), papers: papers.filter((p) => p.examId === e.id) }))
  );
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Question Importer</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Upload question papers and answer keys. Text layers, Word files and spreadsheets are read locally for free; scanned pages and complex layouts use AI vision only after you confirm the estimated cost. Approved questions enter the Question Bank through the existing Bulk Import.
        </p>
      </div>
      {!settings.aiEnabled && (
        <Card>
          <CardContent className="py-3 text-sm text-[var(--color-warning)]" data-testid="ai-off-banner">
            Paid AI processing is switched off in Import Settings. Digital PDFs, Word files and spreadsheets still work; scanned pages will be listed as needing AI.
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>New import</CardTitle>
          <CardDescription>Choose the exam the paper belongs to. Subjects and topics come from that exam&apos;s existing configuration.</CardDescription>
        </CardHeader>
        <CardContent>
          {canUse ? <NewImportForm exams={options} defaultBudget={settings.budget.defaultJobCapInr} maxJobInr={settings.budget.maxJobInr} /> : <p className="text-sm text-[var(--color-muted-foreground)]">You can view imports but not start one (Master Admin only).</p>}
        </CardContent>
      </Card>
    </div>
  );
}
