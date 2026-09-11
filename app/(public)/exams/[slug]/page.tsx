import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Container } from "@/components/common/Container";
import { MetaChip } from "@/components/common/MetaChip";
import { StatusBadge } from "@/components/common/StatusBadge";
import { FinalCtaSection } from "@/components/home/FinalCtaSection";
import { TestSeriesCard } from "@/components/home/TestSeriesCard";
import { prisma } from "@/lib/db";

async function getExam(slug: string) {
  return prisma.exam.findUnique({
    where: { slug },
    include: { testSeries: { orderBy: { order: "asc" } } },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const exam = await getExam(slug);
  if (!exam) return {};

  return {
    title: exam.seoTitle ?? exam.title,
    description: exam.seoDesc ?? exam.description,
  };
}

export default async function ExamDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const exam = await getExam(slug);
  if (!exam || exam.status === "ARCHIVED") notFound();

  const isActive = exam.status === "ACTIVE";

  return (
    <>
      <section className="border-b border-border bg-surface">
        <Container className="pt-5">
          <nav className="flex flex-wrap items-center gap-2 text-[13px] text-text-faint">
            <Link href="/" className="hover:text-primary">
              Home
            </Link>
            <span>/</span>
            <Link href="/exams" className="hover:text-primary">
              Exams
            </Link>
            <span>/</span>
            <span className="font-semibold text-text-muted">{exam.title}</span>
          </nav>
        </Container>
        <Container className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-x-14 gap-y-7 py-6 pb-[clamp(36px,5vw,56px)]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusBadge tone={isActive ? "success" : "accent"} dot={isActive}>
                {isActive ? "Active exam" : "Coming soon"}
              </StatusBadge>
              {exam.region ? <StatusBadge tone="neutral">{exam.region}</StatusBadge> : null}
            </div>
            <h1 className="mt-4.5 font-display text-[clamp(32px,4.4vw,50px)] leading-[1.08] font-bold tracking-[-.02em] text-text-heading text-balance">
              {exam.title}
            </h1>
            <p className="mt-4 max-w-[56ch] text-[clamp(15.5px,1.3vw,18px)] leading-relaxed text-text-muted text-pretty">
              {exam.description}
            </p>
            {isActive ? (
              <div className="mt-6.5 flex flex-wrap gap-3">
                <Link
                  href="/student/register"
                  className="inline-flex items-center gap-2.5 rounded-[10px] bg-primary px-6 py-[15px] text-base font-bold text-primary-foreground hover:bg-primary-hover"
                >
                  Start Free Mock Test
                  <ArrowRight className="size-[17px]" strokeWidth={2.2} />
                </Link>
              </div>
            ) : null}
          </div>

          {exam.metaChips.length > 0 ? (
            <div className="min-w-0 rounded-2xl border border-border bg-background p-5.5">
              <p className="font-mono text-[11px] font-semibold tracking-[.1em] text-text-faint uppercase">
                Exam at a glance
              </p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {exam.metaChips.map((chip) => (
                  <MetaChip key={chip} className="bg-surface">
                    {chip}
                  </MetaChip>
                ))}
              </ul>
            </div>
          ) : null}
        </Container>
      </section>

      {exam.testSeries.length > 0 ? (
        <section className="py-[clamp(48px,6vw,80px)]">
          <Container>
            <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
              Test series for this exam
            </p>
            <h2 className="mt-2 font-display text-[clamp(26px,2.8vw,36px)] leading-[1.15] font-bold tracking-[-.015em] text-text-heading">
              Three ways to practice
            </h2>
            <div className="mt-6.5 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5">
              {exam.testSeries.map((series) => (
                <TestSeriesCard
                  key={series.slug}
                  series={{
                    slug: series.slug,
                    kind: series.kind,
                    title: series.title,
                    description: series.description,
                    metaLabel: series.metaLabel,
                  }}
                />
              ))}
            </div>
          </Container>
        </section>
      ) : null}

      <FinalCtaSection
        heading={`Start with ${exam.shortTitle ?? exam.title}`}
        body="Free to start. Attempt a mock test in exam mode, then read the AI explanation on every question you missed."
        note={isActive ? "Login required to attempt a test" : "Register to get notified at launch"}
        primaryCta={{ label: "Start Free Mock Test", href: "/student/register", variant: "accent" }}
        secondaryCta={{ label: "View Pricing", href: "/pricing", variant: "ghost" }}
      />
    </>
  );
}
