import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen, FileText, ListChecks, Sparkles, Clock, Target } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import {
  getPublicExamBySlug,
  getExamPublicStats,
  getExamSubjectsWithCounts,
  getExamPapers,
  parseFaqItems,
  parseImportantDates,
} from "@/lib/exam-public";
import { getSiteUrl } from "@/lib/site-url";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { getStudentSession } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExamBreadcrumbs } from "@/components/public-exam/breadcrumbs";
import { ExamSubNav } from "@/components/public-exam/exam-subnav";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [exam, seo, siteUrl] = await Promise.all([getPublicExamBySlug(slug), getSeoSettings(), getSiteUrl()]);
  if (!exam) return {};

  const title = exam.seoTitle || applyTitleTemplate(seo.titleTemplate, exam.name);
  const description = exam.seoDescription || exam.shortDescription || seo.defaultMetaDescription;
  const url = `${siteUrl}/exams/${exam.publicSlug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    robots: seo.siteIndexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, url, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ExamPillarPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getPublicExamBySlug(slug);
  if (!exam) notFound();

  const [stats, subjects, papers, siteUrl, session, omrResource] = await Promise.all([
    getExamPublicStats(exam.id),
    getExamSubjectsWithCounts(exam.id),
    getExamPapers(exam.id),
    getSiteUrl(),
    getStudentSession(),
    prisma.testResource.findFirst({
      where: { type: "OMR_TEMPLATE", isActive: true, examId: exam.id, mockTestId: null },
      select: { id: true },
    }),
  ]);

  const faqItems = parseFaqItems(exam.faqItems);
  const importantDates = parseImportantDates(exam.importantDates);
  const isLoggedIn = Boolean(session?.user);
  const pageUrl = `${siteUrl}/exams/${exam.publicSlug}`;

  const firstAttemptablePaper = papers.find((p) => p.questionCount > 0);

  const patternFacts: { label: string; value: string }[] = [];
  if (exam.conductingAuthority) patternFacts.push({ label: "Conducting Authority", value: exam.conductingAuthority });
  if (exam.examMode) patternFacts.push({ label: "Exam Mode", value: exam.examMode });
  if (exam.totalQuestions) patternFacts.push({ label: "Questions", value: String(exam.totalQuestions) });
  if (exam.totalMarks) patternFacts.push({ label: "Total Marks", value: String(exam.totalMarks) });
  if (exam.durationMinutes) patternFacts.push({ label: "Duration", value: `${exam.durationMinutes} minutes` });
  if (exam.negativeMarking) patternFacts.push({ label: "Negative Marking", value: `${exam.negativeMarking} per wrong answer` });

  const webPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: exam.seoTitle || exam.name,
    description: exam.seoDescription || exam.shortDescription || undefined,
    url: pageUrl,
  };
  const faqJsonLd =
    faqItems.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqItems.map((f) => ({
            "@type": "Question",
            name: f.question,
            acceptedAnswer: { "@type": "Answer", text: f.answer },
          })),
        }
      : null;

  return (
    <PublicPageShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webPageJsonLd) }} />
      {faqJsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} /> : null}

      {/* HERO */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <ExamBreadcrumbs baseUrl={siteUrl} crumbs={[{ label: "Home", href: "/" }, { label: "Exams", href: "/exams" }, { label: exam.name }]} />

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {exam.year ? <Badge variant="primary">{exam.year}</Badge> : null}
            {exam.isUpcoming ? <Badge variant="info">Upcoming</Badge> : null}
          </div>

          <h1 className="mt-3 max-w-3xl text-3xl font-semibold text-[var(--color-foreground)] sm:text-4xl lg:text-5xl">{exam.name}</h1>

          {exam.shortDescription ? (
            <p className="mt-4 max-w-2xl text-base text-[var(--color-muted-foreground)] sm:text-lg">{exam.shortDescription}</p>
          ) : null}

          <div className="mt-7 flex flex-wrap items-center gap-3">
            {isLoggedIn ? (
              <Button asChild size="lg">
                <Link href={`/student/exams/${exam.id}`}>Continue Preparation →</Link>
              </Button>
            ) : firstAttemptablePaper ? (
              <Button asChild size="lg">
                <Link href={`/student/attempt/resume?paper=${firstAttemptablePaper.id}`}>Start Preparing →</Link>
              </Button>
            ) : (
              <Button asChild size="lg">
                <Link href="/login">Start Preparing →</Link>
              </Button>
            )}
            {papers.length > 0 ? (
              <Button asChild variant="outline" size="lg">
                <Link href={`/exams/${exam.publicSlug}/previous-year-papers`}>Explore Previous Year Papers</Link>
              </Button>
            ) : null}
            {omrResource ? (
              <Button asChild variant="outline" size="lg">
                <a href={`/api/student/test-resources/${omrResource.id}`}>Download OMR Sheet</a>
              </Button>
            ) : null}
            {!isLoggedIn ? (
              <Button asChild variant="ghost" size="lg">
                <Link href="/login">Student Login</Link>
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

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        {/* EXAM AT A GLANCE */}
        {patternFacts.length > 0 || exam.eligibility ? (
          <section>
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Exam at a Glance</h2>
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              Facts an admin has verified for this exam. Anything not confirmed for the current cycle is labeled below rather than
              stated as fact — always cross-check against the official notification.
            </p>
            {patternFacts.length > 0 ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {patternFacts.map((f) => (
                  <Card key={f.label}>
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">{f.label}</p>
                      <p className="mt-1 text-base font-medium text-[var(--color-foreground)]">{f.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : null}
            {exam.eligibility ? (
              <div className="mt-4">
                <h3 className="text-base font-semibold text-[var(--color-foreground)]">Eligibility</h3>
                <p className="mt-1 whitespace-pre-line text-sm text-[var(--color-muted-foreground)]">{exam.eligibility}</p>
              </div>
            ) : null}
            {importantDates.length > 0 ? (
              <div className="mt-4">
                <h3 className="text-base font-semibold text-[var(--color-foreground)]">Important Dates</h3>
                <div className="mt-2 flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)]">
                  {importantDates.map((d, i) => (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span className="text-[var(--color-muted-foreground)]">{d.label}</span>
                      <span className="font-medium text-[var(--color-foreground)]">{d.date}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {exam.overview ? (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">About This Exam</h2>
            <p className="mt-3 whitespace-pre-line text-[var(--color-muted-foreground)]">{exam.overview}</p>
          </section>
        ) : null}

        {/* MOCKTESTSERIES STATS */}
        <section className="mt-12">
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">MockTestSeries.in Preparation Stats</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">Live numbers from our database — updated automatically.</p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <MiniStat value={stats.questions} label="Questions" />
            <MiniStat value={stats.papers} label="PYQ Papers" />
            <MiniStat value={stats.subjects} label="Subjects" />
            <MiniStat value={stats.topics} label="Topics" />
            <MiniStat value={stats.mockTests} label="Mock Tests" />
            <MiniStat value={stats.aiExplanations} label="AI Explanations" />
          </div>
        </section>

        {/* PREVIOUS YEAR PAPERS */}
        {papers.length > 0 ? (
          <section className="mt-12">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Previous Year Papers</h2>
              <Link href={`/exams/${exam.publicSlug}/previous-year-papers`} className="text-sm font-medium text-[var(--color-primary)] hover:underline">
                View All →
              </Link>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {papers.slice(0, 6).map((p) => (
                <Card key={p.id}>
                  <CardContent className="flex flex-col gap-2 p-4">
                    <p className="text-lg font-semibold text-[var(--color-foreground)]">{p.year}</p>
                    <p className="text-sm text-[var(--color-muted-foreground)]">{p.title}</p>
                    {p.questionCount > 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">{p.questionCount} questions</p> : null}
                    {p.questionCount > 0 ? (
                      <Button asChild size="sm" className="mt-1 w-fit">
                        <Link href={`/student/attempt/resume?paper=${p.id}`}>Attempt Paper</Link>
                      </Button>
                    ) : (
                      <Button size="sm" className="mt-1 w-fit" disabled>
                        Attempt Paper
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {/* SUBJECTS / SYLLABUS */}
        {subjects.length > 0 ? (
          <section className="mt-12">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Subjects &amp; Syllabus</h2>
              <Link href={`/exams/${exam.publicSlug}/syllabus`} className="text-sm font-medium text-[var(--color-primary)] hover:underline">
                Full Syllabus →
              </Link>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {subjects.slice(0, 8).map((s) => (
                <Link key={s.id} href={`/student/subject-test/${exam.id}`} className="group block">
                  <Card className="h-full transition-colors group-hover:border-[var(--color-primary)]/50">
                    <CardContent className="p-4">
                      <p className="font-medium text-[var(--color-foreground)]">{s.name}</p>
                      <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                        {s.topicCount} topics · {s.questionCount} questions
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {/* HOW IT WORKS */}
        <section className="mt-12">
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">How MockTestSeries.in Works</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {["Choose Exam", "Attempt", "Submit", "Result", "Ask AI", "Practice Again"].map((step, i) => (
              <div key={step} className="flex flex-col items-center gap-2 text-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-sm font-semibold text-[var(--color-primary)]">
                  {i + 1}
                </div>
                <p className="text-xs font-medium text-[var(--color-foreground)]">{step}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        {faqItems.length > 0 ? (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Frequently Asked Questions</h2>
            <div className="mt-5 flex flex-col gap-2">
              {faqItems.map((f, i) => (
                <details key={i} className="group rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
                  <summary className="cursor-pointer list-none text-sm font-medium text-[var(--color-foreground)] marker:content-none">
                    {f.question}
                  </summary>
                  <p className="mt-2 whitespace-pre-line text-sm text-[var(--color-muted-foreground)]">{f.answer}</p>
                </details>
              ))}
            </div>
          </section>
        ) : null}

        {/* FINAL CTA */}
        <section className="mt-14 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
          <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Ready to start preparing?</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-muted-foreground)]">
            Join MockTestSeries.in for {exam.name} — previous year papers, subject practice, and AI-powered explanations.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href={isLoggedIn ? `/student/exams/${exam.id}` : "/login"}>{isLoggedIn ? "Open Dashboard" : "Create Free Account"}</Link>
            </Button>
          </div>
        </section>
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

function MiniStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-center">
      <p className="text-xl font-semibold text-[var(--color-foreground)]">{value}</p>
      <p className="text-[11px] text-[var(--color-muted-foreground)]">{label}</p>
    </div>
  );
}
