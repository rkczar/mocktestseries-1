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
import { ExamDisclaimer, ExamSection, FactGrid, SubjectWeightageTable } from "@/components/public-exam/seo-blocks";
import { getExamMockSeriesSummary } from "@/lib/mock-series";
import { displayExamName } from "@/lib/exam-display";
import { examPageMetadata } from "@/lib/exam-seo";
import { formatShare, getExamPyqInsights, pyqYearPath, type PaperInsight } from "@/lib/exam-pyq-insights";
import { examShortName, getPaperNote } from "@/lib/exam-editorial-facts";
import { examInsightPath, hasPyqAnalysis } from "@/lib/exam-pyq-analysis";

/**
 * One previous year's paper(s) for an exam. Exists only for years whose
 * paper clears the indexable threshold (lib/exam-pyq-insights.ts); any
 * other year 404s, so no thin page is ever served. Shows aggregates only,
 * never a question, option or answer.
 */

async function load(slug: string, yearParam: string) {
  if (!/^\d{4}$/.test(yearParam)) return null;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return null;
  const year = Number(yearParam);
  const insights = await getExamPyqInsights(exam.id);
  const papers = insights.papers.filter((p) => p.year === year && p.indexable);
  if (papers.length === 0) return null;
  return { exam, year, insights, papers };
}

/** "RUHS Medical Officer" from "RUHS Medical Officer 2026". */
function examBaseName(name: string): string {
  return name.replace(/\s\d{4}$/, "");
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string; year: string }> }): Promise<Metadata> {
  const { slug, year } = await params;
  const data = await load(slug, year);
  if (!data) return {};
  const baseName = examBaseName(displayExamName(data.exam.name));
  const questions = data.papers.reduce((sum, p) => sum + p.questionCount, 0);
  const subjects = new Set(data.papers.flatMap((p) => p.subjects.map((s) => s.name))).size;
  const top = data.papers[0].subjects[0].name;
  // A paper labelled by its recruitment cycle but held the next year is also searched for by the year it was held.
  const note = getPaperNote(data.exam.code, data.year);
  return examPageMetadata({
    exam: data.exam,
    path: pyqYearPath(data.exam.publicSlug!, data.year),
    title: note
      ? `${baseName} ${data.year} Question Paper (Exam Held ${note.heldMonth})`
      : `${baseName} ${data.year} Question Paper: Subject-wise Analysis`,
    description: note
      ? `${baseName} ${data.year} question paper (${note.cycle}), the exam held on ${note.heldOn}: ${questions} questions across ${subjects} subjects, led by ${top}. Subject-wise analysis and an online attempt.`
      : `${baseName} ${data.year} question paper: ${questions} questions across ${subjects} subjects, led by ${top}. Subject-wise analysis and an online attempt in the exam format.`,
  });
}

/** Subjects whose share in this paper differs from the all-paper average by at least 2 points. */
function standouts(paper: PaperInsight, baseline: Map<string, number>) {
  const rows = paper.subjects.map((s) => {
    const share = s.count / paper.questionCount;
    return { name: s.name, share, avg: baseline.get(s.name) ?? 0, diff: share - (baseline.get(s.name) ?? 0) };
  });
  return {
    heavier: rows.filter((r) => r.diff >= 0.02).sort((a, b) => b.diff - a.diff).slice(0, 3),
    lighter: rows.filter((r) => r.diff <= -0.02).sort((a, b) => a.diff - b.diff).slice(0, 3),
  };
}

