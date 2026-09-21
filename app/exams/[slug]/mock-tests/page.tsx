import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, ListChecks } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug, getExamMockTests } from "@/lib/exam-public";
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
  const title = applyTitleTemplate(seo.titleTemplate, `${exam.name} Mock Tests`);
  const description = `Full-length ${exam.name} mock tests in exam pattern, with instant results and AI-powered explanations.`;
  const url = `${siteUrl}/exams/${exam.publicSlug}/mock-tests`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
  };
}

export default async function ExamMockTestsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const [tests, siteUrl] = await Promise.all([getExamMockTests(exam.id), getSiteUrl()]);

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
              { label: "Mock Tests" },
            ]}
          />
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-foreground)]">{exam.name} Mock Tests</h1>
          <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">Full-length, exam-pattern mock tests with instant scoring and AI explanations.</p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="mock-tests" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {tests.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No full-length mock tests are published for {exam.name} yet. In the meantime, practice with real previous year papers
              and subject-wise tests — both are fully available today.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <Button asChild>
                <Link href={`/exams/${exam.publicSlug}/previous-year-papers`}>Previous Year Papers</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/exams/${exam.publicSlug}/syllabus`}>Practice by Subject</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tests.map((t) => (
              <Card key={t.id}>
                <CardContent className="flex flex-col gap-2 p-5">
                  <p className="text-base font-semibold text-[var(--color-foreground)]">{t.title}</p>
                  {t.description ? <p className="text-sm text-[var(--color-muted-foreground)]">{t.description}</p> : null}
                  <div className="flex gap-4 text-xs text-[var(--color-muted-foreground)]">
                    <span className="flex items-center gap-1">
                      <ListChecks className="h-3.5 w-3.5" aria-hidden /> {t.questionCount} Qs
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" aria-hidden /> {t.durationMinutes} min
                    </span>
                  </div>
                  <Button asChild size="sm" className="mt-1 w-fit">
                    <Link href={`/student/attempt/resume?mockTest=${t.id}`}>Start Test</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </PublicPageShell>
  );
}
