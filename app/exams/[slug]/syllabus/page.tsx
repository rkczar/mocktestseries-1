import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { MockSeriesPromo } from "@/components/public-exam/mock-series-promo";
import { getExamMockSeriesSummary } from "@/lib/mock-series";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [exam, seo, siteUrl] = await Promise.all([getPublicExamBySlug(slug), getSeoSettings(), getSiteUrl()]);
  if (!exam) return {};
  const title = applyTitleTemplate(seo.titleTemplate, `${exam.name} Syllabus`);
  const description = `Full subject and topic-wise syllabus for ${exam.name}, drawn from our question bank taxonomy.`;
  const url = `${siteUrl}/exams/${exam.publicSlug}/syllabus`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
  };
}

export default async function ExamSyllabusPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();
  const mockSeriesSummary = await getExamMockSeriesSummary(exam);

  const [subjects, siteUrl] = await Promise.all([
    prisma.subject.findMany({
      where: { examId: exam.id },
      orderBy: { order: "asc" },
      include: {
        topics: { orderBy: { order: "asc" }, select: { id: true, name: true } },
        _count: { select: { questions: { where: { status: "PUBLISHED" } } } },
      },
    }),
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
              { label: "Syllabus" },
            ]}
          />
          <h1 className="mt-3 text-3xl font-semibold text-[var(--color-foreground)]">{exam.name} Syllabus</h1>
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
        {subjects.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Syllabus not published for this exam yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {subjects.map((s) => (
              <details key={s.id} className="group rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 open:pb-5" open>
                <summary className="flex cursor-pointer list-none items-center justify-between marker:content-none">
                  <span className="text-base font-semibold text-[var(--color-foreground)]">{s.name}</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    {s.topics.length} topics · {s._count.questions} questions
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