export default async function PreviousYearPaperYearPage({ params }: { params: Promise<{ slug: string; year: string }> }) {
  const { slug, year: yearParam } = await params;
  const data = await load(slug, yearParam);
  if (!data) notFound();
  const { exam, year, insights, papers } = data;

  const [mockSeriesSummary, siteUrl] = await Promise.all([getExamMockSeriesSummary(exam), getSiteUrl()]);
  const name = displayExamName(exam.name);
  const baseName = examBaseName(name);
  const base = `/exams/${exam.publicSlug}`;
  const seriesHref = mockSeriesSummary.mockSeries ? mockSeriesSummary.href : null;
  const baseline = new Map(insights.weightage.map((w) => [w.name, w.share]));
  const otherYears = insights.indexableYears.filter((y) => y !== year);
  const note = getPaperNote(exam.code, year);
  const short = examShortName(exam.code, baseName);
  const hasAnalysis = hasPyqAnalysis(insights);

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
              { label: "Previous Year Papers", href: `${base}/previous-year-papers` },
              { label: String(year) },
            ]}
          />
          <h1 className="mt-3 text-3xl tracking-[-0.02em] text-[var(--color-foreground)] sm:text-4xl">
            {baseName} {year} Question Paper{note ? ` (Held ${note.heldMonth})` : ""}
          </h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-[var(--color-muted-foreground)]">
            A subject-wise look at the {year} paper, compared with all {insights.papers.filter((p) => p.questionCount > 0).length} past papers on
            this site, and a timed online attempt in the exam format.
          </p>
          {note ? (
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              This is the {note.cycle} paper. The exam was held on {note.heldOn} (source:{" "}
              <a href={note.sourceUrl} rel="noopener" target="_blank" className="underline underline-offset-4">
                {note.sourceLabel}
              </a>
              ), so if you are looking for the {short} {note.heldMonth.slice(-4)} question paper, this is it.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={exam.publicSlug!} active="previous-year-papers" />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-2 sm:px-6">
        {papers.map((paper) => {
          const { heavier, lighter } = standouts(paper, baseline);
          const facts = [
            { label: "Paper", value: paper.title },
            ...(note ? [{ label: "Exam held", value: `${note.heldOn} (${note.cycle})` }] : []),
            { label: "Questions", value: String(paper.questionCount) },
            { label: "Subjects represented", value: String(paper.subjects.length) },
            { label: "Most questions", value: `${paper.subjects[0].name} (${paper.subjects[0].count})` },
            ...(paper.paperCode ? [{ label: "Paper code", value: paper.paperCode }] : []),
          ];
          return (
            <div key={paper.id}>
              <ExamSection id={papers.length > 1 ? `paper-${paper.id}` : "overview"} title={papers.length > 1 ? paper.title : "Paper at a glance"}>
                <FactGrid facts={facts} />
                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Button asChild size="lg">
                    <Link prefetch={false} href={`/student/attempt/resume?paper=${paper.id}`}>Attempt the {year} paper</Link>
                  </Button>
                  <p className="text-sm text-[var(--color-muted-foreground)]">Timed, in the exam format. Sign in required; review and explanations after you submit.</p>
                </div>
              </ExamSection>

              <ExamSection
                id={papers.length > 1 ? `subjects-${paper.id}` : "subjects"}
                title={`Subject-wise questions in ${year}`}
                intro="Each subject's share of this paper, next to its average share across all past papers on this site."
              >
                <SubjectWeightageTable
                  rows={paper.subjects}
                  total={paper.questionCount}
                  baseline={baseline}
                  caption={`${baseName} ${year} questions by subject`}
                />
                <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
                  Subjects follow this site&apos;s question-bank classification.
                  {hasAnalysis ? (
                    <>
                      {" "}
                      Compare every year side by side in the{" "}
                      <Link href={examInsightPath(exam.publicSlug!, "analysis")} className="font-medium text-[var(--color-foreground)] underline underline-offset-4">
                        {short} previous year paper analysis
                      </Link>
                      .
                    </>
                  ) : null}
                </p>
              </ExamSection>

              {heavier.length > 0 || lighter.length > 0 ? (
                <ExamSection id={papers.length > 1 ? `standouts-${paper.id}` : "standouts"} title={`How ${year} differed from other years`}>
                  <div className="grid gap-3 md:grid-cols-2">
                    {heavier.length > 0 ? (
                      <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
                        <h3 className="text-base font-semibold text-[var(--color-foreground)]">More questions than usual</h3>
                        <ul className="mt-3 flex flex-col gap-2 text-sm text-[var(--color-muted-foreground)]">
                          {heavier.map((r) => (
                            <li key={r.name}>
                              <span className="text-[var(--color-foreground)]">{r.name}</span>: {formatShare(r.share)} of this paper vs {formatShare(r.avg)} on
                              average
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {lighter.length > 0 ? (
                      <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
                        <h3 className="text-base font-semibold text-[var(--color-foreground)]">Fewer questions than usual</h3>
                        <ul className="mt-3 flex flex-col gap-2 text-sm text-[var(--color-muted-foreground)]">
                          {lighter.map((r) => (
                            <li key={r.name}>
                              <span className="text-[var(--color-foreground)]">{r.name}</span>: {formatShare(r.share)} of this paper vs {formatShare(r.avg)} on
                              average
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
                    One paper is a small sample; use these swings to plan revision, not to skip subjects.
                  </p>
                </ExamSection>
              ) : null}
            </div>
          );
        })}

        {otherYears.length > 0 ? (
          <ExamSection id="other-years" title="Other years" action={{ href: `${base}/previous-year-papers`, label: "All previous year papers" }}>
            <ul className="flex flex-wrap gap-2">
              {otherYears.map((y) => (
                <li key={y}>
                  <Link
                    href={pyqYearPath(exam.publicSlug!, y)}
                    className="inline-flex rounded-[var(--radius-badge)] border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-sm text-[var(--color-foreground)] transition-colors hover:border-[var(--color-primary)]/60"
                  >
                    {baseName} {y} paper
                  </Link>
                </li>
              ))}
            </ul>
          </ExamSection>
        ) : null}

        <ExamSection id="keep-preparing" title="Keep preparing">
          <ul className={`grid gap-3 sm:grid-cols-2 ${hasAnalysis ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
            {[
              { href: base, title: name, body: "Dates, eligibility, pattern and preparation plan." },
              { href: `${base}/syllabus`, title: "Syllabus", body: "Every subject with its topic-wise list." },
              ...(hasAnalysis
                ? [{ href: examInsightPath(exam.publicSlug!, "weightage"), title: "Subject-wise weightage", body: "Each subject's share of all past-paper questions." }]
                : []),
              seriesHref
                ? { href: seriesHref, title: "Mock test series", body: "Fresh full-length mocks in the exam pattern." }
                : { href: `${base}/question-bank`, title: "Question bank", body: "Subject-wise practice questions." },
            ].map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="group flex h-full flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 transition-colors hover:border-[var(--color-primary)]/60">
                  <span className="inline-flex items-center gap-1 text-base font-semibold text-[var(--color-foreground)]">
                    {l.title}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                  <span className="text-sm text-[var(--color-muted-foreground)]">{l.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </ExamSection>

        <ExamDisclaimer authority={exam.conductingAuthority} />
      </div>
    </PublicPageShell>
  );
}
