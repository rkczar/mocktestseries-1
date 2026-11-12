import { prisma } from "@/lib/prisma";
import { getPaperPdfIndex, PAPER_PDF_LANGS, PAPER_PDF_LANG_LABEL } from "@/lib/paper-pdfs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ResourceActiveButton } from "./controls";

/** Built paper PDFs per paper × language (built offline by scripts/build-paper-pdfs.ts, stored inactive). */
export async function PaperPdfSection({ examId, canManage }: { examId: string; canManage: boolean }) {
  const [papers, index] = await Promise.all([
    prisma.previousYearPaper.findMany({ where: { examId }, orderBy: { year: "asc" }, select: { id: true, year: true, title: true } }),
    getPaperPdfIndex(examId),
  ]);
  const resources = await prisma.testResource.findMany({ where: { id: { in: index.map((e) => e.resourceId) } }, select: { id: true, isActive: true } });
  const active = new Map(resources.map((r) => [r.id, r.isActive]));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Previous Year Paper PDFs</CardTitle>
        <CardDescription>
          Typeset from the question bank (never the RPSC scan) with the mocktestseries.in watermark, the official answer key and source attribution. Built
          offline by a deploy-time script after review; each file starts inactive. Students download only when the file is active, the Paper PDF switch is
          ON, and they have bought the exam.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {papers.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No previous year papers in this exam.</p> : null}
        {papers.map((p) => (
          <div key={p.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
            <p className="mb-2 font-medium">
              {p.year} — {p.title}
            </p>
            <div className="flex flex-col gap-2">
              {PAPER_PDF_LANGS.map((lang) => {
                const e = index.find((x) => x.paperId === p.id && x.lang === lang);
                const isActive = e ? active.get(e.resourceId) === true : false;
                return (
                  <div key={lang} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{PAPER_PDF_LANG_LABEL[lang]}</span>
                    {e ? (
                      <span className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                        {e.pages} pages · {e.questionCount} questions · built {e.builtAt.slice(0, 10)} · sha {e.sha256.slice(0, 10)}
                        <Badge variant={isActive ? "success" : "neutral"}>{isActive ? "Active" : "Inactive"}</Badge>
                        {canManage ? <ResourceActiveButton resourceId={e.resourceId} isActive={isActive} /> : null}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-muted-foreground)]">Not built</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
