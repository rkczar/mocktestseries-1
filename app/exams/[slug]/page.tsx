import { safeJsonLd } from "@/lib/json-ld";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, BookOpen, FileText, ListChecks, Sparkles, Clock, Target } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug, getExamPublicStats, getExamSubjectsWithCounts, parseFaqItems, parseImportantDates } from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { getStudentSession } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { MockSeriesPromo, OfferPrice } from "@/components/public-exam/mock-series-promo";
import { ExamDisclaimer, ExamSection, FactGrid, FaqList } from "@/components/public-exam/seo-blocks";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { formatShare, getExamPyqInsights, pyqYearPath } from "@/lib/exam-pyq-insights";

type PublicExam = NonNullable<Awaited<ReturnType<typeof getPublicExamBySlug>>>;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return {};
  const name = displayExamName(exam.name);
  return examPageMetadata({
    exam,
    path: `/exams/${exam.publicSlug}`,
    absoluteTitle: exam.seoTitle || undefined,
    title: `${name}: Exam Pattern, Syllabus, Previous Papers & Mock Tests`,
    description:
      exam.seoDescription ||
      exam.shortDescription ||
      `${name} preparation: exam pattern, syllabus, previous year papers and timed mock tests with AI-powered explanations.`,
  });
}

/** Pattern facts an admin has entered on the Exam row. */
function patternFacts(exam: PublicExam) {
  const facts: { label: string; value: string }[] = [];
  if (exam.examMode) facts.push({ label: "Mode", value: exam.examMode });
  if (exam.totalQuestions) facts.push({ label: "Questions", value: String(exam.totalQuestions) });
  if (exam.totalMarks) facts.push({ label: "Total marks", value: String(exam.totalMarks) });
  if (exam.durationMinutes) facts.push({ label: "Duration", value: `${exam.durationMinutes} minutes` });
  if (exam.negativeMarking != null) {
    facts.push({ label: "Negative marking", value: exam.negativeMarking === 0 ? "None" : `${exam.negativeMarking} per wrong answer` });
  }
  return facts;
}

