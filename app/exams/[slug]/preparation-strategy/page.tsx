import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { ExamDisclaimer, ExamSection, FaqList } from "@/components/public-exam/seo-blocks";
import { ExamResourceLinks } from "@/components/public-exam/exam-resource-links";
import { DataStamp, InsightJsonLd, QuickAnswer, TextLink } from "@/components/public-exam/insight-blocks";
import { examPageMetadata } from "@/lib/exam-seo";
import { getSiteUrl } from "@/lib/site-url";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { getExamPublicStats } from "@/lib/exam-public";
import { formatShare } from "@/lib/exam-pyq-insights";
import { BRAND_NAME } from "@/lib/brand";
import { examInsightPath, loadPublicExamAnalysis, type SubjectSpread } from "@/lib/exam-pyq-analysis";

/**
 * Preparation strategy for an exam, built on its previous-year-paper data
 * (the same aggregates as the weightage and analysis pages) and the
 * pattern facts on the Exam row. Published by the editorial team; no
 * individual author. Practice CTAs go through the existing sign-in and
 * entitlement flow (/student/* is login-gated server-side).
 */

const AUTHOR = `${BRAND_NAME} Editorial Team`;
const DATE_PUBLISHED = "2026-10-04";

/** Subjects grouped by past-paper share, for the time-allocation step. */
function tiers(spreads: SubjectSpread[], papers: number) {
  const big = spreads.filter((s) => s.share >= 0.08);
  const mid = spreads.filter((s) => s.share >= 0.04 && s.share < 0.08);
  const small = spreads.filter((s) => s.share < 0.04 && s.papers === papers);
  const rare = spreads.filter((s) => s.share < 0.04 && s.papers < papers);
  const sum = (xs: SubjectSpread[]) => xs.reduce((t, s) => t + s.share, 0);
  return [
    { key: "big", label: "Largest subjects (8% or more each)", rows: big, share: sum(big), advice: "Most study hours; revise twice." },
    { key: "mid", label: "Core subjects (4–8% each)", rows: mid, share: sum(mid), advice: "Full coverage; time in proportion to share." },
    { key: "small", label: "Smaller, but asked every year", rows: small, share: sum(small), advice: "Cover high-yield areas; never skip." },
    { key: "rare", label: "Rarely asked", rows: rare, share: sum(rare), advice: "Quick review once the rest is done." },
  ].filter((t) => t.rows.length > 0);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadPublicExamAnalysis(slug);
  if (!data) return {};
  const { exam, analysis: a, short } = data;
  const yr = exam.year ? ` ${exam.year}` : "";
  return examPageMetadata({
    exam,
    path: examInsightPath(data.slug, "strategy"),
    title: `How to Prepare for ${short}${yr}: Strategy Based on Past Papers`,
    description: `A step-by-step ${short}${yr} preparation strategy built on ${a.papers.length} previous year papers: where the questions come from, how to split your time, and how to use PYQs, subject tests and mocks.`,
  });
}

