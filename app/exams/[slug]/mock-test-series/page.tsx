import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart3, BookOpen, CalendarClock, CheckCircle2, Clock, FileDown, FileText, ListChecks, Sparkles, Target } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { getPublicExamBySlug, getExamPapers } from "@/lib/exam-public";
import { getExamMockSeriesSummary, getPlanComparison, getSeriesCta, mockSeriesPath, type PublicSeriesTest } from "@/lib/mock-series";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { getStudentSession } from "@/lib/student-session";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";
import { OfferPrice, SeriesCounts } from "@/components/public-exam/mock-series-promo";

/**
 * Canonical Mock Test Series landing page (/exams/[slug]/mock-test-series).
 * The old /exams/[slug]/mock-tests URL 301s here (next.config.ts). Every
 * number, price and CTA is read from lib/mock-series.ts — the same source the
 * homepage, Exam Hub and deep pages use — never typed into this file.
 */

async function load(slug: string) {
  const exam = await getPublicExamBySlug(slug);
  if (!exam) return null;
  const summary = await getExamMockSeriesSummary(exam);
  return { exam, summary };
}

function seriesTitle(examName: string, seriesName: string | undefined) {
  return seriesName ?? `${examName} Mock Test Series`;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [data, seo, siteUrl] = await Promise.all([load(slug), getSeoSettings(), getSiteUrl()]);
  if (!data) return {};
  const { exam, summary } = data;
  const name = seriesTitle(exam.name, summary.mockSeries?.series.name);
  const planned = summary.mockSeries?.planned ?? 0;
  const title = applyTitleTemplate(seo.titleTemplate, planned > 0 ? `${name}: ${planned} Mocks, PYQs & AI Review` : name);
  const description =
    summary.mockSeries
      ? `${name}: ${planned > 0 ? `${planned} exam-pattern mock tests planned, ` : ""}${summary.mockSeries.available} available now, with previous year papers, practice OMR, AI explanations and performance analytics.`
      : `Mock tests for ${exam.name} with previous year papers, practice OMR and AI-powered explanations.`;
  const url = `${siteUrl}${mockSeriesPath(exam.publicSlug!)}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function MockTestSeriesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await load(slug);
  if (!data) notFound();
  const { exam, summary } = data;
  const { mockSeries, offer } = summary;
  const examSlug = exam.publicSlug!;

  const [siteUrl, session, papers, comparison, subjects, omr] = await Promise.all([
    getSiteUrl(),
    getStudentSession(),
    getExamPapers(exam.id),
    getPlanComparison(exam.id, mockSeries, offer),
    prisma.subject.findMany({ where: { examId: exam.id }, orderBy: { order: "asc" }, select: { id: true, name: true, _count: { select: { topics: true } } } }),
    prisma.testResource.findFirst({
      where: {
        type: "OMR_TEMPLATE",
        isActive: true,
        OR: [
          ...(mockSeries ? [{ testSeriesId: mockSeries.series.id }] : []),
          { examId: exam.id, mockTestId: null },
          { examId: null, testSeriesId: null, mockTestId: null },
        ],
      },
      orderBy: [{ testSeriesId: { sort: "asc", nulls: "last" } }, { order: "asc" }],
      select: { id: true, title: true, questionCount: true },
    }),
  ]);
  const studentId = session?.user?.studentId ? (session.user.id ?? null) : null;
  const cta = await getSeriesCta(studentId, offer);

  const name = seriesTitle(exam.name, mockSeries?.series.name);
  const pageUrl = `${siteUrl}${mockSeriesPath(examSlug)}`;
  const hub = `/exams/${examSlug}`;
  const tests = mockSeries?.tests ?? [];
  const planned = mockSeries?.planned ?? 0;
  const paperYears = new Set(papers.map((p) => p.year)).size;
  const freeCta = studentId
    ? { label: "Open Test Series", href: "/student/test-series" }
    : { label: "Start Free", href: `/login?callbackUrl=${encodeURIComponent("/student/test-series")}` };

  // Coverage roll-up across published mocks (real admin-selected coverage).
  const fullSyllabusMocks = tests.filter((t) => t.coverageLabel === "Full Syllabus").length;
  const coverageCounts = new Map<string, number>();
  for (const t of tests) for (const item of t.coverageItems) coverageCounts.set(item, (coverageCounts.get(item) ?? 0) + 1);

  const patternBits: string[] = [];
  if (exam.totalQuestions) patternBits.push(`${exam.totalQuestions} questions`);
  if (exam.durationMinutes) patternBits.push(`${exam.durationMinutes} minutes`);
  if (exam.negativeMarking !== null && exam.negativeMarking !== undefined)
    patternBits.push(exam.negativeMarking > 0 ? `−${exam.negativeMarking} per wrong answer` : "no negative marking");
  if (exam.examMode) patternBits.push(exam.examMode);

  const faqs: { q: string; a: string }[] = [
    {
      q: `How many mock tests are in the ${name}?`,
      a: mockSeries
        ? `${planned > 0 ? `${planned} mock tests are planned for the series. ` : ""}${mockSeries.published} ${mockSeries.published === 1 ? "is" : "are"} published so far and ${mockSeries.available} ${mockSeries.available === 1 ? "is" : "are"} available right now. New mocks unlock on their scheduled release date — the schedule on this page is always current.`
        : "The mock schedule is being prepared. Previous year papers and subject-wise practice are available today.",
    },
    {
      q: "What happens when a scheduled mock is released?",
      a: "It unlocks at its release date and time (IST) and then stays open — you can attempt it any time after release. This is different from a live test, which only runs inside a fixed start and end window.",
    },
    {
      q: "Do the mocks follow the exam pattern?",
      a: patternBits.length
        ? `The exam details we have verified are: ${patternBits.join(", ")}. Each mock lists its own question count, duration and negative marking on its card, so you always know exactly what you are attempting. Always confirm the current pattern in the official notification.`
        : "Each mock lists its question count, duration and negative marking on its card. Always confirm the current pattern in the official notification.",
    },
    {
      q: "What does each mock test cover?",
      a: "Every mock shows its coverage — full syllabus, a partial syllabus, or specific subjects and topics — chosen by our team from the same subject and topic taxonomy used across the question bank.",
    },
    {
      q: "Is there a free plan?",
      a: comparison.everythingFreeNow
        ? "Yes. Right now every feature on the platform is free for signed-in students, including all published mocks."
        : `Yes. The free plan includes ${paperYears > 0 ? `${paperYears} years of previous year papers, ` : ""}downloadable practice OMR, result and review, and a daily allowance of AI explanations. The complete series unlocks every mock as it releases and unlimited AI where configured.`,
    },
    {
      q: "Can I practise on an OMR sheet?",
      a: "Yes. A downloadable practice OMR sheet is available on both the free and the complete plan. You can mark answers on paper and then enter them online to get your score and review.",
    },
    {
      q: "How do AI explanations work?",
      a: "After you submit a test, Ask AI explains why the correct option is right and why the others are wrong, with examiner traps and memory tricks where useful. The daily allowance depends on your plan — see the comparison above.",
    },
  ];

  const breadcrumbs = [
    { label: "Home", href: "/" },
    { label: "Exams", href: "/exams" },
    { label: exam.name, href: hub },
    { label: "Mock Test Series" },
  ];

  const jsonLd: object[] = [
    { "@context": "https://schema.org", "@type": "WebPage", name, url: pageUrl, isPartOf: { "@type": "WebSite", url: siteUrl } },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];
  // Product/Offer only when a real purchasable price is shown on the page.
  if (offer?.showPrice) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "Product",
      name: offer.product.name,
      description: offer.product.description ?? undefined,
      url: pageUrl,
      offers: {
        "@type": "Offer",
        price: (offer.price.pricePaise / 100).toFixed(2),
        priceCurrency: offer.price.currency,
        url: pageUrl,
        availability: offer.purchasable ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        ...(offer.price.saleEndsAt ? { priceValidUntil: offer.price.saleEndsAt.toISOString().slice(0, 10) } : {}),
      },
    });
  }

  return (
    <PublicPageShell>
      {jsonLd.map((j, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(j) }} />
      ))}

      {/* HERO */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <ExamBreadcrumbs baseUrl={siteUrl} crumbs={breadcrumbs} />
          <h1 className="mt-4 max-w-3xl text-3xl font-semibold text-[var(--color-foreground)] sm:text-4xl lg:text-5xl">{name}</h1>
          <p className="mt-4 max-w-2xl text-base text-[var(--color-muted-foreground)] sm:text-lg">
            {mockSeries?.series.description ||
              "Exam-focused mock tests released on a schedule, with previous year papers, a practice OMR sheet, AI-powered answer review and performance analytics."}
          </p>
          <div className="mt-5">
            <SeriesCounts summary={summary} />
          </div>
          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <OfferPrice offer={offer} size="lg" />
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {cta.kind === "BUY" || cta.kind === "LOGIN_TO_BUY" ? (
              <>
                <Button asChild size="lg">
                  <Link href={cta.href!}>{cta.label}</Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href={freeCta.href}>{studentId ? "Open Free Mocks" : "Start Free"}</Link>
                </Button>
              </>
            ) : cta.href ? (
              <Button asChild size="lg">
                <Link href={cta.href}>{cta.label}</Link>
              </Button>
            ) : (
              <Button size="lg" disabled>
                {cta.label}
              </Button>
            )}
            <Button asChild size="lg" variant="ghost">
              <Link href="#schedule">See the schedule</Link>
            </Button>
          </div>
          {comparison.everythingFreeNow ? (
            <p className="mt-4 text-sm text-[var(--color-success)]">Everything is currently free for signed-in students.</p>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <ExamSubNav slug={examSlug} active="mock-test-series" />
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-4 py-10 sm:px-6 sm:py-14">
        {/* OVERVIEW */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">{name}: Overview</h2>
          <p className="mt-3 max-w-3xl text-[var(--color-muted-foreground)]">
            This series is built for {exam.name} aspirants who want steady, exam-like practice rather than one last-minute test.
            {planned > 0 ? ` ${planned} full mocks are planned and released on a schedule` : " Mocks are released on a schedule"}, so you can
            pace revision subject by subject and measure progress every week. Each mock is scored instantly, reviewed question by
            question, and explained by AI after you submit.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat value={planned || "—"} label="Mocks planned" />
            <Stat value={mockSeries?.published ?? 0} label="Mocks published" />
            <Stat value={mockSeries?.available ?? 0} label="Available now" />
            <Stat value={paperYears} label="Years of PYQs" />
          </div>
        </section>

        {/* WHAT YOU GET */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">What You Get</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={<CalendarClock className="h-5 w-5" aria-hidden />} title="Scheduled full mocks" body="Mocks unlock on their release date and stay open afterwards — attempt them at your own pace." />
            <Feature icon={<Target className="h-5 w-5" aria-hidden />} title="Stated coverage" body="Every mock lists what it covers: full syllabus, partial syllabus, or specific subjects and topics." />
            <Feature icon={<FileText className="h-5 w-5" aria-hidden />} title="Previous year papers" body={paperYears > 0 ? `${paperYears} years of real papers you can attempt online.` : "Real papers you can attempt online as they are added."} />
            <Feature icon={<FileDown className="h-5 w-5" aria-hidden />} title="Practice OMR" body="Download the OMR sheet, attempt on paper, then enter answers online for your score." />
            <Feature icon={<Sparkles className="h-5 w-5" aria-hidden />} title="AI-powered review" body="Ask AI explains each answer, the traps examiners set, and a way to remember it." />
            <Feature icon={<BarChart3 className="h-5 w-5" aria-hidden />} title="Performance analytics" body="Score, accuracy and subject-wise performance across every attempt." />
          </div>
        </section>

        {/* SCHEDULE */}
        <section id="schedule" className="scroll-mt-24">
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Mock Test Schedule</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Release times are in IST. A released mock stays available — it is not a live test.
          </p>
          {tests.length === 0 ? (
            <div className="mt-5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted-foreground)]">
              The first mocks are being scheduled. Meanwhile, practise with{" "}
              <Link className="text-[var(--color-primary)] hover:underline" href={`${hub}/previous-year-papers`}>
                previous year papers
              </Link>{" "}
              and{" "}
              <Link className="text-[var(--color-primary)] hover:underline" href={`${hub}/syllabus`}>
                subject-wise practice
              </Link>
              .
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              {tests.map((t) => (
                <ScheduleRow key={t.id} test={t} />
              ))}
              {planned > tests.length ? (
                <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-muted-foreground)]">
                  Mocks {tests.length + 1}–{planned} are planned and will appear here once scheduled.
                </div>
              ) : null}
            </div>
          )}
        </section>

        {/* SYLLABUS COVERAGE */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Syllabus Coverage</h2>
          {tests.length > 0 ? (
            <>
              <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
                {fullSyllabusMocks} of {tests.length} published mocks cover the full syllabus.
                {coverageCounts.size > 0 ? " Subject and topic focus across the rest:" : ""}
              </p>
              {coverageCounts.size > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {[...coverageCounts.entries()].sort((a, b) => b[1] - a[1]).map(([item, n]) => (
                    <span key={item} className="rounded-[var(--radius-badge)] border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted-foreground)]">
                      {item} · {n} mock{n === 1 ? "" : "s"}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">Each mock will list its exact coverage when it is published.</p>
          )}
          {subjects.length > 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted-foreground)]">
              The full {exam.name} syllabus spans {subjects.length} subjects and {subjects.reduce((n, s) => n + s._count.topics, 0)} topics —{" "}
              <Link className="text-[var(--color-primary)] hover:underline" href={`${hub}/syllabus`}>
                view the complete syllabus
              </Link>
              .
            </p>
          ) : null}
        </section>

        {/* FREE VS COMPLETE */}
        <section id="plans" className="scroll-mt-24">
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Free vs Complete Series</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Generated from the platform&apos;s live access rules and AI settings — only what is actually enforced is listed.
            {comparison.everythingFreeNow ? " Right now, every signed-in student gets complete access for free." : ""}
          </p>
          {/* md+: table */}
          <div className="mt-5 hidden overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--color-surface)]">
                <tr className="text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Feature</th>
                  <th className="px-4 py-3 font-medium">Free</th>
                  <th className="px-4 py-3 font-medium text-[var(--color-foreground)]">Complete Series</th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((r) => (
                  <tr key={r.feature} className="border-t border-[var(--color-border)]">
                    <td className="px-4 py-3 font-medium text-[var(--color-foreground)]">
                      {r.feature}
                      {r.note ? <span className="block text-xs font-normal text-[var(--color-muted-foreground)]">{r.note}</span> : null}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-muted-foreground)]">{r.free}</td>
                    <td className="px-4 py-3 text-[var(--color-foreground)]">{r.paid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* mobile: stacked cards, no horizontal scroll */}
          <div className="mt-5 flex flex-col gap-2 md:hidden">
            {comparison.rows.map((r) => (
              <div key={r.feature} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
                <p className="text-sm font-medium text-[var(--color-foreground)]">{r.feature}</p>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-[11px] uppercase text-[var(--color-muted-foreground)]">Free</dt>
                    <dd className="text-[var(--color-muted-foreground)]">{r.free}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase text-[var(--color-muted-foreground)]">Complete</dt>
                    <dd className="text-[var(--color-foreground)]">{r.paid}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </section>

        {/* AI REVIEW + PERFORMANCE */}
        <section className="grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">AI-Powered Review</h2>
            <p className="mt-3 text-[var(--color-muted-foreground)]">
              After you submit, open any question and Ask AI. You get why the correct option is right, why each distractor is wrong,
              the traps examiners like to set, and a short memory trick. Explanations unlock only after submission, so they never
              help mid-test.
            </p>
          </div>
          <div>
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Performance Analysis</h2>
            <p className="mt-3 text-[var(--color-muted-foreground)]">
              Every attempt records score, accuracy, time taken and subject-wise results. Your dashboard tracks the trend across
              mocks, and question-by-question review shows exactly where marks were lost.
            </p>
          </div>
        </section>

        {/* PYQ + OMR */}
        <section className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardContent className="flex h-full flex-col gap-3 p-6">
              <h2 className="text-xl font-semibold text-[var(--color-foreground)]">Previous Year Papers</h2>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                {papers.length > 0
                  ? `${papers.length} papers across ${paperYears} years (${Math.min(...papers.map((p) => p.year))}–${Math.max(...papers.map((p) => p.year))}), each attemptable online with the same result and review engine as the mocks.`
                  : "Papers are added as they are verified."}
              </p>
              <Button asChild variant="outline" className="mt-auto w-fit">
                <Link href={`${hub}/previous-year-papers`}>Browse Previous Year Papers</Link>
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex h-full flex-col gap-3 p-6">
              <h2 className="text-xl font-semibold text-[var(--color-foreground)]">Practice OMR</h2>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Train for an OMR-based paper: print the sheet, attempt a mock on paper against the clock, then enter your answers
                online to get the score and full review. Available on the free and complete plans.
              </p>
              {omr ? (
                <Button asChild variant="outline" className="mt-auto w-fit">
                  <a href={`/api/student/test-resources/${omr.id}`}>
                    Download OMR{omr.questionCount ? ` (${omr.questionCount} Qs)` : ""}
                  </a>
                </Button>
              ) : (
                <p className="mt-auto text-xs text-[var(--color-muted-foreground)]">The OMR sheet will be available here shortly.</p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* HOW IT WORKS */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">How It Works</h2>
          <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Sign in", "Create a free account with Google, email or mobile."],
              ["Pick a mock", "Open the Test Series and choose any released mock."],
              ["Attempt", "Online in the exam-style player, or on the practice OMR."],
              ["Result", "Instant score, accuracy and subject-wise breakdown."],
              ["Review & Ask AI", "Go through every question and let AI explain it."],
            ].map(([t, b], i) => (
              <li key={t} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-sm font-semibold text-[var(--color-primary)]">
                  {i + 1}
                </span>
                <p className="mt-2 font-medium text-[var(--color-foreground)]">{t}</p>
                <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{b}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* WHY MOCKS */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Why Practise with Mock Tests?</h2>
          <div className="mt-3 grid gap-4 text-[var(--color-muted-foreground)] md:grid-cols-3">
            <p>
              <span className="font-medium text-[var(--color-foreground)]">Time management.</span> Timed papers train you to
              finish without rushing the last section — a skill that reading notes alone doesn&apos;t build.
            </p>
            <p>
              <span className="font-medium text-[var(--color-foreground)]">Finding weak areas early.</span> Subject-wise results
              across several mocks show which topics keep costing marks, so revision goes where it matters.
            </p>
            <p>
              <span className="font-medium text-[var(--color-foreground)]">Exam temperament.</span> Regular full-length attempts make
              the real paper feel familiar, and reviewing mistakes turns each attempt into learning.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Frequently Asked Questions</h2>
          <div className="mt-5 flex flex-col gap-2">
            {faqs.map((f) => (
              <details key={f.q} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
                <summary className="cursor-pointer list-none text-sm font-medium text-[var(--color-foreground)] marker:content-none">{f.q}</summary>
                <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* RELATED */}
        <section>
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Related {exam.name} Resources</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Related href={hub} icon={<BookOpen className="h-4 w-4" aria-hidden />} title="Exam overview" />
            <Related href={`${hub}/previous-year-papers`} icon={<FileText className="h-4 w-4" aria-hidden />} title="Previous year papers" />
            <Related href={`${hub}/syllabus`} icon={<ListChecks className="h-4 w-4" aria-hidden />} title="Syllabus" />
            <Related href={`${hub}/exam-pattern`} icon={<Target className="h-4 w-4" aria-hidden />} title="Exam pattern" />
            <Related href={`${hub}/question-bank`} icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title="Question bank" />
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Start your {exam.name} mock practice</h2>
          <div className="mx-auto mt-4 flex w-fit justify-center">
            <OfferPrice offer={offer} />
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {cta.href ? (
              <Button asChild size="lg">
                <Link href={cta.href}>{cta.label}</Link>
              </Button>
            ) : null}
            {cta.kind === "BUY" || cta.kind === "LOGIN_TO_BUY" ? (
              <Button asChild size="lg" variant="outline">
                <Link href={freeCta.href}>{studentId ? "Open Free Mocks" : "Start Free"}</Link>
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    </PublicPageShell>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-center">
      <p className="text-2xl font-semibold text-[var(--color-foreground)]">{value}</p>
      <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
      <div className="text-[var(--color-primary)]">{icon}</div>
      <p className="mt-2 font-medium text-[var(--color-foreground)]">{title}</p>
      <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{body}</p>
    </div>
  );
}

function Related({ href, icon, title }: { href: string; icon: React.ReactNode; title: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm font-medium text-[var(--color-foreground)] hover:border-[var(--color-primary)]/50">
      {icon}
      {title}
    </Link>
  );
}

function ScheduleRow({ test: t }: { test: PublicSeriesTest }) {
  const available = t.availability === "AVAILABLE";
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {t.testNumber > 0 ? <span className="text-xs font-semibold text-[var(--color-muted-foreground)]">Mock {t.testNumber}</span> : null}
          <Badge variant={available ? "success" : "info"}>{available ? "Available" : "Upcoming"}</Badge>
          <Badge variant={t.accessType === "FREE" ? "primary" : "neutral"}>{t.accessType === "FREE" ? "Free" : "Complete Series"}</Badge>
        </div>
        <p className="font-medium text-[var(--color-foreground)]">{t.title}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {t.coverageLabel}
          {t.coverageItems.length ? `: ${t.coverageItems.join(", ")}` : ""}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
          <span className="flex items-center gap-1">
            <ListChecks className="h-3.5 w-3.5" aria-hidden /> {t.questionCount} Qs
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden /> {t.durationMinutes} min
          </span>
          <span className="flex items-center gap-1">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden /> {t.availableFrom ? `${available ? "Released" : "Releases"} ${formatIst(t.availableFrom)}` : "Available now"}
          </span>
        </div>
      </div>
      {available ? (
        <Button asChild size="sm" className="w-fit shrink-0">
          <Link href={`/student/attempt/resume?mockTest=${t.id}`}>Start Mock</Link>
        </Button>
      ) : null}
    </div>
  );
}
