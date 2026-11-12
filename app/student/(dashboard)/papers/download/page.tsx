import Link from "next/link";
import { notFound } from "next/navigation";
import { FileDown, Lock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getContentAccess, paywallHref } from "@/lib/payments/access";
import { getPublicPaperDownloads, isPaperPdfLang, PAPER_PDF_LANG_LABEL } from "@/lib/paper-pdfs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Download paper — Mock Test Series.in", robots: { index: false, follow: false } };

/**
 * Landing for "Download PDF" links on public paper pages: login is enforced by requireStudentOrLogin
 * (back here after login), then the student sees Download (bought) or Buy (not bought). The file itself
 * is served only by /api/student/paper-download, which repeats every check.
 */
export default async function PaperDownloadPage({ searchParams }: { searchParams: Promise<{ paperId?: string; lang?: string }> }) {
  const student = await requireStudentOrLogin();
  const { paperId = "", lang } = await searchParams;
  if (!/^[a-z0-9]{10,40}$/i.test(paperId) || !isPaperPdfLang(lang)) notFound();
  const paper = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { id: true, year: true, title: true, examId: true, isActive: true, exam: { select: { isActive: true, name: true } } } });
  if (!paper?.isActive || !paper.exam.isActive) notFound();
  const offered = await getPublicPaperDownloads(paper.examId, [paper.id]);
  if (!offered.some((o) => o.lang === lang)) notFound();
  const content = { kind: "PREVIOUS_YEAR_PAPER" as const, id: paper.id, examId: paper.examId, accessType: "PAID" as const };
  const access = await getContentAccess(student.id, content);
  const owned = access.allowed && access.status === "ACTIVE_SUBSCRIPTION";

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <Card>
        <CardContent className="flex flex-col gap-4 py-6">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-foreground)]">
              {paper.title} — {PAPER_PDF_LANG_LABEL[lang]}
            </h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Typeset PDF with the official RPSC answer key. Your copy is marked with your masked mobile number; please don&apos;t share it.
            </p>
          </div>
          {owned ? (
            <Button asChild>
              <a href={`/api/student/paper-download?paperId=${paper.id}&lang=${lang}`} rel="nofollow">
                <FileDown className="h-4 w-4" aria-hidden /> Download PDF
              </a>
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="flex items-start gap-2 text-sm text-[var(--color-muted-foreground)]">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden />
                {access.status === "EXPIRED" ? "Your access to this exam has ended." : `Paper PDFs are part of the ${paper.exam.name} access.`}
              </p>
              {access.status === "NOT_AVAILABLE" || access.purchasesPaused ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">Purchases are not open right now.</p>
              ) : (
                <Button asChild>
                  <Link href={paywallHref(access, content)}>Buy access</Link>
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
