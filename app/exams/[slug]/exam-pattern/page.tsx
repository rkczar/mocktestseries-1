import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { Card, CardContent } from "@/components/ui/card";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { MockSeriesPromo } from "@/components/public-exam/mock-series-promo";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { getExamPyqInsights } from "@/lib/exam-pyq-insights";
import { examInsightPath, hasPyqAnalysis } from "@/lib/exam-pyq-analysis";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return {};
  const name = displayExamName(exam.name);
  return examPageMetadata({
    exam,
    path: `/exams/${exam.publicSlug}/exam-pattern`,
    title: `${name} Exam Pattern & Marking Scheme`,
    description: `${name} exam pattern: number of questions, marks, duration, mode and negative marking, with confirmed facts kept separate from previous-cycle details.`,
  });
}

export default async function ExamPatternPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();
  const mockSeriesSummary = await getExamMockSeriesSummary(exam);

  const [siteUrl, pyqInsights] = await Promise.all([getSiteUrl(), getExamPyqInsights(exam.id)]);
  const name = displayExamName(exam.name);
  const hasAnalysis = hasPyqAnalysis(pyqInsights);

  const confirmedFacts: { label: string; value: string }[] = [];
  if (exam.conductingAuthority) confirmedFacts.push({ label: "Conducting Authority", value: exam.conductingAuthority });
  if (exam.totalQuestions) confirmedFacts.push({ label: "Questions", value: String(exam.totalQuestions) });
  if (exam.totalMarks) confirmedFacts.push({ label: "Total Marks", value: String(exam.totalMarks) });
  if (exam.durationMinutes) confirmedFacts.push({ label: "Duration", value: `${exam.durationMinutes} minutes` });
  if (exam.negativeMarking != null) {
    confirmedFacts.push({ label: "Negative Marking", value: exam.negativeMarking === 0 ? "None" : `${exam.negativeMarking} per wrong answer` });
  }
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
              { label: name, href: `/exams/${exam.publicSlug}` },
              { label: "Exam Pattern" },
            ]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{name} Exam Pattern</h1>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="exam-pattern" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {confirmedFacts.length > 0 ? (
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-foreground)]">Pattern at a Glance</h2>
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
                <h2 className="text-base font-semibold text-[var(--color-foreground)]">Sources and what is still to be confirmed</h2>
                <p className="mt-2 whitespace-pre-line text-sm text-[var(--color-muted-foreground)]">{exam.examPatternInfo}</p>
              </div>
            </div>
          </section>
        ) : null}

        {confirmedFacts.length === 0 && !exam.examPatternInfo ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Exam pattern details haven&apos;t been published yet for {name}.
          </p>
        ) : null}
        {hasAnalysis ? (
          <p className="mt-8 max-w-3xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">
            The pattern tells you the format; past papers show where the questions come from. See the{" "}
            <Link href={examInsightPath(exam.publicSlug!, "weightage")} className="font-medium text-[var(--color-foreground)] underline underline-offset-4">
              subject-wise weightage of previous papers
            </Link>{" "}
            and a{" "}
            <Link href={examInsightPath(exam.publicSlug!, "strategy")} className="font-medium text-[var(--color-foreground)] underline underline-offset-4">
              preparation strategy built for this pattern
            </Link>
            .
          </p>
        ) : null}
        <div className="mt-10">
          <MockSeriesPromo summary={mockSeriesSummary} blurb="Practise under this pattern: timed mocks with per-test question count, duration and negative marking shown upfront." />
        </div>
      </div>
    </PublicPageShell>
  );
}
