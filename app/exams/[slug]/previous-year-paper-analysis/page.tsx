import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { ExamDisclaimer, ExamSection } from "@/components/public-exam/seo-blocks";
import { ExamResourceLinks } from "@/components/public-exam/exam-resource-links";
import { DataStamp, InsightJsonLd, MethodNote, QuickAnswer, TextLink } from "@/components/public-exam/insight-blocks";
import { examPageMetadata } from "@/lib/exam-seo";
import { getSiteUrl } from "@/lib/site-url";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { formatShare, pyqYearPath } from "@/lib/exam-pyq-insights";
import { getPaperNote } from "@/lib/exam-editorial-facts";
import { examInsightPath, formatShareDiff, loadPublicExamAnalysis, type PyqAnalysis } from "@/lib/exam-pyq-analysis";

/**
 * Cross-year analysis of an exam's previous year papers: paper-by-paper
 * facts, the year × subject matrix and how stable the subject mix is.
 * Subject-level only (topic tags and difficulty aren't reliable yet).
 * Aggregates only: no question, option or answer is ever rendered.
 */

function span(a: PyqAnalysis): string {
  return a.firstYear === a.lastYear ? String(a.lastYear) : `${a.firstYear}–${a.lastYear}`;
}

/** The subject whose share in this paper is furthest above its all-paper share (≥ 2 points), if any. */
function standout(a: PyqAnalysis, year: number) {
  const paper = a.papers.find((p) => p.year === year)!;
  const best = paper.subjects
    .map((s) => ({ name: s.name, diff: s.count / paper.questionCount - (a.spreads.find((w) => w.name === s.name)?.share ?? 0) }))
    .sort((x, y) => y.diff - x.diff)[0];
  return best && best.diff >= 0.02 ? best : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadPublicExamAnalysis(slug);
  if (!data) return {};
  const { exam, analysis: a, short } = data;
  return examPageMetadata({
    exam,
    path: examInsightPath(data.slug, "analysis"),
    title: `${short} Previous Year Paper Analysis: ${span(a)} Trends`,
    description: `${a.papers.length} ${short} previous year papers (${span(a)}) analysed: ${a.totalQuestions} questions, the subject mix year by year, the subjects asked every year and what changed.`,
  });
}

export default async function PreviousYearPaperAnalysisPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loadPublicExamAnalysis(slug);
  if (!data) notFound();
  const { exam, analysis: a, meta, name, baseName, short } = data;
  const [siteUrl, mockSeriesSummary] = await Promise.all([getSiteUrl(), getExamMockSeriesSummary(exam)]);
  const base = `/exams/${data.slug}`;
  const path = examInsightPath(data.slug, "analysis");
  const n = a.papers.length;
  const indexable = new Set(data.insights.papers.filter((p) => p.indexable).map((p) => p.year));
  const newestFirst = [...a.papers].reverse();
  const leaderCounts = new Map<string, number>();
  for (const l of a.leaders) for (const nm of l.names) leaderCounts.set(nm, (leaderCounts.get(nm) ?? 0) + 1);
  const [topLeader, topLeaderPapers] = [...leaderCounts].sort((x, y) => y[1] - x[1])[0];
  const moved = a.trends.filter((t) => t.signal !== "steady");
  const byRange = [...a.inEveryPaper].sort((x, y) => y.max - y.min - (x.max - x.min));
  const mostVariable = byRange.slice(0, 2);
  const steadiest = [...byRange].reverse().filter((s) => s.max - s.min <= 2).slice(0, 4);
  const h1 = `${short} Previous Year Paper Analysis (${span(a)})`;
  const description = `${n} ${baseName} previous year papers compared: questions, subject mix by year and consistency.`;
  const authority = exam.conductingAuthority ? exam.conductingAuthority.split(/[—,(]/)[0].trim() : "the conducting authority";
  const notes = a.papers.map((p) => ({ year: p.year, note: getPaperNote(exam.code, p.year) })).filter((x) => x.note);

  return (
    <PublicPageShell>
      <InsightJsonLd siteUrl={siteUrl} path={path} name={h1} description={description} dateModified={meta.dataAsOf} examName={name} />

      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <ExamBreadcrumbs
            baseUrl={siteUrl}
            crumbs={[{ label: "Home", href: "/" }, { label: "Exams", href: "/exams" }, { label: name, href: base }, { label: "Previous Year Paper Analysis" }]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{h1}</h1>
          <p className="mt-3 max-w-3xl leading-relaxed text-[var(--color-muted-foreground)]">
            All {n} {baseName} ({short}) previous year papers on this site, compared side by side: how many questions each had, which subjects they
            came from, and how much the mix changes from one year to the next.
          </p>
          <DataStamp iso={meta.dataAsOf} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={data.slug} />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-2 sm:px-6">
        <ExamSection id="key-findings" title={`Key findings from ${n} ${short} papers`}>
          <QuickAnswer label="In short">
            The {short} paper has been broadly consistent: {topLeader} had the most questions in {topLeaderPapers} of {n} papers,{" "}
            {a.inEveryPaper.length} subjects appeared every time, and{" "}
            {moved.length === 0 ? "no subject's share changed significantly between older and recent papers" : `only ${moved.map((t) => t.name).join(", ")} changed significantly`}
            .
          </QuickAnswer>
          <ul className="mt-5 grid gap-3 md:grid-cols-2">
            {[
              `${n} papers (${a.papers.map((p) => p.year).join(", ")}), ${a.totalQuestions} questions in all.`,
              `Each paper had ${a.questionsPerPaper.min}–${a.questionsPerPaper.max} questions drawn from ${a.subjectsPerPaper.min}–${a.subjectsPerPaper.max} subjects.`,
              `${a.inEveryPaper.length} of ${a.spreads.length} subjects were asked in every paper; ${a.rare.length} appeared in fewer than half.`,
              `The widest swings: ${mostVariable.map((s) => `${s.name} (${s.min}–${s.max} questions per paper)`).join(" and ")}.`,
            ].map((t) => (
              <li key={t} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
                {t}
              </li>
            ))}
          </ul>
        </ExamSection>

        <ExamSection
          id="papers"
          title={`${short} papers at a glance`}
          intro="One row per paper. The year links to that paper's own subject-wise breakdown, where you can also attempt it online."
        >
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">{short} previous year papers by year</caption>
              <thead className="bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Paper
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-4">
                    Questions
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-4">
                    Subjects
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Most questions
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Above its usual share
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {newestFirst.map((p) => {
                  const leader = a.leaders.find((l) => l.year === p.year)!;
                  const note = getPaperNote(exam.code, p.year);
                  const up = standout(a, p.year);
                  return (
                    <tr key={p.id} className="bg-[var(--color-card)] align-top">
                      <th scope="row" className="px-3 py-2.5 text-left font-normal sm:px-4">
                        {indexable.has(p.year) ? (
                          <Link href={pyqYearPath(data.slug, p.year)} className="font-medium text-[var(--color-foreground)] underline underline-offset-4 hover:text-[var(--color-primary)]">
                            {short} {p.year} paper
                          </Link>
                        ) : (
                          <span className="text-[var(--color-foreground)]">{p.title}</span>
                        )}
                        {note ? (
                          <span className="mt-0.5 block text-xs text-[var(--color-muted-foreground)]">
                            {note.cycle}, held {note.heldOn}
                          </span>
                        ) : null}
                      </th>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-foreground)] sm:px-4">{p.questionCount}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-muted-foreground)] sm:px-4">{p.subjects.length}</td>
                      <td className="px-3 py-2.5 text-[var(--color-muted-foreground)] sm:px-4">
                        {leader.names.join(" / ")} ({leader.count})
                      </td>
                      <td className="px-3 py-2.5 text-[var(--color-muted-foreground)] sm:px-4">{up ? `${up.name} (${formatShareDiff(up.diff)})` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
            &ldquo;Above its usual share&rdquo; is the subject whose share of that paper was furthest above its share across all {n} papers (shown
            only when at least 2 percentage points).
          </p>
        </ExamSection>

        <ExamSection
          id="year-by-year"
          title="Year-by-year subject distribution"
          intro="Questions per subject in each paper. Most papers had about 100 questions, so each count is close to that subject's percentage of the paper."
        >
          <div className="relative overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">{short} questions per subject in each previous year paper</caption>
              <thead className="bg-[var(--color-surface)] text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th scope="col" className="sticky left-0 z-10 bg-[var(--color-surface)] px-3 py-2.5 text-left font-medium sm:px-4">
                    Subject
                  </th>
                  {a.papers.map((p) => (
                    <th key={p.id} scope="col" className="px-2 py-2.5 text-right font-medium tabular-nums">
                      {indexable.has(p.year) ? (
                        <Link href={pyqYearPath(data.slug, p.year)} className="underline-offset-4 hover:underline">
                          {p.year}
                        </Link>
                      ) : (
                        p.year
                      )}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2.5 text-right font-medium sm:px-4">
                    All
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {a.spreads.map((s) => (
                  <tr key={s.name} className="bg-[var(--color-card)]">
                    <th scope="row" className="sticky left-0 z-10 bg-[var(--color-card)] px-3 py-2 text-left font-normal leading-snug text-[var(--color-foreground)] sm:px-4">
                      {s.name}
                    </th>
                    {a.papers.map((p) => {
                      const c = p.subjects.find((x) => x.name === s.name)?.count ?? 0;
                      return (
                        <td key={p.id} className={`px-2 py-2 text-right tabular-nums ${c === 0 ? "text-[var(--color-muted-foreground)]/50" : "text-[var(--color-foreground)]"}`}>
                          {c === 0 ? "–" : c}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-[var(--color-foreground)] sm:px-4">{s.count}</td>
                  </tr>
                ))}
                <tr className="bg-[var(--color-surface)] text-xs">
                  <th scope="row" className="sticky left-0 z-10 bg-[var(--color-surface)] px-3 py-2 text-left font-medium text-[var(--color-muted-foreground)] sm:px-4">
                    Total
                  </th>
                  {a.papers.map((p) => (
                    <td key={p.id} className="px-2 py-2 text-right tabular-nums text-[var(--color-muted-foreground)]">
                      {p.questionCount}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-muted-foreground)] sm:px-4">{a.totalQuestions}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-[var(--color-muted-foreground)] sm:hidden">Scroll the table sideways to see every year.</p>
        </ExamSection>

        <ExamSection id="consistency" title="How consistent is the paper from year to year?">
          <QuickAnswer>
            Mostly consistent at the subject level.{" "}
            {steadiest.length > 0
              ? `${steadiest.map((s) => `${s.name} (${s.min}–${s.max})`).join(", ")} varied by no more than two questions from paper to paper, while`
              : "Most subjects stayed within a few questions per paper, while"} {mostVariable.map((s) => `${s.name} (${s.min}–${s.max})`).join(" and ")} swung the most. For the share of each
            subject across all papers, and a significance test of recent-vs-older changes, see the{" "}
            <TextLink href={examInsightPath(data.slug, "weightage")}>{short} subject-wise weightage</TextLink>.
          </QuickAnswer>
          <ul className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {byRange.map((s) => (
              <li
                key={s.name}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm"
              >
                <span className="min-w-0 break-words text-[var(--color-foreground)]">{s.name}</span>
                <span className="shrink-0 tabular-nums text-xs text-[var(--color-muted-foreground)]">
                  {s.min}–{s.max} per paper · avg {formatShare(s.share)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">Subjects asked in every paper, widest range first.</p>
        </ExamSection>

        <ExamSection id="practise" title="Put the analysis to work">
          <p className="max-w-3xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">
            Attempt each paper timed, newest first, from the <TextLink href={`${base}/previous-year-papers`}>{short} previous year papers</TextLink>{" "}
            page (sign in required; the result comes with question-wise review). Then follow the{" "}
            <TextLink href={examInsightPath(data.slug, "strategy")}>{short} preparation strategy</TextLink> to turn what the papers show into a
            study plan.
          </p>
        </ExamSection>

        <ExamSection id="methodology" title="Methodology and limitations">
          <MethodNote
            items={[
              <>
                <strong className="text-[var(--color-foreground)]">Source:</strong> the {a.totalQuestions} published questions of the {n}{" "}
                {baseName} papers on this site, each filed under one subject by this site. {authority} does not publish an official subject-wise
                breakdown.
              </>,
              ...notes.map(({ year, note }) => (
                <>
                  <strong className="text-[var(--color-foreground)]">The {year} paper</strong> is {note!.cycle}, the exam held on {note!.heldOn}{" "}
                  (source:{" "}
                  <a href={note!.sourceUrl} rel="noopener" target="_blank" className="underline underline-offset-4">
                    {note!.sourceLabel}
                  </a>
                  ). Papers are labelled by recruitment cycle, not by the date of the exam.
                </>
              )),
              ...(a.gapYears.length > 0
                ? [
                    <>
                      <strong className="text-[var(--color-foreground)]">Missing years:</strong> no paper for {a.gapYears.join(", ")} is available on
                      this site, so those years are not part of the analysis.
                    </>,
                  ]
                : []),
              <>
                <strong className="text-[var(--color-foreground)]">Not analysed yet:</strong> difficulty (not recorded reliably) and topics (topic
                tags are not yet complete across all years). Topic-level findings will be added only once the data supports them.
              </>,
              <>
                <strong className="text-[var(--color-foreground)]">Historical only:</strong> these patterns describe past papers and do not predict
                the {exam.year ?? "next"} paper. See the <TextLink href={`${base}/exam-pattern`}>{short} exam pattern</TextLink> for the official,
                sourced format.
              </>,
            ]}
          />
        </ExamSection>

        <ExamResourceLinks
          slug={data.slug}
          examName={short}
          current="analysis"
          exclude={mockSeriesSummary.mockSeries ? [] : ["mock-test-series"]}
        />

        <ExamDisclaimer authority={exam.conductingAuthority} />
      </div>
    </PublicPageShell>
  );
}
