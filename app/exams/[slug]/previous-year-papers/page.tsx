import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { MockSeriesPromo } from "@/components/public-exam/mock-series-promo";
import { ExamDisclaimer, ExamSection, FaqList, SubjectWeightageTable } from "@/components/public-exam/seo-blocks";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { formatShare, getExamPyqInsights, pyqYearPath, type ExamPyqInsights } from "@/lib/exam-pyq-insights";

function yearSpan(insights: ExamPyqInsights): string {
  const years = insights.papers.filter((p) => p.questionCount > 0).map((p) => p.year);
  if (years.length === 0) return "";
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? String(max) : `${min}–${max}`;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return {};
  const name = displayExamName(exam.name);
  const insights = await getExamPyqInsights(exam.id);
  const papers = insights.papers.filter((p) => p.questionCount > 0);
  const span = yearSpan(insights);
  return examPageMetadata({
    exam,
    path: `/exams/${exam.publicSlug}/previous-year-papers`,
    title: `${name} Previous Year Papers${span ? ` (${span})` : ""}`,
    description:
      papers.length > 0
        ? `${papers.length} ${name} previous year question papers (${span}) to attempt online in the exam format, with subject-wise question counts and question-wise review after you submit.`
        : `${name} previous year question papers, as they are added, to attempt online in the exam format.`,
  });
}

export default async function ExamPreviousYearPapersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const [insights, mockSeriesSummary, siteUrl] = await Promise.all([getExamPyqInsights(exam.id), getExamMockSeriesSummary(exam), getSiteUrl()]);
  const name = displayExamName(exam.name);
  const base = `/exams/${exam.publicSlug}`;
  const papers = insights.papers.filter((p) => p.questionCount > 0);
  const span = yearSpan(insights);
  const top = insights.weightage.slice(0, 3);
  const seriesHref = mockSeriesSummary.mockSeries ? mockSeriesSummary.href : null;

  const faq =
    papers.length > 0
      ? [
          {
            question: `How many ${name} previous year papers are available?`,
            answer: `${papers.length} papers are available to attempt online: ${papers.map((p) => p.year).join(", ")}. Together they contain ${insights.totalQuestions} questions.`,
          },
          {
            question: "Which subjects have the most questions in past papers?",
            answer: `Across all ${papers.length} papers, ${top.map((s) => `${s.name} (${s.count} questions, ${formatShare(s.share)})`).join(", ")} had the most questions. The subject-wise table on this page lists every subject. Subjects follow this site's question-bank classification.`,
          },
          {
            question: "Can I download these papers as PDFs?",
            answer:
              "No. Papers here are for timed online attempts in the exam format, not downloads. Where the conducting authority releases official question papers or answer keys, they are published on its own website.",
          },
          {
            question: "How do I attempt a paper and check my answers?",
            answer:
              "Sign in, open a paper and attempt it like the real exam. When you submit, you get your result with question-wise review, and you can ask the AI to explain any question you got wrong.",
          },
        ]
      : [];

  return (
    <PublicPageShell>
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <ExamBreadcrumbs
            baseUrl={siteUrl}
            crumbs={[
              { label: "Home", href: "/" },
              { label: "Exams", href: "/exams" },
              { label: name, href: base },
              { label: "Previous Year Papers" },
            ]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{name} Previous Year Papers</h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-[var(--color-muted-foreground)]">
            {papers.length > 0
              ? `${papers.length} past papers from ${span}, ${insights.totalQuestions} questions in all. Attempt each one timed, in the exam format, then review every question with an explanation.`
              : "Past papers will appear here as they are added."}
          </p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="previous-year-papers" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-2 sm:px-6">
        <ExamSection id="papers" title="Papers by year">
          {papers.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No previous year papers are published for this exam yet.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {papers.map((p) => (
                <li key={p.id} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-lg text-[var(--color-foreground)]">
                      {p.indexable ? (
                        <Link href={pyqYearPath(exam.publicSlug!, p.year)} className="underline-offset-4 hover:underline">
                          {name.replace(/\s\d{4}$/, "")} {p.year} paper
                        </Link>
                      ) : (
                        `${p.title}`
                      )}
                    </h3>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted-foreground)]">{p.questionCount} Qs</span>
                  </div>
                  {p.subjects.length > 0 ? (
                    <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">
                      {p.subjects.length} subjects · most questions from {p.subjects.slice(0, 2).map((s) => `${s.name} (${s.count})`).join(" and ")}
                    </p>
                  ) : null}
                  <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
                    <Button asChild size="sm">
                      <Link prefetch={false} href={`/student/attempt/resume?paper=${p.id}`}>Attempt paper</Link>
                    </Button>
                    {p.indexable ? (
                      <Link href={pyqYearPath(exam.publicSlug!, p.year)} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
                        Subject breakdown
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ExamSection>

        {insights.weightage.length > 0 ? (
          <ExamSection
            id="subject-weightage"
            title="Subject-wise questions across all papers"
            intro={`How the ${insights.totalQuestions} questions in these ${papers.length} papers are spread across subjects. Use it to decide where revision time goes first.`}
            action={{ href: `${base}/syllabus`, label: "Syllabus with topics" }}
          >
            <SubjectWeightageTable rows={insights.weightage} total={insights.totalQuestions} caption={`${name} previous year questions by subject`} showPapers />
            <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
              Subjects follow this site&apos;s question-bank classification. &ldquo;Papers&rdquo; is the number of papers with at least one question from that subject.
            </p>
          </ExamSection>
        ) : null}

        <ExamSection id="how-to-use" title="How to get the most from previous papers">
          <ol className="grid gap-3 md:grid-cols-3">
            {[
              ["Attempt timed, start to finish", "Treat each paper as the real exam: one sitting, the full time limit, no pausing to look things up."],
              ["Review every mistake", "After submitting, read the explanation for each wrong or guessed answer and note the topic it came from."],
              ["Then move to fresh mocks", "Past papers show what gets asked; mocks test whether you can do it again on new questions."],
            ].map(([title, body], i) => (
              <li key={title} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
                <span className="text-xs tabular-nums text-[var(--color-muted-foreground)]">Step {i + 1}</span>
                <h3 className="text-base font-semibold text-[var(--color-foreground)]">{title}</h3>
                <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">{body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link href={base} className="font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
              {name}: dates, eligibility and pattern
            </Link>
            <Link href={`${base}/exam-pattern`} className="font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
              Exam pattern
            </Link>
            {seriesHref ? (
              <Link href={seriesHref} className="font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
                {name} mock test series
              </Link>
            ) : null}
          </div>
        </ExamSection>

        {faq.length > 0 ? (
          <ExamSection id="faq" title="Frequently asked questions">
            <FaqList items={faq} />
          </ExamSection>
        ) : null}

        <div className="mt-6">
          <MockSeriesPromo
            summary={mockSeriesSummary}
            blurb="Solved the past papers? Test yourself on fresh, exam-pattern mocks released on a schedule, with the same result, review and Ask AI."
          />
        </div>

        <ExamDisclaimer authority={exam.conductingAuthority} />
      </div>
    </PublicPageShell>
  );
}
