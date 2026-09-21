import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, FileText, HelpCircle, Layers } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { requirePageVisible } from "@/lib/page-visibility";
import { getPublicExamList, getExamPublicStats } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";

export async function generateMetadata(): Promise<Metadata> {
  const [seo, siteUrl] = await Promise.all([getSeoSettings(), getSiteUrl()]);
  const title = applyTitleTemplate(seo.titleTemplate, "Exams");
  const description = "Browse every exam on MockTestSeries.in — mock tests, previous year papers, syllabus, and AI-powered explanations.";
  return {
    title,
    description,
    alternates: { canonical: `${siteUrl}/exams` },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url: `${siteUrl}/exams`, type: "website" },
  };
}

export default async function ExamsDirectoryPage() {
  await requirePageVisible("exams-directory");
  const [exams, siteUrl] = await Promise.all([getPublicExamList(), getSiteUrl()]);
  const statsByExam = new Map(await Promise.all(exams.map(async (e) => [e.id, await getExamPublicStats(e.id)] as const)));

  return (
    <PublicPageShell>
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <ExamBreadcrumbs baseUrl={siteUrl} crumbs={[{ label: "Home", href: "/" }, { label: "Exams" }]} />

        <h1 className="mt-4 text-3xl font-semibold text-[var(--color-foreground)] sm:text-4xl">Exams</h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">
          Full-length mock tests, previous year papers, and AI-powered explanations for every exam on the platform.
        </p>

        {exams.length === 0 ? (
          <p className="mt-10 text-sm text-[var(--color-muted-foreground)]">
            No exam pages are published yet — check back soon.
          </p>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {exams.map((exam) => {
              const stats = statsByExam.get(exam.id);
              return (
                <Link key={exam.id} href={`/exams/${exam.publicSlug}`} className="group block">
                  <Card className="h-full transition-colors group-hover:border-[var(--color-primary)]/50">
                    <CardContent className="flex flex-col gap-3 p-5">
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="text-lg font-semibold text-[var(--color-foreground)]">{exam.name}</h2>
                        {exam.isUpcoming ? <Badge variant="primary">Upcoming</Badge> : null}
                      </div>
                      {exam.shortDescription ? (
                        <p className="line-clamp-2 text-sm text-[var(--color-muted-foreground)]">{exam.shortDescription}</p>
                      ) : null}
                      {stats ? (
                        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
                          <span className="flex items-center gap-1">
                            <Layers className="h-3.5 w-3.5" aria-hidden /> {stats.questions} Questions
                          </span>
                          <span className="flex items-center gap-1">
                            <BookOpen className="h-3.5 w-3.5" aria-hidden /> {stats.subjects} Subjects
                          </span>
                          <span className="flex items-center gap-1">
                            <FileText className="h-3.5 w-3.5" aria-hidden /> {stats.papers} PYQ Papers
                          </span>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

        <div className="mt-10 flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted-foreground)]">
          <HelpCircle className="h-4 w-4 shrink-0" aria-hidden />
          Don&apos;t see your exam yet? More exams are added regularly — check back soon.
        </div>
      </div>
    </PublicPageShell>
  );
}
