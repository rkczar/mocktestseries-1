import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { ExamDisclaimer, ExamSection } from "@/components/public-exam/seo-blocks";
import { ExamResourceLinks } from "@/components/public-exam/exam-resource-links";
import { DataStamp, InsightJsonLd, MethodNote, QuickAnswer, TextLink } from "@/components/public-exam/insight-blocks";
import { examPageMetadata } from "@/lib/exam-seo";
import { getSiteUrl } from "@/lib/site-url";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { formatShare } from "@/lib/exam-pyq-insights";
import { PUBLIC_BRAND_NAME } from "@/lib/brand";
import { examInsightPath, formatShareDiff, loadPublicExamAnalysis, type PyqAnalysis } from "@/lib/exam-pyq-analysis";

/**
 * Historical subject-wise weightage of an exam's previous year papers.
 * Owns the "subject weightage" intent for the exam cluster (the syllabus
 * page targets syllabus intent and links here). Aggregates only: no
 * question, option or answer is ever rendered.
 */

function span(a: PyqAnalysis): string {
  return a.firstYear === a.lastYear ? String(a.lastYear) : `${a.firstYear}–${a.lastYear}`;
}

function periodLabel(years: number[]): string {
  return years.length === 1 ? String(years[0]) : `${years[0]}–${years[years.length - 1]}`;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadPublicExamAnalysis(slug);
  if (!data) return {};
  const { exam, analysis: a, short } = data;
  const top = a.spreads.slice(0, 3);
  return examPageMetadata({
    exam,
    path: examInsightPath(data.slug, "weightage"),
    title: `${short} Subject-Wise Weightage: ${span(a)} PYQ Analysis`,
    description: `${short} subject-wise weightage from ${a.papers.length} previous year papers (${span(a)}, ${a.totalQuestions} questions): ${top
      .map((s) => `${s.name} ${formatShare(s.share)}`)
      .join(", ")}. Historical, not a ${exam.year ?? "future"} forecast.`,
  });
}

