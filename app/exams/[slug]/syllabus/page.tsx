import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { formatShare, getExamPyqInsights } from "@/lib/exam-pyq-insights";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { MockSeriesPromo } from "@/components/public-exam/mock-series-promo";
import { getExamMockSeriesSummary } from "@/lib/mock-series";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return {};
  const name = displayExamName(exam.name);
  return examPageMetadata({
    exam,
    path: `/exams/${exam.publicSlug}/syllabus`,
    title: `${name} Syllabus & Subject Weightage`,
    description: `Subject and topic-wise ${name} syllabus, with how many questions each subject carried in previous year papers, so you know where revision time pays off.`,
  });
}

export default async function ExamSyllabusPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();
  const mockSeriesSummary = await getExamMockSeriesSummary(exam);

  const [subjects, siteUrl] = await Promise.all([
    // Linked taxonomy; question counts are this exam's own.
    Promise.all([
      getExamTaxonomy(prisma, exam.id),
      prisma.question.groupBy({ by: ["subjectId"], where: { examId: exam.id, status: "PUBLISHED" }, _count: { _all: true } }),
    ]).then(([taxonomy, counts]) => {
      const bySubject = new Map(counts.map((c) => [c.subjectId, c._count._all]));
      return taxonomy.map((s) => ({ ...s, _count: { questions: bySubject.get(s.id) ?? 0 } }));
    }),
    getSiteUrl(),
  ]);
  const insights = await getExamPyqInsights(exam.id);
  const weightBySubject = new Map(insights.weightage.map((w) => [w.name, w]));
  const pastPapers = insights.papers.filter((p) => p.questionCount > 0).length;
  const name = displayExamName(exam.name);

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
              { label: "Syllabus" },
            ]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{name} Syllabus</h1>
          {exam.syllabusDescription ? (
            <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">{exam.syllabusDescription}</p>
          ) : (
            <p className="mt-2 max-w-2xl text-[var(--color-muted-foreground)]">
              Subject and topic-wise breakdown, matched to our question bank so every topic below has real practice questions.
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="syllabus" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        {pastPapers > 0 && subjects.length > 0 ? (
          <p className="mb-6 max-w-3xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">
            Each subject shows its topics, the practice questions available here, and its share of the {insights.totalQuestions} questions in{" "}
            <Link href={`/exams/${exam.publicSlug}/previous-year-papers`} className="font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
              {pastPapers} previous year papers
            </Link>{" "}
            (this site&apos;s subject classification). Confirm the official syllabus in the conducting authority&apos;s notification.
          </p>
        ) : null}
        {subjects.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Syllabus not published for this exam yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {subjects.map((s) => (
              <details key={s.id} className="group rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 open:pb-5" open>
                <summary className="flex cursor-pointer list-none items-center justify-between marker:content-none">
                  <span className="text-base font-semibold text-[var(--color-foreground)]">{s.name}</span>
                  <span className="text-right text-xs text-[var(--color-muted-foreground)]">
                    {s.topics.length} topics · {s._count.questions} questions
                    {weightBySubject.has(s.name) ? (
                      <span className="block sm:inline">
                        <span className="hidden sm:inline"> · </span>
                        {formatShare(weightBySubject.get(s.name)!.share)} of past-paper questions
                      </span>
                    ) : null}
                  </span>
                </summary>
                {s.topics.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {s.topics.map((t) => (
                      <span
                        key={t.id}
                        className="rounded-[var(--radius-badge)] border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted-foreground)]"
                      >
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-4">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/student/subject-test/${exam.id}`}>Practice {s.name} →</Link>
                  </Button>
                </div>
              </details>
            ))}
          </div>
        )}
        <div className="mt-10">
          <MockSeriesPromo summary={mockSeriesSummary} blurb="Each mock states exactly which subjects and topics it covers, so you can match practice to this syllabus." />
        </div>
      </div>
    </PublicPageShell>
  );
}