export default async function ExamPillarPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const [stats, subjects, insights, siteUrl, session, omrResource, mockSeriesSummary] = await Promise.all([
    getExamPublicStats(exam.id),
    getExamSubjectsWithCounts(exam.id),
    getExamPyqInsights(exam.id),
    getSiteUrl(),
    getStudentSession(),
    prisma.testResource.findFirst({
      where: { type: "OMR_TEMPLATE", isActive: true, examId: exam.id, mockTestId: null },
      select: { id: true },
    }),
    getExamMockSeriesSummary(exam),
  ]);
  const name = displayExamName(exam.name);
  const base = `/exams/${exam.publicSlug}`;
  const seriesHref = mockSeriesSummary.mockSeries ? mockSeriesSummary.href : null;
  const faqItems = parseFaqItems(exam.faqItems);
  const importantDates = parseImportantDates(exam.importantDates);
  const facts = patternFacts(exam);
  const isLoggedIn = Boolean(session?.user);
  const papers = insights.papers.filter((p) => p.questionCount > 0);
  const firstAttemptablePaper = papers[0];
  const topSubjects = insights.weightage.slice(0, 3);
  const inEveryPaper = papers.length > 1 ? insights.weightage.filter((w) => w.papers === papers.length).length : 0;
  const years = papers.map((p) => p.year);

  const webPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name,
    description: exam.seoDescription || exam.shortDescription || undefined,
    url: `${siteUrl}${base}`,
    isPartOf: { "@type": "WebSite", "@id": `${siteUrl}/#website` },
  };

  const onThisPage = [
    exam.overview ? { id: "overview", label: "Overview" } : null,
    { id: "important-dates", label: "Important dates" },
    exam.eligibility ? { id: "eligibility", label: "Eligibility" } : null,
    facts.length > 0 || exam.examPatternInfo ? { id: "exam-pattern", label: "Exam pattern" } : null,
    subjects.length > 0 ? { id: "syllabus", label: "Syllabus" } : null,
    papers.length > 0 ? { id: "previous-year-papers", label: "Previous papers" } : null,
    seriesHref ? { id: "mock-tests", label: "Mock tests" } : null,
    { id: "preparation", label: "How to prepare" },
    faqItems.length > 0 ? { id: "faq", label: "FAQ" } : null,
  ].filter((x): x is { id: string; label: string } => x !== null);

  const steps = [
    {
      title: "Know the paper you are training for",
      body:
        facts.length > 0
          ? `Practise in the format you will face (${facts
              .filter((f) => ["Mode", "Questions", "Duration", "Negative marking"].includes(f.label))
              .map((f) => `${f.label.toLowerCase()}: ${f.value}`)
              .join(" · ")}) and re-check the official notice for any change before the exam.`
          : "Start with the official notice so your practice matches the real paper.",
      href: `${base}/exam-pattern`,
      link: "Exam pattern",
    },
    {
      title: "Spend time where the questions are",
      body:
        topSubjects.length > 0
          ? `In past papers, ${topSubjects.map((s) => s.name).join(", ")} together made up ${formatShare(
              topSubjects.reduce((sum, s) => sum + s.share, 0)
            )} of the questions.${inEveryPaper > 0 ? ` ${inEveryPaper} subjects appeared in every paper, so cover breadth as well as depth.` : ""}`
          : "Cover every subject, then go deeper where past papers concentrate.",
      href: `${base}/syllabus`,
      link: "Subject-wise syllabus",
    },
    {
      title: "Solve previous papers under exam conditions",
      body:
        papers.length > 0
          ? `Attempt the ${papers.length} available past papers timed, one at a time, and review every wrong or guessed answer before moving to the next year.`
          : "Use past papers as timed practice as soon as they are available.",
      href: `${base}/previous-year-papers`,
      link: "Previous year papers",
    },
    {
      title: "Take full mocks and review them properly",
      body: "Full-length mocks build pacing and show weak topics. After each one, read the explanation for every question you missed and ask the AI about anything still unclear.",
      href: seriesHref ?? `${base}/question-bank`,
      link: seriesHref ? "Mock test series" : "Question bank",
    },
  ];

  return (
    <PublicPageShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonLd(webPageJsonLd) }} />

      {/* HERO */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <ExamBreadcrumbs baseUrl={siteUrl} crumbs={[{ label: "Home", href: "/" }, { label: "Exams", href: "/exams" }, { label: name }]} />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {exam.year ? <Badge variant="primary">{exam.year}</Badge> : null}
            {exam.isUpcoming ? <Badge variant="info">Upcoming</Badge> : null}
          </div>

          <h1 className="mt-3 max-w-3xl text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl lg:text-5xl">{name}</h1>

          {exam.shortDescription ? (
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--color-muted-foreground)] sm:text-lg">{exam.shortDescription}</p>
          ) : null}

          {seriesHref ? (
            <div className="mt-5">
              <OfferPrice offer={mockSeriesSummary.offer} />
            </div>
          ) : null}

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            {isLoggedIn ? (
              <Button asChild size="lg">
                <Link href={`/student/exams/${exam.id}`}>Continue Preparation →</Link>
              </Button>
            ) : firstAttemptablePaper ? (
              <Button asChild size="lg">
                <Link prefetch={false} href={`/student/attempt/resume?paper=${firstAttemptablePaper.id}`}>Start Preparing →</Link>
              </Button>
            ) : (
              <Button asChild size="lg">
                <Link href="/login">Start Preparing →</Link>
              </Button>
            )}
            {seriesHref ? (
              <Button asChild variant="outline" size="lg">
                <Link href={seriesHref}>View Mock Test Series</Link>
              </Button>
            ) : null}
            {papers.length > 0 ? (
              <Button asChild variant="outline" size="lg">
                <Link href={`${base}/previous-year-papers`}>Previous Year Papers</Link>
              </Button>
            ) : null}
            {omrResource ? (
              <Button asChild variant="ghost" size="lg">
                <a href={`/api/student/test-resources/${omrResource.id}`}>Download OMR Sheet</a>
              </Button>
            ) : null}
          </div>

          <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <StatItem icon={<ListChecks className="h-4 w-4" aria-hidden />} value={stats.questions} label="Questions" />
            <StatItem icon={<BookOpen className="h-4 w-4" aria-hidden />} value={stats.subjects} label="Subjects" />
            <StatItem icon={<Target className="h-4 w-4" aria-hidden />} value={stats.topics} label="Topics" />
            <StatItem icon={<FileText className="h-4 w-4" aria-hidden />} value={stats.papers} label="Previous Year Papers" />
            {stats.mockTests > 0 ? <StatItem icon={<Clock className="h-4 w-4" aria-hidden />} value={stats.mockTests} label="Mock Tests" /> : null}
            {stats.aiExplanations > 0 ? (
              <StatItem icon={<Sparkles className="h-4 w-4" aria-hidden />} value={stats.aiExplanations} label="AI Explanations" />
            ) : null}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="overview" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-8 sm:px-6">
        <nav aria-label="On this page" className="flex flex-wrap gap-2 pb-8">
          {onThisPage.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="rounded-[var(--radius-badge)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted-foreground)] transition-colors hover:border-[var(--color-primary)]/60 hover:text-[var(--color-foreground)]"
            >
              {item.label}
            </a>
          ))}
        </nav>

        {exam.overview ? (
          <ExamSection id="overview" title={`About ${name}`}>
            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <p className="whitespace-pre-line leading-relaxed text-[var(--color-muted-foreground)]">{exam.overview}</p>
              {exam.conductingAuthority ? (
                <div className="h-fit rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4">
                  <p className="text-xs text-[var(--color-muted-foreground)]">Conducting authority</p>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--color-foreground)]">{exam.conductingAuthority}</p>
                </div>
              ) : null}
            </div>
          </ExamSection>
        ) : null}

        <ExamSection id="important-dates" title="Important dates">
          {importantDates.length > 0 ? (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
              <table className="w-full text-sm">
                <caption className="sr-only">{name} important dates</caption>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {importantDates.map((d, i) => (
                    <tr key={i} className="bg-[var(--color-card)]">
                      <th scope="row" className="w-1/2 px-4 py-3 text-left align-top font-normal text-[var(--color-muted-foreground)]">
                        {d.label}
                      </th>
                      <td className="px-4 py-3 font-medium text-[var(--color-foreground)]">{d.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] px-4 py-4 text-sm text-[var(--color-muted-foreground)]">
              Awaiting the official notification. Dates will be listed here once the conducting authority announces them.
            </p>
          )}
        </ExamSection>

        {exam.eligibility ? (
          <ExamSection id="eligibility" title="Eligibility">
            <p className="max-w-3xl whitespace-pre-line leading-relaxed text-[var(--color-muted-foreground)]">{exam.eligibility}</p>
          </ExamSection>
        ) : null}

        {facts.length > 0 || exam.examPatternInfo ? (
          <ExamSection id="exam-pattern" title="Exam pattern" action={{ href: `${base}/exam-pattern`, label: "Full exam pattern" }}>
            <FactGrid facts={facts} />
            {exam.examPatternInfo ? (
              <p className="mt-4 max-w-3xl whitespace-pre-line text-sm leading-relaxed text-[var(--color-muted-foreground)]">{exam.examPatternInfo}</p>
            ) : null}
          </ExamSection>
        ) : null}

        {subjects.length > 0 ? (
          <ExamSection
            id="syllabus"
            title="Syllabus and subjects"
            intro={
              topSubjects.length > 0
                ? `Across ${papers.length} previous papers, ${topSubjects.map((s) => `${s.name} (${formatShare(s.share)})`).join(", ")} carried the most questions.`
                : undefined
            }
            action={{ href: `${base}/syllabus`, label: "Subject-wise syllabus" }}
          >
            <ul className="flex flex-wrap gap-2">
              {subjects.map((s) => (
                <li key={s.id} className="rounded-[var(--radius-badge)] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
                  {s.name}
                  <span className="ml-1.5 text-xs text-[var(--color-muted-foreground)]">{s.topicCount} topics</span>
                </li>
              ))}
            </ul>
          </ExamSection>
        ) : null}

        {papers.length > 0 ? (
          <ExamSection
            id="previous-year-papers"
            title="Previous year papers"
            intro={`${papers.length} past papers (${Math.min(...years)}–${Math.max(...years)}) to attempt online in the exam format, with question-wise review after you submit.`}
            action={{ href: `${base}/previous-year-papers`, label: "All previous year papers" }}
          >
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {papers.map((p) => (
                <li key={p.id}>
                  <Link
                    href={p.indexable ? pyqYearPath(exam.publicSlug!, p.year) : `${base}/previous-year-papers`}
                    className="flex h-full flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 transition-colors hover:border-[var(--color-primary)]/60"
                  >
                    <span className="text-lg tabular-nums text-[var(--color-foreground)]" style={{ fontFamily: "var(--font-mono)" }}>
                      {p.year}
                    </span>
                    <span className="text-sm text-[var(--color-foreground)]">{p.title}</span>
                    <span className="text-xs text-[var(--color-muted-foreground)]">{p.questionCount} questions</span>
                  </Link>
                </li>
              ))}
            </ul>
          </ExamSection>
        ) : null}

        {seriesHref ? (
          <ExamSection id="mock-tests" title="Mock tests" action={{ href: seriesHref, label: `${name} mock test series` }}>
            <MockSeriesPromo
              summary={mockSeriesSummary}
              blurb="Scheduled, exam-pattern mocks with stated syllabus coverage, instant results, question-by-question review and AI explanations."
            />
          </ExamSection>
        ) : null}

        <ExamSection id="preparation" title={`How to prepare for ${name}`}>
          <ol className="grid gap-3 md:grid-cols-2">
            {steps.map((step, i) => (
              <li key={step.title} className="flex gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-sm tabular-nums text-[var(--color-foreground)]">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <h3 className="text-base font-semibold text-[var(--color-foreground)]">{step.title}</h3>
                  <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">{step.body}</p>
                  <Link href={step.href} className="mt-1 inline-flex w-fit items-center gap-1 text-sm font-medium text-[var(--color-foreground)] underline-offset-4 hover:underline">
                    {step.link}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        </ExamSection>

        {faqItems.length > 0 ? (
          <ExamSection id="faq" title="Frequently asked questions">
            <FaqList items={faqItems} />
          </ExamSection>
        ) : null}

        <section className="mt-6 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center sm:p-8">
          <h2 className="text-2xl tracking-[-0.01em] text-[var(--color-foreground)]">Start preparing for {name}</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-muted-foreground)]">
            Previous year papers, subject-wise practice and AI-powered explanations, in one place.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href={isLoggedIn ? `/student/exams/${exam.id}` : "/login"}>{isLoggedIn ? "Open Dashboard" : "Create Free Account"}</Link>
            </Button>
          </div>
        </section>

        <ExamDisclaimer authority={exam.conductingAuthority} />
      </div>
    </PublicPageShell>
  );
}

function StatItem({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[var(--color-muted-foreground)]">
      {icon}
      <span className="font-semibold text-[var(--color-foreground)]">{value}</span> {label}
    </span>
  );
}
