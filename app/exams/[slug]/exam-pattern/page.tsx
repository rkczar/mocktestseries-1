import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { Card, CardContent } from "@/components/ui/card";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [exam, seo, siteUrl] = await Promise.all([getPublicExamBySlug(slug), getSeoSettings(), getSiteUrl()]);
  if (!exam) return {};
  const title = applyTitleTemplate(seo.titleTemplate, `${exam.name} Exam Pattern`);
  const description = `${exam.name} exam pattern — questions, marks, duration, and negative marking, with official vs. historical facts clearly labeled.`;
  const url = `${siteUrl}/exams/${exam.publicSlug}/exam-pattern`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
  };
}

export default async function ExamPatternPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const siteUrl = await getSiteUrl();

  const confirmedFacts: { label: string; value: string }[] = [];
  if (exam.conductingAuthority) confirmedFacts.push({ label: "Conducting Authority", value: exam.conductingAuthority });
  if (exam.totalQuestions) confirmedFacts.push({ label: "Questions", value: String(exam.totalQuestions) });
  if (exam.totalMarks) confirmedFacts.push({ label: "Total Marks", value: String(exam.totalMarks) });
  if (exam.durationMinutes) confirmedFacts.push({ label: "Duration", value: `${exam.durationMinutes} minutes` });
  if (exam.negativeMarking != null) confirmedFacts.push({ label: "Negative Marking", value: `${exam.negativeMarking} per wrong answer` });
  if (exam.examMode) confirmedFacts.push({ label: "Exam Mode", value: exam.examMode });

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
              { label: "Exam Pattern" },
            ]}
          />
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-foreground)]">{exam.name} Exam Pattern</h1>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="exam-pattern" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {confirmedFacts.length > 0 ? (
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-foreground)]">Confirmed Facts</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {confirmedFacts.map((f) => (
                <Card key={f.label}>
                  <CardContent className="p-4">
                    <p className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{f.label}</p>
                    <p className="mt-1 text-base font-medium text-[var(--color-foreground)]">{f.value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {exam.examPatternInfo ? (
          <section className="mt-10">
            <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-5">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-warning)]" aria-hidden />
              <div>
                <h2 className="text-base font-semibold text-[var(--color-foreground)]">Historical / Unconfirmed Pattern Details</h2>
                <p className="mt-2 whitespace-pre-line text-sm text-[var(--color-muted-foreground)]">{exam.examPatternInfo}</p>
              </div>
            </div>
          </section>
        ) : null}

        {confirmedFacts.length === 0 && !exam.examPatternInfo ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Exam pattern details haven&apos;t been published yet for {exam.name}.
          </p>
        ) : null}
      </div>
    </PublicPageShell>
  );
}
