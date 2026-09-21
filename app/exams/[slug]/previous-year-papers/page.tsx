import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug, getExamPapers } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [exam, seo, siteUrl] = await Promise.all([getPublicExamBySlug(slug), getSeoSettings(), getSiteUrl()]);
  if (!exam) return {};
  const title = applyTitleTemplate(seo.titleTemplate, `${exam.name} Previous Year Papers`);
  const description = `Practice real ${exam.name} previous year papers in live-test format, with AI-powered explanations after every attempt.`;
  const url = `${siteUrl}/exams/${exam.publicSlug}/previous-year-papers`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
  };
}

export default async function ExamPreviousYearPapersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const [papers, siteUrl] = await Promise.all([getExamPapers(exam.id), getSiteUrl()]);

  return (
    <PublicPageShell>
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          <ExamBreadcrumbs
            baseUrl={siteUrl}
            crumbs={[
              { label: "Home", href: "/" },
              { label: "Exams", href: "/exams" },
              { label: exam.name, href: `/exams/${exam.publicSlug}` },
              { label: "Previous Year Papers" },
            ]}
          />
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-foreground)]">{exam.name} Previous Year Papers</h1>
          <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">
            Attempt real past papers in live-test format — timed, exam-pattern, with question-wise review and AI explanations.
          </p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="previous-year-papers" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {papers.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">No previous year papers are published for this exam yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {papers.map((p) => (
              <Card key={p.id}>
                <CardContent className="flex flex-col gap-2 p-5">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-[var(--color-primary)]" aria-hidden />
                    <p className="text-xl font-semibold text-[var(--color-foreground)]">{p.year}</p>
                  </div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{p.title}</p>
                  {p.paperCode ? <p className="text-xs text-[var(--color-muted-foreground)]">Code: {p.paperCode}</p> : null}
                  {p.questionCount > 0 ? (
                    <p className="text-xs text-[var(--color-muted-foreground)]">{p.questionCount} questions</p>
                  ) : (
                    <p className="text-xs text-[var(--color-warning)]">Questions coming soon</p>
                  )}
                  {p.questionCount > 0 ? (
                    <Button asChild size="sm" className="mt-1 w-fit">
                      <Link href={`/student/attempt/resume?paper=${p.id}`}>Attempt Paper</Link>
                    </Button>
                  ) : (
                    <Button size="sm" className="mt-1 w-fit" disabled>
                      Attempt Paper
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </PublicPageShell>
  );
}
