import type { Metadata } from "next";
import { Clock, FileText, Target } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Container } from "@/components/common/Container";
import { prisma } from "@/lib/db";

const KIND_ICON = { FULL_MOCK: Clock, PREVIOUS_YEAR: FileText, SUBJECT_WISE: Target } as const;
const KIND_LABEL = {
  FULL_MOCK: "Full mock test",
  PREVIOUS_YEAR: "Previous year paper",
  SUBJECT_WISE: "Subject-wise practice",
} as const;

async function getSeries(slug: string) {
  return prisma.testSeries.findUnique({
    where: { slug },
    include: { exam: true, tests: { where: { isPublished: true }, orderBy: { order: "asc" } } },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const series = await getSeries(slug);
  if (!series) return {};
  return { title: series.title, description: series.description };
}

export default async function TestSeriesDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const series = await getSeries(slug);
  if (!series) notFound();

  const Icon = KIND_ICON[series.kind];

  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <nav className="flex flex-wrap items-center gap-2 text-[13px] text-text-faint">
        <Link href="/" className="hover:text-primary">
          Home
        </Link>
        <span>/</span>
        <Link href="/test-series" className="hover:text-primary">
          Test Series
        </Link>
        <span>/</span>
        <span className="font-semibold text-text-muted">{series.title}</span>
      </nav>

      <div className="mt-4 flex items-start gap-4">
        <span className="flex size-12 flex-none items-center justify-center rounded-xl border border-primary-border bg-primary-tint">
          <Icon className="size-6 text-primary" strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
            {KIND_LABEL[series.kind]} ·{" "}
            <Link href={`/exams/${series.exam.slug}`} className="normal-case text-primary">
              {series.exam.title}
            </Link>
          </p>
          <h1 className="mt-1.5 font-display text-[clamp(26px,3vw,36px)] leading-[1.15] font-bold tracking-[-.015em] text-text-heading">
            {series.title}
          </h1>
        </div>
      </div>
      <p className="mt-4 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
        {series.description}
      </p>
      {series.metaLabel ? (
        <p className="mt-3 font-mono text-xs text-text-faint">{series.metaLabel}</p>
      ) : null}

      <section className="mt-9">
        <h2 className="text-lg font-extrabold text-text-heading">Tests in this series</h2>
        {series.tests.length === 0 ? (
          <p className="mt-3 text-[15px] text-text-faint">
            Tests for this series are being added from the Admin Panel — check back soon.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {series.tests.map((test) => (
              <li
                key={test.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-background px-4.5 py-4"
              >
                <div className="min-w-0">
                  <p className="font-bold text-text-heading">{test.title}</p>
                  <p className="mt-1 text-[13px] text-text-faint">
                    {test.totalMarks} marks · {test.durationMin} min
                  </p>
                </div>
                <Link
                  href={`/student/tests/${test.id}`}
                  className="rounded-[9px] bg-primary px-4 py-2.5 text-sm font-bold whitespace-nowrap text-primary-foreground hover:bg-primary-hover"
                >
                  Attempt test
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Container>
  );
}