export default async function PreparationStrategyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await loadPublicExamAnalysis(slug);
  if (!data) notFound();
  const { exam, analysis: a, meta, name, baseName, short } = data;
  const [siteUrl, mockSeriesSummary, stats] = await Promise.all([getSiteUrl(), getExamMockSeriesSummary(exam), getExamPublicStats(exam.id)]);
  const base = `/exams/${data.slug}`;
  const path = examInsightPath(data.slug, "strategy");
  const yr = exam.year ? ` ${exam.year}` : "";
  const n = a.papers.length;
  const top = a.spreads.slice(0, 3);
  const topShare = top.reduce((t, s) => t + s.share, 0);
  const groups = tiers(a.spreads, n);
  const newest = [...a.papers].reverse();
  const byRange = [...a.inEveryPaper].sort((x, y) => y.max - y.min - (x.max - x.min));
  const swing = byRange[0];
  const moved = a.trends.filter((t) => t.signal !== "steady");
  const hasMocks = Boolean(mockSeriesSummary.mockSeries);
  const noNegative = exam.negativeMarking === 0;
  const h1 = `${short}${yr} Preparation Strategy`;
  const description = `A ${short}${yr} preparation plan based on ${n} previous year papers and the exam pattern.`;
  const dateModified = meta.dataAsOf && meta.dataAsOf > DATE_PUBLISHED ? meta.dataAsOf : DATE_PUBLISHED;
  const subjectTestHref = `/student/subject-test/${exam.id}`;

  const format = [
    exam.totalQuestions ? `${exam.totalQuestions} multiple-choice questions` : null,
    exam.totalMarks ? `${exam.totalMarks} marks` : null,
    exam.durationMinutes ? `${exam.durationMinutes} minutes` : null,
    exam.examMode ? exam.examMode.toLowerCase().replace(/\(omr-based\)/i, "(OMR)") : null,
    exam.negativeMarking != null ? (noNegative ? "no negative marking" : `${exam.negativeMarking} negative marking per wrong answer`) : null,
  ].filter(Boolean);

  const steps: { id: string; title: string; body: React.ReactNode }[] = [
    {
      id: "format",
      title: "Practise in the exam's own format from day one",
      body: (
        <>
          {format.length > 0 ? `The pattern listed for ${short}: ${format.join(", ")}. ` : ""}
          Time every practice set to that format, and fill answers the way you will on the day.
          {noNegative ? " With no negative marking listed, a blank answer is a lost mark, so practise committing to an answer on every question." : ""}{" "}
          Re-check the current official notification for any change; the sourced details are on the{" "}
          <TextLink href={`${base}/exam-pattern`}>{short} exam pattern</TextLink> page.
        </>
      ),
    },
    {
      id: "syllabus",
      title: "Map the syllabus before you start reading",
      body: (
        <>
          The {short} syllabus here is organised into {stats.subjects} subjects and {stats.topics} topics. Use the{" "}
          <TextLink href={`${base}/syllabus`}>subject and topic-wise syllabus</TextLink> as a checklist and tick topics off as you cover them, so
          gaps are visible rather than discovered in a mock.
        </>
      ),
    },
    {
      id: "time",
      title: "Split your time by past-paper weightage, without dropping subjects",
      body: (
        <>
          Across {n} papers, {top.map((s) => s.name).join(", ")} carried {formatShare(topShare)} of the questions, and the remaining{" "}
          {formatShare(1 - topShare)} was spread over {a.spreads.length - 3} subjects, {a.inEveryPaper.length - top.length} of which appeared in
          every paper. A practical rule: give each subject time roughly in proportion to its share, with a minimum for every subject that is asked
          every year. The groups below come from the{" "}
          <TextLink href={examInsightPath(data.slug, "weightage")}>{short} subject-wise weightage</TextLink>.
        </>
      ),
    },
    {
      id: "pyqs",
      title: "Solve the previous year papers timed, newest first",
      body: (
        <>
          {n} papers are available ({newest.map((p) => p.year).join(", ")}). Attempt one per sitting under full exam conditions, starting with
          the most recent, and keep two papers unseen for the final weeks as full rehearsals. The{" "}
          <TextLink href={examInsightPath(data.slug, "analysis")}>previous year paper analysis</TextLink> shows how each year&apos;s subject mix
          differed, so one unusual paper doesn&apos;t skew your plan.
        </>
      ),
    },
    {
      id: "review",
      title: "Review every mistake and keep an error log",
      body: (
        <>
          A paper is only half done when you submit it. Go through the question-wise review, read the explanation for every wrong or guessed
          answer, and log each one by subject and topic. Save questions you want to see again. After three or four papers the log shows your real
          weak areas better than any general advice can.
        </>
      ),
    },
    {
      id: "subject-tests",
      title: "Fix weak subjects with Subject Tests and custom practice",
      body: (
        <>
          Turn the error log into targeted practice: a Subject Test builds a timed set from one subject (and, if you choose, specific years or
          topics) of the <TextLink href={`${base}/question-bank`}>{short} question bank</TextLink>, and a Custom Module lets you assemble your own
          set across subjects. Short, frequent sets on weak areas work better than rereading.
        </>
      ),
    },
    {
      id: "mocks",
      title: "Rehearse with full-length mocks",
      body: hasMocks ? (
        <>
          Once most of the syllabus is covered, take full-length papers on a fixed schedule from the{" "}
          <TextLink href={`${base}/mock-test-series`}>{short} mock test series</TextLink> and review each one exactly like a previous paper.
          Mocks test whether you can answer new questions, not just ones you have seen.
        </>
      ) : (
        <>Once most of the syllabus is covered, take full-length papers on a fixed schedule and review each one exactly like a previous paper.</>
      ),
    },
    {
      id: "revision",
      title: "Final weeks: errors first, then breadth",
      body: (
        <>
          In the last two to three weeks, re-attempt the questions in your error log, take the two papers you kept unseen, and do a fast pass over
          the smaller subjects that appear every year. Avoid starting new sources this late.
        </>
      ),
    },
  ];

  const outline = [
    { weeks: "1–2", focus: "Learn the format, map the syllabus, attempt the newest previous paper as a baseline.", links: ["pattern", "pyqs"] },
    { weeks: "3–8", focus: "Cover subjects in proportion to their weightage; one previous paper a week; a Subject Test after each subject.", links: ["weightage", "bank"] },
    { weeks: "9–11", focus: `Remaining previous papers${hasMocks ? " plus one full mock a week" : ""}; work through the error log.`, links: hasMocks ? ["mocks", "pyqs"] : ["pyqs"] },
    { weeks: "12", focus: "Re-attempt logged mistakes, the two unseen papers, a light pass over the smaller subjects.", links: ["pyqs"] },
  ];
  const outlineLinks: Record<string, { href: string; label: string }> = {
    pattern: { href: `${base}/exam-pattern`, label: "Exam pattern" },
    pyqs: { href: `${base}/previous-year-papers`, label: "Previous papers" },
    weightage: { href: examInsightPath(data.slug, "weightage"), label: "Weightage" },
    bank: { href: `${base}/question-bank`, label: "Question bank" },
    mocks: { href: `${base}/mock-test-series`, label: "Mock tests" },
  };

  const faq = [
    {
      question: `Are previous year papers enough to prepare for ${short}?`,
      answer: `No, but they are the best place to start. The ${n} papers show the format and how questions are spread across subjects; exact repeats of past questions are rare, while the same concepts come back more often. Use the papers to plan and to rehearse, and cover the full syllabus for the rest.`,
    },
    {
      question: `Which subjects should I start with for ${short}?`,
      answer: `${top.map((s) => `${s.name} (${formatShare(s.share)})`).join(", ")} had the most questions in past papers, so they deserve the most time. But ${a.inEveryPaper.length} subjects appeared in every paper, so start a parallel track for the smaller subjects rather than leaving them to the end.`,
    },
    ...(exam.negativeMarking != null
      ? [
          {
            question: `Is there negative marking in ${short}?`,
            answer: `The ${short} exam pattern page lists ${noNegative ? "no negative marking" : `${exam.negativeMarking} marks deducted per wrong answer`}, with its sources. Confirm it in the current official notification before the exam.`,
          },
        ]
      : []),
  ];

  return (
    <PublicPageShell>
      <InsightJsonLd
        siteUrl={siteUrl}
        path={path}
        name={h1}
        description={description}
        dateModified={dateModified}
        examName={name}
        article={{ authorName: AUTHOR, datePublished: DATE_PUBLISHED }}
      />

      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <ExamBreadcrumbs
            baseUrl={siteUrl}
            crumbs={[{ label: "Home", href: "/" }, { label: "Exams", href: "/exams" }, { label: name, href: base }, { label: "Preparation Strategy" }]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">{h1}</h1>
          <p className="mt-3 max-w-3xl leading-relaxed text-[var(--color-muted-foreground)]">
            How to prepare for the {baseName} ({short}) exam, using what {n} previous year papers show about where the questions come from. Every
            number on this page is calculated from those papers.
          </p>
          <DataStamp iso={dateModified} byline={`By ${AUTHOR}`} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={data.slug} />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-2 sm:px-6">
        <ExamSection id="summary" title={`How to prepare for ${short}${yr}`}>
          <QuickAnswer>
            Work in four phases: learn the format and map the syllabus; cover all {a.inEveryPaper.length} subjects that appear in every paper,
            giving the most time to {top.map((s) => s.name).join(", ")} ({formatShare(topShare)} of past questions together); solve the {n}{" "}
            previous papers timed and review every mistake; then finish with {hasMocks ? "full-length mocks and " : ""}targeted practice on your
            weak subjects.
          </QuickAnswer>
        </ExamSection>

        <ExamSection id="plan" title={`Step-by-step ${short} preparation plan`}>
          <ol className="flex flex-col gap-3">
            {steps.map((s, i) => (
              <li key={s.id} id={`step-${s.id}`} className="flex scroll-mt-24 gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-sm tabular-nums text-[var(--color-foreground)]">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <h3 className="text-base font-semibold text-[var(--color-foreground)]">{s.title}</h3>
                  <p className="text-sm leading-relaxed text-[var(--color-muted-foreground)]">{s.body}</p>
                  {s.id === "time" ? (
                    <div className="mt-3 overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
                      <table className="w-full min-w-[32rem] text-sm">
                        <caption className="sr-only">{short} subjects grouped by previous-year-paper share</caption>
                        <thead className="bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted-foreground)]">
                          <tr>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Group
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Subjects
                            </th>
                            <th scope="col" className="px-3 py-2 text-right font-medium">
                              Share
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium">
                              Approach
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-border)]">
                          {groups.map((g) => (
                            <tr key={g.key} className="align-top">
                              <th scope="row" className="px-3 py-2 text-left font-medium text-[var(--color-foreground)]">
                                {g.label}
                              </th>
                              <td className="px-3 py-2 text-xs leading-relaxed text-[var(--color-muted-foreground)]">{g.rows.map((r) => r.name).join(", ")}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-[var(--color-foreground)]">{formatShare(g.share)}</td>
                              <td className="px-3 py-2 text-xs text-[var(--color-muted-foreground)]">{g.advice}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {s.id === "pyqs" ? (
                    <div className="mt-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`${base}/previous-year-papers`}>Choose a previous year paper</Link>
                      </Button>
                    </div>
                  ) : null}
                  {s.id === "subject-tests" ? (
                    <div className="mt-2">
                      <Button asChild size="sm" variant="outline">
                        <Link prefetch={false} rel="nofollow" href={subjectTestHref}>
                          Start a Subject Test
                        </Link>
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">Practice tests open after you sign in; paid content follows your plan.</p>
        </ExamSection>

        <ExamSection
          id="outline"
          title="A 12-week outline"
          intro="The steps above as a calendar. With fewer weeks, compress subject coverage but keep the previous papers and the error log."
        >
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-border)]">
            <table className="w-full min-w-[32rem] text-sm">
              <caption className="sr-only">{short} 12-week preparation outline</caption>
              <thead className="bg-[var(--color-surface)] text-left text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Weeks
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Focus
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                    Use
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {outline.map((o) => (
                  <tr key={o.weeks} className="bg-[var(--color-card)] align-top">
                    <th scope="row" className="whitespace-nowrap px-3 py-2.5 text-left font-medium tabular-nums text-[var(--color-foreground)] sm:px-4">
                      {o.weeks}
                    </th>
                    <td className="px-3 py-2.5 leading-relaxed text-[var(--color-muted-foreground)] sm:px-4">{o.focus}</td>
                    <td className="px-3 py-2.5 sm:px-4">
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {o.links.map((k) => (
                          <TextLink key={k} href={outlineLinks[k].href}>
                            {outlineLinks[k].label}
                          </TextLink>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ExamSection>

        <ExamSection id="mistakes" title="Preparation mistakes the past papers argue against">
          <ul className="grid gap-3 md:grid-cols-2">
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Putting everything into one big subject</h3>
              {top[0].name} is the largest subject, yet it carried {formatShare(top[0].share)} of past questions. Most of the paper comes from
              elsewhere.
            </li>
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Skipping the &ldquo;small&rdquo; subjects</h3>
              {a.inEveryPaper.length} subjects were asked in every one of the {n} papers. Several of them carry only a few questions each, but
              together they are a large part of the score.
            </li>
            {swing ? (
              <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
                <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Reading one paper as a trend</h3>
                {swing.name} ranged from {swing.min} to {swing.max} questions per paper.{" "}
                {moved.length === 0
                  ? "Yet between older and recent papers no subject's share changed significantly. Plan on the long-run average, not the last paper."
                  : "Plan on the long-run average and the tested changes, not on a single paper."}
              </li>
            ) : null}
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              <h3 className="mb-1.5 text-base font-semibold text-[var(--color-foreground)]">Memorising past answers instead of concepts</h3>
              Exact repeats of past questions are rare in these papers. When you review a question, learn the concept behind it and the options
              around it, not just the correct letter.
            </li>
          </ul>
        </ExamSection>

        <ExamSection id="faq" title="Frequently asked questions">
          <FaqList items={faq} />
        </ExamSection>

        <ExamResourceLinks slug={data.slug} examName={short} current="strategy" exclude={hasMocks ? [] : ["mock-test-series"]} />

        <ExamDisclaimer authority={exam.conductingAuthority} />
      </div>
    </PublicPageShell>
  );
}
