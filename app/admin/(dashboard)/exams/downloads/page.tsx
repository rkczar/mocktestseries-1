import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getExamFeatures } from "@/lib/exam-features";
import { numberedOmrSpecFor } from "@/lib/exam-downloads";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DownloadSwitch, DownloadsExamPicker, GenerateOmrButton, ResourceActiveButton } from "./controls";
import { PaperPdfSection } from "./paper-pdf-section";

/**
 * Exam → Downloads: the per-exam OMR and Paper PDF switches (both OFF unless turned on here) and the
 * exam-level files they release. Students only ever reach these files through the download routes,
 * which re-check the exam, the switch and (paper PDFs) login + purchase on every request.
 */
export default async function ExamDownloadsPanel({ searchParams }: { searchParams: Promise<{ examId?: string }> }) {
  const { examId } = await searchParams;
  const [exams, canManage] = await Promise.all([
    prisma.exam.findMany({ select: { id: true, name: true, code: true }, orderBy: [{ order: "asc" }, { name: "asc" }] }),
    hasPermission(PERMISSIONS.EXAMS_MANAGE),
  ]);
  const exam = examId ? await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, name: true, code: true, isActive: true } }) : null;
  const [features, omrSheets] = exam
    ? await Promise.all([
        getExamFeatures(exam.id),
        prisma.testResource.findMany({
          where: { examId: exam.id, mockTestId: null, type: "OMR_TEMPLATE" },
          orderBy: [{ order: "asc" }, { createdAt: "desc" }],
          select: { id: true, title: true, questionCount: true, isActive: true, createdAt: true },
        }),
      ])
    : [null, []];
  const omrSpec = exam ? numberedOmrSpecFor(exam.code) : null;

  return (
    <div className="flex flex-col gap-4">
      <DownloadsExamPicker exams={exams} selectedExamId={exam?.id} />
      {!exam || !features ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Pick an exam to manage its OMR and Paper PDF downloads.</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Download switches — {exam.name}</CardTitle>
              <CardDescription>
                Both are OFF unless turned on here. While the exam itself is inactive ({exam.isActive ? "it is active" : "it is inactive now"}), students get nothing
                either way.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <DownloadSwitch examId={exam.id} feature="omrDownloadEnabled" label="OMR sheet download (public, no login)" enabled={features.omrDownloadEnabled} canManage={canManage} />
              <DownloadSwitch examId={exam.id} feature="paperDownloadEnabled" label="Paper PDF download (login + purchase)" enabled={features.paperDownloadEnabled} canManage={canManage} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Practice OMR sheets</CardTitle>
              <CardDescription>Only this exam&apos;s sheet is offered to its students; another exam never receives it.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {omrSheets.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No OMR sheet for this exam yet.</p> : null}
              {omrSheets.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
                  <div>
                    <p className="font-medium">{r.title}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {r.questionCount ?? "?"} questions · created {r.createdAt.toISOString().slice(0, 10)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={r.isActive ? "success" : "neutral"}>{r.isActive ? "Active" : "Inactive"}</Badge>
                    {canManage ? <ResourceActiveButton resourceId={r.id} isActive={r.isActive} /> : null}
                  </div>
                </div>
              ))}
              {canManage && omrSpec ? <GenerateOmrButton examId={exam.id} /> : null}
            </CardContent>
          </Card>

          <PaperPdfSection examId={exam.id} canManage={canManage} />
        </>
      )}
    </div>
  );
}
