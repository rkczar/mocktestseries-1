import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug, getExamSubjectsWithCounts, getExamPublicStats } from "@/lib/exam-public";
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
  const title = applyTitleTemplate(seo.titleTemplate, `${exam.name} Question Bank`);
  const description = `Subject-wise ${exam.name} question bank with AI-powered explanations for every question.`;
  const url = `${siteUrl}/exams/${exam.publicSlug}/question-bank`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
  };
}

export default async function ExamQuestionBankPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const [subjects, stats, siteUrl] = await Promise.all([
    getExamSubjectsWithCounts(exam.id),
    getExamPublicStats(exam.id),
    getSiteUrl(),
  ]);

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
              { label: "Question Bank" },
            ]}
          />
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-foreground)]">{exam.name} Question Bank</h1>
          <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">
            {stats.questions} published questions across {stats.subjects} subjects, each with an AI-powered explanation available
            once you sign in.
          </p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="question-bank" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {subjects.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">No questions published for this exam yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subjects.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex flex-col gap-2 p-4">
                  <p className="font-medium text-[var(--color-foreground)]">{s.name}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    {s.questionCount} questions · {s.topicCount} topics
                  </p>
                  <Button asChild size="sm" variant="outline" className="mt-1 w-fit">
                    <Link href={`/student/subject-test/${exam.id}`}>Practice →</Link>
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