export default async function SubjectWiseWeightagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loadPublicExamAnalysis(slug);
  if (!data) notFound();
  const { exam, analysis: a, meta, name, baseName, short } = data;
  const [siteUrl, mockSeriesSummary] = await Promise.all([getSiteUrl(), getExamMockSeriesSummary(exam)]);
  const base = `/exams/${data.slug}`;
  const authority = exam.conductingAuthority ? exam.conductingAuthority.split(/[—,(]/)[0].trim() : "The conducting authority";
  const path = examInsightPath(data.slug, "weightage");
  const n = a.papers.length;
  const top = a.spreads.slice(0, 3);
  const topShare = top.reduce((sum, s) => sum + s.share, 0);
  const alwaysLed = a.leaders.filter((l) => l.names.length === 1 && l.names[0] === top[0].name).length;
  const everyOutsideTop = a.inEveryPaper.filter((s) => !top.some((t) => t.name === s.name));
  const everyOutsideTopShare = everyOutsideTop.reduce((sum, s) => sum + s.share, 0);
  const moved = a.trends.filter((t) => t.signal !== "steady");
  const biggestMoves = [...a.trends].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 2);
  const h1 = `${short}${exam.year ? ` ${exam.year}` : ""} Subject-Wise Weightage`;
  const description = `Subject-wise share of ${a.totalQuestions} questions in ${n} ${baseName} previous year papers (${span(a)}), with recent-vs-older comparison.`;
  const subjectTest = (subject?: string) => {
    const id = subject ? meta.subjectIds[subject] : undefined;
    return `/student/subject-test/${exam.id}${id ? `?subjectId=${encodeURIComponent(id)}` : ""}`;
  };

  return (
    <PublicPageShell>
      <InsightJsonLd siteUrl={siteUrl} path={path} name={h1} description={description} dateModified={meta.dataAsOf} examName={name} />

      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <ExamBreadcrumbs
            baseUrl={siteUrl}
            crumbs={[{ label: "Home", href: "/" }, { label: "Exams", href: "/exams" }, { label: name, href: base }, { label: "Subject-Wise Weightage" }]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{h1}</h1>
          <p className="mt-3 max-w-3xl leading-relaxed text-[var(--color-muted-foreground)]">
            How the {a.totalQuestions} questions in {n} {baseName} ({short}) previous year papers from {span(a)} are spread across subjects. This is
            historical analysis of past papers: it does not guarantee how the {exam.year ?? "next"} paper will be distributed.
          </p>
          <DataStamp iso={meta.dataAsOf} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={data.slug} />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-2 sm:px-6">
        <ExamSection id="most-questions" title={`Which subjects carry the most questions in ${short}?`}>
          <QuickAnswer>
            <strong>{top[0].name}</strong>: {top[0].count} of {a.totalQuestions} questions ({formatShare(top[0].share)})
            {alwaysLed === n ? `, and the largest subject in all ${n} papers` : ""}. {top[1].name} ({top[1].count}, {formatShare(top[1].share)}) and{" "}
            {top[2].name} ({top[2].count}, {formatShare(top[2].share)}) follow. Together these three made up {formatShare(topShare)}; the other{" "}
            {a.spreads.length - 3} subjects shared the remaining {formatShare(1 - topShare)}, and {a.inEveryPaper.length} subjects appeared in every
            paper.
          </QuickAnswer>
        </ExamSection>

        <ExamSection
          id="subject-weightage"
          title={`Subject-wise weightage across all ${short} papers`}
          intro={`Every subject's question count and share across the ${n} papers, and how many of the papers asked it at all.`}
        >
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">
                {short} subject-wise weightage, {span(a)} previous year papers
              </caption>
              <thead className="bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th scope="col" className="w-[42%] px-3 py-2.5 font-medium sm:w-[36%] sm:px-4">
                    Subject
                  </th>
                  <th scope="col" className="w-[15%] px-2 py-2.5 text-right font-medium sm:px-4">
                    Questions
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Share
                  </th>
                  <th scope="col" className="w-[17%] px-2 py-2.5 text-right font-medium sm:w-[14%] sm:px-4">
                    Papers
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {a.spreads.map((s) => (
                  <tr key={s.name} className="bg-[var(--color-card)]">
                    <th scope="row" className="break-words px-3 py-2.5 text-left font-normal leading-snug text-[var(--color-foreground)] sm:px-4">
                      {s.name}
                    </th>
                    <td className="px-2 py-2.5 text-right tabular-nums text-[var(--color-foreground)] sm:px-4">{s.count}</td>
                    <td className="px-3 py-2.5 sm:px-4">
                      <div className="flex items-center gap-2">
                        <div className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)] sm:block" aria-hidden>
                          <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.max(3, (s.count / top[0].count) * 100)}%` }} />
                        </div>
                        <span className="tabular-nums text-[var(--color-muted-foreground)]">{formatShare(s.share)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-[var(--color-muted-foreground)] sm:px-4">
                      {s.papers}/{n}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            &ldquo;Papers&rdquo; = how many of the {n} papers had at least one question from the subject. Subjects follow this site&apos;s
            classification; see the methodology below.
          </p>
          <div className="mt-5 flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Practise any subject with a timed Subject Test drawn from the {short} question bank. Sign in required.
            </p>
            <div className="flex flex-wrap gap-2">
              {top.map((s) => (
                <Button key={s.name} asChild size="sm" variant="outline">
                  <Link prefetch={false} rel="nofollow" href={subjectTest(s.name)}>
                    Practise {s.name}
                  </Link>
                </Button>
              ))}
              <Button asChild size="sm">
                <Link prefetch={false} rel="nofollow" href={subjectTest()}>
                  All subjects
                </Link>
              </Button>
            </div>
          </div>
        </ExamSection>

        {a.trends.length > 0 ? (
          <ExamSection
            id="recent-vs-older"
            title="Has the subject weightage changed in recent papers?"
            intro={`The ${a.older.years.length} older papers (${periodLabel(a.older.years)}, ${a.older.questions} questions) compared with the ${a.recent.years.length} most recent (${periodLabel(a.recent.years)}, ${a.recent.questions} questions).`}
          >
            <QuickAnswer>
              {moved.length === 0 ? (
                <>
                  Not in a statistically meaningful way. No subject&apos;s share moved by a significant margin between the two periods. The largest
                  shifts were {biggestMoves.map((t) => `${t.name} (${formatShareDiff(t.diff)})`).join(" and ")}, which are within normal year-to-year
                  variation for papers of about 100 questions.
                </>
              ) : (
                <>
                  {moved.length === 1 ? "One subject" : `${moved.length} subjects`} changed significantly:{" "}
                  {moved.map((t) => `${t.name} (${formatShareDiff(t.diff)}, ${t.signal === "up" ? "more" : "fewer"} questions recently)`).join("; ")}.
                  Every other subject stayed within normal year-to-year variation.
                </>
              )}
            </QuickAnswer>
            <div className="mt-5 overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
              <table className="w-full min-w-[30rem] text-sm">
                <caption className="sr-only">
                  {short} subject share, {periodLabel(a.older.years)} vs {periodLabel(a.recent.years)}
                </caption>
                <thead className="bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted-foreground)]">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                      Subject
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-4">
                      {periodLabel(a.older.years)}
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-4">
                      {periodLabel(a.recent.years)}
                    </th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-4">
                      Change
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                      Reading
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {a.trends.map((t) => (
                    <tr key={t.name} className="bg-[var(--color-card)]">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal leading-snug text-[var(--color-foreground)] sm:px-4">
                        {t.name}
                      </th>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-muted-foreground)] sm:px-4">{formatShare(t.olderShare)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-muted-foreground)] sm:px-4">{formatShare(t.recentShare)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-foreground)] sm:px-4">{formatShareDiff(t.diff)}</td>
                      <td className="px-3 py-2.5 text-xs text-[var(--color-muted-foreground)] sm:px-4">
                        {t.signal === "up" ? "Significant rise" : t.signal === "down" ? "Significant fall" : "No clear change"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
              A change is called significant only when it is at least 2 percentage points and passes a two-proportion z-test at the 95% level. For
              the year-by-year numbers behind this, see the <TextLink href={examInsightPath(data.slug, "analysis")}>previous year paper analysis</TextLink>.
            </p>
          </ExamSection>
        ) : null}

        <ExamSection
          id="every-paper"
          title={`Subjects asked in every ${short} paper`}
          intro={`${a.inEveryPaper.length} of ${a.spreads.length} subjects had at least one question in all ${n} papers. The range shows the fewest and most questions the subject had in a single paper.`}
        >
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {a.inEveryPaper.map((s) => (
              <li
                key={s.name}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm"
              >
                <span className="min-w-0 break-words text-[var(--color-foreground)]">{s.name}</span>
                <span className="shrink-0 tabular-nums text-xs text-[var(--color-muted-foreground)]">
                  {s.min}–{s.max} per paper
                </span>
              </li>
            ))}
          </ul>
          {everyOutsideTop.length > 0 ? (
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              Beyond the three largest subjects, the other {everyOutsideTop.length} ever-present subjects together carried{" "}
              {formatShare(everyOutsideTopShare)} of all questions. Individually small, together they decide most of the paper.
            </p>
          ) : null}
        </ExamSection>

        {a.rare.length > 0 ? (
          <ExamSection id="rarely-asked" title="Subjects that rarely appear">
            <ul className="flex flex-wrap gap-2">
              {a.rare.map((s) => (
                <li key={s.name} className="rounded-[var(--radius-badge)] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
                  {s.name}
                  <span className="ml-1.5 text-xs text-[var(--color-muted-foreground)]">
                    {s.count} {s.count === 1 ? "question" : "questions"} in {s.papers}/{n} papers
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              Low counts here partly reflect classification: a question that spans two subjects is filed under only one of them. These subjects
              are still part of the MBBS syllabus the exam draws on.
            </p>
          </ExamSection>
        ) : null}

        <ExamSection id="how-to-use" title="How to use subject weightage in your preparation">
          <ul className="grid gap-3 md:grid-cols-2">
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Set revision time, don&apos;t skip subjects</h3>
              Give the largest subjects more hours, but plan every ever-present subject: at {a.inEveryPaper.length} subjects per paper, small
              subjects add up. The <TextLink href={examInsightPath(data.slug, "strategy")}>{short} preparation strategy</TextLink> turns these shares
              into a study plan.
            </li>
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Go from subjects to topics</h3>
              Weightage tells you where questions come from, not what to read inside a subject. Use the{" "}
              <TextLink href={`${base}/syllabus`}>{short} syllabus with its topic-wise list</TextLink> to plan within each subject.
            </li>
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Expect year-to-year swings</h3>
              A subject&apos;s count varies from paper to paper (see the ranges above). Check how each year differed in the{" "}
              <TextLink href={`${base}/previous-year-papers`}>{short} previous year papers</TextLink>, and attempt them in the exam format.
            </li>
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Test the plan</h3>
              Subject-wise practice in the <TextLink href={`${base}/question-bank`}>question bank</TextLink> shows weak areas early
              {mockSeriesSummary.mockSeries ? (
                <>
                  ; full-length papers in the <TextLink href={`${base}/mock-test-series`}>{short} mock test series</TextLink> show whether your
                  coverage holds up
                </>
              ) : null}
              .
            </li>
          </ul>
        </ExamSection>

        <ExamSection id="methodology" title="Methodology and data notes">
          <MethodNote
            items={[
              <>
                <strong className="text-[var(--color-foreground)]">Source:</strong> the {a.totalQuestions} published questions of the {n}{" "}
                {baseName} previous year papers on this site ({a.papers.map((p) => p.year).join(", ")}). No paper is available here for{" "}
                {a.gapYears.length > 0 ? a.gapYears.join(", ") : "other years"}.
              </>,
              <>
                <strong className="text-[var(--color-foreground)]">Classification:</strong> each question is filed under one subject by{" "}
                {PUBLIC_BRAND_NAME}. {authority} does not publish an official subject-wise breakdown, so other sources may count some questions
                differently.
              </>,
              <>
                <strong className="text-[var(--color-foreground)]">Shares, not raw counts:</strong> papers ranged from {a.questionsPerPaper.min} to{" "}
                {a.questionsPerPaper.max} questions, so comparisons use each subject&apos;s share of the questions.
              </>,
              <>
                <strong className="text-[var(--color-foreground)]">Recent vs older:</strong> the papers are split into an older and a more recent
                half; a change is reported only when it is at least 2 percentage points and statistically significant (two-proportion z-test, 95%).
              </>,
              <>
                <strong className="text-[var(--color-foreground)]">Not used:</strong> question difficulty and topic tags. They are not yet complete
                enough across all years to analyse reliably.
              </>,
              <>
                <strong className="text-[var(--color-foreground)]">Historical only:</strong> past weightage does not guarantee the{" "}
                {exam.year ?? "next"} paper. Confirm the official pattern and syllabus in the official notification; see the{" "}
                <TextLink href={`${base}/exam-pattern`}>{short} exam pattern</TextLink> for the sourced details.
              </>,
            ]}
          />
        </ExamSection>

        <ExamResourceLinks
          slug={data.slug}
          examName={short}
          current="weightage"
          exclude={mockSeriesSummary.mockSeries ? [] : ["mock-test-series"]}
        />

        <ExamDisclaimer authority={exam.conductingAuthority} />
      </div>
    </PublicPageShell>
  );
}
